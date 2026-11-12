//! Directory scanning + the filename parser ported from `lib/parse-name.js`.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::{decode, is_accepted};

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
    let mut normalized = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\u{2018}' | '\u{2019}' => normalized.push('\''),
            '\u{201c}' | '\u{201d}' => normalized.push('"'),
            '\u{3001}' | '\u{ff5c}' => {
                normalized.push(' ');
                normalized.push('|');
                normalized.push(' ');
            }
            _ => normalized.push(ch),
        }
    }
    normalized
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|c: char| {
            c.is_whitespace()
                || c == '-'
                || c == '\u{2013}'
                || c == '\u{2014}'
                || c == '|'
                || c == ','
                || c == ';'
                || c == ':'
        })
        .to_string()
}

/// Tokens the uploader bolts onto a name. Matched as WHOLE WORDS only â€” a
/// substring test would eat "Clean Bandit", and sweeping tokens out of the
/// middle of a title would turn "Video Games" into "Games". Nothing here is
/// ever removed from the middle of a name. Version tags (remastered, explicit,
/// clean) are absent on purpose: they tell two masters of the same song apart.
const PROMO: &[&str] = &[
    "official",
    "video",
    "audio",
    "lyric",
    "lyrics",
    "lyrical",
    "music",
    "hd",
    "hq",
    "4k",
    "8k",
    "uhd",
    "mv",
    "m/v",
    "visualizer",
    "visualiser",
    "premiere",
    "teaser",
    "trailer",
    "promo",
    "song",
    "full",
    "original",
    "new",
    "latest",
    "subscribe",
    "out",
    "now",
    "prod",
    "prod.",
];

/// Words that carry no meaning on their own but do not make a field "promo".
const FILLER: &[&str] = &[
    "a", "an", "the", "by", "of", "in", "on", "with", "and", "ft", "ft.", "feat", "feat.",
];

fn bare(word: &str) -> String {
    word.to_lowercase()
        .trim_matches(|c: char| !(c.is_ascii_alphanumeric() || c == '/'))
        .to_string()
}

/// A bare year is a date stamp, not a name: "Official Video 2020" is promo,
/// but "Live 2020" is not, because "live" is not a promo token.
fn is_year(t: &str) -> bool {
    t.len() == 4
        && (t.starts_with("19") || t.starts_with("20"))
        && t.bytes().all(|b| b.is_ascii_digit())
}

/// True only when the field says nothing but promo noise. A field that merely
/// STARTS with a promo word ("Clean Bandit", "New Order") is a real name, and
/// so is a field made only of filler ("A").
fn looks_promo(s: &str) -> bool {
    let w: Vec<&str> = s.split_whitespace().collect();
    if w.is_empty() {
        return true;
    }
    if w.len() > 9 {
        return true; // long tail is a description, not a name
    }
    let mut promo = false;
    for word in w {
        let t = bare(word);
        if PROMO.contains(&t.as_str()) {
            promo = true;
            continue;
        }
        if FILLER.contains(&t.as_str()) {
            continue;
        }
        if is_year(&t) {
            continue;
        }
        return false;
    }
    promo
}

fn trim_promo_tail(s: &str) -> String {
    let mut w: Vec<&str> = s.split_whitespace().collect();
    while w.len() > 1 {
        let t = bare(w[w.len() - 1]);
        if !PROMO.contains(&t.as_str()) {
            break;
        }
        w.pop();
    }
    w.join(" ")
}

