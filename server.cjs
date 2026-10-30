// Dev / web entry point: `node server.cjs [root] [port]`
// Serves player/index.html plus every audio file in <root>/songs and <root>/songs-added.
// Scans per request, so dropping a file in either folder shows up on refresh.
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('./lib/server.cjs');

const ROOT = process.argv[2] || path.join(__dirname, '..');
const PORT = Number(process.argv[3] || 8142);

const ADDED = path.join(ROOT, 'songs-added');
try { fs.mkdirSync(ADDED, { recursive: true }); } catch { /* read-only is fine */ }

const sources = [
  { key: 'lib', dir: path.join(ROOT, 'songs') },
  { key: 'add', dir: ADDED },
];

const server = createServer({ pageDir: path.join(ROOT, 'player'), sources });

server.listen(PORT, '127.0.0.1', () => {
  const lib = require('./lib/library.cjs').buildLibrary(sources, path.join(ROOT, 'player', 'thumbs'));
  console.log(`[player] http://127.0.0.1:${PORT}/  root=${ROOT}  tracks=${lib.length}`);
});
