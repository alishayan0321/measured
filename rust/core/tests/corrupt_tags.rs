//! A file whose tag block is malformed must still be listed and still play.
//!
//! The tag reader is allowed to give up on a broken tag block — the filename
//! parser is the documented fallback — but giving up must not take the rest of
//! the library with it, and it must not make the audio unplayable. The bytes
//! are generated here rather than checked in as a fixture so the corruption is
//! visible in the test that depends on it.

use std::fs;
use std::path::{Path, PathBuf};

use measured_core::decode::decode_file;
use measured_core::scan::scan_dir;
use measured_core::tags::Tags;

const RATE: u32 = 44_100;
const FRAMES: u32 = RATE / 2; // 0.5 s

fn temp_dir(tag: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("measured-corrupt-{tag}-{}", std::process::id()));
    fs::create_dir_all(&p).unwrap();
    p
}

/// 16-bit mono PCM samples for a 440 Hz sine at half scale.
fn sine_pcm() -> Vec<u8> {
    let mut data = Vec::with_capacity((FRAMES * 2) as usize);
    for i in 0..FRAMES {
        let t = i as f32 / RATE as f32;
        let s = (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.5;
        data.extend_from_slice(&((s * 32767.0) as i16).to_le_bytes());
    }
    data
}

fn push_fmt(b: &mut Vec<u8>) {
    b.extend_from_slice(b"fmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes()); // PCM
    b.extend_from_slice(&1u16.to_le_bytes()); // mono
    b.extend_from_slice(&RATE.to_le_bytes());
    b.extend_from_slice(&(RATE * 2).to_le_bytes()); // byte rate
    b.extend_from_slice(&2u16.to_le_bytes()); // block align
    b.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
}

/// A valid, non-silent WAV whose LIST/INFO chunk declares a size far past the
/// end of the file. The RIFF length stays honest, so the corruption is exactly
/// the tag block: a truncated download or a writer that never patched its
/// placeholder size looks like this.
fn write_wav_with_broken_info(path: &Path) {
    let data = sine_pcm();
    let mut info: Vec<u8> = b"INFO".to_vec();
    info.extend_from_slice(b"IART");
    info.extend_from_slice(&4u32.to_le_bytes());
    info.extend_from_slice(b"Bad\0");
    let bogus_list_len = 0x7fff_fff0u32;

    let mut b: Vec<u8> = Vec::new();
    b.extend_from_slice(b"RIFF");
    let riff_len = 4 + (8 + 16) + (8 + info.len() as u32) + (8 + data.len() as u32);
    b.extend_from_slice(&riff_len.to_le_bytes());
    b.extend_from_slice(b"WAVE");
    push_fmt(&mut b);
    b.extend_from_slice(b"LIST");
    b.extend_from_slice(&bogus_list_len.to_le_bytes());
    b.extend_from_slice(&info);
    b.extend_from_slice(b"data");
    b.extend_from_slice(&(data.len() as u32).to_le_bytes());
    b.extend_from_slice(&data);
    fs::write(path, b).unwrap();
}

/// Append one INFO subchunk, including the pad byte RIFF requires after an
/// odd-sized payload.
fn push_info_subchunk(b: &mut Vec<u8>, id: &[u8; 4], value: &[u8]) {
    b.extend_from_slice(id);
    b.extend_from_slice(&(value.len() as u32).to_le_bytes());
    b.extend_from_slice(value);
    if value.len() % 2 == 1 {
        b.push(0);
    }
}

/// The control file: same audio, a well-formed INFO tag set whose artist
/// differs from the filename, so the tag winning is observable.
fn write_good_wav(path: &Path) {
    let data = sine_pcm();
    let mut info: Vec<u8> = b"INFO".to_vec();
    push_info_subchunk(&mut info, b"IART", b"Tagged Artist");

    let mut b: Vec<u8> = Vec::new();
    b.extend_from_slice(b"RIFF");
    let riff_len = 4 + (8 + 16) + (8 + info.len() as u32) + (8 + data.len() as u32);
    b.extend_from_slice(&riff_len.to_le_bytes());
    b.extend_from_slice(b"WAVE");
    push_fmt(&mut b);
    b.extend_from_slice(b"LIST");
    b.extend_from_slice(&(info.len() as u32).to_le_bytes());
    b.extend_from_slice(&info);
    b.extend_from_slice(b"data");
    b.extend_from_slice(&(data.len() as u32).to_le_bytes());
    b.extend_from_slice(&data);
    fs::write(path, b).unwrap();
}

/// A file that is not audio at all: it must still be listed, with filename
/// metadata, rather than disappearing from the library.
fn write_garbage(path: &Path) {
    fs::write(path, vec![0xAAu8; 1024]).unwrap();
}

#[test]
fn malformed_tag_block_does_not_hide_or_break_the_audio() {
    let dir = temp_dir("tags");
    let broken = dir.join("Broken Artist - Broken Title.wav");
    let good = dir.join("Good Artist - Good Title.wav");
    let garbage = dir.join("Garbage Artist - Garbage Title.wav");
    write_wav_with_broken_info(&broken);
    write_good_wav(&good);
    write_garbage(&garbage);

    // (a) The tag path gives up cleanly: no tags, no panic.
    assert_eq!(
        Tags::read(&broken),
        None,
        "a malformed tag block must read as no tags"
    );

    // (b) The scan lists every file: the corrupt one is not skipped and does
    // not abort the walk. It keeps its filename metadata.
    let lib = scan_dir(&dir, None);
    assert_eq!(lib.count, 3, "every file must be listed");
    let broken_track = lib
        .tracks
        .iter()
        .find(|t| t.file == "Broken Artist - Broken Title.wav")
        .expect("the corrupt file must appear in the library");
    assert_eq!(
        broken_track.artist.as_deref(),
        Some("Broken Artist"),
        "a file with no readable tags keeps its filename artist"
    );
    assert_eq!(broken_track.title, "Broken Title");
    let good_track = lib
        .tracks
        .iter()
        .find(|t| t.file == "Good Artist - Good Title.wav")
        .expect("the good file must appear in the library");
    assert_eq!(
        good_track.artist.as_deref(),
        Some("Tagged Artist"),
        "the good file's tag must still win over its filename"
    );
    let garbage_track = lib
        .tracks
        .iter()
        .find(|t| t.file == "Garbage Artist - Garbage Title.wav")
        .expect("a genuinely unreadable file must still be listed");
    assert_eq!(
        garbage_track.artist.as_deref(),
        Some("Garbage Artist"),
        "an unreadable file keeps its filename metadata"
    );

    // (c) The audio still decodes: the malformed metadata chunk is skipped and
    // the data chunk is reached. The good file still decodes normally, so the
    // repair path did not disturb the ordinary one.
    let pcm = decode_file(&broken).expect("the corrupt file must still decode");
    assert!(!pcm.samples.is_empty(), "decoded samples must not be empty");
    assert_eq!(pcm.rate, RATE);
    assert_eq!(pcm.channels, 1);
    let secs = pcm.frames() as f64 / pcm.rate as f64;
    assert!(
        (0.4..=0.6).contains(&secs),
        "expected about 0.5 s of audio, decoded {secs:.3} s"
    );
    let good_pcm = decode_file(&good).expect("the good file must decode");
    assert_eq!(good_pcm.rate, RATE);
    assert!(
        decode_file(&garbage).is_err(),
        "a file that is not audio must not decode"
    );

    fs::remove_dir_all(&dir).ok();
}
