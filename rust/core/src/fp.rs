//! Spectral fingerprint: the numbers behind the readout (LUFS, true peak,
//! crest factor, rolloff, 26 log bands). Same shape as `fingerprints.json` so
//! the existing UI keeps working.
//!
//! Loudness is ITU-R BS.1770-4: K-weighting plus the two-stage gate. The filter
//! is designed from the analog prototype rather than copied from the 48 kHz
//! coefficient table, because a hard-coded table silently mis-weights every
//! 44.1 kHz file. True peak is 4x oversampled, because a sample peak under-reads
//! anything whose crest falls between samples.

use std::path::Path;

use rustfft::{num_complex::Complex, FftPlanner};
use serde::{Deserialize, Serialize};

use crate::decode::{decode_window, duration_ms, Pcm};

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

/// Seconds decoded per window. Head, middle and tail together characterise a
/// track without decoding a two-hour mix end to end.
const WINDOW_SECS: f64 = 20.0;

#[derive(Clone, Copy)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
}

impl Biquad {
    fn run(&self, x: &[f32]) -> Vec<f32> {
        let mut y = Vec::with_capacity(x.len());
        let (mut x1, mut x2, mut y1, mut y2) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
        for &xi in x {
            let yi = self.b0 * xi + self.b1 * x1 + self.b2 * x2 - self.a1 * y1 - self.a2 * y2;
            x2 = x1;
            x1 = xi;
            y2 = y1;
            y1 = yi;
            y.push(yi);
        }
        y
    }
}

/// BS.1770 K-weighting: a +4 dB high shelf followed by the RLB high-pass.
///
/// Both stages are bilinear-transformed from the analog prototype with the
/// corner pre-warped, so the coefficients are correct at any sample rate.
fn k_weighting(rate: u32) -> (Biquad, Biquad) {
    let fs = rate.max(1) as f64;
    let pi = std::f64::consts::PI;

    // Stage 1: high shelf, +4 dB above ~1.7 kHz.
    let f0 = 1681.974450955533;
    let g = 3.999843853973347;
    let q = 0.7071752369554196;
    let k = (pi * f0 / fs).tan();
    let vh = 10f64.powf(g / 20.0);
    let vb = vh.powf(0.4996667741545416);
    let a0 = 1.0 + k / q + k * k;
    let shelf = Biquad {
        b0: ((vh + vb * k / q + k * k) / a0) as f32,
        b1: (2.0 * (k * k - vh) / a0) as f32,
        b2: ((vh - vb * k / q + k * k) / a0) as f32,
        a1: (2.0 * (k * k - 1.0) / a0) as f32,
        a2: ((1.0 - k / q + k * k) / a0) as f32,
    };

    // Stage 2: RLB high-pass at ~38 Hz.
    let f0 = 38.13547087602444;
    let q = 0.5003270373238773;
    let k = (pi * f0 / fs).tan();
    let a0 = 1.0 + k / q + k * k;
    let hp = Biquad {
        b0: 1.0,
        b1: -2.0,
        b2: 1.0,
        a1: (2.0 * (k * k - 1.0) / a0) as f32,
        a2: ((1.0 - k / q + k * k) / a0) as f32,
    };
    (shelf, hp)
}

/// Gated integrated loudness in LUFS (BS.1770-4 §2.4).
///
/// 400 ms blocks with a 100 ms hop, an absolute gate at -70 LUFS, then a
/// relative gate 10 LU below the mean of what survived the first gate.
fn integrated_lufs(kw: &[f32], rate: u32) -> f32 {
    let block = ((rate as f64 * 0.4) as usize).max(1);
    let hop = ((rate as f64 * 0.1) as usize).max(1);

    let mean_sq = |s: &[f32]| -> f64 {
        if s.is_empty() {
            return 0.0;
        }
        s.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / s.len() as f64
    };

    if kw.len() < block {
        // Shorter than one block: measure it whole so a 3-second clip still
        // gets a number instead of the -70 floor.
        let ms = mean_sq(kw);
        return if ms > 0.0 {
            (-0.691 + 10.0 * ms.log10()) as f32
        } else {
            -70.0
        };
    }

    let mut z: Vec<f64> = Vec::new();
    let mut pos = 0;
    while pos + block <= kw.len() {
        z.push(mean_sq(&kw[pos..pos + block]));
        pos += hop;
    }

    let abs_gate = 10f64.powf((-70.0 + 0.691) / 10.0);
    let above: Vec<f64> = z.iter().copied().filter(|&v| v > abs_gate).collect();
    if above.is_empty() {
        return -70.0;
    }
    let mean_abs = above.iter().sum::<f64>() / above.len() as f64;
    let rel_gate = mean_abs * 0.1; // -10 LU
    let gated: Vec<f64> = above.iter().copied().filter(|&v| v > rel_gate).collect();
    if gated.is_empty() {
        return -70.0;
    }
    let mean = gated.iter().sum::<f64>() / gated.len() as f64;
    (-0.691 + 10.0 * mean.log10()) as f32
}

