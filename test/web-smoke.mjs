#!/usr/bin/env node
/* Web-shell smoke test: the third platform, end to end.

 * WHY: index.html + app.js + api.js is the shell that runs in a plain browser,
 * and it is also what the desktop and Android shells load. test/csp.check.cjs
 * drives the staged desktop copy only to prove the CSP string and that its
 * controls still respond; nothing exercised the web shell's own data path
 * (server.cjs, /api/tracks, Range serving) or playback, seek, search and theme
 * end to end. A regression there shipped silently because every other test is
 * unit-level.
 *
 * WHAT: generates a throwaway library of two WAVs, starts the real dev server
 * (server.cjs) on it, launches headless Chrome, and drives the page over CDP
 * with real mouse and keyboard input: the library must come from /api/tracks,
 * a track must play and advance, the seek rail must move playback, shuffle and
 * repeat must toggle, search must filter, and the theme must cycle. It also
 * asserts zero unhandled rejections and zero console errors.
 *
 * FAILURE RULES: any FAIL step exits 1. A harness failure (server never
 * answers, Chrome never exposes a page, CDP attach fails) exits 2 — that is a
 * broken test, not a broken app. A run that cannot observe the page must never
 * report PASS.
 *
 * NEGATIVE CONTROL: --break <step> poisons that step's primary expectation
 * (e.g. it expects 3 rows where the fixture has 2). The run must then exit 1.
 * That is how we know the assertions actually gate the exit code instead of
 * passing for the wrong reason. Run it once by hand:
 *   node test/web-smoke.mjs --break library   -> exit 1
 *
 * USAGE: node test/web-smoke.mjs [--break <step>] [--keep] [--chrome <path>]
 *   --keep keeps the temp library and Chrome profile for inspection.
 *   CHROME_PATH (or --chrome) overrides the browser.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BOOT_TIMEOUT = 30000;
const STEP_TIMEOUT = 30000;
const PAGE_TIMEOUT = 15000;
const STEPS = ['library', 'play', 'seek', 'modes', 'search', 'theme', 'clean'];

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

const BREAK = arg('break', '');
const KEEP = process.argv.includes('--keep');
const CHROME = arg('chrome', process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');

// ------------------------------------------------------------------ reporting

const results = [];

function line(status, title, detail) {
  console.log(`${status.padEnd(7)} ${title}${detail ? ' — ' + detail : ''}`);
}

async function step(id, title, fn) {
  try {
    const out = await withTimeout(fn(), STEP_TIMEOUT, title);
    if (!out || !out.ok) {
      const detail = (out && out.detail) || 'assertion failed';
      results.push({ id, title, status: 'FAIL', detail });
      line('FAIL', title, detail);
      return;
    }
    results.push({ id, title, status: 'PASS', detail: out.detail || '' });
    line('PASS', title, out.detail || '');
  } catch (e) {
    results.push({ id, title, status: 'FAIL', detail: e.message });
    line('FAIL', title, e.message);
  }
}

/* A step collects every assertion it makes and reports all of them, so one
   broken expectation does not hide the next. */
function checks() {
  const bad = [];
  const good = [];
  return {
    eq(actual, expected, what) {
      if (Object.is(actual, expected)) good.push(`${what}=${JSON.stringify(actual)}`);
      else bad.push(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    /* The second string is the pass label; the third is what a failure says,
       so a red line never reads like a green one. */
    truthy(v, what, fail) {
      if (v) good.push(what);
      else bad.push(fail || what);
    },
    near(actual, expected, tol, what) {
      if (Math.abs(actual - expected) <= tol) good.push(`${what}=${actual.toFixed(2)}`);
      else bad.push(`${what}: expected ${expected.toFixed(2)}±${tol.toFixed(2)}, got ${actual.toFixed(2)}`);
    },
    done() {
      return bad.length ? { ok: false, detail: bad.join('; ') } : { ok: true, detail: good.join(', ') };
    },
  };
}

function withTimeout(p, ms, what) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${what}: timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ fixture

/* A WAV is the one format every Chromium build decodes without a codec pack,
   and it is "native" to the app (lib/parse-name.js), so the web shell serves it
   straight from the library instead of asking a shell to transcode it. Two
   tracks with distinct artists make the search assertion meaningful. */
function wav(seconds, freq) {
  const rate = 44100;
  const n = Math.round(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.25 * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); // byte rate
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'measured-web-'));
  mkdirSync(join(root, 'songs'), { recursive: true });
  /* Names are chosen to survive the parser's promo filter: a title ending in
     "Song" loses that word (it is a promo token), which would make the
     assertions below test the parser instead of the shell. */
  writeFileSync(join(root, 'songs', 'Other Act - Second Take.wav'), wav(4, 220));
  writeFileSync(join(root, 'songs', 'Smoke Artist - Smoke Title.wav'), wav(8, 440));
  return root;
}

