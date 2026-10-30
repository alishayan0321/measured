// Fill player/thumbs/<key>.jpg with real cover art.
// These .webm files are audio-only (opus, no video stream), so there is no frame to pull:
// the art comes from the YouTube poster for the track's 11-char id.
// key = the id when the filename carries one, else a short md5 of the name (server uses the same key).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const ROOT = process.env.MEASURED_ROOT || path.join(__dirname);
const SONGS = path.join(ROOT, 'songs');
const OUT = path.join(ROOT, 'player', 'thumbs');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const AUDIO_EXT = new Set(['.mp3', '.webm', '.flac', '.m4a', '.ogg', '.opus', '.wav', '.aac']);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const SIZES = ['maxresdefault', 'hq720', 'mqdefault'];

function idOf(file) {
  const m = file.replace(/\.[^.]+$/, '').match(/\s*\[([A-Za-z0-9_-]{11})\]\s*$/);
  return m ? m[1] : null;
}
function keyFor(file) {
  return idOf(file) || crypto.createHash('md5').update(file).digest('hex').slice(0, 12);
}

function get(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'image/*' }, timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(buf.length > 1500 ? buf : null);          // 404-ish bodies are tiny
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function embeddedArt(src, out) {
  try {
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', src,
      '-map', '0:v?', '-frames:v', '1', '-q:v', '4', '-y', out], { stdio: 'ignore', timeout: 30000 });
    return fs.existsSync(out) && fs.statSync(out).size > 1500;
  } catch { return false; }
}

fs.mkdirSync(OUT, { recursive: true });

const files = fs.readdirSync(SONGS, { withFileTypes: true })
  .filter((f) => f.isFile() && AUDIO_EXT.has(path.extname(f.name).toLowerCase()))
  .map((f) => f.name);

(async () => {
  let made = 0, skipped = 0, failed = 0;
  const misses = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const key = keyFor(file);
    const out = path.join(OUT, key + '.jpg');
    if (fs.existsSync(out) && fs.statSync(out).size > 1500) { skipped++; continue; }
    const tag = `[${i + 1}/${files.length}] ${key}`;
    const id = idOf(file);
    let ok = false;

    if (id) {
      for (const size of SIZES) {
        const buf = await get(`https://i.ytimg.com/vi/${id}/${size}.jpg`);
        if (buf) { fs.writeFileSync(out, buf); ok = true; console.log(`${tag} ${size} ${(buf.length / 1024).toFixed(0)}k`); break; }
      }
    }
    if (!ok) {
      if (embeddedArt(path.join(SONGS, file), out)) { ok = true; console.log(tag + ' embedded art'); }
    }
    if (ok) made++; else { failed++; misses.push(file); console.log(tag + ' no art'); }
  }

  console.log(`\ndone: ${made} fetched, ${skipped} already there, ${failed} without art`);
  if (misses.length) console.log('no art:\n' + misses.join('\n'));
})();
