/* Library scanning shared by the web server and the Electron shell.
   A "source" is one folder of audio on disk:
     { key: 'lib', dir, label }   bundled with the app
     { key: 'add', dir, label }   files the user added later (writable)
   Tracks always carry `src` + `url`, so the same UI works no matter which
   folder a file lives in. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const P = require('./parse-name.js');

function hashKey(file) {
  return crypto.createHash('md5').update(file).digest('hex').slice(0, 12);
}

// Cover thumbs are keyed by video id when we have one, else by a short hash of the
// filename — the same rule gen-covers.cjs baked into player/thumbs/.
function thumbKey(file, videoId) {
  return P.keyFor(file, videoId) || hashKey(file);
}

function coverUrl(file, videoId, thumbsDir) {
  const key = thumbKey(file, videoId);
  if (!fs.existsSync(path.join(thumbsDir, key + '.jpg'))) return null;
  return '/player/thumbs/' + encodeURIComponent(key) + '.jpg';
}

function scanSource(source, thumbsDir) {
  let entries = [];
  try { entries = fs.readdirSync(source.dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!P.isAudio(e.name)) continue;
    let st;
    try { st = fs.statSync(path.join(source.dir, e.name)); } catch { continue; }
    const { artist, title, videoId } = P.parseName(e.name);
    out.push({
      file: e.name,
      src: source.key,
      url: '/' + source.key + '/' + encodeURIComponent(e.name),
      cover: coverUrl(e.name, videoId, thumbsDir),
      artist, title, videoId,
      ext: P.extOf(e.name).slice(1),
      bytes: st.size,
      mtime: st.mtimeMs,
      added: source.key !== 'lib',
    });
  }
  return out;
}

function buildLibrary(sources, thumbsDir) {
  const seen = new Set();
  const out = [];
  for (const s of sources) {
    for (const t of scanSource(s, thumbsDir)) {
      const id = t.src + '::' + t.file;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(t);
    }
  }
  out.sort((a, b) => (a.artist + a.title).localeCompare(b.artist + b.title, undefined, { sensitivity: 'base' }));
  return out;
}

function statsOf(sources) {
  let bytes = 0, files = 0;
  const perSource = {};
  for (const s of sources) {
    let n = 0, b = 0;
    try {
      for (const e of fs.readdirSync(s.dir, { withFileTypes: true })) {
        if (!e.isFile() || !P.isAudio(e.name)) continue;
        try { b += fs.statSync(path.join(s.dir, e.name)).size; n++; } catch { /* skip */ }
      }
    } catch { /* missing folder is fine */ }
    perSource[s.key] = { files: n, bytes: b };
    files += n; bytes += b;
  }
  return { files, bytes, perSource };
}

module.exports = { buildLibrary, scanSource, statsOf, thumbKey, coverUrl };
