//! A tiny loopback audio proxy - the piece that makes equalisation possible.
//!
//! Two facts forced this design:
//!   * googlevideo answers **only** bounded `Range` requests. A plain GET, or a
//!     Range covering the whole file, comes back 403. So playback must arrive as
//!     a stream of bounded ranges.
//!   * googlevideo sends no `Access-Control-Allow-Origin`, and a media element
//!     without CORS taints its Web Audio source into silence. So the page can
//!     never equalise a stream it fetches directly.
//!
//! Serving everything from 127.0.0.1 solves both: the page gets one same-origin
//! source with CORS headers it can feed into Web Audio, and the proxy speaks
//! googlevideo's required language (bounded ranges, one per client range).
//!
//! ## Why this is not an open proxy
//!
//! A loopback listener is reachable by every process and every web page on the
//! machine, so the naive version of this file was a local-file-read and SSRF
//! primitive for any website the user happened to visit. Three gates close that:
//!
//!   1. **Per-launch token in the path.** `start()` returns
//!      `http://127.0.0.1:<port>/<token>` and the page simply appends `/u?...`,
//!      so the token rides along with no client changes. Without it: 403.
//!   2. **Origin allowlist.** CORS is echoed only for the WebView's own origin;
//!      there is no `Access-Control-Allow-Origin: *` anywhere, so a foreign page
//!      cannot read a response even if it somehow learned the token.
//!   3. **Destination allowlists.** `/u` only reaches `*.googlevideo.com`, and
//!      the `asset.localhost` unwrap only reads inside the app's own media
//!      directories.
//!
//!   GET /<token>/u?u=<percent-encoded url>&n=<optional total bytes>
//!   Range: bytes=s-e   -> 206, clamped to one chunk

use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::OnceLock;

const UA: &str = "com.google.ios.youtube/20.10.4 (iPhone16,3; U; CPU iOS 18_3_2 like Mac OS X)";
const CHUNK: usize = 1024 * 1024;

/// Per-launch secret. Generated once in `start()`, never written to disk.
static TOKEN: OnceLock<String> = OnceLock::new();
/// Directories the `asset.localhost` unwrap is allowed to read from.
static ROOTS: OnceLock<Vec<PathBuf>> = OnceLock::new();

/// Origins the WebView may present. Tauri v2 on Windows/Linux serves the app
/// from `http://tauri.localhost`; macOS uses `tauri://localhost`. The Vite dev
/// port is included so `tauri dev` keeps working.
const ALLOWED_ORIGINS: &[&str] = &[
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
    "http://localhost:1420",
];

/// Startup breadcrumb - the app has no console, so the proxy records why it
/// did or did not come up. Overwritten on every launch.
fn note(msg: &str) {
    let dir = std::env::var("LOCALAPPDATA")
        .unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string());
    let path = std::path::Path::new(&dir).join("MEASURED");
    let _ = std::fs::create_dir_all(&path);
    let _ = std::fs::write(path.join("proxy.txt"), msg);
}

/// 128 bits from the OS-seeded `RandomState` plus the clock and pid. Not a
/// cryptographic RNG, but unguessable enough for a token that lives for one
/// process lifetime and never leaves the machine.
fn random_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut a = std::collections::hash_map::RandomState::new().build_hasher();
    a.write_u64(std::process::id() as u64);
    let mut b = std::collections::hash_map::RandomState::new().build_hasher();
    b.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    format!("{:016x}{:016x}", a.finish(), b.finish())
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(b[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn query(raw: &str, name: &str) -> Option<String> {
    for pair in raw.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == name {
                return Some(percent_decode(v));
            }
        }
    }
    None
}

