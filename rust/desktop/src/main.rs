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

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Theme};

use measured_core as core;

mod net;

#[derive(Debug, Clone, Serialize)]
struct TrackOut {
    file: String,
    src: String,
    path: String,
    artist: Option<String>,
    title: String,
    ext: String,
    bytes: u64,
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
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("songs");
    dev.is_dir().then(|| clean(dev))
}
/// Absolute, ..-free path: Tauri's asset protocol rejects paths that walk up.
fn clean(p: PathBuf) -> PathBuf {
    std::fs::canonicalize(&p).unwrap_or(p)
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
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("thumbs");
    dev.is_dir().then(|| clean(dev))
}

fn settings_path(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    std::fs::create_dir_all(&base).ok();
    base.join("settings.json")
}

// ---------------------------------------------------------------- commands

fn collect(dir: &Path, key: &str, thumbs: Option<&Path>, added: bool) -> Vec<TrackOut> {
    let lib = core::scan_dir(dir, thumbs);
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
            duration_ms: t.duration_ms,
            video_id: t.video_id,
            added,
        })
        .collect()
}

#[tauri::command]
fn library(app: AppHandle) -> Result<Lib, String> {
    let thumbs = thumbs_dir(&app);
    let mut tracks: Vec<TrackOut> = Vec::new();

    if let Some(dir) = bundled_dir(&app) {
        tracks.extend(collect(&dir, "lib", thumbs.as_deref(), false));
    }
    let added = added_dir(&app);
    tracks.extend(collect(&added, "add", thumbs.as_deref(), true));

    tracks.sort_by(|a, b| {
        let ka = a.artist.clone().unwrap_or_default().to_lowercase();
        let kb = b.artist.clone().unwrap_or_default().to_lowercase();
        ka.cmp(&kb).then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
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
#[tauri::command]
fn prepare(app: AppHandle, src: String, file: String) -> Result<Option<String>, String> {
    if core::is_native(&file) {
        return Ok(None);
    }
    let dir = if src == "add" {
        added_dir(&app)
    } else {
        bundled_dir(&app).ok_or_else(|| "bundled library missing".to_string())?
    };
    let input = dir.join(&file);
    if !input.is_file() {
        return Err(format!("not found: {}", input.display()));
    }

    let out_name = format!("{}.wav", core::scan::key_for(&file, None));
    let out = transcode_dir(&app).join(out_name);
    if !out.is_file() {
        core::decode_to_wav(&input, &out).map_err(|e| e.to_string())?;
    }
    Ok(Some(out.to_string_lossy().to_string()))
}

#[tauri::command]
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
    Storage { added_count: count, added_bytes: bytes, free_bytes: free, total_bytes: total }
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
        .add_filter("Audio", &["mp3", "webm", "flac", "m4a", "ogg", "opus", "wav", "aac", "aiff", "aif", "wma", "ape", "alac", "caf", "mka", "wv", "tta", "caf"])
        .blocking_pick_files();

    let Some(paths) = picked else {
        return Ok(Vec::new());
    };

    let dest = added_dir(&app);
    let mut names = Vec::new();
    for fp in paths {
        let Some(src) = fp.into_path().ok() else { continue };
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
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "track".into());
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
    let p = added_dir(&app).join(file);
    std::fs::remove_file(p).is_ok()
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
    let theme = if mode == "dark" { Theme::Dark } else { Theme::Light };
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

// ---------------------------------------------------------------- boot

#[derive(Deserialize)]
struct PriorSettings {
    #[serde(default)]
    theme: Option<String>,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            load_settings(&handle);
            let prior: PriorSettings =
                serde_json::from_value(get("theme".into(), None)).unwrap_or(PriorSettings { theme: None });
            let dark = prior.theme.as_deref() == Some("dark");
            if let Some(w) = app.get_webview_window("main") {
                w.set_theme(Some(if dark { Theme::Dark } else { Theme::Light })).ok();
            }
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
            get,
            set,
            set_theme,
            version,
            platform,
            net::yt_search,
            net::yt_audio,
        net::yt_download
        ])
        .run(tauri::generate_context!())
        .expect("failed to start MEASURED");
}
