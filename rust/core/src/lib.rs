//! MEASURED core — everything the player needs that is not UI.
//!
//! Scanning, tag reading, decoding, WAV export, spectral fingerprints and cover
//! thumbnails all live here so the desktop shell (Tauri) and the Android shell
//! (JNI) share one implementation instead of shipping ffmpeg or trusting the
//! phone's MediaExtractor.

pub mod decode;
pub mod fp;
pub mod scan;
pub mod thumb;

pub use decode::{decode_to_wav, duration_ms, Pcm};
pub use fp::{fingerprint, Fingerprint};
pub use scan::{parse_name, scan_dir, Library, Track};
pub use thumb::{avg_color, make_thumb};

/// Formats the browser engine plays unaided — the page hands these straight to
/// the audio element. MUST stay identical to NATIVE_EXT in lib/parse-name.js,
/// otherwise one side thinks a file is native and the other converts it.
pub const NATIVE_EXT: &[&str] = &[
    "mp3", "m4a", "mp4", "m4b", "aac", "flac", "ogg", "oga", "opus", "wav", "wave", "weba", "webm",
];

/// Decodable by symphonia but not by the browser: decoded to WAV on demand by
/// `prepare()`. AIFF/CAF/ALAC live here — symphonia reads them, WebView2 does not.
pub const CONVERT_EXT: &[&str] = &[
    "mp2", "mp1", "mpa", "vorbis", "aif", "aiff", "aifc", "caf", "alac", "mka", "mkv", "spx", "au",
    "snd",
];

/// Accepted for import: everything we can either play or convert, plus the
/// containers we can only tag-read (wma, ape, wv…) which get a clear message.
pub const ACCEPTED_EXT: &[&str] = &[
    "mp3", "mp2", "mp1", "mpa", "flac", "ogg", "oga", "opus", "vorbis", "wav", "wave", "aif",
    "aiff", "aifc", "caf", "m4a", "m4b", "mp4", "aac", "alac", "webm", "weba", "mka", "mkv", "wma",
    "ape", "wv", "tta", "amr", "ac3", "dts", "mlp", "dsf", "dff", "spx", "au", "snd",
];

pub fn is_convertible(name: &str) -> bool {
    match scan::ext_of(name) {
        Some(e) => CONVERT_EXT.contains(&e.as_str()),
        None => false,
    }
}

pub fn is_native(name: &str) -> bool {
    match scan::ext_of(name) {
        Some(e) => NATIVE_EXT.contains(&e.as_str()),
        None => false,
    }
}

pub fn is_accepted(name: &str) -> bool {
    match scan::ext_of(name) {
        Some(e) => ACCEPTED_EXT.contains(&e.as_str()),
        None => false,
    }
}
