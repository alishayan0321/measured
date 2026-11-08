//! YouTube search through the public InnerTube web endpoint.
//!
//! Only *search* lives here. Playback is handed to the official IFrame player
//! inside the page, so no stream URL is ever extracted and nothing is
//! downloaded — the video plays exactly as it does on youtube.com, which is
//! both simpler and within their terms.

use serde::{Deserialize, Serialize};
use serde_json::Value;

const SEARCH_URL: &str =
    "https://www.youtube.com/youtubei/v1/search?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Video {
    pub id: String,
    pub title: String,
    pub author: String,
    pub seconds: u32,
    pub views: String,
    pub thumb: Option<String>,
}

fn text_of(node: &Value) -> String {
    node.get("simpleText")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            node.get("runs")
                .and_then(|r| r.as_array())
                .map(|runs| {
                    runs.iter()
                        .filter_map(|r| r.get("text").and_then(|t| t.as_str()))
                        .collect::<String>()
                })
        })
        .unwrap_or_default()
}

fn parse_length(s: &str) -> u32 {
    let mut total = 0u32;
    for part in s.split(':').rev().enumerate() {
        let (idx, raw) = part;
        let n: u32 = raw.trim().parse().unwrap_or(0);
        total += n * 60u32.pow(idx as u32);
    }
    total
}

fn walk_videos(node: &Value, out: &mut Vec<Video>) {
    if let Some(vr) = node.get("videoRenderer") {
        let id = vr.get("videoId").and_then(|v| v.as_str()).unwrap_or("");
        if id.len() == 11 {
            let title = vr
                .get("title")
                .map(text_of)
                .unwrap_or_else(|| "Untitled".to_string());
            let author = vr
                .get("ownerText")
                .or_else(|| vr.get("longBylineText"))
                .map(text_of)
                .unwrap_or_default();
            let length = vr.get("lengthText").map(text_of).unwrap_or_default();
            let views = vr
                .get("shortViewCountText")
                .or_else(|| vr.get("viewCountText"))
                .map(text_of)
                .unwrap_or_default();
            let thumb = vr
                .get("thumbnail")
                .and_then(|t| t.get("thumbnails"))
                .and_then(|t| t.as_array())
                .and_then(|arr| arr.last())
                .and_then(|t| t.get("url"))
                .and_then(|u| u.as_str())
                .map(|s| s.to_string());

            out.push(Video {
                id: id.to_string(),
                title,
                author,
                seconds: parse_length(&length),
                views,
                thumb,
            });
        }
    }

    match node {
        Value::Object(map) => {
            for (_, v) in map {
                walk_videos(v, out);
            }
        }
        Value::Array(arr) => {
            for v in arr {
                walk_videos(v, out);
            }
        }
        _ => {}
    }
}

/// Search YouTube. `limit` caps the returned rows (the API usually sends ~20).
#[tauri::command]
pub async fn yt_search(query: String, limit: Option<usize>) -> Result<Vec<Video>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let body = serde_json::json!({
        "context": {
            "client": {
                "clientName": "WEB",
                "clientVersion": "2.20240726.00.00",
                "hl": "en",
                "gl": "US"
            }
        },
        "query": q,
        "params": "EgIQAQ%3D%3D"
    });

    let client = reqwest::Client::builder()
        .user_agent(UA)
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(SEARCH_URL)
        .header("Content-Type", "application/json")
        .header("Accept-Language", "en-US,en;q=0.9")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("search failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("search HTTP {}", resp.status()));
    }

    let json: Value = resp.json().await.map_err(|e| format!("bad json: {e}"))?;
    let mut videos = Vec::new();
    walk_videos(&json, &mut videos);

    // de-duplicate while keeping order, then apply the limit
    let mut seen = std::collections::HashSet::new();
    videos.retain(|v| seen.insert(v.id.clone()));
    if let Some(n) = limit {
        videos.truncate(n);
    }
    Ok(videos)
}

// ------------------------------------------------------------------ audio
// Audio-first playback. The video path stays with the official IFrame player,
// but an audio-only session needs a real audio URL.
//
// Resolution order, cheapest first:
//   1. the YouTube Music InnerTube player endpoint (one POST, ~150 ms, no
//      binary involved) — same route SimpMusic's StreamRepository takes;
//   2. yt-dlp, which can sign what InnerTube hands back ciphered.
// The returned googlevideo URL carries `cpn` and `range=0-<length>` so the
// whole song streams in one connection, and it expires — callers must not
// cache it past `expires_in`.

