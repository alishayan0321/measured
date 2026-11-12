//! MEASURED desktop shell (Tauri v2).
//!
//! The UI is the same `player/index.html` used by the browser and the Electron
//! build; only the plumbing changed. There is no local HTTP server: the page
//! asks this process for a library, and every audio file is handed to the
//! WebView through Tauri's asset protocol (`convertFileSrc`), which already
//! implements HTTP Range requests, so seeking works without a socket.
//!
//! Everything that used to be a Node module or an ffmpeg subprocess lives in
//! `measured-core`: scanning, name parsing, decoding (symphonia), cover crops
//! (image) and the spectral fingerprint (rustfft).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Theme};

use measured_core as core;

mod media;
mod net;
mod proxy;

#[derive(Debug, Clone, Serialize)]
struct TrackOut {
    file: String,
    src: String,
    path: String,
    artist: Option<String>,
    title: String,
    ext: String,
    bytes: u64,
    mtime_ms: u64,
    duration_ms: u64,
    video_id: Option<String>,
    cover: Option<String>,
    added: bool,
}

#[derive(Debug, Clone, Serialize)]
struct Stats {
    files: u64,
    bytes: u64,
    added_files: u64,
    added_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
struct Lib {
    count: usize,
    bytes: u64,
    tracks: Vec<TrackOut>,
    stats: Stats,
}

// ---------------------------------------------------------------- paths

fn bundled_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("MEASURED_SONGS") {
        let p = PathBuf::from(custom);
        if p.is_dir() {
            return Some(clean(p));
        }
    }
    // portable install: the folder that holds MEASURED.exe
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("songs");
            if p.is_dir() {
                return Some(clean(p));
            }
        }
    }
    // packaged: <resources>/songs ; dev: repo-root songs/ if present
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("songs");
        if p.is_dir() {
            return Some(clean(p));
        }
    }
    dev_root()
        .map(|r| r.join("songs"))
        .filter(|p| p.is_dir())
        .map(clean)
}
/// Absolute, ..-free path: Tauri's asset protocol rejects paths that walk up.
fn clean(p: PathBuf) -> PathBuf {
    std::fs::canonicalize(&p).unwrap_or(p)
}

/// Development root, resolved at RUNTIME so no build-machine path is compiled in.
/// Honours MEASURED_DEV_ROOT, else walks up from the executable looking for songs/ or thumbs/.
fn dev_root() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("MEASURED_DEV_ROOT") {
        let p = PathBuf::from(v);
        if p.is_dir() {
            return Some(clean(p));
        }
    }
    let mut dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for _ in 0..6 {
        if dir.join("songs").is_dir() || dir.join("thumbs").is_dir() {
            return Some(clean(dir));
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

fn added_dir(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let p = base.join("songs");
    std::fs::create_dir_all(&p).ok();
    clean(p)
}

fn transcode_dir(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let p = base.join("transcode");
    std::fs::create_dir_all(&p).ok();
    clean(p)
}

fn thumbs_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("player").join("thumbs");
        if p.is_dir() {
            return Some(clean(p));
        }
    }
    dev_root()
        .map(|r| r.join("thumbs"))
        .filter(|p| p.is_dir())
        .map(clean)
}

fn settings_path(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    std::fs::create_dir_all(&base).ok();
    base.join("settings.json")
}

/// Where the duration cache lives. It sits in the cache dir next to the
/// transcodes because both are derived data: deleting either only costs time.
fn duration_cache_path(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    std::fs::create_dir_all(&base).ok();
    base.join("durations.json")
}

/// Reduce a page-supplied file name to a single path component.
///
/// `prepare` and `remove_added` join this onto a library directory, so an
/// absolute path or a `..` segment would let the page read or delete anything
/// the process can reach. `file_name` drops every directory part; requiring the
/// result to equal the input rejects `..`, `a/b`, `./a` and absolute paths
/// outright instead of silently rewriting them into a different file.
fn safe_name(file: &str) -> Option<String> {
    let name = Path::new(file).file_name()?.to_string_lossy().to_string();
    if name == file {
        Some(name)
    } else {
        None
    }
}

// ---------------------------------------------------------------- commands

