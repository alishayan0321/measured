//! Decoding through symphonia, plus a hand-written 16-bit WAV writer.
//!
//! This is the replacement for spawning ffmpeg (desktop) and for
//! `MediaExtractor` + `MediaCodec` (Android). The phone's extractor cannot read
//! AIFF/WMA at all, which is exactly what this fixes: AIFF decodes here.

use std::fs::{self, File};
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

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

fn open_track(path: &Path) -> Result<(Box<dyn symphonia::core::formats::FormatReader>, u32)> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

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
