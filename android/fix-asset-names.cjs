// aapt2 on Windows mirrors OS separators into asset entry names
// ("assets/player\deck\vinyl.css"). Android's AssetManager only resolves
// forward slashes, so the WebView would 404 on every file.
// '\' and '/' are both one byte, so the names can be patched in place in the
// local headers and the central directory without moving any data.
//   node fix-asset-names.cjs app.apk
const fs = require('node:fs');

const apk = process.argv[2];
if (!apk) {
  console.error('usage: fix-asset-names.cjs app.apk');
  process.exit(1);
}

const buf = fs.readFileSync(apk);
const BSLASH = 0x5c, SLASH = 0x2f;

let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) throw new Error('no EOCD');

const count = buf.readUInt16LE(eocd + 10);
const cdOffset = buf.readUInt32LE(eocd + 16);

let fixed = 0;
let p = cdOffset;
for (let i = 0; i < count; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory at ' + p);
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const commentLen = buf.readUInt16LE(p + 32);
  const localOff = buf.readUInt32LE(p + 42);
  const nameAt = p + 46;

  let hasBackslash = false;
  for (let k = 0; k < nameLen; k++) {
    if (buf[nameAt + k] === BSLASH) { buf[nameAt + k] = SLASH; hasBackslash = true; }
  }
  if (hasBackslash) {
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('bad local header');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lNameAt = localOff + 30;
    if (lNameLen !== nameLen) throw new Error('name length mismatch at ' + localOff);
    for (let k = 0; k < lNameLen; k++) {
      if (buf[lNameAt + k] === BSLASH) buf[lNameAt + k] = SLASH;
    }
    fixed++;
  }

  p = nameAt + nameLen + extraLen + commentLen;
}

fs.writeFileSync(apk, buf);
console.log(`  normalised ${fixed} asset path${fixed === 1 ? '' : 's'} to forward slashes`);
