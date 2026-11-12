/* Stage the web UI into rust/desktop/dist so `cargo tauri build` has a frontend.
   Only the files the page actually needs are copied — no .cjs, no node_modules. */
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..');
// MEASURED_STAGE_OUT lets test/stage.test.cjs stage into a throwaway directory
// instead of clobbering the real dist/ the desktop build reads.
const out = process.env.MEASURED_STAGE_OUT
  ? path.resolve(process.env.MEASURED_STAGE_OUT)
  : path.resolve(__dirname, 'desktop', 'dist');

// embeddings.json is fetched by index.html at boot (loadEmbeddings); leaving it
// out of the bundle made the recommender's embedding feature 404 silently in
// every packaged desktop build.
const files = [
  'index.html',
  'api.js',
  'fingerprints.js',
  'fingerprints.json',
  'library.json',
  'embeddings.json',
  'icon.png',
];
const dirs = ['deck', 'styles', 'thumbs'];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const f of files) {
  const src = path.join(repo, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, f));
}

for (const d of dirs) {
  const src = path.join(repo, d);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(out, d), { recursive: true });
}

// lib/ holds parse-name.js plus Node-only .cjs helpers — ship the JS only.
const libSrc = path.join(repo, 'lib');
const libOut = path.join(out, 'lib');
fs.mkdirSync(libOut, { recursive: true });
if (fs.existsSync(libSrc)) {
  for (const f of fs.readdirSync(libSrc)) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(libSrc, f), path.join(libOut, f));
  }
}

let count = 0;
let bytes = 0;
(function walk(p) {
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) walk(full);
    else {
      count++;
      bytes += fs.statSync(full).size;
    }
  }
})(out);

console.log(`staged ${count} files, ${(bytes / 1048576).toFixed(1)} MB -> ${out}`);