/// (Official Video), [Lyrics], ï¼ˆHDï¼‰ â€” removed only when the whole bracket is promo.
fn drop_promo_brackets(base: &str) -> String {
    let chars: Vec<char> = base.chars().collect();
    let mut out = String::with_capacity(base.len());
    let mut i = 0;
    while i < chars.len() {
        let open = chars[i];
        if open != '(' && open != '\u{ff08}' && open != '[' {
            out.push(open);
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < chars.len() && chars[j] != ')' && chars[j] != '\u{ff09}' && chars[j] != ']' {
            j += 1;
        }
        if j >= chars.len() {
            out.push(open);
            i += 1;
            continue;
        }
        let inner: String = chars[i + 1..j].iter().collect();
        if looks_promo(&inner) {
            out.push(' ');
        } else {
            out.extend(chars[i..=j].iter());
        }
        i = j + 1;
    }
    out
}

fn strip_copy_marker(s: &str) -> Option<String> {
    let t = s.trim_end();
    if !t.ends_with(')') {
        return None;
    }
    let open = t.rfind('(')?;
    let inner: Vec<char> = t[open + 1..t.len() - 1].chars().collect();
    if inner.is_empty() || !inner.iter().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(t[..open].trim_end().to_string())
}

fn strip_video_id(s: &str) -> Option<(String, String)> {
    let t = s.trim_end();
    if !t.ends_with(']') {
        return None;
    }
    let open = t.rfind('[')?;
    let inner: Vec<char> = t[open + 1..t.len() - 1].chars().collect();
    if inner.len() != 11 {
        return None;
    }
    if !inner
        .iter()
        .all(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
    {
        return None;
    }
    Some((
        t[..open].trim_end().to_string(),
        inner.into_iter().collect(),
    ))
}

fn split_dash(base: &str) -> Vec<String> {
    let chars: Vec<char> = base.chars().collect();
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            let mut j = i;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j + 1 < chars.len()
                && matches!(chars[j], '-' | '\u{2013}' | '\u{2014}')
                && chars[j + 1].is_whitespace()
            {
                parts.push(cur.clone());
                cur.clear();
                let mut k = j + 1;
                while k < chars.len() && chars[k].is_whitespace() {
                    k += 1;
                }
                i = k;
                continue;
            }
        }
        cur.push(chars[i]);
        i += 1;
    }
    parts.push(cur);
    parts
}

fn split_ft(base: &str) -> Option<(String, String)> {
    let chars: Vec<char> = base.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            let mut j = i;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            let mut k = j;
            while k < chars.len() && !chars[k].is_whitespace() {
                k += 1;
            }
            let tok: String = chars[j..k].iter().collect();
            let low = tok.to_lowercase();
            if low == "ft" || low == "ft." || low == "feat" || low == "feat." {
                let mut r = k;
                while r < chars.len() && chars[r].is_whitespace() {
                    r += 1;
                }
                if r < chars.len() {
                    return Some((chars[..i].iter().collect(), chars[r..].iter().collect()));
                }
            }
            i = k;
            continue;
        }
        i += 1;
    }
    None
}

