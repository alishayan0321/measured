// Reproduce the Android code path without the phone: load the real page in
// Chromium with a stub window.AndroidBridge that returns the bundled library.json
// and fingerprints, then report whether the list renders.
const path = require('path');
const fs = require('fs');
const PW = process.env.PLAYWRIGHT_CORE || path.join(process.cwd(), '..', 'player', 'desktop', 'node_modules', 'playwright-core');
const ROOT = process.env.MEASURED_ROOT || process.cwd();

async function main() {
  const { chromium } = require(PW);
  const lib = JSON.parse(fs.readFileSync(path.join(ROOT, 'library.json'), 'utf8'));
  const payload = { bundled: lib.tracks || lib, added: [] };

  const browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 160)));

  await page.addInitScript((data) => {
    const songUrl = (f) => 'file:///android_asset/songs/' + encodeURIComponent(f);
    window.AndroidBridge = {
      library: () => JSON.stringify(data),
      platform: () => 'android',
      storage: () => JSON.stringify({ addedCount: 0, addedBytes: 0, freeBytes: 40e9, totalBytes: 240e9 }),
      get: (k, d) => { const v = localStorage.getItem('t:' + k); return v === null ? d : v; },
      set: (k, v) => { localStorage.setItem('t:' + k, v); },
      theme: () => {}, version: () => '1.0.0',
      pickSongs: () => true, clearAdded: () => true, removeAdded: () => true,
      media: () => {}, prepare: () => null,
      ytSearch: () => {}, ytAudio: () => {}, ytDownload: () => {}
    };
    // url field in library.json already points at the assets; keep it
    for (const t of data.bundled) { if (!t.url) t.url = songUrl(t.file); }
  }, payload);

  await page.goto('file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/'), { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  const state = await page.evaluate(() => ({
    engine: window.PlayerAPI && PlayerAPI.engine,
    count: (document.querySelector('#count') || {}).textContent,
    rows: document.querySelectorAll('.row').length,
    listKids: (document.querySelector('#list') || { children: [] }).children.length,
    title: (document.querySelector('#title') || {}).textContent,
    note: (document.querySelector('#lib-note') || {}).textContent,
    firstRow: (document.querySelector('.row .t') || {}).textContent
  }));
  console.log(JSON.stringify({ state, errors: errors.slice(0, 6) }, null, 1));
  await browser.close();
}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
