//! Decoding through symphonia, plus a hand-written 16-bit WAV writer.
//!
//! This is the replacement for spawning ffmpeg (desktop) and for
//! `MediaExtractor` + `MediaCodec` (Android). The phone's extractor cannot read
//! AIFF/WMA at all, which is exactly what this fixes: AIFF decodes here.

use std::fs::{self, File};
use std::io::{BufWriter, Write};
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
        if self.channels == 0 {
            0
        } else {
            self.samples.len() / self.channels
        }
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
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
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
    let mut channels = params
        .channels
        .map(|c| c.count())
        .unwrap_or(2)
        .max(1);

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
                if sample_buf.is_none() || sample_buf.as_ref().map(|b| b.capacity()) < Some(decoded.capacity() as usize) {
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
    Ok(Pcm { rate, channels, samples })
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

/// Write 16-bit PCM WAV. The WebView and every Android media stack play this,
/// which is why non-native containers are transcoded to WAV rather than MP3.
pub fn write_wav(pcm: &Pcm, out: &Path) -> Result<()> {
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).ok();
    }
    let tmp = out.with_extension("part");

    let bits = 16u16;
    let block_align = (pcm.channels as u16) * (bits / 8);
    let byte_rate = pcm.rate * block_align as u32;
    let data_len = (pcm.samples.len() * 2) as u32;

    {
        let f = File::create(&tmp).with_context(|| format!("create {}", tmp.display()))?;
        let mut w = BufWriter::new(f);
        w.write_all(b"RIFF")?;
        w.write_all(&(36 + data_len).to_le_bytes())?;
        w.write_all(b"WAVE")?;
        w.write_all(b"fmt ")?;
        w.write_all(&16u32.to_le_bytes())?;
        w.write_all(&1u16.to_le_bytes())?; // PCM
        w.write_all(&(pcm.channels as u16).to_le_bytes())?;
        w.write_all(&pcm.rate.to_le_bytes())?;
        w.write_all(&byte_rate.to_le_bytes())?;
        w.write_all(&block_align.to_le_bytes())?;
        w.write_all(&bits.to_le_bytes())?;
        w.write_all(b"data")?;
        w.write_all(&data_len.to_le_bytes())?;

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

/// decode + transcode in one step; returns the output path.
pub fn decode_to_wav(src: &Path, out: &Path) -> Result<()> {
    let pcm = decode_file(src)?;
    write_wav(&pcm, out)
}
