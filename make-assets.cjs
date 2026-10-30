// Bakes the data the page needs into plain <script>-loadable files.
// The APK runs from file:///android_asset, where fetch() is dead, so the
// fingerprint table must arrive as a script and the bundled library as JSON the
// native bridge hands over verbatim.
//   node make-assets.cjs
//
// Names: aapt2 refuses asset paths containing | : * ? " < > — the songs folder is
// full of "Artist | Label | Song 2023" names — so bundled files are staged under a
// sanitised name, and both library.json and the fingerprint keys use that name so
// the page's file/track join keeps working.
const fs = require('node:fs');
const path = require('node:path');
const { buildLibrary, statsOf } = require('./lib/library.cjs');

const HERE = __dirname;
const ROOT = path.join(HERE, '..');
const SONGS = path.join(ROOT, 'songs');
const THUMBS = path.join(HERE, 'thumbs');
const ASSET_BASE = 'file:///android_asset';

/** One implementation — the APK packaging reads the map this writes.
 *  aapt2 on Windows cannot open asset paths with non-ASCII or reserved characters
 *  (the songs folder is full of 【】｜： and emoji), so inside the APK every song is
 *  staged under its YouTube id / content hash. The page never shows these names:
 *  artist and title travel in library.json. */
function assetName(t) {
  const id = t.videoId || require('node:crypto').createHash('md5').update(t.file).digest('hex').slice(0, 12);
  const ext = String(t.ext || 'webm').replace(/^\./, '');
  return String(id).replace(/[^A-Za-z0-9_-]/g, '') + '.' + ext;
}

// 1. the bundled library as the page will see it
const tracks = buildLibrary([{ key: 'lib', dir: SONGS }], THUMBS);
const stageMap = new Map();   // original file name -> staged asset name
const used = new Map();
for (const t of tracks) {
  let staged = assetName(t);
  const n = used.get(staged) || 0;
  used.set(staged, n + 1);
  if (n) staged = staged.replace(/(\.[^.]+)$/, '~' + (n + 1) + '$1');
  stageMap.set(t.file, staged);
}
const staged = (file) => {
  if (stageMap.has(file)) return stageMap.get(file);
  const t = tracks.find((x) => x.file === file);
  return t ? assetName(t) : file;
};

// 2. fingerprints.json -> fingerprints.js (window.FINGERPRINTS)
const fpJson = path.join(HERE, 'fingerprints.json');
const fpJs = path.join(HERE, 'fingerprints.js');
let fps = [];
if (fs.existsSync(fpJson)) {
  const data = JSON.parse(fs.readFileSync(fpJson, 'utf8'));
  fps = Array.isArray(data) ? data : (data.tracks || []);
  const forBake = fps.map((f) => (f && f.file ? { ...f, file: staged(f.file) } : f));
  fs.writeFileSync(fpJs, 'window.FINGERPRINTS=' + JSON.stringify(forBake) + ';\n');
  console.log(`fingerprints.js  ${fps.length} tracks  ${(fs.statSync(fpJs).size / 1024).toFixed(0)} KB`);
} else {
  console.log('  ~ no fingerprints.json, skipping');
}
const durByFile = new Map();
for (const f of fps) if (f && f.file && f.dur) durByFile.set(f.file, f.dur);

// 3. library.json — file:// URLs the WebView can play directly
const baked = tracks.map((t) => {
  const name = stageMap.get(t.file) || assetName(t);
  return {
    file: name,
    artist: t.artist,
    title: t.title,
    videoId: t.videoId,
    ext: t.ext,
    bytes: t.bytes,
    dur: durByFile.get(t.file) || 0,
    cover: t.cover ? ASSET_BASE + t.cover : null,
    url: ASSET_BASE + '/songs/' + encodeURIComponent(name),
    added: false,
  };
});

const libPath = path.join(HERE, 'library.json');
fs.writeFileSync(libPath, JSON.stringify(baked));
const stats = statsOf([{ key: 'lib', dir: SONGS }]);
const renamed = baked.filter((t, i) => t.file !== tracks[i].file).length;
console.log(`library.json     ${baked.length} tracks  ${(fs.statSync(libPath).size / 1024).toFixed(0)} KB  ` +
  `${(stats.bytes / 1048576).toFixed(0)} MB audio  ${baked.filter((t) => t.cover).length} with cover  ` +
  `${baked.filter((t) => t.dur).length} with duration  (${renamed} sanitised)`);

// 4. the copy map the packaging step follows
fs.writeFileSync(path.join(HERE, 'asset-names.json'), JSON.stringify(
  tracks.map((t, i) => ({ from: t.file, to: baked[i].file })), null, 0));
