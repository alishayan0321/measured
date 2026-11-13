//! Decoding through symphonia, plus a hand-written 16-bit WAV writer.
//!
//! This is the replacement for spawning ffmpeg (desktop) and for
//! `MediaExtractor` + `MediaCodec` (Android). The phone's extractor cannot read
//! AIFF/WMA at all, which is exactly what this fixes: AIFF decodes here.

use std::fs::{self, File};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

#[derive(Debug)]
pub struct Pcm {
    pub rate: u32,
    pub channels: usize,
    pub samples: Vec<f32>,
}

impl Pcm {
    pub fn frames(&self) -> usize {
        self.samples.len().checked_div(self.channels).unwrap_or(0)
    }

    /// Mono mixdown, handy for analysis.
    pub fn mono(&self) -> Vec<f32> {
        if self.channels <= 1 {
            return self.samples.clone();
        }
        let ch = self.channels;
        self.samples
            .chunks_exact(ch)
            .map(|frame| frame.iter().sum::<f32>() / ch as f32)
            .collect()
    }
}

/// How far into a file to look for the data chunk when repairing a broken
/// metadata chunk. Tag blocks sit at the front of the file; this is generous
/// for cover art while keeping the repair from reading a whole track twice.
const REPAIR_SCAN_BYTES: u64 = 16 * 1024 * 1024;

/// A file whose metadata chunk declares a size past the end of the file makes
/// symphonia's RIFF walker reject the whole stream, even though the audio is
/// intact. The repair is length-preserving: the bad chunk's size field is
/// replaced with the real distance to the data chunk, so the walker skips the
/// metadata and reaches the audio.
#[derive(Debug)]
struct PatchedSource {
    file: File,
    len: u64,
    pos: u64,
    patch_at: u64,
    patch: [u8; 4],
}

impl Read for PatchedSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.file.read(buf)?;
        let start = self.pos;
        let end = start + n as u64;
        let patch_end = self.patch_at + 4;
        if start < patch_end && end > self.patch_at {
            for (i, byte) in buf[..n].iter_mut().enumerate() {
                let off = start + i as u64;
                if off >= self.patch_at && off < patch_end {
                    *byte = self.patch[(off - self.patch_at) as usize];
                }
            }
        }
        self.pos = end;
        Ok(n)
    }
}

impl Seek for PatchedSource {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let p = self.file.seek(pos)?;
        self.pos = p;
        Ok(p)
    }
}

impl symphonia::core::io::MediaSource for PatchedSource {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        Some(self.len)
    }
}

/// Find the length-preserving patch that lets the RIFF walker skip a metadata
/// chunk whose declared size runs past the end of the file. Returns the offset
/// of the chunk's size field and the four bytes to put there.
fn wav_chunk_size_repair(path: &Path) -> Option<(u64, [u8; 4])> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let scan = len.min(REPAIR_SCAN_BYTES) as usize;
    let mut buf = vec![0u8; scan];
    file.read_exact(&mut buf).ok()?;
    if buf.len() < 12 || &buf[0..4] != b"RIFF" || &buf[8..12] != b"WAVE" {
        return None;
    }

    let mut pos = 12usize;
    while pos + 8 <= buf.len() {
        let size = u32::from_le_bytes(buf[pos + 4..pos + 8].try_into().ok()?) as u64;
        let body = pos as u64 + 8;
        if &buf[pos..pos + 4] == b"data" {
            return None; // the walk reached the audio; nothing to repair
        }
        if body + size > len {
            let data_at = find_data_chunk(&buf, pos + 8, len)?;
            let real = u32::try_from(data_at.checked_sub(body)?).ok()?;
            return Some((pos as u64 + 4, real.to_le_bytes()));
        }
        pos = (body + size + (size & 1)) as usize;
    }
    None
}

