//! Proof that the tag reader handles the containers the library actually meets.
//!
//! `test/tag-vectors.json` declares every case; the bytes are built here at test
//! time, so a case can only pass when lofty parses the container it is handed.
//! A container lofty rejects would fall back to the filename and prove nothing,
//! which is why every filename parses to a different artist and title than the
//! tags it carries: the tag winning is what the assertions observe.

use std::fs;
use std::path::{Path, PathBuf};

use measured_core::scan::scan_dir;
use measured_core::tags::Tags;
use serde_json::Value;

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/tag-vectors.json")
}

/// Unique per process and wiped first, so a rerun never reads a stale file.
fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("measured-tag-matrix-{}", std::process::id()));
    fs::remove_dir_all(&dir).ok();
    fs::create_dir_all(&dir).expect("create the fixture directory");
    dir
}

fn build(case: &Value) -> Vec<u8> {
    let container = case["container"].as_str().expect("case container");
    let tags = &case["tags"];
    match container {
        "mp3/id3v2.3" => id3_file(3, tags),
        "mp3/id3v2.4" => id3_file(4, tags),
        "mp3/truncated-id3" => truncated_id3(),
        "mp4/ilst" => mp4_file(tags),
        "flac/vorbis" => flac_file(tags),
        "ogg/opus" => opus_file(tags),
        "wav/pcm" => wav_file(),
        other => panic!("unknown container {other:?}"),
    }
}

fn syncsafe(value: u32) -> [u8; 4] {
    [
        ((value >> 21) & 0x7f) as u8,
        ((value >> 14) & 0x7f) as u8,
        ((value >> 7) & 0x7f) as u8,
        (value & 0x7f) as u8,
    ]
}

fn id3_text(major: u8, text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    if major >= 4 {
        out.push(0x03); // UTF-8
        out.extend_from_slice(text.as_bytes());
    } else {
        out.push(0x01); // UTF-16 with a BOM
        out.extend_from_slice(&[0xff, 0xfe]);
        for unit in text.encode_utf16() {
            out.extend_from_slice(&unit.to_le_bytes());
        }
    }
    out
}

fn id3_number(major: u8, number: u64) -> Vec<u8> {
    let text = number.to_string();
    let mut out = Vec::new();
    out.push(if major >= 4 { 0x03 } else { 0x00 });
    out.extend_from_slice(text.as_bytes());
    out
}

fn id3_file(major: u8, tags: &Value) -> Vec<u8> {
    let mut frames: Vec<(&str, Vec<u8>)> = Vec::new();
    if let Some(title) = tags.get("title").and_then(Value::as_str) {
        frames.push(("TIT2", id3_text(major, title)));
    }
    if let Some(artist) = tags.get("artist").and_then(Value::as_str) {
        frames.push(("TPE1", id3_text(major, artist)));
    }
    if let Some(album) = tags.get("album").and_then(Value::as_str) {
        frames.push(("TALB", id3_text(major, album)));
    }
    if let Some(track) = tags.get("track").and_then(Value::as_u64) {
        frames.push(("TRCK", id3_number(major, track)));
    }
    if let Some(disc) = tags.get("disc").and_then(Value::as_u64) {
        frames.push(("TPOS", id3_number(major, disc)));
    }

    let mut body = Vec::new();
    for (id, content) in &frames {
        body.extend_from_slice(id.as_bytes());
        // v2.4 frame sizes are syncsafe; v2.3 sizes are plain big-endian.
        if major >= 4 {
            body.extend_from_slice(&syncsafe(content.len() as u32));
        } else {
            body.extend_from_slice(&(content.len() as u32).to_be_bytes());
        }
        body.extend_from_slice(&[0, 0]);
        body.extend_from_slice(content);
    }

    let mut out = Vec::with_capacity(10 + body.len());
    out.extend_from_slice(b"ID3");
    out.push(major);
    out.push(0);
    out.push(0);
    out.extend_from_slice(&syncsafe(body.len() as u32));
    out.extend_from_slice(&body);
    out.extend_from_slice(&mpeg_frames());
    out
}

