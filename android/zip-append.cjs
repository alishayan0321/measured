// Append entries to an existing zip WITHOUT rewriting the archive.
// Used to drop classes.dex into the aapt2-built APK while leaving the 400 MB of
// -0 (stored) audio exactly as it is — `jar uf` would recompress everything.
//   node zip-append.cjs app.apk classes.dex [more files...]
const fs = require('node:fs');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('no end-of-central-directory record');
}

const [apkPath, ...files] = process.argv.slice(2);
if (!apkPath || !files.length) {
  console.error('usage: zip-append.cjs app.apk file [file...]');
  process.exit(1);
}

const buf = fs.readFileSync(apkPath);
const eocd = findEOCD(buf);
const entries = buf.readUInt16LE(eocd + 10);
const cdSize = buf.readUInt32LE(eocd + 12);
const cdOffset = buf.readUInt32LE(eocd + 16);

if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
  throw new Error('zip64 archives are not supported');
}

const cd = buf.subarray(cdOffset, cdOffset + cdSize);
const head = buf.subarray(0, cdOffset);          // local entries (+ any prefix)

const locals = [];
const centrals = [];
let offset = cdOffset;

for (const f of files) {
  const data = fs.readFileSync(f);
  const name = Buffer.from(fs_pathBasename(f), 'utf8');
  const crc = crc32(data);

  const lh = Buffer.alloc(30 + name.length);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);            // version needed
  lh.writeUInt16LE(0, 6);             // flags
  lh.writeUInt16LE(0, 8);             // stored
  lh.writeUInt16LE(0, 10);            // time
  lh.writeUInt16LE(0x21, 12);         // date: 1980-01-01
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(data.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(name.length, 26);
  lh.writeUInt16LE(0, 28);
  name.copy(lh, 30);

  const ch = Buffer.alloc(46 + name.length);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);            // version made by
  ch.writeUInt16LE(20, 6);            // version needed
  ch.writeUInt16LE(0, 8);
  ch.writeUInt16LE(0, 10);
  ch.writeUInt16LE(0, 12);
  ch.writeUInt16LE(0x21, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(data.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(name.length, 28);
  ch.writeUInt16LE(0, 30);            // extra
  ch.writeUInt16LE(0, 32);            // comment
  ch.writeUInt16LE(0, 34);            // disk
  ch.writeUInt16LE(0, 36);            // internal attrs
  ch.writeUInt32LE(0, 38);            // external attrs
  ch.writeUInt32LE(offset, 42);
  name.copy(ch, 46);

  locals.push(lh, data);
  centrals.push(ch);
  offset += lh.length + data.length;
}

const newCD = Buffer.concat([cd, ...centrals]);
const eocdBuf = Buffer.alloc(22);
eocdBuf.writeUInt32LE(0x06054b50, 0);
eocdBuf.writeUInt16LE(0, 4);
eocdBuf.writeUInt16LE(0, 6);
eocdBuf.writeUInt16LE(entries + files.length, 8);
eocdBuf.writeUInt16LE(entries + files.length, 10);
eocdBuf.writeUInt32LE(newCD.length, 12);
eocdBuf.writeUInt32LE(offset, 16);
eocdBuf.writeUInt16LE(0, 20);

fs.writeFileSync(apkPath, Buffer.concat([head, ...locals, newCD, eocdBuf]));
console.log(`  +${files.length} entr${files.length === 1 ? 'y' : 'ies'} stored in ${apkPath}`);

function fs_pathBasename(p) {
  const m = /[\\/]([^\\/]+)$/.exec(p);
  return m ? m[1] : p;
}