// ------------------------------------------------------------------ processes

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* The real dev server, not a stub: the point is to exercise the same
   /api/tracks + Range-serving path the app uses in development. */
async function startServer(root, port) {
  const proc = spawn(process.execPath, [join(ROOT, 'server.cjs'), root, String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`server exited ${proc.exitCode}: ${log.trim()}`);
    try {
      const j = await fetchJson(url + 'api/tracks');
      if (j && j.count === 2) return { proc, url, log: () => log };
    } catch (e) { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server never answered /api/tracks: ${log.trim()}`);
    await sleep(150);
  }
}

async function launchChrome(port, profile) {
  const proc = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    /* Headless has no audio device and no real gesture history; without this
       the element can reject play() for reasons that have nothing to do with
       the app. The click below is still a real CDP input event. */
    '--autoplay-policy=no-user-gesture-required',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  proc.on('error', (e) => { err += e.message; });
  const deadline = Date.now() + BOOT_TIMEOUT;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`chrome exited ${proc.exitCode}: ${err.trim()}`);
    try {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return { proc, page };
    } catch (e) { /* not listening yet */ }
    await sleep(120);
  }
  throw new Error(`chrome never exposed a page on port ${port}: ${err.trim()}`);
}

// ------------------------------------------------------------------ cdp

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
        else res(msg.result);
        return;
      }
      if (msg.method) for (const l of this.listeners) l(msg);
    });
  }
  on(fn) { this.listeners.push(fn); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`${method}: no reply after 20000 ms`));
        }
      }, 20000);
    });
  }
  close() {
    try { this.ws.close(); } catch (e) { /* already gone */ }
  }
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { try { ws.close(); } catch (e) {} rej(new Error('websocket open timed out')); }, 10000);
    ws.addEventListener('open', () => { clearTimeout(t); res(ws); });
    ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('websocket failed to open')); });
  });
}

/* Installed as an init script: it runs before the document's own scripts on
   every navigation, so a rejection during boot lands in the collector instead
   of in the void. Kept as a string because it must survive the CDP boundary. */
const COLLECTOR = `(() => {
  const S = window.__smoke = window.__smoke || { rejections: [], errors: [], console: [] };
  const str = (v) => {
    try {
      if (v && v.stack) return String(v.stack);
      if (v && v.message) return String(v.message);
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object') return JSON.stringify(v);
      return String(v);
    } catch (e) { return '<unprintable>'; }
  };
  addEventListener('unhandledrejection', (e) => { S.rejections.push(str(e.reason)); });
  addEventListener('error', (e) => { S.errors.push(str(e.error || e.message)); });
  for (const lv of ['error', 'warn']) {
    const orig = console[lv].bind(console);
    console[lv] = (...a) => { try { S.console.push(lv + ': ' + a.map(str).join(' ')); } catch (e) {} orig(...a); };
  }
  return true;
})()`;

// ------------------------------------------------------------------ page helpers

function makePage(cdp) {
  const evaluate = async (expression, timeout = PAGE_TIMEOUT) => {
    const r = await withTimeout(
      cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      timeout,
      'Runtime.evaluate',
    );
    if (r.exceptionDetails) {
      const t = r.exceptionDetails.exception && (r.exceptionDetails.exception.description || r.exceptionDetails.exception.value);
      throw new Error('page exception: ' + (t || r.exceptionDetails.text));
    }
    return r.result ? r.result.value : undefined;
  };

  const mouse = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, clickCount: 1, ...extra,
  });

  /* Centre of an element in CSS pixels, after scrolling it into view. Fails
     loudly instead of clicking (0,0) when the element is missing or has no box.
     A slide-in panel is briefly outside the viewport, so give transitions a
     moment rather than clicking off-screen coordinates. */
  const centre = async (sel) => {
    const deadline = Date.now() + 2500;
    let last = null;
    for (;;) {
      const r = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return { missing: true };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const b = el.getBoundingClientRect();
        if (!b.width || !b.height) return { missing: true, w: b.width, h: b.height };
        return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, vw: innerWidth, vh: innerHeight };
      })()`);
      if (r && !r.missing) {
        if (r.x > 0 && r.y > 0 && r.x < r.vw && r.y < r.vh) return r;
        last = r;
      } else {
        last = last || r;
      }
      if (Date.now() >= deadline) {
        if (r && r.missing) throw new Error(`element not visible: ${sel}`);
        throw new Error(`element off-screen after 2.5 s: ${sel} at ${Math.round(last.x)},${Math.round(last.y)} in ${last.vw}x${last.vh}`);
      }
      await sleep(120);
    }
  };

  const click = async (sel) => {
    const c = await centre(sel);
    /* A coordinate click only means anything if the target is what sits under
       the cursor. Naming the covering element turns "the button did nothing"
       into a failure someone can act on. */
    const top = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      const hit = document.elementFromPoint(${c.x}, ${c.y});
      if (!hit) return { hit: 'nothing' };
      const cls = typeof hit.className === 'string' && hit.className.trim()
        ? '.' + hit.className.trim().split(/\\s+/).join('.') : '';
      return { hit: hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + cls, contains: el === hit || el.contains(hit) };
    })()`);
    if (top && !top.contains) {
      throw new Error(`${sel} is covered by ${top.hit} at ${Math.round(c.x)},${Math.round(c.y)}`);
    }
    await mouse('mouseMoved', c.x, c.y, { buttons: 0 });
    await mouse('mousePressed', c.x, c.y, { button: 'left', buttons: 1 });
    await mouse('mouseReleased', c.x, c.y, { button: 'left', buttons: 0 });
    return c;
  };

  /* The seek rail is bound with pointer events; Chromium synthesises those from
     mouse input, so a real press-move-release is the same path a hand takes. */
  const drag = async (sel, fromFrac, toFrac) => {
    const c = await centre(sel);
    const x0 = c.x - c.w / 2 + c.w * fromFrac;
    const x1 = c.x - c.w / 2 + c.w * toFrac;
    await mouse('mouseMoved', x0, c.y, { buttons: 0 });
    await mouse('mousePressed', x0, c.y, { button: 'left', buttons: 1 });
    for (let i = 1; i <= 6; i++) {
      await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 6, c.y, { button: 'left', buttons: 1 });
      await sleep(16);
    }
    await mouse('mouseReleased', x1, c.y, { button: 'left', buttons: 0 });
    return { ...c, x0, x1 };
  };

  const key = async (k, code, vk) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  };

  const waitFor = async (expr, ms, what) => {
    const deadline = Date.now() + ms;
    let last = null;
    while (Date.now() < deadline) {
      try {
        const v = await evaluate(expr, 5000);
        if (v) return v;
        last = v;
      } catch (e) { last = e.message; }
      await sleep(150);
    }
    throw new Error(`${what || expr}: not true after ${ms} ms (last: ${JSON.stringify(last)})`);
  };

  const attr = (sel, name) => evaluate(`document.querySelector(${JSON.stringify(sel)}).getAttribute(${JSON.stringify(name)})`);

  return { evaluate, click, drag, key, waitFor, attr };
}

/* Cleanup must never change the verdict: a temp directory Chrome still holds
   open is disposable, and turning that into exit 2 would hide a real FAIL. */
async function stop(proc) {
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((r) => proc.once('exit', r));
  try { proc.kill(); } catch (e) { /* already gone */ }
  await Promise.race([exited, sleep(3000)]);
}

// ------------------------------------------------------------------ main

async function main() {
  if (BREAK && !STEPS.includes(BREAK)) {
    console.error(`--break: unknown step "${BREAK}" (one of: ${STEPS.join(', ')})`);
    process.exit(2);
  }

  const fixture = makeFixture();
  const profile = mkdtempSync(join(tmpdir(), 'measured-chrome-'));
  let server = null;
  let chrome = null;
  let cdp = null;

  try {
    const port = await freePort();
    server = await startServer(fixture, port);
    const cdpPort = await freePort();
    chrome = await launchChrome(cdpPort, profile);
    const ws = await connect(chrome.page.webSocketDebuggerUrl);
    cdp = new CDP(ws);

    const exceptions = [];
    const consoleErrors = [];
    const logErrors = [];
    const responses = [];
    const text = (d) => {
      if (!d) return '<no details>';
      const e = d.exception;
      return (e && (e.description || e.value)) || d.text || '<no text>';
    };
    cdp.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') exceptions.push(text(msg.params.exceptionDetails));
      else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map((a) => a.value || a.description || a.type).join(' '));
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        /* A failed subresource is a network fact, not a JS console error; the
           app is allowed to 404 a thumb. Only script-level errors count. */
        if (msg.params.entry.source !== 'network') logErrors.push(msg.params.entry.text);
      } else if (msg.method === 'Network.responseReceived') {
        responses.push({ requestId: msg.params.requestId, url: msg.params.response.url, status: msg.params.response.status });
      }
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: COLLECTOR });
    await cdp.send('Page.navigate', { url: server.url });

    const page = makePage(cdp);
    const { evaluate, click, drag, key, waitFor, attr } = page;

    console.log(`web smoke: ${server.url} (fixture ${fixture})`);
    if (BREAK) console.log(`NEGATIVE CONTROL: assertion "${BREAK}" is poisoned; this run must fail`);

    // ---------------------------------------------------------------- library

    await step('library', 'library populates from /api/tracks', async () => {
      const a = checks();
      const poison = BREAK === 'library';
      const rows = await waitFor(`document.querySelectorAll('#list .row').length`, 20000, 'library rows');
      a.eq(rows, poison ? 3 : 2, 'rows');
      a.eq(await evaluate(`document.getElementById('count').textContent`), poison ? '3 tracks' : '2 tracks', '#count');
      a.eq(await evaluate(`document.getElementById('libcount').textContent`), poison ? '3/3' : '2/2', '#libcount');
      const listed = await evaluate(`[...document.querySelectorAll('#list .row')].map((r) => r.querySelector('b').textContent + ' / ' + r.querySelector('i').textContent)`);
      a.eq(listed.join(' | '), poison ? 'poisoned' : 'Second Take / Other Act | Smoke Title / Smoke Artist', 'rows');
      /* The rows must come from the app's own request, not from a fixture the
         test injected: read the response body the page actually received. */
      const hit = responses.filter((r) => /\/api\/tracks$/.test(r.url)).pop();
      a.truthy(!!hit, 'app requested /api/tracks', `no /api/tracks response was seen (${responses.length} responses)`);
      if (hit) {
        a.eq(hit.status, 200, 'status');
        const body = await cdp.send('Network.getResponseBody', { requestId: hit.requestId });
        const json = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body);
        a.eq(json.count, poison ? 3 : 2, 'api count');
      }
      return a.done();
    });

    // ---------------------------------------------------------------- play

    await step('play', 'a local track plays and advances time', async () => {
      const a = checks();
      const poison = BREAK === 'play';
      await click('#list .row:nth-child(1)');
      await waitFor(`(() => { const el = document.getElementById('audio'); return !el.paused && el.currentTime > 0.3; })()`, 15000, 'playback');
      const t0 = await evaluate(`document.getElementById('audio').currentTime`);
      /* Wait for the advance instead of sleeping a fixed time: a starved
         renderer would otherwise fail a working player. A frozen clock still
         fails, because the wait has a deadline. */
      await waitFor(`document.getElementById('audio').currentTime > ${t0 + 0.6}`, 8000, 'currentTime advance');
      const t1 = await evaluate(`document.getElementById('audio').currentTime`);
      a.truthy(t1 > t0 + (poison ? 999 : 0.6), `currentTime advanced ${t0.toFixed(2)} → ${t1.toFixed(2)}`, `currentTime did not advance: ${t0.toFixed(2)} → ${t1.toFixed(2)}`);
      a.eq(await attr('#play', 'aria-pressed'), 'true', '#play aria-pressed');
      a.eq(await attr('#play', 'aria-label'), 'Pause', '#play aria-label');
      a.eq(await evaluate(`document.getElementById('artist').textContent`), poison ? 'Wrong Artist' : 'Other Act', '#artist');
      a.eq(await evaluate(`document.getElementById('title').textContent`), poison ? 'Wrong Title' : 'Second Take', '#title');
      a.truthy((await evaluate(`document.getElementById('time').textContent`)) !== '0:00 / 0:00', '#time painted', '#time still reads 0:00 / 0:00');
      return a.done();
    });

    // ---------------------------------------------------------------- seek

    await step('seek', 'seek drag moves playback', async () => {
      const a = checks();
      const poison = BREAK === 'seek';
      const dur = await evaluate(`document.getElementById('audio').duration`);
      a.truthy(dur > 3, `duration ${Number(dur).toFixed(2)} s`, `duration too short: ${dur}`);
      await drag('#seek', 0.1, 0.6);
      await sleep(400);
      const at = await evaluate(`document.getElementById('audio').currentTime`);
      const want = dur * (poison ? 0.1 : 0.6);
      a.near(at, want, dur * 0.12, 'currentTime');
      const now = await evaluate(`Number(document.getElementById('seek').getAttribute('aria-valuenow'))`);
      a.near(now, at, 1.5, 'aria-valuenow');
      return a.done();
    });

    // ---------------------------------------------------------------- modes

    await step('modes', 'shuffle and repeat toggle', async () => {
      const a = checks();
      const poison = BREAK === 'modes';
      await click('#shuffle');
      a.eq(await attr('#shuffle', 'aria-pressed'), 'true', 'shuffle pressed');
      a.eq(await attr('#shuffle', 'aria-label'), 'Shuffle on', 'shuffle label');
      await click('#shuffle');
      a.eq(await attr('#shuffle', 'aria-pressed'), 'false', 'shuffle released');
      await click('#repeat');
      a.eq(await attr('#repeat', 'aria-label'), poison ? 'Repeat one' : 'Repeat all', 'repeat 1');
      a.eq(await attr('#repeat', 'data-mode'), poison ? 'one' : 'all', 'repeat mode 1');
      await click('#repeat');
      a.eq(await attr('#repeat', 'aria-label'), 'Repeat one', 'repeat 2');
      await click('#repeat');
      a.eq(await attr('#repeat', 'aria-label'), 'Repeat off', 'repeat 3');
      return a.done();
    });

    // ---------------------------------------------------------------- search

    await step('search', 'search filters the library', async () => {
      const a = checks();
      const poison = BREAK === 'search';
      await click('#q');
      await cdp.send('Input.insertText', { text: 'smoke' });
      const n1 = await waitFor(`document.querySelectorAll('#list .row').length`, 8000, 'filtered rows');
      a.eq(n1, poison ? 2 : 1, 'rows for "smoke"');
      a.eq(await evaluate(`document.getElementById('libcount').textContent`), poison ? '2/2' : '1/2', '#libcount');
      a.eq(await evaluate(`document.querySelector('#list .row b').textContent`), 'Smoke Title', 'filtered title');
      await cdp.send('Input.insertText', { text: 'zzzz' });
      await waitFor(`document.querySelectorAll('#list .row').length === 0`, 8000, 'no-match rows');
      /* #count stays the library total by design (it labels the whole library,
         not the filter); #libcount is the "visible/total" pair. */
      a.eq(await evaluate(`document.getElementById('libcount').textContent`), poison ? '2/2' : '0/2', '#libcount empty');
      a.eq(await evaluate(`document.getElementById('count').textContent`), '2 tracks', '#count stays total');
      for (let i = 0; i < 9; i++) await key('Backspace', 'Backspace', 8);
      const n3 = await waitFor(`document.querySelectorAll('#list .row').length`, 8000, 'cleared rows');
      a.eq(n3, 2, 'rows after clear');
      return a.done();
    });

    // ---------------------------------------------------------------- theme

    await step('theme', 'theme cycles through all three modes', async () => {
      const a = checks();
      const poison = BREAK === 'theme';
      await click('#gear');
      await waitFor(`!document.getElementById('sheet').hidden`, 5000, 'sheet open');
      a.eq(await attr('#gear', 'aria-expanded'), 'true', 'gear expanded');
      await click('#th-dark');
      a.eq(await evaluate(`document.documentElement.dataset.theme`), poison ? 'liquid' : 'dark', 'theme dark');
      a.eq(await attr('#th-dark', 'aria-checked'), 'true', 'dark checked');
      await click('#th-liquid');
      a.eq(await evaluate(`document.documentElement.dataset.theme`), 'liquid', 'theme liquid');
      await click('#th-light');
      a.eq(await evaluate(`document.documentElement.dataset.theme`), 'light', 'theme light');
      await click('#sheet-x');
      await waitFor(`document.getElementById('sheet').hidden`, 5000, 'sheet closed');
      a.eq(await attr('#gear', 'aria-expanded'), 'false', 'gear collapsed');
      return a.done();
    });

    // ---------------------------------------------------------------- clean

    await step('clean', 'no unhandled rejections or console errors', async () => {
      const a = checks();
      const poison = BREAK === 'clean';
      await sleep(300);
      const snap = await evaluate(`JSON.parse(JSON.stringify(window.__smoke || {}))`);
      const rejections = snap.rejections || [];
      const errors = snap.errors || [];
      const consoleErrs = (snap.console || []).filter((l) => /^error:/.test(l));
      a.eq(rejections.length, poison ? 1 : 0, 'unhandled rejections' + (rejections.length ? ': ' + rejections.join(' | ') : ''));
      a.eq(errors.length, 0, 'window errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
      a.eq(consoleErrs.length, 0, 'console.error' + (consoleErrs.length ? ': ' + consoleErrs.join(' | ') : ''));
      a.eq(exceptions.length, 0, 'uncaught exceptions' + (exceptions.length ? ': ' + exceptions.join(' | ') : ''));
      a.eq(consoleErrors.length, 0, 'CDP console errors' + (consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''));
      a.eq(logErrors.length, 0, 'log errors' + (logErrors.length ? ': ' + logErrors.join(' | ') : ''));
      a.eq(await evaluate(`document.querySelectorAll('[role=alert]').length`), 0, 'boot alert box');
      return a.done();
    });

    // ---------------------------------------------------------------- verdict

    const pass = results.filter((r) => r.status === 'PASS').length;
    const fail = results.filter((r) => r.status === 'FAIL').length;
    console.log(`\nsteps ${pass} pass, ${fail} fail`);
    if (fail) {
      console.log('VERDICT FAIL');
      process.exitCode = 1;
    } else {
      console.log('VERDICT PASS');
      process.exitCode = 0;
    }
  } finally {
    if (cdp) cdp.close();
    await stop(chrome && chrome.proc);
    await stop(server && server.proc);
    if (!KEEP) {
      for (const dir of [fixture, profile]) {
        try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (e) { /* disposable */ }
      }
    } else {
      console.log(`kept: ${fixture} ${profile}`);
    }
  }
}

main().catch((e) => {
  console.error('harness error: ' + e.message);
  process.exit(2);
});