/// Two consecutive MPEG-1 Layer III frames at 128 kbps / 44.1 kHz / stereo.
/// lofty only accepts a frame when the next header sits exactly one frame
/// length later, and that length is 1152 * 128 * 125 / 44100 = 417 bytes.
fn mpeg_frames() -> Vec<u8> {
    let mut out = Vec::new();
    for _ in 0..2 {
        out.extend_from_slice(&[0xff, 0xfb, 0x90, 0x00]);
        out.extend_from_slice(&[0u8; 413]);
    }
    out
}

/// An ID3 header that promises 5000 bytes of tag but is followed by padding.
/// lofty reads it as an empty tag rather than erroring, which is exactly the
/// "half-written download" the scan must survive: untagged, still listed.
fn truncated_id3() -> Vec<u8> {
    let mut out = vec![b'I', b'D', b'3', 3, 0, 0];
    out.extend_from_slice(&syncsafe(5000));
    out.resize(40, 0);
    out
}

fn mp4_atom(ident: &[u8; 4], content: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + content.len());
    out.extend_from_slice(&((content.len() + 8) as u32).to_be_bytes());
    out.extend_from_slice(ident);
    out.extend_from_slice(content);
    out
}

fn mp4_data(type_code: u32, content: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(8 + content.len());
    body.push(0); // well-known type set
    body.extend_from_slice(&type_code.to_be_bytes()[1..]);
    body.extend_from_slice(&[0, 0, 0, 0]); // locale
    body.extend_from_slice(content);
    mp4_atom(b"data", &body)
}

fn mp4_ilst(tags: &Value) -> Vec<u8> {
    let mut items = Vec::new();
    for (key, ident) in [
        ("title", b"\xa9nam"),
        ("artist", b"\xa9ART"),
        ("album", b"\xa9alb"),
    ] {
        if let Some(text) = tags.get(key).and_then(Value::as_str) {
            items.extend_from_slice(&mp4_atom(ident, &mp4_data(1, text.as_bytes())));
        }
    }
    for (key, ident) in [("track", b"trkn"), ("disc", b"disk")] {
        if let Some(number) = tags.get(key).and_then(Value::as_u64) {
            // `track()` reads the u16 at 2..4 and `track_total()` the one at
            // 4..6, so a six byte payload satisfies both readers.
            let content = [0, 0, 0, number as u8, 0, 0];
            items.extend_from_slice(&mp4_atom(ident, &mp4_data(0, &content)));
        }
    }
    mp4_atom(b"ilst", &items)
}

fn mp4_file(tags: &Value) -> Vec<u8> {
    let mut ftyp = Vec::new();
    ftyp.extend_from_slice(b"M4A ");
    ftyp.extend_from_slice(&[0, 0, 0, 0]);

    // A "full" `meta` atom: version and flags, then `hdlr`, then `ilst`.
    let hdlr = mp4_atom(
        b"hdlr",
        &[
            0, 0, 0, 0, // version and flags
            0, 0, 0, 0, // pre-defined
            b'm', b'd', b'i', b'r', // handler type
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // reserved
            0, // empty name
        ],
    );
    let mut meta = vec![0, 0, 0, 0];
    meta.extend_from_slice(&hdlr);
    meta.extend_from_slice(&mp4_ilst(tags));

    let mut out = mp4_atom(b"ftyp", &ftyp);
    out.extend_from_slice(&mp4_atom(
        b"moov",
        &mp4_atom(b"udta", &mp4_atom(b"meta", &meta)),
    ));
    out
}

fn flac_block(last: bool, kind: u8, content: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + content.len());
    out.push(if last { 0x80 | kind } else { kind });
    let len = content.len() as u32;
    out.extend_from_slice(&[(len >> 16) as u8, (len >> 8) as u8, len as u8]);
    out.extend_from_slice(content);
    out
}

