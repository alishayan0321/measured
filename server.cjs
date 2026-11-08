// Dev / web entry point: `node server.cjs [root] [port]`
// Serves index.html from this directory plus every audio file in <root>/songs
// and <root>/songs-added. Scans per request, so dropping a file in either
// folder shows up on refresh.
//
// Defaults are clone-safe: `git clone … && cd measured && node server.cjs`
// works with no arguments, because the page is served from __dirname and the
// songs folder is discovered rather than assumed.
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('./lib/server.cjs');

const ROOT = process.argv[2] || __dirname;
const PORT = Number(process.argv[3] || 8142);

// index.html, thumbs/ and lib/ live beside this script, not under ROOT.
const PAGE_DIR = __dirname;

const isDir = (d) => {
  try { return fs.statSync(d).isDirectory(); } catch { return false; }
};

// First existing candidate wins; otherwise fall back to the first so the
// server still starts and simply reports zero tracks.
const pick = (...cands) => cands.find(isDir) || cands[0];

const SONGS = pick(
  path.join(ROOT, 'songs'),
  path.join(__dirname, 'songs'),
  path.join(__dirname, '..', 'songs'),
);
const ADDED = path.join(ROOT, 'songs-added');
try { fs.mkdirSync(ADDED, { recursive: true }); } catch { /* read-only is fine */ }

const sources = [
  { key: 'lib', dir: SONGS },
  { key: 'add', dir: ADDED },
];

const server = createServer({ pageDir: PAGE_DIR, sources });

server.listen(PORT, '127.0.0.1', () => {
  const lib = require('./lib/library.cjs').buildLibrary(sources, path.join(PAGE_DIR, 'thumbs'));
  console.log(`[player] http://127.0.0.1:${PORT}/  page=${PAGE_DIR}  songs=${SONGS}  tracks=${lib.length}`);
});
