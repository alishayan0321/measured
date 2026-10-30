// Launcher icon: a vinyl on paper. Drawn as an RGB buffer, handed to ffmpeg as
// rawvideo, then scaled into every mipmap density. No image library needed.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const N = 1024;                     // supersampled canvas
const PAPER = [232, 228, 219];
const INK = [20, 19, 16];
const GROOVE = [42, 40, 35];
const ACCENT = [220, 63, 25];
const ACCENT_DARK = [140, 38, 12];

const buf = Buffer.alloc(N * N * 3);
const cx = N / 2, cy = N / 2;
const R_DISC = N * 0.355;
const R_LABEL = N * 0.145;
const R_HOLE = N * 0.024;

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function shade(x, y) {
  const dx = x - cx, dy = y - cy;
  const d = Math.hypot(dx, dy);

  if (d > R_DISC) {
    // soft contact shadow so the disc sits on the paper instead of floating
    const sx = x - cx - N * 0.012, sy = y - cy - N * 0.016;
    const sd = Math.hypot(sx, sy);
    const k = Math.max(0, 1 - (sd - R_DISC) / (N * 0.085));
    if (k <= 0) return PAPER;
    return mix(PAPER, [150, 144, 132], 0.55 * k * k);
  }

  if (d < R_HOLE) return PAPER;
  if (d < R_LABEL) {
    // label with a darker hairline at its rim
    return d > R_LABEL - N * 0.004 ? ACCENT_DARK : ACCENT;
  }
  // grooves: soft rings, brighter toward the top-left so the disc reads as vinyl
  const t = (d - R_LABEL) / (R_DISC - R_LABEL);
  const ring = Math.sin(t * Math.PI * 34) * 0.5 + 0.5;
  const lit = 1 - 0.35 * Math.max(0, (-dx - dy) / R_DISC);
  let c = mix(INK, GROOVE, ring * 0.55);
  c = c.map((v) => Math.min(255, Math.round(v * lit + 6)));
  return c;
}

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const c = shade(x + 0.5, y + 0.5);
    const o = (y * N + x) * 3;
    buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2];
  }
}

const tmp = path.join(HERE, 'icon-1024.png');
execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error',
  '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${N}x${N}`, '-i', 'pipe:0',
  '-frames:v', '1', '-y', tmp], { input: buf, stdio: ['pipe', 'inherit', 'inherit'] });

const SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [density, px] of Object.entries(SIZES)) {
  const dir = path.join(HERE, 'res', `mipmap-${density}`);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', tmp,
    '-vf', `scale=${px}:${px}:flags=lanczos`, '-frames:v', '1', '-y',
    path.join(dir, 'ic_launcher.png')], { stdio: 'inherit' });
  console.log(`mipmap-${density}/ic_launcher.png  ${px}x${px}`);
}
fs.unlinkSync(tmp);
console.log('icon done');