fn header_value(head: &str, name: &str) -> Option<String> {
    let want = name.to_ascii_lowercase();
    for line in head.lines().skip(1) {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().to_ascii_lowercase() == want {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

/// The origin to echo in CORS headers, or `None` when the caller is not the
/// WebView. `None` still serves the bytes (a media element sends no Origin),
/// but omits the CORS header so no script can read them.
fn allowed_origin(head: &str) -> Option<String> {
    let raw = header_value(head, "origin")?;
    let o = raw.trim();
    ALLOWED_ORIGINS
        .iter()
        .find(|a| **a == o)
        .map(|a| a.to_string())
}

/// True when the request carried an Origin that is *not* ours - a browser page
/// from somewhere else. Such requests are refused outright.
fn foreign_origin(head: &str) -> bool {
    header_value(head, "origin").is_some() && allowed_origin(head).is_none()
}

fn parse_range(head: &str) -> Option<(usize, Option<usize>)> {
    let raw = header_value(head, "range")?;
    let spec = raw.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (a, b) = first.split_once('-')?;
    let start: usize = a.trim().parse().ok()?;
    let end = if b.trim().is_empty() {
        None
    } else {
        b.trim().parse().ok()
    };
    Some((start, end))
}

fn mime_for(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" => "audio/mpeg",
        "m4a" | "aac" | "mp4" => "audio/mp4",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        "webm" => "audio/webm",
        _ => "application/octet-stream",
    }
}

/// Only `googlevideo.com` and its subdomains. This is the whole point of the
/// `/u` endpoint, so anything else is a bug or an attack.
fn upstream_allowed(url: &str) -> bool {
    let rest = match url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    {
        Some(r) => r,
        None => return false,
    };
    let host_port = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host_port
        .split(':')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    host == "googlevideo.com" || host.ends_with(".googlevideo.com")
}

/// True when `path` resolves inside one of the app's own media directories.
fn path_allowed(path: &str) -> bool {
    let Some(roots) = ROOTS.get() else {
        return false;
    };
    let Ok(canon) = std::fs::canonicalize(path) else {
        return false;
    };
    roots.iter().any(|root| {
        std::fs::canonicalize(root)
            .map(|r| canon.starts_with(&r))
            .unwrap_or(false)
    })
}

fn respond(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    origin: Option<&str>,
    extra: &str,
    body: &[u8],
) {
    let cors = match origin {
        Some(o) => format!(
            "Access-Control-Allow-Origin: {o}\r\n\
             Vary: Origin\r\n\
             Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
             Access-Control-Allow-Headers: Range, Content-Type\r\n\
             Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges, Content-Type\r\n"
        ),
        None => String::new(),
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         {cors}\
         {extra}\
         Connection: close\r\n\r\n"
    );
    let _ = stream.write_all(head.as_bytes());
    if !body.is_empty() {
        let _ = stream.write_all(body);
    }
    let _ = stream.flush();
}

fn fail(stream: &mut TcpStream, code: u16, reason: &str, origin: Option<&str>, msg: &str) {
    let extra = format!(
        "Content-Type: text/plain\r\nContent-Length: {}\r\n",
        msg.len()
    );
    respond(stream, code, reason, origin, &extra, msg.as_bytes());
}

/// Serve a local file with Range support - the same shape the browser expects
/// from a static server, so a media element can seek inside it.
fn serve_file(
    stream: &mut TcpStream,
    file_path: &str,
    range: Option<(usize, Option<usize>)>,
    method: &str,
    origin: Option<&str>,
) {
    if !path_allowed(file_path) {
        fail(stream, 403, "Forbidden", origin, "path outside media roots");
        return;
    }
    let Ok(mut file) = std::fs::File::open(file_path) else {
        fail(stream, 404, "Not Found", origin, "no such file");
        return;
    };
    let total = file.metadata().map(|m| m.len() as usize).unwrap_or(0);
    if total == 0 {
        fail(stream, 404, "Not Found", origin, "empty file");
        return;
    }
    let (start, end) = match range {
        Some((s, e)) => {
            let s = s.min(total - 1);
            let e = e.unwrap_or(total - 1).min(total - 1);
            (s, e)
        }
        None => (0, total - 1),
    };
    let len = end.saturating_sub(start) + 1;
    let mime = mime_for(file_path);
    let extra = format!(
        "Content-Type: {mime}\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {start}-{end}/{total}\r\nContent-Length: {len}\r\nCache-Control: no-store\r\n"
    );
    respond(stream, 206, "Partial Content", origin, &extra, &[]);
    if method == "HEAD" {
        return;
    }
    if file.seek(SeekFrom::Start(start as u64)).is_ok() {
        let mut left = len;
        let mut chunk = vec![0u8; 64 * 1024];
        while left > 0 {
            let want = chunk.len().min(left);
            match file.read(&mut chunk[..want]) {
                Ok(0) => break,
                Ok(n) => {
                    if stream.write_all(&chunk[..n]).is_err() {
                        break;
                    }
                    left -= n;
                }
                Err(_) => break,
            }
        }
        let _ = stream.flush();
    }
}

/// Fetch `[start, end]` (inclusive) from upstream - always a bounded range,
/// because that is the only shape googlevideo accepts.
fn fetch_range(url: &str, start: usize, end: usize) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .user_agent(UA)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let (status, bytes) = tauri::async_runtime::block_on(async move {
        let resp = client
            .get(url)
            .header("Range", format!("bytes={start}-{end}"))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let body = resp.bytes().await.map_err(|e| e.to_string())?;
        Ok::<_, String>((status, body.to_vec()))
    })?;
    if status != 206 && status != 200 {
        return Err(format!("HTTP {status}"));
    }
    Ok(bytes)
}

fn serve(mut stream: TcpStream) {
    let mut head = Vec::with_capacity(1024);
    let mut buf = [0u8; 1024];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => return,
            Ok(n) => {
                head.extend_from_slice(&buf[..n]);
                if head.windows(4).any(|w| w == b"\r\n\r\n") || head.len() > 8192 {
                    break;
                }
            }
            Err(_) => return,
        }
    }
    let head_str = String::from_utf8_lossy(&head).to_string();
    let method = head_str.split_whitespace().next().unwrap_or("");
    let raw_path = head_str.split_whitespace().nth(1).unwrap_or("");

    // A browser page from anywhere else is refused before anything is parsed.
    if foreign_origin(&head_str) {
        fail(&mut stream, 403, "Forbidden", None, "origin not allowed");
        return;
    }
    let origin = allowed_origin(&head_str);

    let (path_only, query_raw) = match raw_path.split_once('?') {
        Some((p, q)) => (p, q.to_string()),
        None => (raw_path, String::new()),
    };

    // Path shape is /<token>/<endpoint>. Anything else is not ours.
    let path = match path_only.strip_prefix('/').and_then(|r| r.split_once('/')) {
        Some((tok, tail)) => {
            let expected = TOKEN.get().map(|t| t.as_str()).unwrap_or("");
            if expected.is_empty() || tok != expected {
                fail(
                    &mut stream,
                    403,
                    "Forbidden",
                    origin.as_deref(),
                    "bad token",
                );
                return;
            }
            format!("/{tail}")
        }
        None => {
            fail(
                &mut stream,
                403,
                "Forbidden",
                origin.as_deref(),
                "bad token",
            );
            return;
        }
    };

    if method == "OPTIONS" {
        respond(&mut stream, 204, "No Content", origin.as_deref(), "", &[]);
        return;
    }
    if method != "GET" && method != "HEAD" {
        fail(
            &mut stream,
            405,
            "Method Not Allowed",
            origin.as_deref(),
            "GET or HEAD only",
        );
        return;
    }
    // `/u` is the only endpoint; anything else is a probe.
    if path != "/u" {
        fail(
            &mut stream,
            404,
            "Not Found",
            origin.as_deref(),
            "unknown endpoint",
        );
        return;
    }

    let range = parse_range(&head_str);

    // ---- upstream ---------------------------------------------------------
    let Some(url) = query(&query_raw, "u") else {
        fail(
            &mut stream,
            400,
            "Bad Request",
            origin.as_deref(),
            "missing u",
        );
        return;
    };

    // The asset protocol is Tauri-internal, so reqwest cannot reach it: unwrap
    // it back into the file path it encodes and serve it like any local file.
    if let Some(rest) = url.strip_prefix("http://asset.localhost/") {
        let file_path = percent_decode(rest);
        serve_file(&mut stream, &file_path, range, method, origin.as_deref());
        return;
    }

    if !upstream_allowed(&url) {
        fail(
            &mut stream,
            403,
            "Forbidden",
            origin.as_deref(),
            "host not allowed",
        );
        return;
    }

    let hint_total: Option<usize> = query(&query_raw, "n").and_then(|s| s.parse().ok());
    let (start, want_end) = match range {
        Some((s, e)) => (s, e),
        None => (0, None),
    };
    let end = match want_end {
        Some(e) => e.min(start + CHUNK - 1),
        None => start + CHUNK - 1,
    };

    match fetch_range(&url, start, end) {
        Ok(bytes) => {
            let n = bytes.len();
            let total_str = hint_total
                .map(|t| t.to_string())
                .unwrap_or_else(|| "*".to_string());
            let extra = format!(
                "Content-Type: audio/webm\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {start}-{}/{total_str}\r\nContent-Length: {n}\r\nCache-Control: no-store\r\n",
                start + n.saturating_sub(1)
            );
            respond(
                &mut stream,
                206,
                "Partial Content",
                origin.as_deref(),
                &extra,
                &[],
            );
            if method != "HEAD" {
                let _ = stream.write_all(&bytes);
                let _ = stream.flush();
            }
        }
        Err(e) => fail(
            &mut stream,
            502,
            "Bad Gateway",
            origin.as_deref(),
            &format!("upstream: {e}"),
        ),
    }
}

/// Start the proxy on a random loopback port; returns the base URL **including
/// the per-launch token**, so the page can keep doing `base + '/u?u=...'`.
/// `roots` are the only directories the local-file path may read from.
pub fn start(roots: Vec<PathBuf>) -> String {
    let _ = ROOTS.set(roots);
    let token = TOKEN.get_or_init(random_token).clone();

    let listener = match TcpListener::bind(("127.0.0.1", 0)) {
        Ok(l) => l,
        Err(e) => {
            note(&format!("bind failed: {e}"));
            return String::new();
        }
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(_) => return String::new(),
    };
    note(&format!("listening on 127.0.0.1:{port} (token gated)"));
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            match conn {
                Ok(stream) => {
                    std::thread::spawn(move || serve(stream));
                }
                Err(_) => continue,
            }
        }
    });
    format!("http://127.0.0.1:{port}/{token}")
}