fn collect(
    dir: &Path,
    key: &str,
    thumbs: Option<&Path>,
    added: bool,
    cache: &mut core::DurationCache,
) -> Vec<TrackOut> {
    let lib = core::scan_dir_cached(dir, thumbs, cache);
    lib.tracks
        .into_iter()
        .map(|t| TrackOut {
            path: dir.join(&t.file).to_string_lossy().to_string(),
            cover: t.cover.as_ref().and_then(|rel| {
                thumbs.and_then(|d| {
                    Path::new(rel)
                        .file_name()
                        .map(|f| d.join(f).to_string_lossy().to_string())
                })
            }),
            file: t.file,
            src: key.to_string(),
            artist: t.artist,
            title: t.title,
            ext: t.ext,
            bytes: t.bytes,
            mtime_ms: t.mtime_ms,
            duration_ms: t.duration_ms,
            video_id: t.video_id,
            added,
        })
        .collect()
}

/// Runs off the main thread: a cold scan decodes every file whose container
/// does not declare a length, which used to freeze the window for minutes.
#[tauri::command(async)]
fn library(app: AppHandle) -> Result<Lib, String> {
    let thumbs = thumbs_dir(&app);
    let mut tracks: Vec<TrackOut> = Vec::new();

    // One cache for both folders, saved once at the end. A reload of an
    // unchanged library must not decode anything at all.
    let cache_path = duration_cache_path(&app);
    let mut cache = core::DurationCache::load(&cache_path);

    if let Some(dir) = bundled_dir(&app) {
        tracks.extend(collect(&dir, "lib", thumbs.as_deref(), false, &mut cache));
    }
    let added = added_dir(&app);
    tracks.extend(collect(&added, "add", thumbs.as_deref(), true, &mut cache));
    cache.save(&cache_path).ok();

    tracks.sort_by(|a, b| {
        let ka = a.artist.clone().unwrap_or_default().to_lowercase();
        let kb = b.artist.clone().unwrap_or_default().to_lowercase();
        ka.cmp(&kb)
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });

    let bytes: u64 = tracks.iter().map(|t| t.bytes).sum();
    let count = tracks.len();
    let added_files = tracks.iter().filter(|t| t.added).count() as u64;
    let added_bytes: u64 = tracks.iter().filter(|t| t.added).map(|t| t.bytes).sum();

    Ok(Lib {
        count,
        bytes,
        tracks,
        stats: Stats {
            files: count as u64,
            bytes,
            added_files,
            added_bytes,
        },
    })
}

#[tauri::command]
fn is_native(file: String) -> bool {
    core::is_native(&file)
}

/// Decode anything symphonia understands into a 16-bit WAV in the cache dir and
/// return its absolute path. Returns `None` when the format is native and needs
/// no conversion.
///
/// Runs off the main thread: a long mix takes minutes to decode.
#[tauri::command(async)]
fn prepare(app: AppHandle, src: String, file: String) -> Result<Option<String>, String> {
    if core::is_native(&file) {
        return Ok(None);
    }
    let name = safe_name(&file).ok_or_else(|| format!("invalid file name: {file}"))?;
    let dir = if src == "add" {
        added_dir(&app)
    } else {
        bundled_dir(&app).ok_or_else(|| "bundled library missing".to_string())?
    };
    let input = dir.join(&name);
    let meta = std::fs::metadata(&input).map_err(|_| format!("not found: {}", input.display()))?;
    if !meta.is_file() {
        return Err(format!("not found: {}", input.display()));
    }

    // The key covers mtime and size as well as the name: replacing a track with
    // a different file of the same name must not keep serving the old WAV.
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let out_name = format!(
        "{}.wav",
        core::scan::transcode_key(&name, mtime_ms, meta.len())
    );
    let out = transcode_dir(&app).join(out_name);
    if !out.is_file() {
        core::decode_to_wav(&input, &out).map_err(|e| e.to_string())?;
        // 16-bit WAV is roughly 10 MB per minute, so an unbounded cache fills
        // the disk. Keep the newest files under a cap and drop the rest.
        trim_cache(&transcode_dir(&app), 2 * 1024 * 1024 * 1024);
    }
    Ok(Some(out.to_string_lossy().to_string()))
}