/// Locate the data chunk after a chunk whose size cannot be trusted. Chunk
/// headers are word-aligned, so only even offsets are considered; a candidate
/// is accepted only when its declared payload fits inside the file, and one
/// that ends exactly at EOF wins.
fn find_data_chunk(buf: &[u8], from: usize, len: u64) -> Option<u64> {
    let mut fallback = None;
    let mut i = from;
    while i + 8 <= buf.len() {
        if &buf[i..i + 4] == b"data" {
            let size = u32::from_le_bytes(buf[i + 4..i + 8].try_into().ok()?) as u64;
            let body = i as u64 + 8;
            if size > 0 && body + size <= len {
                if body + size == len {
                    return Some(i as u64);
                }
                fallback.get_or_insert(i as u64);
            }
        }
        i += 2;
    }
    fallback
}

fn open_track(path: &Path) -> Result<(Box<dyn symphonia::core::formats::FormatReader>, u32)> {
    match open_track_with(path, None) {
        Ok(v) => Ok(v),
        Err(first) => {
            // A malformed metadata chunk makes the RIFF walker reject the file
            // even though the audio is intact; retry once with the bad size
            // patched in the stream.
            if let Some((at, patch)) = wav_chunk_size_repair(path) {
                if let Ok(v) = open_track_with(path, Some((at, patch))) {
                    return Ok(v);
                }
            }
            Err(first)
        }
    }
}

fn open_track_with(
    path: &Path,
    patch: Option<(u64, [u8; 4])>,
) -> Result<(Box<dyn symphonia::core::formats::FormatReader>, u32)> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let source: Box<dyn symphonia::core::io::MediaSource> = match patch {
        Some((patch_at, bytes)) => Box::new(PatchedSource {
            file,
            len,
            pos: 0,
            patch_at,
            patch: bytes,
        }),
        None => Box::new(file),
    };
    let mss = MediaSourceStream::new(source, Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .with_context(|| format!("probe {}", path.display()))?;

    let reader = probed.format;
    let track_id = reader
        .default_track()
        .map(|t| t.id)
        .ok_or_else(|| anyhow!("no default track in {}", path.display()))?;
    Ok((reader, track_id))
}

/// Decode a whole file to interleaved f32 samples.
pub fn decode_file(path: &Path) -> Result<Pcm> {
    let (mut reader, track_id) = open_track(path)?;

    let params = reader
        .tracks()
        .iter()
        .find(|t| t.id == track_id)
        .map(|t| t.codec_params.clone())
        .ok_or_else(|| anyhow!("missing track {track_id}"))?;

    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .context("create decoder")?;

    let mut rate = params.sample_rate.unwrap_or(44_100);
    let mut channels = params.channels.map(|c| c.count()).unwrap_or(2).max(1);

    let mut samples: Vec<f32> = Vec::new();
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match reader.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(e) => return Err(anyhow!("read packet: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                rate = spec.rate;
                channels = spec.channels.count().max(1);
                if sample_buf.is_none()
                    || sample_buf.as_ref().map(|b| b.capacity()) < Some(decoded.capacity())
                {
                    sample_buf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
                }
                if let Some(buf) = sample_buf.as_mut() {
                    buf.copy_interleaved_ref(decoded);
                    samples.extend_from_slice(buf.samples());
                }
            }
            Err(SymError::DecodeError(_)) => continue,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(anyhow!("decode: {e}")),
        }
    }

    if samples.is_empty() {
        return Err(anyhow!("no audio decoded from {}", path.display()));
    }
    Ok(Pcm {
        rate,
        channels,
        samples,
    })
}

