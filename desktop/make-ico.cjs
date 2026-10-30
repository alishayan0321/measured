/* Build a multi-size .ico (PNG-compressed entries) from the 1024 master. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const here = __dirname;
const master = path.join(here, 'icon.png');
const tmp = path.join(here, 'tmp', 'ico');
fs.mkdirSync(tmp, { recursive: true });

// small sizes come from the simplified master (flat disc, bigger label)
require('child_process').execFileSync(process.execPath, [path.join(here, 'icon-small.cjs')], { stdio: 'inherit' });

const entries = [];
for (const s of SIZES) {
  const small = path.join(tmp, `s${s}.png`);
  if (s <= 64 && fs.existsSync(small)) {
    entries.push({ size: s, buf: fs.readFileSync(small) });
    continue;
  }
  const out = path.join(tmp, `i${s}.png`);
  if (!fs.existsSync(out)) {
    const r = spawnSync(FFMPEG, ['-v', 'error', '-y', '-i', master, '-vf', `scale=${s}:${s}:flags=lanczos`, out], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('ffmpeg failed for ' + s);
  }
  entries.push({ size: s, buf: fs.readFileSync(out) });
}

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);          // reserved
header.writeUInt16LE(1, 2);          // type: icon
header.writeUInt16LE(entries.length, 4);

const dir = Buffer.alloc(16 * entries.length);
let offset = 6 + dir.length;
entries.forEach((e, i) => {
  const o = i * 16;
  dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 0);      // width
  dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);      // height
  dir.writeUInt8(0, o + 2);                               // palette
  dir.writeUInt8(0, o + 3);                               // reserved
  dir.writeUInt16LE(1, o + 4);                            // planes
  dir.writeUInt16LE(32, o + 6);                           // bpp
  dir.writeUInt32LE(e.buf.length, o + 8);                 // bytes
  dir.writeUInt32LE(offset, o + 12);                      // offset
  offset += e.buf.length;
});

const ico = Buffer.concat([header, dir, ...entries.map((e) => e.buf)]);
const outFile = path.join(here, 'icon.ico');
fs.writeFileSync(outFile, ico);
console.log(`wrote ${outFile}  ${ico.length} bytes  sizes=${SIZES.join(',')}`);
