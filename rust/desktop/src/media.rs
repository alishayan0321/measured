//! OS media controls: Windows SMTC, macOS Now Playing, Linux MPRIS.
//!
//! The frontend owns playback; this module only mirrors it outward and forwards
//! the OS's own transport buttons back as Tauri events. The `MediaControls`
//! handle must outlive the app — dropping it removes the player from the
//! Windows volume flyout and the lock screen — so it lives in managed state
//! rather than a local.

use std::sync::Mutex;
use std::time::Duration;

use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
};
use tauri::{AppHandle, Emitter, Manager, State};

/// Live controls handle, or `None` when the platform refused to create one
/// (headless CI, no audio session, unsupported backend). Every command then
/// degrades to a no-op instead of failing the UI.
pub struct MediaState(pub Mutex<Option<MediaControls>>);

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// `file://` URL or http(s) URL. souvlaki loads `file://` itself on Windows.
    pub cover: Option<String>,
    pub duration_ms: Option<u64>,
    pub playing: bool,
    pub position_ms: Option<u64>,
}

fn progress(ms: Option<u64>) -> Option<MediaPosition> {
    ms.map(|ms| MediaPosition(Duration::from_millis(ms)))
}

#[cfg(target_os = "windows")]
fn platform_config(app: &AppHandle) -> PlatformConfig<'static> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    // SMTC has to be bound to a real HWND; without one Windows refuses to show
    // the player at all, so a missing handle is reported as `None` and `new`
    // fails cleanly rather than panicking.
    // The handle borrows the window, so the raw pointer has to be extracted
    // inside the closure; returning the handle itself would not outlive `w`.
    let hwnd = app.get_webview_window("main").and_then(|w| {
        let handle = w.window_handle().ok()?;
        match handle.as_raw() {
            RawWindowHandle::Win32(h) => Some(h.hwnd.get() as *mut std::ffi::c_void),
            _ => None,
        }
    });
    PlatformConfig {
        dbus_name: "measured",
        display_name: "MEASURED",
        hwnd,
    }
}

#[cfg(not(target_os = "windows"))]
fn platform_config(_app: &AppHandle) -> PlatformConfig<'static> {
    PlatformConfig {
        dbus_name: "measured",
        display_name: "MEASURED",
        hwnd: None,
    }
}

/// Build the controls and attach the OS event pump. Called once from `setup`.
pub fn init(app: &AppHandle) {
    let mut controls = match MediaControls::new(platform_config(app)) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[media] OS media controls unavailable: {e}");
            app.manage(MediaState(Mutex::new(None)));
            return;
        }
    };

    let handle = app.clone();
    let attached = controls.attach(move |event: MediaControlEvent| match event {
        MediaControlEvent::Play => {
            let _ = handle.emit("smtc-event", "play");
        }
        MediaControlEvent::Pause => {
            let _ = handle.emit("smtc-event", "pause");
        }
        MediaControlEvent::Toggle => {
            let _ = handle.emit("smtc-event", "toggle");
        }
        MediaControlEvent::Next => {
            let _ = handle.emit("smtc-event", "next");
        }
        MediaControlEvent::Previous => {
            let _ = handle.emit("smtc-event", "prev");
        }
        MediaControlEvent::Stop => {
            let _ = handle.emit("smtc-event", "stop");
        }
        MediaControlEvent::SetPosition(p) => {
            let _ = handle.emit("smtc-seek", p.0.as_millis() as u64);
        }
        MediaControlEvent::Raise => {
            if let Some(w) = handle.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }
        // Seek/volume/shuffle/open-uri are not wired to the player yet; the
        // enum is non_exhaustive so the wildcard is required regardless.
        _ => {}
    });

    if let Err(e) = attached {
        eprintln!("[media] could not attach OS media handler: {e}");
    }

    app.manage(MediaState(Mutex::new(Some(controls))));
}

/// Mirror the current track and transport state into the OS.
#[tauri::command]
pub fn smtc_update(state: State<'_, MediaState>, now: NowPlaying) {
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let Some(controls) = guard.as_mut() else { return };

    let _ = controls.set_metadata(MediaMetadata {
        title: now.title.as_deref(),
        artist: now.artist.as_deref(),
        album: now.album.as_deref(),
        cover_url: now.cover.as_deref(),
        duration: now.duration_ms.map(Duration::from_millis),
    });

    let progress = progress(now.position_ms);
    let _ = controls.set_playback(if now.playing {
        MediaPlayback::Playing { progress }
    } else {
        MediaPlayback::Paused { progress }
    });
}

/// Drop the player out of the OS flyout (nothing loaded, or app closing).
#[tauri::command]
pub fn smtc_clear(state: State<'_, MediaState>) {
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(controls) = guard.as_mut() {
        let _ = controls.set_playback(MediaPlayback::Stopped);
        let _ = controls.set_metadata(MediaMetadata::default());
    }
}