const PLAYER_URL: &str =
    "https://music.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const UA_IOS: &str = "com.google.ios.youtube/20.10.4 (iPhone16,3; U; CPU iOS 18_3_2 like Mac OS X)";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedAudio {
    pub url: String,
    pub itag: i64,
    pub mime: String,
    pub bitrate: i64,
    pub expires_in: i64,
    pub content_length: Option<i64>,
    pub length_seconds: Option<i64>,
    pub via: String,
}

/// 16-char client playback nonce (the `cpn` InnerTube expects).
fn cpn() -> String {
    const A: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
    let mut seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
        ^ (std::process::id() as u64).rotate_left(17);
    let mut out = String::with_capacity(16);
    for _ in 0..16 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        out.push(A[(seed >> 33) as usize % A.len()] as char);
    }
    out
}

fn audio_rank(itag: i64) -> i32 {
    match itag {
        251 => 0, // Opus 160 kbps
        141 => 1, // AAC 256
        140 => 2, // AAC 128
        250 => 3, // Opus 70
        249 => 4, // Opus 50
        774 => 8, // Opus 256, usually ciphered — only as a last resort
        _ => 9,
    }
}

fn pick_audio(json: &Value) -> Option<ResolvedAudio> {
    let sd = json.get("streamingData")?;
    let mut best: Option<(i32, ResolvedAudio)> = None;

    for key in ["adaptiveFormats", "formats"] {
        let Some(list) = sd.get(key).and_then(|v| v.as_array()) else { continue };
        for f in list {
            let Some(url) = f.get("url").and_then(|v| v.as_str()).filter(|u| u.starts_with("http")) else { continue };
            let mime = f.get("mimeType").and_then(|v| v.as_str()).unwrap_or("");
            if !mime.starts_with("audio/") && key == "adaptiveFormats" {
                continue;
            }
            if !mime.starts_with("audio/") {
                continue;
            }
            let itag = f.get("itag").and_then(|v| v.as_i64()).unwrap_or(0);
            let rank = audio_rank(itag);
            let cand = ResolvedAudio {
                url: url.to_string(),
                itag,
                mime: mime.to_string(),
                bitrate: f.get("bitrate").and_then(|v| v.as_i64()).unwrap_or(0),
                expires_in: sd.get("expiresInSeconds").and_then(|v| v.as_str().and_then(|s| s.parse::<i64>().ok())).unwrap_or(0),
                content_length: f.get("contentLength").and_then(|v| v.as_str().and_then(|s| s.parse::<i64>().ok())),
                length_seconds: json
                    .get("videoDetails")
                    .and_then(|v| v.get("lengthSeconds"))
                    .and_then(|v| v.as_str().and_then(|s| s.parse::<i64>().ok())),
                via: "innertube".to_string(),
            };
            if best.as_ref().map(|(r, _)| rank < *r).unwrap_or(true) {
                best = Some((rank, cand));
            }
        }
    }
    best.map(|(_, c)| c)
}

/// Ask the InnerTube player endpoint for a playable audio URL.
pub async fn resolve_audio(id: &str) -> Result<ResolvedAudio, String> {
    let body = serde_json::json!({
        "context": {
            "client": {
                "clientName": "IOS",
                "clientVersion": "20.10.4",
                "deviceModel": "iPhone16,3",
                "osName": "iPhone",
                "osVersion": "18.3.2.22D82",
                "hl": "en",
                "gl": "US"
            }
        },
        "videoId": id,
        "contentCheckOk": true,
        "racyCheckOk": true
    });

    let client = reqwest::Client::builder()
        .user_agent(UA_IOS)
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(PLAYER_URL)
        .header("Content-Type", "application/json")
        .header("Origin", "https://music.youtube.com")
        .header("Referer", "https://music.youtube.com/")
        .header("Accept-Language", "en-US,en;q=0.9")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("player failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("player HTTP {}", resp.status()));
    }
    let json: Value = resp.json().await.map_err(|e| format!("bad json: {e}"))?;

    if let Some(status) = json.get("playabilityStatus").and_then(|s| s.get("status")).and_then(|s| s.as_str()) {
        if status != "OK" {
            let why = json
                .get("playabilityStatus")
                .and_then(|s| s.get("reason"))
                .and_then(|s| s.as_str())
                .unwrap_or(status);
            return Err(format!("not playable: {why}"));
        }
    }

    let mut out = pick_audio(&json).ok_or_else(|| "no audio format with a URL (ciphered)".to_string())?;
    let len = out.content_length.unwrap_or(10_000_000);
    let sep = "&";
    out.url = format!("{}{}cpn={}&range=0-{}", out.url, sep, cpn(), len);
    Ok(out)
}