/// STREAMINFO: lofty only checks that it comes first and is long enough, but a
/// plausible body (44.1 kHz, stereo, 16 bits) keeps the fixture honest.
fn flac_streaminfo() -> Vec<u8> {
    let mut out = Vec::with_capacity(34);
    out.extend_from_slice(&4096u16.to_be_bytes());
    out.extend_from_slice(&4096u16.to_be_bytes());
    out.extend_from_slice(&[0, 0, 0]);
    out.extend_from_slice(&[0, 0, 0]);
    let packed: u64 = (44_100u64 << 44) | (1u64 << 41) | (15u64 << 36);
    out.extend_from_slice(&packed.to_be_bytes());
    out.extend_from_slice(&[0u8; 16]);
    out
}

fn flac_file(tags: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"fLaC");
    out.extend_from_slice(&flac_block(false, 0, &flac_streaminfo()));
    out.extend_from_slice(&flac_block(true, 4, &vorbis_comment(tags)));
    out
}

fn vorbis_comment(tags: &Value) -> Vec<u8> {
    let vendor = b"measured-test";
    let mut entries: Vec<String> = Vec::new();
    for (key, name) in [("title", "TITLE"), ("artist", "ARTIST"), ("album", "ALBUM")] {
        if let Some(text) = tags.get(key).and_then(Value::as_str) {
            entries.push(format!("{name}={text}"));
        }
    }
    for (key, name) in [("track", "TRACKNUMBER"), ("disc", "DISCNUMBER")] {
        if let Some(number) = tags.get(key).and_then(Value::as_u64) {
            entries.push(format!("{name}={number}"));
        }
    }

    let mut out = Vec::new();
    out.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    out.extend_from_slice(vendor);
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for entry in &entries {
        out.extend_from_slice(&(entry.len() as u32).to_le_bytes());
        out.extend_from_slice(entry.as_bytes());
    }
    out
}

fn ogg_crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0;
    for byte in data {
        crc ^= u32::from(*byte) << 24;
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 {
                (crc << 1) ^ 0x04c1_1db7
            } else {
                crc << 1
            };
        }
    }
    crc
}

fn ogg_page(header_type: u8, serial: u32, seq: u32, packet: &[u8]) -> Vec<u8> {
    let mut lacing = Vec::new();
    let mut left = packet.len();
    loop {
        if left >= 255 {
            lacing.push(255);
            left -= 255;
        } else {
            lacing.push(left as u8);
            break;
        }
    }

    let mut page = Vec::new();
    page.extend_from_slice(b"OggS");
    page.push(0); // stream structure version
    page.push(header_type);
    page.extend_from_slice(&0u64.to_le_bytes()); // granule position
    page.extend_from_slice(&serial.to_le_bytes());
    page.extend_from_slice(&seq.to_le_bytes());
    page.extend_from_slice(&[0, 0, 0, 0]); // checksum placeholder, filled below
    page.push(lacing.len() as u8);
    page.extend_from_slice(&lacing);
    page.extend_from_slice(packet);

    // Ogg's CRC-32: polynomial 0x04C11DB7, initial value 0, no reflection and
    // no final xor, computed with the checksum field itself left zeroed.
    let crc = ogg_crc32(&page);
    page[22..26].copy_from_slice(&crc.to_le_bytes());
    page
}

fn opus_file(tags: &Value) -> Vec<u8> {
    let mut head = Vec::new();
    head.extend_from_slice(b"OpusHead");
    head.push(1); // version
    head.push(2); // channels
    head.extend_from_slice(&312u16.to_le_bytes()); // pre-skip
    head.extend_from_slice(&48_000u32.to_le_bytes()); // input sample rate
    head.extend_from_slice(&0i16.to_le_bytes()); // output gain
    head.push(0); // channel mapping family

    let mut comments = Vec::new();
    comments.extend_from_slice(b"OpusTags");
    comments.extend_from_slice(&vorbis_comment(tags));

    let mut out = ogg_page(0x02, 1, 0, &head);
    out.extend_from_slice(&ogg_page(0x00, 1, 1, &comments));
    out
}

