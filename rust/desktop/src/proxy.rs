//! A tiny loopback audio proxy — the piece that makes equalisation possible.
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
//!   GET /u?u=<percent-encoded url>&n=<optional total bytes>
//!   GET /f?p=<percent-encoded local path>
//!   Range: bytes=s-e   → 206, clamped to one chunk

use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};

const UA: &str = "com.google.ios.youtube/20.10.4 (iPhone16,3; U; CPU iOS 18_3_2 like Mac OS X)";
const CHUNK: usize = 1024 * 1024;

/// Startup breadcrumb — the app has no console, so the proxy records why it
/// did or did not come up. Overwritten on every launch.
fn note(msg: &str) {
    let dir = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string());
    let path = std::path::Path::new(&dir).join("MEASURED");
    let _ = std::fs::create_dir_all(&path);
    let _ = std::fs::write(path.join("proxy.txt"), msg);
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

fn parse_range(head: &str) -> Option<(usize, Option<usize>)> {
    let raw = header_value(head, "range")?;
    let spec = raw.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (a, b) = first.split_once('-')?;
    let start: usize = a.trim().parse().ok()?;
    let end = if b.trim().is_empty() { None } else { b.trim().parse().ok() };
    Some((start, end))
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "mp3" => "audio/mpeg",
        "m4a" | "aac" | "mp4" => "audio/mp4",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        "webm" => "audio/webm",
        _ => "application/octet-stream",
    }
}

fn respond(stream: &mut TcpStream, status: u16, reason: &str, extra: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
         Access-Control-Allow-Headers: Range, Content-Type\r\n\
         Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges, Content-Type\r\n\
         {extra}\
         Connection: close\r\n\r\n"
    );
    let _ = stream.write_all(head.as_bytes());
    if !body.is_empty() {
        let _ = stream.write_all(body);
    }
    let _ = stream.flush();
}

fn fail(stream: &mut TcpStream, code: u16, reason: &str, msg: &str) {
    let extra = format!("Content-Type: text/plain\r\nContent-Length: {}\r\n", msg.len());
    respond(stream, code, reason, &extra, msg.as_bytes());
}

/// Serve a local file with Range support — the same shape the browser expects
/// from a static server, so a media element can seek inside it.
fn serve_file(stream: &mut TcpStream, file_path: &str, range: Option<(usize, Option<usize>)>, method: &str) {
    let Ok(mut file) = std::fs::File::open(file_path) else {
        fail(stream, 404, "Not Found", "no such file");
        return;
    };
    let total = file.metadata().map(|m| m.len() as usize).unwrap_or(0);
    if total == 0 {
        fail(stream, 404, "Not Found", "empty file");
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
    respond(stream, 206, "Partial Content", &extra, &[]);
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

/// Fetch `[start, end]` (inclusive) from upstream — always a bounded range,
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
    let path = head_str.split_whitespace().nth(1).unwrap_or("");
    let query_raw = path.split_once('?').map(|(_, q)| q.to_string()).unwrap_or_default();

    if method == "OPTIONS" {
        respond(&mut stream, 204, "No Content", "", &[]);
        return;
    }
    if method != "GET" && method != "HEAD" {
        fail(&mut stream, 405, "Method Not Allowed", "GET or HEAD only");
        return;
    }

    let range = parse_range(&head_str);

    // ---- local file -------------------------------------------------------
    if path.starts_with("/f") {
        match query(&query_raw, "p") {
            Some(file_path) => serve_file(&mut stream, &file_path, range, method),
            None => fail(&mut stream, 400, "Bad Request", "missing p"),
        }
        return;
    }

    // ---- upstream ---------------------------------------------------------
    let Some(url) = query(&query_raw, "u") else {
        fail(&mut stream, 400, "Bad Request", "missing u");
        return;
    };

    // The asset protocol is Tauri-internal, so reqwest cannot reach it: unwrap
    // it back into the file path it encodes and serve it like any local file.
    if let Some(rest) = url.strip_prefix("http://asset.localhost/") {
        let file_path = percent_decode(rest);
        serve_file(&mut stream, &file_path, range, method);
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
            let total_str = hint_total.map(|t| t.to_string()).unwrap_or_else(|| "*".to_string());
            let extra = format!(
                "Content-Type: audio/webm\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {start}-{}/{total_str}\r\nContent-Length: {n}\r\nCache-Control: no-store\r\n",
                start + n.saturating_sub(1)
            );
            respond(&mut stream, 206, "Partial Content", &extra, &[]);
            if method != "HEAD" {
                let _ = stream.write_all(&bytes);
                let _ = stream.flush();
            }
        }
        Err(e) => fail(&mut stream, 502, "Bad Gateway", &format!("upstream: {e}")),
    }
}

/// Start the proxy on a random loopback port; returns the base URL.
pub fn start() -> String {
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
    note(&format!("listening on 127.0.0.1:{port}"));
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
    format!("http://127.0.0.1:{port}")
}
