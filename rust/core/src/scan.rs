//! Directory scanning + the filename parser ported from `lib/parse-name.js`.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::{is_accepted, decode};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub file: String,
    pub artist: Option<String>,
    pub title: String,
    pub video_id: Option<String>,
    pub ext: String,
    pub bytes: u64,
    pub mtime_ms: u64,
    pub duration_ms: u64,
    pub cover: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Library {
    pub count: usize,
    pub bytes: u64,
    pub tracks: Vec<Track>,
}

pub fn ext_of(name: &str) -> Option<String> {
    let dot = name.rfind('.')?;
    if dot + 1 >= name.len() {
        return None;
    }
    Some(name[dot + 1..].to_ascii_lowercase())
}

fn tidy(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_space = false;
    for ch in s.chars() {
        let is_ws = ch.is_whitespace();
        if is_ws {
            if !last_space && !out.is_empty() {
                out.push(' ');
            }
        } else {
            out.push(ch);
        }
        last_space = is_ws;
    }
    out.trim().trim_matches(|c: char| c == '-' || c == '_' || c == '|').trim().to_string()
}

/// Words the downloader put in front of titles. Kept as a slice so the list can
/// be extended without recompiling call sites.
const PROMO: &[&str] = &[
    "official video", "official audio", "official music video", "lyric video", "lyrics",
    "hd", "hq", "4k", "8k", "audio", "video", "music video", "visualizer", "m/v", "mv",
    "prod.", "prod by", "out now", "premiere", "explicit", "clean", "remastered",
];

fn looks_promo(s: &str) -> bool {
    let low = s.to_ascii_lowercase();
    PROMO.iter().any(|p| low.contains(p))
}

/// Parse "Artist - Title [videoId](1).webm" into its parts.
pub fn parse_name(file: &str) -> (Option<String>, String, Option<String>) {
    let stem = match file.rfind('.') {
        Some(i) => &file[..i],
        None => file,
    };

    let mut rest = stem.to_string();

    // trailing [XXXXXXXXXXX] youtube id
    let mut video_id = None;
    if let Some(close) = rest.rfind(']') {
        if close + 1 == rest.len() {
            if let Some(open) = rest.rfind('[') {
                let inner = &rest[open + 1..close];
                if inner.len() == 11 && inner.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                    video_id = Some(inner.to_string());
                    rest = rest[..open].trim_end().to_string();
                }
            }
        }
    }

    // trailing (1)/(2) copy markers
    while rest.ends_with(')') {
        if let Some(open) = rest.rfind('(') {
            let inner = &rest[open + 1..rest.len() - 1];
            if !inner.is_empty() && inner.chars().all(|c| c.is_ascii_digit()) {
                rest = rest[..open].trim_end().to_string();
                continue;
            }
        }
        break;
    }

    // split artist - title on the last " - " that leaves both sides non-empty
    let mut artist = None;
    let mut title = rest.clone();
    if let Some(idx) = rest.rfind(" - ") {
        let (a, t) = (&rest[..idx], &rest[idx + 3..]);
        if !a.trim().is_empty() && !t.trim().is_empty() {
            artist = Some(tidy(a));
            title = t.trim().to_string();
        }
    }

    // drop promo junk from the title tail
    let mut cleaned: Vec<String> = Vec::new();
    for part in title.split(|c| c == '|' || c == '·' || c == '/') {
        let p = part.trim();
        if p.is_empty() || looks_promo(p) {
            continue;
        }
        cleaned.push(p.to_string());
    }
    if !cleaned.is_empty() {
        title = cleaned.join(" ");
    }

    let title = tidy(&title);
    let title = if title.is_empty() { tidy(stem) } else { title };
    (artist, title, video_id)
}

/// Stable key used for cover art filenames: the video id when we have one,
/// otherwise the first 12 hex chars of the file name's md5.
pub fn key_for(file: &str, video_id: Option<&str>) -> String {
    match video_id {
        Some(id) => id.to_string(),
        None => {
            let digest = md5::compute(file.as_bytes());
            format!("{:x}", digest)[..12].to_string()
        }
    }
}

pub fn cover_for(file: &str, video_id: Option<&str>, thumbs_dir: Option<&Path>) -> Option<String> {
    let dir = thumbs_dir?;
    let key = key_for(file, video_id);
    let p = dir.join(format!("{key}.jpg"));
    if p.is_file() {
        Some(format!("thumbs/{key}.jpg"))
    } else {
        None
    }
}

/// Walk a directory and return playable tracks sorted by artist then title.
pub fn scan_dir(dir: &Path, thumbs_dir: Option<&Path>) -> Library {
    let mut tracks: Vec<Track> = Vec::new();
    let mut bytes_total = 0u64;

    for entry in WalkDir::new(dir).max_depth(2).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_accepted(&name) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let (artist, title, video_id) = parse_name(&name);
        let ext = ext_of(&name).unwrap_or_default();
        let duration_ms = if crate::is_native(&name) {
            decode::duration_ms(&entry.path()).unwrap_or(0)
        } else {
            decode::duration_ms(&entry.path()).unwrap_or(0)
        };

        bytes_total += meta.len();
        tracks.push(Track {
            file: name.clone(),
            cover: cover_for(&name, video_id.as_deref(), thumbs_dir),
            artist,
            title,
            video_id,
            ext,
            bytes: meta.len(),
            mtime_ms,
            duration_ms,
        });
    }

    tracks.sort_by(|a, b| {
        let ka = a.artist.clone().unwrap_or_default().to_lowercase();
        let kb = b.artist.clone().unwrap_or_default().to_lowercase();
        ka.cmp(&kb).then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });

    Library { count: tracks.len(), bytes: bytes_total, tracks }
}

/// Convenience for callers that only have a string path.
pub fn scan_dir_str(dir: &str, thumbs: Option<&str>) -> Library {
    let d = PathBuf::from(dir);
    let t = thumbs.map(PathBuf::from);
    scan_dir(&d, t.as_deref())
}
