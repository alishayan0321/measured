//! Spectral fingerprint: the numbers behind the readout (LUFS, true peak,
//! crest factor, rolloff, 26 log bands). Same shape as `fingerprints.json` so
//! the existing UI keeps working.

use std::path::Path;

use rustfft::{num_complex::Complex, FftPlanner};
use serde::{Deserialize, Serialize};

use crate::decode::{decode_file, Pcm};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fingerprint {
    pub lufs: f32,
    pub tp: f32,
    pub crest: f32,
    pub rolloff: f32,
    pub bands: Vec<f32>,
    pub dur: f64,
}

const FFT_SIZE: usize = 2048;
const BANDS: usize = 26;
const ANALYSIS_SECS: f64 = 60.0;

fn to_mono_at(pcm: &Pcm, target_rate: u32) -> Vec<f32> {
    let mono = pcm.mono();
    if pcm.rate == target_rate || pcm.rate == 0 {
        return mono;
    }
    // cheap linear resample — good enough for spectral summarisation
    let ratio = pcm.rate as f64 / target_rate as f64;
    let out_len = ((mono.len() as f64) / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let idx = pos.floor() as usize;
        let frac = (pos - idx as f64) as f32;
        let a = *mono.get(idx).unwrap_or(&0.0);
        let b = *mono.get(idx + 1).unwrap_or(&a);
        out.push(a + (b - a) * frac);
    }
    out
}

pub fn fingerprint(path: &Path) -> anyhow::Result<Fingerprint> {
    let pcm = decode_file(path)?;
    let dur = pcm.frames() as f64 / pcm.rate.max(1) as f64;

    let mut mono = to_mono_at(&pcm, 44_100);
    let cap = (44_100f64 * ANALYSIS_SECS) as usize;
    if mono.len() > cap {
        mono.truncate(cap);
    }

    // loudness: mean square of the K-weighted-ish signal (high-pass + shelf
    // omitted; a 60 Hz high-pass keeps DC and rumble out of the number)
    let mut hp = 0.0f32;
    let mut prev_in = 0.0f32;
    let alpha = 0.995f32;
    let mut sum_sq = 0.0f64;
    for s in &mono {
        hp = alpha * (hp + s - prev_in);
        prev_in = *s;
        sum_sq += (hp as f64) * (hp as f64);
    }
    let mean_sq = if mono.is_empty() { 0.0 } else { sum_sq / mono.len() as f64 };
    let lufs = if mean_sq > 0.0 { (-0.691 + 10.0 * mean_sq.log10()) as f32 } else { -70.0 };

    // peaks
    let mut tp: f32 = 0.0;
    let mut peak_sum_sq = 0.0f64;
    for s in &pcm.samples {
        let a = s.abs();
        if a > tp {
            tp = a;
        }
        peak_sum_sq += (a as f64) * (a as f64);
    }
    let rms = if pcm.samples.is_empty() {
        0.0
    } else {
        (peak_sum_sq / pcm.samples.len() as f64).sqrt() as f32
    };
    let crest = if rms > 0.0 { 20.0 * (tp / rms).log10() } else { 0.0 };

    // spectrum
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let window: Vec<f32> = (0..FFT_SIZE)
        .map(|i| 0.5 - 0.5 * ((2.0 * std::f32::consts::PI * i as f32) / (FFT_SIZE as f32 - 1.0)).cos())
        .collect();

    let mut acc = vec![0f64; FFT_SIZE / 2 + 1];
    let mut frames = 0usize;
    let mut total_energy = 0f64;
    let mut rolloff_bins_sum = 0f64;

    let mut buf: Vec<Complex<f32>> = vec![Complex::new(0.0, 0.0); FFT_SIZE];
    let mut pos = 0usize;
    while pos + FFT_SIZE <= mono.len() {
        for i in 0..FFT_SIZE {
            buf[i] = Complex::new(mono[pos + i] * window[i], 0.0);
        }
        fft.process(&mut buf);

        let mut frame_energy = 0f64;
        for (k, c) in buf.iter().take(FFT_SIZE / 2 + 1).enumerate() {
            let mag = (c.re * c.re + c.im * c.im) as f64;
            acc[k] += mag;
            frame_energy += mag;
        }
        if frame_energy > 0.0 {
            let mut cum = 0f64;
            let target = frame_energy * 0.95;
            for (k, c) in buf.iter().take(FFT_SIZE / 2 + 1).enumerate() {
                cum += (c.re * c.re + c.im * c.im) as f64;
                if cum >= target {
                    rolloff_bins_sum += k as f64;
                    break;
                }
            }
        }
        total_energy += frame_energy;
        frames += 1;
        pos += FFT_SIZE / 2;
    }

    let nyquist = 22_050f32;
    let bin_hz = nyquist / (FFT_SIZE as f32 / 2.0);
    let rolloff = if frames > 0 {
        (rolloff_bins_sum / frames as f64) as f32 * bin_hz
    } else {
        0.0
    };

    // 26 log-spaced bands from 40 Hz to 16 kHz
    let mut bands = vec![0f32; BANDS];
    if frames > 0 && total_energy > 0.0 {
        let f_lo = 40f32;
        let f_hi = 16_000f32;
        for b in 0..BANDS {
            let t0 = b as f32 / BANDS as f32;
            let t1 = (b + 1) as f32 / BANDS as f32;
            let hz0 = f_lo * (f_hi / f_lo).powf(t0);
            let hz1 = f_lo * (f_hi / f_lo).powf(t1);
            let k0 = ((hz0 / bin_hz).floor() as usize).max(1);
            let k1 = ((hz1 / bin_hz).ceil() as usize).min(FFT_SIZE / 2);
            let mut e = 0f64;
            for k in k0..k1.max(k0 + 1) {
                e += acc[k];
            }
            let norm = e / total_energy;
            let db = if norm > 1e-12 { 10.0 * norm.log10() } else { -120.0 };
            bands[b] = db.max(-120.0) as f32;
        }
    }

    Ok(Fingerprint {
        lufs,
        tp: if tp > 0.0 { 20.0 * tp.log10() } else { -60.0 },
        crest,
        rolloff,
        bands,
        dur,
    })
}