/// Evict the oldest transcodes until the cache is back under `cap_bytes`.
fn trim_cache(dir: &Path, cap_bytes: u64) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let p = e.path();
            let m = e.metadata().ok()?;
            if !m.is_file() {
                return None;
            }
            Some((m.modified().ok()?, m.len(), p))
        })
        .collect();
    let total: u64 = files.iter().map(|(_, n, _)| *n).sum();
    if total <= cap_bytes {
        return;
    }
    files.sort_by_key(|(t, _, _)| *t); // oldest first
    let mut over = total - cap_bytes;
    for (_, n, p) in files {
        if over == 0 {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            over = over.saturating_sub(n);
        }
    }
}

/// Runs off the main thread: the FFT analysis takes seconds on a long track.
#[tauri::command(async)]
fn fingerprint(path: String) -> Result<core::Fingerprint, String> {
    core::fingerprint(Path::new(&path)).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct Storage {
    added_count: u64,
    added_bytes: u64,
    free_bytes: u64,
    total_bytes: u64,
}

#[tauri::command]
fn storage(app: AppHandle) -> Storage {
    let dir = added_dir(&app);
    let mut count = 0u64;
    let mut bytes = 0u64;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            if let Ok(m) = e.metadata() {
                if m.is_file() {
                    count += 1;
                    bytes += m.len();
                }
            }
        }
    }
    let (free, total) = free_space(&dir);
    Storage {
        added_count: count,
        added_bytes: bytes,
        free_bytes: free,
        total_bytes: total,
    }
}

fn free_space(_p: &Path) -> (u64, u64) {
    // std has no statvfs; the page also reads this from the settings sheet, and
    // a failed read simply hides the bar, so return a zeroed pair rather than
    // pulling a platform crate for one number.
    (0, 0)
}

#[tauri::command]
fn pick_songs(app: AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = app
        .dialog()
        .file()
        .add_filter(
            "Audio",
            &[
                "mp3", "webm", "flac", "m4a", "ogg", "opus", "wav", "aac", "aiff", "aif", "wma",
                "ape", "alac", "caf", "mka", "wv", "tta", "caf",
            ],
        )
        .blocking_pick_files();

    let Some(paths) = picked else {
        return Ok(Vec::new());
    };

    let dest = added_dir(&app);
    let mut names = Vec::new();
    for fp in paths {
        let Some(src) = fp.into_path().ok() else {
            continue;
        };
        let Some(name) = src.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        let target = unique_path(&dest, &name);
        if std::fs::copy(&src, &target).is_ok() {
            if let Some(n) = target.file_name() {
                names.push(n.to_string_lossy().to_string());
            }
        }
    }
    Ok(names)
}

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let mut target = dir.join(name);
    if !target.exists() {
        return target;
    }
    let p = Path::new(name);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "track".into());
    let ext = p.extension().map(|e| e.to_string_lossy().to_string());
    for i in 2..9999 {
        let candidate = match &ext {
            Some(e) => format!("{stem} ({i}).{e}"),
            None => format!("{stem} ({i})"),
        };
        target = dir.join(candidate);
        if !target.exists() {
            return target;
        }
    }
    target
}

#[tauri::command]
fn remove_added(app: AppHandle, file: String) -> bool {
    // The page supplies this name, so it must not be able to reach outside the
    // added-songs folder with `..` or an absolute path.
    let Some(name) = safe_name(&file) else {
        return false;
    };
    std::fs::remove_file(added_dir(&app).join(name)).is_ok()
}

#[tauri::command]
fn clear_added(app: AppHandle) -> u64 {
    let dir = added_dir(&app);
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            if std::fs::remove_file(e.path()).is_ok() {
                n += 1;
            }
        }
    }
    n
}

// ---------------------------------------------------------------- settings

type Store = Mutex<HashMap<String, serde_json::Value>>;
static STORE: OnceLock<Store> = OnceLock::new();

fn store() -> &'static Store {
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn load_settings(app: &AppHandle) {
    if let Ok(text) = std::fs::read_to_string(settings_path(app)) {
        if let Ok(map) = serde_json::from_str::<HashMap<String, serde_json::Value>>(&text) {
            if let Ok(mut s) = store().lock() {
                *s = map;
            }
        }
    }
}

fn save_settings(app: &AppHandle) {
    if let Ok(s) = store().lock() {
        if let Ok(text) = serde_json::to_string_pretty(&*s) {
            std::fs::write(settings_path(app), text).ok();
        }
    }
}