#[tauri::command]
pub async fn yt_resolve(id: String) -> Result<ResolvedAudio, String> {
    check_id(&id)?;
    resolve_audio(&id).await
}

fn check_id(id: &str) -> Result<(), String> {
    if id.len() != 11 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("bad video id".into());
    }
    Ok(())
}

fn ytdlp_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    if let Ok(p) = std::env::var("MEASURED_YTDLP") {
        let pb = std::path::PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("yt-dlp.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    let dev = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("yt-dlp.exe")))
        .unwrap_or_default();
    dev.is_file().then_some(dev)
}

#[tauri::command]
pub async fn yt_audio(app: tauri::AppHandle, id: String) -> Result<String, String> {
    check_id(&id)?;

    // Fast path: InnerTube hands back a direct googlevideo URL for most tracks.
    match resolve_audio(&id).await {
        Ok(r) => return Ok(r.url),
        Err(_) => { /* fall through to yt-dlp, which can sign ciphered formats */ }
    }

    let exe = ytdlp_path(&app).ok_or_else(|| "yt-dlp.exe is missing".to_string())?;

    let mut cmd = std::process::Command::new(exe);
    cmd.args([
        "-f",
        "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio",
        "-g",
        "--no-warnings",
        "--no-playlist",
        "--no-progress",
        &format!("https://www.youtube.com/watch?v={id}"),
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let out = cmd.output().map_err(|e| format!("spawn failed: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("yt-dlp: {}", err.lines().last().unwrap_or("failed")));
    }
    let url = String::from_utf8_lossy(&out.stdout)
        .lines()
        .find(|l| l.starts_with("http"))
        .map(|l| l.trim().to_string())
        .ok_or_else(|| "yt-dlp returned no URL".to_string())?;
    Ok(url)
}
/// Save a streamed song into the local library (added-songs folder).
/// Returns the stored file name, which the page then picks up from a reload.
#[tauri::command]
pub fn yt_download(
    app: tauri::AppHandle,
    id: String,
    title: String,
    author: String,
) -> Result<String, String> {
    use tauri::Manager;

    if id.len() != 11 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("bad video id".into());
    }
    let exe = ytdlp_path(&app).ok_or_else(|| "yt-dlp.exe is missing".to_string())?;

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("songs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create songs dir: {e}"))?;

    // "Artist - Title", stripped of everything Windows rejects, bounded so the
    // path stays well inside MAX_PATH even under a long %APPDATA%.
    let stem = format!("{} - {}", author.trim(), title.trim());
    let mut clean: String = stem
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            c if (c as u32) < 0x20 => ' ',
            c => c,
        })
        .collect();
    clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    let clean = clean.trim_matches(|c: char| c == '.' || c == ' ').to_string();
    let stem = if clean.is_empty() {
        format!("YouTube {id}")
    } else {
        clean.chars().take(80).collect::<String>()
    };

    let mut cmd = std::process::Command::new(&exe);
    cmd.args([
        "-f",
        "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio",
        "--no-warnings",
        "--no-playlist",
        "--no-progress",
        "--no-mtime",
        "-P",
        &dir.to_string_lossy(),
        "-o",
        &format!("{stem}.%(ext)s"),
        &format!("https://www.youtube.com/watch?v={id}"),
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let out = cmd.output().map_err(|e| format!("spawn failed: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: String = err.chars().rev().take(240).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(format!("download failed: {}", tail.trim()));
    }

    // yt-dlp chose the extension; find the file we just wrote.
    let mut found: Option<String> = None;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with(&stem) && name.len() > stem.len() {
                found = Some(name);
            }
        }
    }
    found.ok_or_else(|| "download finished but no file appeared".to_string())
}