/// 4x oversampled peak in dBFS.
///
/// A sample peak misses the real crest of anything whose maximum falls between
/// samples: a fs/4 sine at 45 degrees reads -3 dBFS by sample and 0 dBFS in
/// reality. The interpolator is a 16-tap windowed-sinc polyphase bank.
fn true_peak_db(samples: &[f32], channels: usize) -> f32 {
    const OS: usize = 4;
    const TAPS: usize = 16;
    const HALF: i32 = 7; // taps span -7..=8

    let mut h = [[0f32; TAPS]; OS];
    for (p, phase) in h.iter_mut().enumerate() {
        let frac = p as f32 / OS as f32;
        let mut sum = 0.0f32;
        for (j, k) in (-HALF..=HALF + 1).enumerate() {
            let t = k as f32 - frac;
            let sinc = if t.abs() < 1e-6 {
                1.0
            } else {
                (std::f32::consts::PI * t).sin() / (std::f32::consts::PI * t)
            };
            let n = j as f32 / (TAPS - 1) as f32;
            let w = 0.42 - 0.5 * (2.0 * std::f32::consts::PI * n).cos()
                + 0.08 * (4.0 * std::f32::consts::PI * n).cos();
            phase[j] = sinc * w;
            sum += phase[j];
        }
        if sum.abs() > 1e-9 {
            for v in phase.iter_mut() {
                *v /= sum;
            }
        }
    }

    let ch = channels.max(1);
    let mut peak = 0.0f32;
    for c in 0..ch {
        let x: Vec<f32> = samples.iter().skip(c).step_by(ch).copied().collect();
        for &s in &x {
            peak = peak.max(s.abs());
        }
        for i in 0..x.len() {
            for phase in h.iter().skip(1) {
                let mut acc = 0.0f32;
                for (j, k) in (-HALF..=HALF + 1).enumerate() {
                    let idx = i as i32 + k;
                    if idx < 0 || idx as usize >= x.len() {
                        continue;
                    }
                    acc += x[idx as usize] * phase[j];
                }
                peak = peak.max(acc.abs());
            }
        }
    }
    if peak > 0.0 {
        20.0 * peak.log10()
    } else {
        -60.0
    }
}

