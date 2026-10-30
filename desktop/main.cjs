'use strict';
/* MEASURED — desktop shell.
   The page is the same one the phone runs; the only desktop-specific parts are
   the HTTP server (so audio can stream with Range support), the native file
   picker, and a small settings store. Nothing leaves the machine. */
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const isDev = !app.isPackaged;

/** The shared HTTP layer lives next to the page in both layouts. */
const libDir = isDev ? path.join(__dirname, '..', 'lib') : path.join(process.resourcesPath, 'player', 'lib');
const { createServer } = require(path.join(libDir, 'server.cjs'));

/* Every format we accept. The browser decoders handle the first group natively;
   the rest are converted with the bundled ffmpeg before they reach <audio>. */
const NATIVE_EXT = new Set(['.mp3', '.m4a', '.mp4', '.m4b', '.aac', '.flac', '.ogg', '.oga',
  '.opus', '.wav', '.wave', '.weba', '.webm']);
const EXTRA_EXT = new Set(['.aiff', '.aif', '.aifc', '.caf', '.wma', '.ape', '.alac', '.mka',
  '.wv', '.tta', '.amr', '.ac3', '.dts', '.mlp', '.dsf', '.dff', '.spx', '.au', '.snd']);
const AUDIO_EXT = new Set([...NATIVE_EXT, ...EXTRA_EXT]);

/** ffmpeg ships beside the app: node_modules in dev, resources/ when packaged. */
const ffmpegPath = (() => {
  /* the packaged copy lives beside the app, never inside app.asar: a child process
     cannot execute out of an archive (spawn -> ENOENT) */
  const candidates = [
    path.join(process.resourcesPath || '', 'ffmpeg.exe'),
    path.join(__dirname, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
  ];
  for (const p of candidates) {
    if (!p || p.indexOf('app.asar') >= 0) continue;  // unreachable from a child process
    try { if (p && fs.existsSync(p)) return p; } catch (e) { /* keep looking */ }
  }
  return null;
})();

let win = null;
let server = null;
let port = 0;
let songCache = { dir: '', files: [], at: 0 };
const converting = new Map();   // cache key -> Promise<string|null>, so double clicks do not fork ffmpeg

/* ── paths ─────────────────────────────────────────────────────────────────── */
const pageDir = () => (isDev
  ? path.join(__dirname, '..')                       // player/ during development
  : path.join(process.resourcesPath, 'player'));     // resources/player when packaged

const bundledSongs = () => (isDev
  ? path.join(__dirname, '..', '..', 'songs')
  : path.join(process.resourcesPath, 'songs'));

const addedSongs = () => path.join(app.getPath('userData'), 'songs');
const storePath = () => path.join(app.getPath('userData'), 'settings.json');

/* Where converted audio is cached. The first candidate is the normal home; the
   others exist because a locked profile, a privacy tool or an antivirus can refuse
   writes there, and then ffmpeg — not us — is the process that fails. */
const tcCandidates = () => {
  const list = [];
  /* explicit override, used by tests and by anyone whose profile must live elsewhere */
  if (process.env.MEASURED_TRANSCODE) list.push({ key: 'tce', dir: process.env.MEASURED_TRANSCODE });
  list.push(
    { key: 'tc0', dir: path.join(app.getPath('userData'), 'transcode') },
    { key: 'tc1', dir: path.join(require('node:os').tmpdir(), 'measured-transcode') },
    { key: 'tc2', dir: path.join(path.dirname(process.execPath), 'transcode') },
  );
  /* a dev run keeps its cache beside the sources, which is also the only place a
     sandboxed test harness lets a spawned ffmpeg write */
  if (!app.isPackaged) list.push({ key: 'tc3', dir: path.join(__dirname, '..', '.transcode') });
  return list;
};
let tcPinned = null;   // key of the first candidate that actually converted something

/** Append one line to <userData>/transcode.log; used to explain conversion failures. */
function debugLog(line) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'transcode.log'),
      `${new Date().toISOString()} ${line}\n`);
  } catch (e) { /* logging must never break playback */ }
}

/* ── format conversion ─────────────────────────────────────────────────────── */
/** Absolute path of a track inside whichever library holds it. */
function sourceFile(srcKey, file) {
  const name = path.basename(String(file || ''));
  const dir = srcKey === 'add' ? addedSongs() : bundledSongs();
  return path.join(dir, name);
}

/** Convert anything ffmpeg reads into 192 kbps mp3, cached by name.
    Resolves to a URL the page can play, or null when the file cannot be read. */
