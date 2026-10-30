/* Simplified vinyl for tiny icon sizes: flat disc, bigger label, no shadow
   and no grooves — at 16px the detailed master turns into mush. */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const HERE = __dirname;
const OUT = path.join(HERE, 'tmp', 'ico');
fs.mkdirSync(OUT, { recursive: true });

const N = 256;
const PAPER = [232, 228, 219];
const INK = [20, 19, 16];
const ACCENT = [220, 63, 25];
const ACCENT_DARK = [150, 40, 12];

const cx = N / 2;
const R_DISC = N * 0.44;      // fills more of the tile at small sizes
const R_LABEL = N * 0.175;
const R_HOLE = N * 0.038;

const buf = Buffer.alloc(N * N * 3);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cx;
    const d = Math.hypot(dx, dy);
    let c = PAPER;
    if (d < R_DISC) {
      if (d < R_HOLE) c = PAPER;
      else if (d < R_LABEL) c = d > R_LABEL - 1.5 ? ACCENT_DARK : ACCENT;
      else c = INK;
    }
    const o = (y * N + x) * 3;
    buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2];
  }
}

const master = path.join(OUT, 'small-256.png');
execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error',
  '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${N}x${N}`, '-i', 'pipe:0',
  '-frames:v', '1', '-y', master], { input: buf, stdio: ['pipe', 'inherit', 'inherit'] });

for (const px of [16, 24, 32, 48, 64]) {
  const out = path.join(OUT, `s${px}.png`);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', master,
    '-vf', `scale=${px}:${px}:flags=lanczos`, '-frames:v', '1', '-y', out], { stdio: 'inherit' });
  console.log(`s${px}.png`);
}