#[tauri::command]
fn get(key: String, fallback: Option<serde_json::Value>) -> serde_json::Value {
    let s = store().lock().ok();
    s.as_ref()
        .and_then(|m| m.get(&key).cloned())
        .or(fallback)
        .unwrap_or(serde_json::Value::Null)
}

#[tauri::command]
fn set(app: AppHandle, key: String, value: serde_json::Value) {
    if let Ok(mut s) = store().lock() {
        s.insert(key, value);
    }
    save_settings(&app);
}

#[tauri::command]
fn set_theme(app: AppHandle, mode: String) {
    let theme = if mode == "dark" {
        Theme::Dark
    } else {
        Theme::Light
    };
    if let Some(w) = app.get_webview_window("main") {
        w.set_theme(Some(theme)).ok();
    }
}

#[tauri::command]
fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[tauri::command]
fn platform() -> &'static str {
    "desktop"
}

/// Online shelf: fetch a licensed preview query from the Rust side so the WebView
/// never needs CORS headers or a relaxed CSP. Only the iTunes search endpoint is
/// ever contacted, and the page builds the URL.
#[tauri::command]
async fn shelf_search(url: String) -> Result<String, String> {
    if !url.starts_with("https://itunes.apple.com/search?") {
        return Err("blocked: not a shelf query".into());
    }
    let res = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("search failed: {}", res.status()));
    }
    res.text().await.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- boot

#[derive(Deserialize)]
struct PriorSettings {
    #[serde(default)]
    theme: Option<String>,
}

static PROXY_BASE: OnceLock<String> = OnceLock::new();

/// Base URL of the loopback audio proxy (empty string if it could not start).
#[tauri::command]
fn proxy_base() -> String {
    PROXY_BASE.get().cloned().unwrap_or_default()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            PROXY_BASE.get_or_init(|| {
                let mut roots: Vec<PathBuf> = Vec::new();
                if let Some(d) = bundled_dir(&handle) {
                    roots.push(d);
                }
                roots.push(added_dir(&handle));
                if let Some(d) = thumbs_dir(&handle) {
                    roots.push(d);
                }
                roots.push(transcode_dir(&handle));
                proxy::start(roots)
            });
            load_settings(&handle);
            let prior: PriorSettings = serde_json::from_value(get("theme".into(), None))
                .unwrap_or(PriorSettings { theme: None });
            let dark = prior.theme.as_deref() == Some("dark");
            if let Some(w) = app.get_webview_window("main") {
                w.set_theme(Some(if dark { Theme::Dark } else { Theme::Light }))
                    .ok();
            }
            // Bind the OS media controls to the main window. Must run after the
            // window exists (SMTC needs its HWND) and before the UI can play.
            media::init(&handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library,
            is_native,
            prepare,
            fingerprint,
            storage,
            pick_songs,
            remove_added,
            clear_added,
            shelf_search,
            get,
            set,
            set_theme,
            version,
            platform,
            proxy_base,
            media::smtc_update,
            media::smtc_clear,
            net::yt_search,
            net::yt_resolve,
            net::yt_audio,
            net::yt_download
        ])
        .run(tauri::generate_context!())
        .expect("failed to start MEASURED");
}

#[cfg(test)]
mod tests {
    use super::safe_name;
    use std::path::Path;

    // `prepare` and `remove_added` join this onto a library directory. Every
    // rejected case here would otherwise escape that directory.
    #[test]
    fn safe_name_accepts_plain_file_names() {
        assert_eq!(safe_name("song.mp3").as_deref(), Some("song.mp3"));
        assert_eq!(
            safe_name("Artist - Title.webm").as_deref(),
            Some("Artist - Title.webm")
        );
    }

    #[test]
    fn safe_name_rejects_traversal_and_paths() {
        for bad in [
            "..",
            ".",
            "../evil.mp3",
            "..\\evil.mp3",
            "a/b.mp3",
            "a\\b.mp3",
            "/etc/passwd",
            "C:\\Windows\\system32\\evil.mp3",
            "./song.mp3",
            "",
        ] {
            assert_eq!(safe_name(bad), None, "must reject {bad:?}");
        }
    }

    #[test]
    fn safe_name_result_never_leaves_the_directory() {
        let dir = Path::new(r"C:\music\added");
        let name = safe_name("track 01.mp3").expect("plain name");
        assert_eq!(dir.join(&name).parent(), Some(dir));
    }
}