async function prepareTrack(srcKey, file) {
  if (!file) return null;
  const ext = path.extname(String(file)).toLowerCase();
  if (NATIVE_EXT.has(ext)) return null;      // already playable, nothing to do
  if (!ffmpegPath) return null;              // no converter available

  const abs = sourceFile(srcKey, file);
  const there = (() => { try { return fs.existsSync(abs); } catch (e) { return false; } })();
  if (!there) return null;

  const key = crypto.createHash('md5').update(srcKey + '::' + path.basename(abs)).digest('hex').slice(0, 16);

  /* cached already? then answer immediately whichever folder holds it */
  for (const c of tcCandidates()) {
    const hit = path.join(c.dir, key + '.mp3');
    try { if (fs.statSync(hit).size > 1024) return { key: c.key, name: key + '.mp3' }; } catch (e) { /* keep looking */ }
  }
  if (converting.has(key)) return converting.get(key);

  const job = (async () => {
    const order = tcPinned
      ? [...tcCandidates().filter((c) => c.key === tcPinned), ...tcCandidates().filter((c) => c.key !== tcPinned)]
      : tcCandidates();
    for (const c of order) {
      const out = path.join(c.dir, key + '.mp3');
      try { fs.mkdirSync(c.dir, { recursive: true }); } catch (e) { continue; }
      const ok = await new Promise((resolve) => {
        const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', abs,
          '-vn', '-map_metadata', '-1', '-ac', '2', '-ar', '44100', '-b:a', '192k', out];
        let done = false;
        const finish = (good, why) => {
          if (done) return;
          done = true;
          if (!good) debugLog(`fail ${c.key} ${c.dir} :: ${why || ''}`);
          resolve(good);
        };
        let ff;
        try { ff = spawn(ffmpegPath, args, { windowsHide: true }); } catch (e) { return finish(false, 'spawn threw ' + (e && e.message)); }
        let err = '';
        ff.stderr.on('data', (b) => { err += String(b); });
        ff.on('error', (e) => finish(false, 'spawn error ' + (e && e.message)));
        ff.on('close', (code) => {
          if (code === 0) return finish(true);
          if (err) console.error('[transcode]', path.basename(abs), err.trim().split('\n').slice(-1)[0]);
          finish(false, 'exit ' + code + ' ' + err.trim().split('\n').slice(-1)[0]);
        });
      });
      if (ok) {
        tcPinned = c.key;
        return { key: c.key, name: key + '.mp3' };
      }
      try { fs.unlinkSync(out); } catch (e) { /* nothing written */ }
    }
    return null;
  })().finally(() => converting.delete(key));

  converting.set(key, job);
  return job;
}

/* ── tiny settings store ───────────────────────────────────────────────────── */
function readStore() {
  try { return JSON.parse(fs.readFileSync(storePath(), 'utf8')) || {}; } catch (e) { return {}; }
}
function writeStore(patch) {
  const next = { ...readStore(), ...patch };
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(next, null, 2));
  } catch (e) { /* a locked profile must not break playback */ }
  return next;
}

/* ── file helpers ──────────────────────────────────────────────────────────── */
function uniqueName(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = `${stem}${ext}`;
  let n = 2;
  while (fs.existsSync(path.join(dir, candidate))) candidate = `${stem} (${n++})${ext}`;
  return candidate;
}

function listAddedFiles() {
  const dir = addedSongs();
  if (songCache.dir === dir && Date.now() - songCache.at < 1500) return songCache.files;
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { file: f, bytes: st.size, mtime: st.mtimeMs };
      });
  } catch (e) { files = []; }
  songCache = { dir, files, at: Date.now() };
  return files;
}

function storageInfo() {
  try {
    const st = fs.statfsSync(app.getPath('userData'));
    return {
      addedBytes: listAddedFiles().reduce((n, f) => n + f.bytes, 0),
      addedCount: listAddedFiles().length,
      freeBytes: st.bavail * st.bsize,
      totalBytes: st.blocks * st.bsize,
    };
  } catch (e) {
    return { addedBytes: 0, addedCount: 0, freeBytes: 0, totalBytes: 0 };
  }
}