/// Measure an already-decoded buffer. Split out from [`fingerprint`] so the
/// synthetic-signal tests can drive it without touching the filesystem.
pub fn analyze(pcm: &Pcm) -> Fingerprint {
    let rate = pcm.rate.max(1);
    let dur = pcm.frames() as f64 / rate as f64;
    let mono = pcm.mono();

    let (shelf, hp) = k_weighting(rate);
    let kw = hp.run(&shelf.run(&mono));
    let lufs = integrated_lufs(&kw, rate);

    let tp = true_peak_db(&pcm.samples, pcm.channels);

    // Crest factor from the unweighted signal: it is a property of the waveform,
    // not of the loudness weighting.
    let mut peak = 0.0f32;
    let mut sum_sq = 0.0f64;
    for &s in &mono {
        peak = peak.max(s.abs());
        sum_sq += (s as f64) * (s as f64);
    }
    let rms = if mono.is_empty() {
        0.0
    } else {
        (sum_sq / mono.len() as f64).sqrt() as f32
    };
    let crest = if rms > 0.0 {
        20.0 * (peak / rms).log10()
    } else {
        0.0
    };

    // Spectrum
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let window: Vec<f32> = (0..FFT_SIZE)
        .map(|i| {
            0.5 - 0.5 * ((2.0 * std::f32::consts::PI * i as f32) / (FFT_SIZE as f32 - 1.0)).cos()
        })
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

    let nyquist = rate as f32 / 2.0;
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
        for (b, band) in bands.iter_mut().enumerate() {
            let t0 = b as f32 / BANDS as f32;
            let t1 = (b + 1) as f32 / BANDS as f32;
            let hz0 = f_lo * (f_hi / f_lo).powf(t0);
            let hz1 = f_lo * (f_hi / f_lo).powf(t1);
            let k0 = ((hz0 / bin_hz).floor() as usize).max(1);
            let k1 = ((hz1 / bin_hz).ceil() as usize).min(FFT_SIZE / 2);
            let mut e = 0f64;
            for v in acc.iter().take(k1.max(k0 + 1)).skip(k0) {
                e += *v;
            }
            let norm = e / total_energy;
            let db = if norm > 1e-12 {
                10.0 * norm.log10()
            } else {
                -120.0
            };
            *band = db.max(-120.0) as f32;
        }
    }

    Fingerprint {
        lufs,
        tp,
        crest,
        rolloff,
        bands,
        dur,
    }
}

pub fn fingerprint(path: &Path) -> anyhow::Result<Fingerprint> {
    let dur = duration_ms(path)
        .map(|ms| ms as f64 / 1000.0)
        .unwrap_or(0.0);

    let mut pcm = decode_window(path, 0.0, WINDOW_SECS)?;
    if dur > WINDOW_SECS * 3.0 {
        for start in [dur / 2.0, (dur - WINDOW_SECS).max(0.0)] {
            if let Ok(part) = decode_window(path, start, WINDOW_SECS) {
                // Same file, so the format cannot change mid-track; the guard is
                // here because a malformed container can still report otherwise.
                if part.rate == pcm.rate && part.channels == pcm.channels {
                    pcm.samples.extend_from_slice(&part.samples);
                }
            }
        }
    }

    let mut fp = analyze(&pcm);
    if dur > 0.0 {
        fp.dur = dur;
    }
    Ok(fp)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A mono sine with a known RMS, so the expected LUFS is known in advance.
    fn sine(rate: u32, hz: f64, rms_dbfs: f64, secs: f64, phase: f64) -> Pcm {
        let amp = 10f64.powf(rms_dbfs / 20.0) * std::f64::consts::SQRT_2;
        let n = (rate as f64 * secs) as usize;
        let samples: Vec<f32> = (0..n)
            .map(|i| {
                let t = 2.0 * std::f64::consts::PI * hz * i as f64 / rate as f64 + phase;
                (amp * t.sin()) as f32
            })
            .collect();
        Pcm {
            rate,
            channels: 1,
            samples,
        }
    }

    /// BS.1770 is calibrated so a 1 kHz sine reads its own RMS in LUFS. The
    /// K-weighting gain at 1 kHz (+0.69 dB) cancels the -0.691 offset exactly.
    #[test]
    fn lufs_reads_minus_23_at_44k1() {
        let fp = analyze(&sine(44_100, 1000.0, -23.0, 10.0, 0.0));
        assert!((fp.lufs + 23.0).abs() < 0.5, "44.1k LUFS was {}", fp.lufs);
    }

    #[test]
    fn lufs_reads_minus_23_at_48k() {
        let fp = analyze(&sine(48_000, 1000.0, -23.0, 10.0, 0.0));
        assert!((fp.lufs + 23.0).abs() < 0.5, "48k LUFS was {}", fp.lufs);
    }

    /// fs/4 sine at 45 degrees: every sample is +-0.7071 (-3.01 dBFS), but the
    /// waveform reaches 1.0 (0 dBFS) halfway between samples.
    #[test]
    fn true_peak_sees_between_the_samples() {
        let fp = analyze(&sine(
            48_000,
            12_000.0,
            -3.0103,
            1.0,
            std::f64::consts::FRAC_PI_4,
        ));
        assert!((fp.tp - 0.0).abs() < 0.5, "true peak was {} dBFS", fp.tp);
    }
}