/// Parse "Artist - Title [videoId](1).webm" into its parts.
///
/// This is one half of a two-language contract: `lib/parse-name.js` implements
/// the same spec, and `test/parse-vectors.json` is the fixture both sides run.
/// Changing one without the others leaves the desktop, web and Android builds
/// naming the same file differently.
pub fn parse_name(file: &str) -> (Option<String>, String, Option<String>) {
    let leaf = file.rsplit(['/', '\\']).next().unwrap_or(file);
    let mut base = leaf.to_string();
    if let Some(dot) = base.rfind('.') {
        if dot > 0 {
            base.truncate(dot);
        }
    }

    // Copy markers and the id can come in either order â€” "Song [id] (2)" and
    // "Song (2) [id]" are both common â€” so peel them in a loop.
    let mut video_id: Option<String> = None;
    for _ in 0..3 {
        if let Some(next) = strip_copy_marker(&base) {
            base = next;
            continue;
        }
        if video_id.is_none() {
            if let Some((rest, id)) = strip_video_id(&base) {
                base = rest;
                video_id = Some(id);
                continue;
            }
        }
        break;
    }
    base = drop_promo_brackets(&base);

    let mut artist = String::from("Unknown");
    let title: String;

    let fields: Vec<String> = base
        .split(['|', '\u{ff5c}'])
        .map(tidy)
        .filter(|f| !f.is_empty())
        .collect();

    if fields.len() >= 2 {
        // scraped shape: title | artist | extra
        title = fields[0].clone();
        for f in &fields[1..] {
            if !looks_promo(f) {
                artist = f.clone();
                break;
            }
        }
    } else {
        let parts = split_dash(&base);
        if parts.len() >= 2 {
            let head = tidy(&parts[0]);
            if head.is_empty() || looks_promo(&head) {
                artist = String::from("Unknown");
                title = tidy(&base);
            } else {
                artist = head;
                title = tidy(&parts[1..].join(" - "));
            }
        } else {
            title = tidy(&base);
            if let Some((before, after)) = split_ft(&base) {
                let head = tidy(&before);
                if !head.is_empty() && head.split_whitespace().count() <= 4 {
                    artist = tidy(&after);
                }
            }
        }
    }

    let fallback = {
        let t = tidy(&base);
        if t.is_empty() {
            base.clone()
        } else {
            t
        }
    };
    let title = {
        let t = trim_promo_tail(&tidy(&title));
        if t.is_empty() {
            fallback.clone()
        } else {
            t
        }
    };
    let artist = {
        let t = tidy(&artist);
        if t.is_empty() {
            String::from("Unknown")
        } else {
            t
        }
    };
    let title = if title.to_lowercase() == artist.to_lowercase() {
        fallback
    } else {
        title
    };
    (Some(artist), title, video_id)
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

/// Cache key for a transcoded copy of `file`.
///
/// The file name alone is not enough: replacing a track with a different one of
/// the same name left the old WAV in the cache and the player kept serving stale
/// audio. mtime and size change with the content, so a replaced file gets a new
/// key and is transcoded again, while an untouched file keeps hitting the cache.
pub fn transcode_key(file: &str, mtime_ms: u64, bytes: u64) -> String {
    let digest = md5::compute(format!("{file}\u{0}{mtime_ms}\u{0}{bytes}"));
    format!("{:x}", digest)[..16].to_string()
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DurationEntry {
    mtime_ms: u64,
    bytes: u64,
    duration_ms: u64,
}

/// Persistent duration cache, keyed by absolute path.
///
/// `decode::duration_ms` only reads a header when the container declares a frame
/// count. Every webm we download from YouTube declares none, so it falls back to
/// decoding the whole file â€” and `scan_dir` called it for every file on every
/// boot, which is why a large library took minutes to appear. Entries are
/// validated against mtime and size, so an unchanged file is never re-decoded
/// and a replaced one is.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct DurationCache {
    #[serde(default)]
    entries: HashMap<String, DurationEntry>,
    /// Paths seen by the scans that used this cache. `save` prunes everything
    /// else so the file does not grow forever as tracks are renamed or deleted.
    #[serde(skip)]
    seen: HashSet<String>,
    /// Number of `duration_ms` calls made while this cache was in memory. Only
    /// tests read it; it is the proof that a reload did no decoding.
    #[serde(skip)]
    decodes: usize,
}

impl DurationCache {
    /// A missing or corrupt cache is not an error â€” it only costs a re-measure.
    pub fn load(path: &Path) -> Self {
        fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice::<DurationCache>(&b).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let mut out = DurationCache {
            entries: self.entries.clone(),
            seen: HashSet::new(),
            decodes: 0,
        };
        // Pruning is skipped when nothing was scanned: an empty scan usually
        // means the library folder was unavailable (unplugged drive, moved
        // songs dir) rather than emptied, and wiping the cache there would force
        // a full re-decode on the next boot.
        if !self.seen.is_empty() {
            out.entries.retain(|k, _| self.seen.contains(k));
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).ok();
        }
        let tmp = path.with_extension("part");
        let json = serde_json::to_vec(&out).context("serialize duration cache")?;
        fs::write(&tmp, json).with_context(|| format!("write {}", tmp.display()))?;
        fs::rename(&tmp, path).with_context(|| format!("rename into {}", path.display()))?;
        Ok(())
    }

    /// Number of real duration measurements performed so far.
    pub fn decodes(&self) -> usize {
        self.decodes
    }

    fn get(&self, path: &str, mtime_ms: u64, bytes: u64) -> Option<u64> {
        let e = self.entries.get(path)?;
        // mtime and size together catch both an edited file and a same-size
        // replacement written inside the filesystem's timestamp granularity.
        if e.mtime_ms == mtime_ms && e.bytes == bytes {
            Some(e.duration_ms)
        } else {
            None
        }
    }

    fn put(&mut self, path: &str, mtime_ms: u64, bytes: u64, duration_ms: u64) {
        self.entries.insert(
            path.to_string(),
            DurationEntry {
                mtime_ms,
                bytes,
                duration_ms,
            },
        );
    }
}

/// Walk a directory and return playable tracks sorted by artist then title.
///
/// `cache` is consulted before `duration_ms` is called, so a reload of an
/// unchanged library does no decoding at all.
pub fn scan_dir_cached(
    dir: &Path,
    thumbs_dir: Option<&Path>,
    cache: &mut DurationCache,
) -> Library {
    let mut tracks: Vec<Track> = Vec::new();
    let mut bytes_total = 0u64;

    for entry in WalkDir::new(dir)
        .max_depth(2)
        .into_iter()
        .filter_map(|e| e.ok())
    {
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

        let abs = entry.path().to_string_lossy().to_string();
        cache.seen.insert(abs.clone());
        let duration_ms = match cache.get(&abs, mtime_ms, meta.len()) {
            Some(d) => d,
            None => {
                cache.decodes += 1;
                match decode::duration_ms(entry.path()) {
                    // Only successes are stored: a file that was locked or half
                    // written when we looked gets another chance next scan.
                    Ok(d) => {
                        cache.put(&abs, mtime_ms, meta.len(), d);
                        d
                    }
                    Err(_) => 0,
                }
            }
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
        ka.cmp(&kb)
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });

    Library {
        count: tracks.len(),
        bytes: bytes_total,
        tracks,
    }
}