fn wav_file() -> Vec<u8> {
    let data_len = 4410u32; // 50 ms of 44.1 kHz mono 16-bit
    let mut out = Vec::new();
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&44_100u32.to_le_bytes());
    out.extend_from_slice(&88_200u32.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.resize(out.len() + data_len as usize, 0);
    out
}

#[test]
fn ogg_crc_matches_the_published_check_value() {
    // CRC-32/CKSUM uses this polynomial, initial value and reflection with a
    // final xor of 0xFFFFFFFF, and its published check value for "123456789"
    // is 0x765E7680. Ogg drops that final xor, so the same input must come out
    // as the complement -- which is what proves the page checksums are real
    // even though lofty does not verify them on read.
    assert_eq!(ogg_crc32(b"123456789"), 0x89a1_897f);
}

#[test]
fn tag_matrix_matches_every_declared_container() {
    let raw = fs::read_to_string(fixture_path()).expect("read test/tag-vectors.json");
    let fixture: Value = serde_json::from_str(&raw).expect("parse test/tag-vectors.json");
    let cases = fixture["cases"].as_array().expect("cases array");
    assert_eq!(
        cases.len(),
        10,
        "the fixture must keep the ten containers this card covers"
    );

    let dir = temp_dir();

    // (a) What each file declares about itself.
    let mut read_back = 0usize;
    for case in cases {
        let id = case["id"].as_str().expect("case id");
        let filename = case["filename"].as_str().expect("case filename");
        let expect = &case["expect"];

        let bytes = build(case);
        fs::write(dir.join(filename), &bytes)
            .unwrap_or_else(|e| panic!("{id}: write {filename}: {e}"));

        let tag_read = Tags::read(&dir.join(filename));
        let want_tags = expect["tags_read"].as_bool().expect("case tags_read");
        assert_eq!(tag_read.is_some(), want_tags, "{id}: Tags::read presence");
        if let Some(actual) = tag_read {
            assert_eq!(
                actual.title.as_deref(),
                expect["title"].as_str(),
                "{id}: title"
            );
            assert_eq!(
                actual.artist.as_deref(),
                expect["artist"].as_str(),
                "{id}: artist"
            );
            assert_eq!(
                actual.album.as_deref(),
                expect["album"].as_str(),
                "{id}: album"
            );
            let track = expect["track"].as_u64().map(|n| n as u32);
            assert_eq!(actual.track, track, "{id}: track");
            let disc = expect["disc"].as_u64().map(|n| n as u32);
            assert_eq!(actual.disc, disc, "{id}: disc");
        }
        read_back += 1;
    }
    assert_eq!(read_back, cases.len(), "no case may be skipped");

    // (b) What the scanner exposes after merging each field with the filename.
    let library = scan_dir(&dir, None);
    assert_eq!(
        library.count,
        cases.len(),
        "scan must list every fixture file"
    );
    assert_eq!(
        library.tracks.len(),
        cases.len(),
        "scan must not drop a fixture file"
    );

    for case in cases {
        let id = case["id"].as_str().expect("case id");
        let filename = case["filename"].as_str().expect("case filename");
        let scanned = &case["scanned"];
        let track = library
            .tracks
            .iter()
            .find(|track| track.file.as_str() == filename)
            .unwrap_or_else(|| panic!("{id}: scan did not list {filename}"));
        assert_eq!(
            track.title,
            scanned["title"].as_str().expect("case scanned title"),
            "{id}: scanned title"
        );
        assert_eq!(
            track.artist.as_deref(),
            scanned["artist"].as_str(),
            "{id}: scanned artist"
        );
    }

    fs::remove_dir_all(&dir).ok();
}