/* ── http server over both sources ─────────────────────────────────────────── */
function startServer() {
  return new Promise((resolve, reject) => {
    const sources = [
      { key: 'lib', dir: bundledSongs() },
      { key: 'add', dir: addedSongs() },
    ];
    try { fs.mkdirSync(addedSongs(), { recursive: true }); } catch (e) { /* ignore */ }
    /* every cache folder is routable, so whichever one ffmpeg could write to plays */
    const staticDirs = {};
    for (const c of tcCandidates()) {
      try { fs.mkdirSync(c.dir, { recursive: true }); } catch (e) { /* ignore */ }
      staticDirs[c.key] = c.dir;
    }
    server = createServer({ pageDir: pageDir(), sources, staticDirs });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve(port);
    });
  });
}

/* ── window ────────────────────────────────────────────────────────────────── */
function paintChrome(mode) {
  const dark = mode === 'dark';
  nativeTheme.themeSource = dark ? 'dark' : 'light';
  if (win && !win.isDestroyed()) win.setBackgroundColor(dark ? '#131210' : '#e8e4db');
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 880,
    minHeight: 560,
    show: false,
    backgroundColor: readStore().theme === 'dark' ? '#131210' : '#e8e4db',
    title: 'MEASURED',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  await win.loadURL(`http://127.0.0.1:${port}/`);
  paintChrome(readStore().theme === 'dark' ? 'dark' : 'light');
}

/* ── ipc: what preload exposes as DesktopBridge ────────────────────────────── */
function wireIpc() {
  ipcMain.handle('measured:pick', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Add songs to MEASURED',
      buttonLabel: 'Add',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Audio', extensions: Array.from(AUDIO_EXT).map((e) => e.slice(1)) },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return 0;
    const dir = addedSongs();
    fs.mkdirSync(dir, { recursive: true });
    let copied = 0;
    for (const src of res.filePaths) {
      if (!AUDIO_EXT.has(path.extname(src).toLowerCase())) continue;
      try {
        fs.copyFileSync(src, path.join(dir, uniqueName(dir, path.basename(src))));
        copied += 1;
      } catch (e) { /* skip unreadable files, keep the rest */ }
    }
    songCache.at = 0;
    if (copied) await tellPage();
    return copied;
  });

  ipcMain.on('measured:remove', (e, file) => {
    try {
      const abs = path.join(addedSongs(), path.basename(String(file)));
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
      songCache.at = 0;
      e.returnValue = { ok: true };
    } catch (err) { e.returnValue = { ok: false, error: String(err.message || err) }; }
  });

  ipcMain.on('measured:clear', (e) => {
    const dir = addedSongs();
    let removed = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!AUDIO_EXT.has(path.extname(f).toLowerCase())) continue;
        try { fs.unlinkSync(path.join(dir, f)); removed += 1; } catch (err) { /* ignore */ }
      }
    } catch (err) { /* nothing added yet */ }
    songCache.at = 0;
    e.returnValue = { removed };
  });

  /* synchronous, same contract as AndroidBridge.get/set/storage/setTheme */
  /* async: converting a file takes as long as it takes. Returns the URL to play,
     or null when this file cannot be read at all. */
  ipcMain.handle('measured:prepare', async (e, srcKey, file) => {
    const ready = await prepareTrack(String(srcKey || 'lib'), String(file || ''));
    if (!ready || !ready.key || !ready.name) return null;
    return `http://127.0.0.1:${port}/${ready.key}/${encodeURIComponent(ready.name)}`;
  });

  ipcMain.on('measured:storage', (e) => { e.returnValue = storageInfo(); });
  ipcMain.on('measured:get', (e, key) => {
    const v = readStore()[String(key)];
    e.returnValue = v === undefined ? null : String(v);
  });
  ipcMain.on('measured:set', (e, key, value) => {
    writeStore({ [String(key)]: String(value) });
    e.returnValue = true;
  });
  ipcMain.on('measured:theme', (e, mode) => {
    writeStore({ theme: mode === 'dark' ? 'dark' : 'light' });
    paintChrome(mode);
    e.returnValue = true;
  });
}

/** after a native import the page reloads its own library */
async function tellPage() {
  if (!win || win.isDestroyed()) return;
  try {
    await win.webContents.executeJavaScript('(window.PlayerAPI && PlayerAPI.onSongsChanged ? PlayerAPI.onSongsChanged() : 0)');
  } catch (e) { /* page not ready */ }
}

/* ── lifecycle ─────────────────────────────────────────────────────────────── */
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  wireIpc();
  try {
    await startServer();
  } catch (e) {
    dialog.showErrorBox('MEASURED could not start', String(e.message || e));
    app.quit();
    return;
  }
  await createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (server) server.close(); });