/// Decode at most `max_secs` of audio starting at `start_secs`.
///
/// Fingerprinting needs a few windows, not the whole track: a two-hour mix is
/// over a gigabyte of f32 samples and minutes of decode. Seeking is best-effort
/// — a container that cannot seek falls back to decoding from the start and
/// dropping the leading samples, which is slower but still correct.
pub fn decode_window(path: &Path, start_secs: f64, max_secs: f64) -> Result<Pcm> {
    let (mut reader, track_id) = open_track(path)?;
    let params = reader
        .tracks()
        .iter()
        .find(|t| t.id == track_id)
        .map(|t| t.codec_params.clone())
        .ok_or_else(|| anyhow!("missing track {track_id}"))?;
    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .context("create decoder")?;

    let mut rate = params.sample_rate.unwrap_or(44_100);
    let mut channels = params.channels.map(|c| c.count()).unwrap_or(2).max(1);

    let mut skip = 0usize;
    if start_secs > 0.0 {
        let secs = start_secs.max(0.0);
        let to = SeekTo::Time {
            time: Time {
                seconds: secs as u64,
                frac: secs.fract(),
            },
            track_id: Some(track_id),
        };
        if reader.seek(SeekMode::Accurate, to).is_err() {
            skip = (secs * rate as f64) as usize * channels;
        }
    }

    let mut samples: Vec<f32> = Vec::new();
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        // Recomputed each pass because the first decoded packet is what reveals
        // the real rate and channel count.
        let want = (max_secs * rate as f64) as usize * channels;
        if samples.len() >= want {
            break;
        }
        let packet = match reader.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(e) => return Err(anyhow!("read packet: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                rate = spec.rate;
                channels = spec.channels.count().max(1);
                if sample_buf.is_none()
                    || sample_buf.as_ref().map(|b| b.capacity()) < Some(decoded.capacity())
                {
                    sample_buf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
                }
                if let Some(buf) = sample_buf.as_mut() {
                    buf.copy_interleaved_ref(decoded);
                    samples.extend_from_slice(buf.samples());
                }
            }
            Err(SymError::DecodeError(_)) => continue,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(anyhow!("decode: {e}")),
        }
    }

    if skip > 0 && skip < samples.len() {
        samples.drain(..skip);
    }
    let want = (max_secs * rate as f64) as usize * channels;
    if samples.len() > want {
        samples.truncate(want);
    }
    if samples.is_empty() {
        return Err(anyhow!("no audio decoded from {}", path.display()));
    }
    Ok(Pcm {
        rate,
        channels,
        samples,
    })
}

pub fn duration_ms(path: &Path) -> Result<u64> {
    let (reader, track_id) = open_track(path)?;
    let params = reader
        .tracks()
        .iter()
        .find(|t| t.id == track_id)
        .map(|t| t.codec_params.clone());
    if let Some(p) = params.as_ref() {
        if let (Some(n_frames), Some(tb)) = (p.n_frames, p.time_base) {
            let secs = n_frames as f64 * tb.numer as f64 / tb.denom as f64;
            if secs.is_finite() && secs > 0.0 {
                return Ok((secs * 1000.0) as u64);
            }
        }
    }
    // fall back to a full decode when the container does not declare a length
    let pcm = decode_file(path)?;
    Ok(((pcm.frames() as f64 / pcm.rate as f64) * 1000.0) as u64)
}

/// Canonical 44-byte PCM WAV header.
///
/// `data_len` is written into both size fields. The streaming writer passes 0
/// and patches them afterwards, because it does not know the length until the
/// last packet has been decoded.
fn wav_header(rate: u32, channels: usize, data_len: u32) -> [u8; 44] {
    let bits = 16u16;
    let block_align = (channels as u16) * (bits / 8);
    let byte_rate = rate * block_align as u32;

    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_len).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&(channels as u16).to_le_bytes());
    h[24..28].copy_from_slice(&rate.to_le_bytes());
    h[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    h[32..34].copy_from_slice(&block_align.to_le_bytes());
    h[34..36].copy_from_slice(&bits.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_len.to_le_bytes());
    h
}

/// Write 16-bit PCM WAV. The WebView and every Android media stack play this,
/// which is why non-native containers are transcoded to WAV rather than MP3.
pub fn write_wav(pcm: &Pcm, out: &Path) -> Result<()> {
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).ok();
    }
    let tmp = out.with_extension("part");
    let data_len = u32::try_from(pcm.samples.len() * 2).map_err(|_| {
        anyhow!(
            "track too long for a WAV file: {} samples",
            pcm.samples.len()
        )
    })?;

    {
        let f = File::create(&tmp).with_context(|| format!("create {}", tmp.display()))?;
        let mut w = BufWriter::new(f);
        w.write_all(&wav_header(pcm.rate, pcm.channels, data_len))?;

        let mut chunk: Vec<u8> = Vec::with_capacity(64 * 1024);
        for s in &pcm.samples {
            let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
            chunk.extend_from_slice(&v.to_le_bytes());
            if chunk.len() >= 64 * 1024 {
                w.write_all(&chunk)?;
                chunk.clear();
            }
        }
        if !chunk.is_empty() {
            w.write_all(&chunk)?;
        }
        w.flush()?;
    }

    fs::rename(&tmp, out).with_context(|| format!("rename into {}", out.display()))?;
    Ok(())
}