/// Walk a directory without a persistent cache. Callers that scan repeatedly
/// (the desktop library command) should use `scan_dir_cached` instead.
pub fn scan_dir(dir: &Path, thumbs_dir: Option<&Path>) -> Library {
    scan_dir_cached(dir, thumbs_dir, &mut DurationCache::default())
}

/// Convenience for callers that only have a string path.
pub fn scan_dir_str(dir: &str, thumbs: Option<&str>) -> Library {
    let d = PathBuf::from(dir);
    let t = thumbs.map(PathBuf::from);
    scan_dir(&d, t.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("measured-scan-{tag}-{}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// Minimal 16-bit PCM WAV. `duration_ms` reads the frame count straight from
    /// the header, so this exercises the cache without needing a real encoder.
    fn write_test_wav(path: &Path, rate: u32, channels: u16, frames: u32) {
        let data_len = frames * channels as u32 * 2;
        let mut b: Vec<u8> = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data_len).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes()); // PCM
        b.extend_from_slice(&channels.to_le_bytes());
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
        b.extend_from_slice(&(channels * 2).to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&data_len.to_le_bytes());
        b.resize(b.len() + data_len as usize, 0);
        fs::write(path, b).unwrap();
    }

    #[test]
    fn transcode_key_tracks_name_mtime_and_size() {
        let base = transcode_key("song.webm", 1_700_000_000_000, 4096);
        assert_eq!(base.len(), 16);
        assert_eq!(base, transcode_key("song.webm", 1_700_000_000_000, 4096));
        assert_ne!(base, transcode_key("song.webm", 1_700_000_000_001, 4096));
        assert_ne!(base, transcode_key("song.webm", 1_700_000_000_000, 4097));
        assert_ne!(base, transcode_key("other.webm", 1_700_000_000_000, 4096));
    }

    #[test]
    fn duration_cache_skips_unchanged_files() {
        let dir = temp_dir("dur");
        let wav = dir.join("Artist - Title.wav");
        write_test_wav(&wav, 44_100, 2, 44_100); // exactly one second

        let mut cache = DurationCache::default();
        let first = scan_dir_cached(&dir, None, &mut cache);
        assert_eq!(first.count, 1);
        assert_eq!(first.tracks[0].duration_ms, 1000);
        assert_eq!(cache.decodes(), 1, "first scan must measure the file");

        let second = scan_dir_cached(&dir, None, &mut cache);
        assert_eq!(second.tracks[0].duration_ms, 1000);
        assert_eq!(cache.decodes(), 1, "unchanged file must not be re-decoded");

        // A replaced file has a new size, so its entry must be re-measured.
        write_test_wav(&wav, 44_100, 2, 88_200);
        let third = scan_dir_cached(&dir, None, &mut cache);
        assert_eq!(third.tracks[0].duration_ms, 2000);
        assert_eq!(cache.decodes(), 2, "replaced file must be re-measured");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn duration_cache_round_trips_through_disk() {
        let dir = temp_dir("durjson");
        let file = dir.join("durations.json");

        let mut cache = DurationCache::default();
        cache.put("/music/a.webm", 7, 99, 1234);
        cache.save(&file).unwrap();

        let loaded = DurationCache::load(&file);
        assert_eq!(loaded.get("/music/a.webm", 7, 99), Some(1234));
        assert_eq!(loaded.get("/music/a.webm", 8, 99), None);
        assert_eq!(loaded.get("/music/a.webm", 7, 100), None);

        fs::remove_dir_all(&dir).ok();
    }

    /// The shared contract: every vector must parse the same way here as in
    /// lib/parse-name.js, which runs the same file from node.
    #[test]
    fn parser_matches_shared_vectors() {
        let raw = include_str!("../../../test/parse-vectors.json");
        let doc: serde_json::Value = serde_json::from_str(raw).expect("fixture json");
        let cases = doc["cases"].as_array().expect("cases array");
        assert!(cases.len() >= 25, "expected at least 25 vectors");
        for c in cases {
            let file = c["file"].as_str().expect("file");
            let want_artist = c["artist"].as_str().expect("artist");
            let want_title = c["title"].as_str().expect("title");
            let want_id = c["videoId"].as_str();
            let (artist, title, id) = parse_name(file);
            assert_eq!(artist.as_deref(), Some(want_artist), "artist for {file}");
            assert_eq!(title, want_title, "title for {file}");
            assert_eq!(id.as_deref(), want_id, "videoId for {file}");
        }
    }
}