/// Decode `src` into a 16-bit WAV at `out` without holding the track in RAM.
///
/// `decode_file` keeps every sample as f32 — roughly 100 MB for a five-minute
/// stereo track and well over a gigabyte for a long mix — which is fine for the
/// 60-second fingerprint window but not for transcoding. This writes the header
/// with placeholder sizes, appends PCM as packets arrive, then patches the two
/// size fields and renames the finished file into place.
pub fn decode_to_wav(src: &Path, out: &Path) -> Result<()> {
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).ok();
    }
    let tmp = out.with_extension("part");

    let (mut reader, track_id) = open_track(src)?;
    let params = reader
        .tracks()
        .iter()
        .find(|t| t.id == track_id)
        .map(|t| t.codec_params.clone())
        .ok_or_else(|| anyhow!("missing track {track_id}"))?;
    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .context("create decoder")?;

    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut data_len: u64 = 0;
    let mut header_written = false;

    {
        let f = File::create(&tmp).with_context(|| format!("create {}", tmp.display()))?;
        let mut w = BufWriter::new(f);
        let mut chunk: Vec<u8> = Vec::with_capacity(64 * 1024);

        loop {
            let packet = match reader.next_packet() {
                Ok(p) => p,
                Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(SymError::ResetRequired) => break,
                Err(e) => return Err(anyhow!("read packet: {e}")),
            };
            if packet.track_id() != track_id {
                continue;
            }
            match decoder.decode(&packet) {
                Ok(decoded) => {
                    let spec = *decoded.spec();
                    // The header needs the real rate and channel count, and some
                    // containers only reveal them on the first decoded packet,
                    // so nothing is written until one has been decoded.
                    if !header_written {
                        w.write_all(&wav_header(spec.rate, spec.channels.count().max(1), 0))?;
                        header_written = true;
                    }
                    if sample_buf.is_none()
                        || sample_buf.as_ref().map(|b| b.capacity()) < Some(decoded.capacity())
                    {
                        sample_buf =
                            Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
                    }
                    if let Some(buf) = sample_buf.as_mut() {
                        buf.copy_interleaved_ref(decoded);
                        for s in buf.samples() {
                            let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                            chunk.extend_from_slice(&v.to_le_bytes());
                        }
                        data_len += chunk.len() as u64;
                        w.write_all(&chunk)?;
                        chunk.clear();
                    }
                }
                Err(SymError::DecodeError(_)) => continue,
                Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(e) => return Err(anyhow!("decode: {e}")),
            }
        }
        w.flush()?;
    }

    if !header_written || data_len == 0 {
        fs::remove_file(&tmp).ok();
        return Err(anyhow!("no audio decoded from {}", src.display()));
    }
    if data_len > u32::MAX as u64 {
        fs::remove_file(&tmp).ok();
        return Err(anyhow!("track too long for a WAV file: {data_len} bytes"));
    }

    // Patch the two size fields the header had to leave at zero.
    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .open(&tmp)
            .with_context(|| format!("reopen {}", tmp.display()))?;
        f.seek(SeekFrom::Start(4))?;
        f.write_all(&(36 + data_len as u32).to_le_bytes())?;
        f.seek(SeekFrom::Start(40))?;
        f.write_all(&(data_len as u32).to_le_bytes())?;
        f.flush()?;
    }

    fs::rename(&tmp, out).with_context(|| format!("rename into {}", out.display()))?;
    Ok(())
}
