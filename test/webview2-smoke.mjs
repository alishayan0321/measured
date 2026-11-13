#!/usr/bin/env node
/* WebView2 smoke test for the packaged desktop app.
 *
 * The release exe is a Tauri/WebView2 window, so nothing in CI could see it:
 * `cargo test` covers the Rust side and the node tests cover the web shell, but
 * the packaged artifact itself (capability ACL, CSP, asset protocol, the real
 * WebView2 runtime) was only ever checked by hand. That is how a shipped build
 * got two unhandled rejections at boot — `Command plugin:event|listen not
 * allowed by ACL` — with every test green.
 *
 * This harness drives the exe the same way a user does: it launches it with a
 * remote-debugging port, attaches over CDP, reloads once with collectors
 * installed BEFORE the document runs, then clicks the real controls.
 *
 * Why reload: the page boots the moment the process starts, so by the time we
 * can attach the interesting part of the boot has already happened. A reload
 * gives the collectors a guaranteed front-row seat for a full boot, and the
 * boot path is identical (it is the same document, freshly evaluated).
 *
 * Failure rules:
 *   - any unhandled promise rejection fails the run (not only the known ones);
 *   - any uncaught error fails the run;
 *   - any console line matching /not allowed by ACL|Uncaught/ fails the run;
 *   - a click step that throws or whose assertion fails fails the run;
 *   - the library must paint at least one row;
 *   - a BLOCKED step fails the run, with one exception: the native file picker
 *     is BLOCKED by design. It is an OS-level modal dialog, the one surface CDP
 *     can neither observe nor dismiss, and a renderer waiting on it stops
 *     answering Runtime.evaluate — so a read that times out after the click is
 *     the expected evidence that the dialog is up, not a failure.
 * A step that cannot run because the environment lacks something (network, a
 * playable track) is still reported as BLOCKED with the observed reason — but
 * it fails the verdict instead of quietly shrinking the surface, so a broken
 * environment cannot come out green. This file never pretends to have tested
 * what it did not.
 *
 * Because the picker blocks the page, the page collectors are snapshotted
 * BEFORE the picker is clicked and the verdict is computed from that snapshot.
 * No unguarded CDP call may run after #act-add, and the picker step is last for
 * that same reason: reading the collectors afterwards is what once turned a
 * blocked picker into a harness error (exit 2).
 *
 * Exit codes: 0 pass, 1 fail, 2 harness error (could not attach, exe missing).
 *
 * Usage:
 *   node test/webview2-smoke.mjs --exe "%LOCALAPPDATA%\MEASURED\MEASURED.exe"
 *   node test/webview2-smoke.mjs --exe <pre-fix exe> --expect-rejections 2
 *   node test/webview2-smoke.mjs --exe <any exe> --expect-rejections 2 \
 *        --expect-match "some other text"        # must exit non-zero
 *
 * `--expect-rejections` turns the run into a negative control: it passes only
 * if exactly that many unhandled rejections occurred AND every --expect-match
 * substring appears in one of them. When --expect-match is omitted with a
 * positive count the signature defaults to "not allowed by ACL", so a run that
 * counts two arbitrary rejections cannot pass. That is how the pre-fix artifact
 * proves the harness can actually see the defect it was written for, and how a
 * wrong signature proves it is not just counting.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// ------------------------------------------------------------------ args

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const allArgs = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--' + name && argv[i + 1]) out.push(argv[i + 1]);
  }
  return out;
};

const exeArg = arg('exe', '');
if (!exeArg || exeArg === true) {
  console.error('usage: node test/webview2-smoke.mjs --exe <path-to-MEASURED.exe> [--expect-rejections N] [--expect-match <substring>]');
  process.exit(2);
}
const EXE = resolve(String(exeArg));
const SONGS = arg('songs', '');
const expectRejections = arg('expect-rejections', null);
const expectMatchesArg = allArgs('expect-match');
// A negative control that names no signature would accept any N rejections,
// which is exactly the false green this harness exists to prevent. With a
// positive count, default to the defect string the pre-fix artifact emits.
const expectMatches = expectMatchesArg.length
  ? expectMatchesArg
  : expectRejections !== null && Number(expectRejections) > 0
    ? ['not allowed by ACL']
    : [];
if (expectRejections !== null && !/^\d+$/.test(String(expectRejections))) {
  console.error(`harness: --expect-rejections wants a non-negative integer, got ${JSON.stringify(expectRejections)}`);
  process.exit(2);
}
const STEP_TIMEOUT = Number(arg('step-timeout', 40000));
const BOOT_TIMEOUT = Number(arg('boot-timeout', 40000));
// Once #act-add is clicked the renderer stops answering for as long as the
// modal picker is up, so every read from that point on must be short: a wedged
// page should cost a few seconds and a BLOCKED step, never a 15 s default
// evaluate timeout and a harness error. The settle window gives the OS dialog
// time to appear before the probe read runs.
const PICKER_SETTLE_MS = 2500;
const PICKER_READ_TIMEOUT = 4000;
// The verdict's input is read before the picker, where the page still answers;
// the same short budget applies so a slow page cannot look like a dead one.
const SNAPSHOT_TIMEOUT = 4000;

let exeStat;
try {
  exeStat = statSync(EXE);
} catch (e) {
  console.error(`harness: cannot stat ${EXE}: ${e.message}`);
  process.exit(2);
}
const exeSha = createHash('sha256').update(readFileSync(EXE)).digest('hex').toUpperCase();

// ------------------------------------------------------------------ output

const results = [];
function line(status, name, detail) {
  const tag = status.padEnd(7);
  console.log(`${tag} ${name}${detail ? ' — ' + detail : ''}`);
}
async function step(name, fn) {
  const started = Date.now();
  try {
    const out = await withTimeout(fn(), STEP_TIMEOUT, name);
    if (out && out.blocked) {
      results.push({ name, status: 'BLOCKED', detail: out.blocked, ms: Date.now() - started });
      line('BLOCKED', name, out.blocked);
      return;
    }
    if (!out || !out.ok) {
      results.push({ name, status: 'FAIL', detail: (out && out.detail) || 'assertion failed', ms: Date.now() - started });
      line('FAIL', name, (out && out.detail) || 'assertion failed');
      return;
    }
    results.push({ name, status: 'PASS', detail: out.detail || '', ms: Date.now() - started });
    line('PASS', name, out.detail || '');
  } catch (e) {
    results.push({ name, status: 'FAIL', detail: e.message, ms: Date.now() - started });
    line('FAIL', name, e.message);
  }
}

function withTimeout(p, ms, what) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${what}: timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ port + cdp

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

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
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
      if (msg.method) {
        this.events.push(msg);
        for (const l of this.listeners) l(msg);
      }
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

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function attach(port, deadline) {
  const base = `http://127.0.0.1:${port}`;
  let lastErr = null;
  let fallback = null;
  const startedAt = deadline - BOOT_TIMEOUT;
  while (Date.now() < deadline) {
    try {
      const list = await fetchJson(`${base}/json/list`);
      const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && !/^devtools:/i.test(t.url || ''));
      // WebView2 lists an about:blank document first and fills in the app URL a
      // moment later. Binding to that early target puts the whole session on the
      // wrong document, so wait for the app URL and only fall back if it never
      // appears.
      const app = pages.find((t) => /tauri\.localhost|index\.html|^https?:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(t.url || ''));
      if (app) return app;
      fallback = fallback || pages[0] || null;
      if (fallback && Date.now() - startedAt > 8000) return fallback;
    } catch (e) { lastErr = e; }
    await sleep(120);
  }
  if (fallback) return fallback;
  throw new Error(`no CDP page target on ${base}/json/list (${lastErr ? lastErr.message : 'empty list'})`);
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { try { ws.close(); } catch (e) {} rej(new Error('websocket open timed out')); }, 10000);
    ws.addEventListener('open', () => { clearTimeout(t); res(ws); });
    ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('websocket error')); });
  });
}

// ------------------------------------------------------------------ the page script

/* Installed as an init script: runs before the document's own scripts on every
   navigation, so the two boot rejections land in the collector instead of in
   the void. Kept as a string because it must survive the CDP boundary. */
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
  addEventListener('unhandledrejection', (e) => {
    S.rejections.push(str(e.reason));
  });
  addEventListener('error', (e) => {
    S.errors.push(str(e.error || e.message));
  });
  for (const lv of ['error', 'warn']) {
    const orig = console[lv].bind(console);
    console[lv] = (...a) => { try { S.console.push(lv + ': ' + a.map(str).join(' ')); } catch (e) {} orig(...a); };
  }
  return true;
})()`;

// ------------------------------------------------------------------ page helpers

function makePage(cdp) {
  const evaluate = async (expression, timeout = 15000) => {
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

  // Centre of an element in CSS pixels, after scrolling it into view. Fails
  // loudly instead of clicking (0,0) when the element is missing or has no box.
  // A slide-in panel is briefly outside the viewport, so give transitions a
  // moment rather than clicking off-screen coordinates.
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
    // A coordinate click only means anything if the target is what sits under
    // the cursor. Naming the covering element turns "the button did nothing"
    // into a failure someone can act on.
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

  // Sheets and the now-playing cover layer are modal-ish and persist in
  // settings.json between runs, so a fresh process can boot with one already
  // open. Escape is the app's own dismissal path; the steps then test the
  // surface they name instead of whatever an earlier run left behind.
  const esc = async () => {
    for (let i = 0; i < 3; i++) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await sleep(180);
      const open = await evaluate(`(() => {
        const ids = ['np-scrim', 'scrim'];
        return ids.filter((id) => { const e = document.getElementById(id); return e && !e.hidden && getComputedStyle(e).display !== 'none'; });
      })()`);
      if (!open || !open.length) return true;
    }
    return false;
  };

  return { evaluate, click, drag, centre, waitFor, mouse, esc };
}

// ------------------------------------------------------------------ main

async function main() {
  const port = await freePort();
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  };
  if (SONGS && SONGS !== true) env.MEASURED_SONGS = String(SONGS);

  console.log(`exe        ${EXE}`);
  console.log(`bytes      ${exeStat.size}`);
  console.log(`sha256     ${exeSha}`);
  console.log(`cdp port   ${port}`);
  if (env.MEASURED_SONGS) console.log(`songs      ${env.MEASURED_SONGS}`);
  console.log('');

  const child = spawn(EXE, [], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  let childOut = '';
  child.stdout.on('data', (d) => { childOut += d.toString(); });
  child.stderr.on('data', (d) => { childOut += d.toString(); });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  let cdp = null;
  const consoleLines = [];
  const pageErrors = [];
  try {
    const target = await attach(port, Date.now() + BOOT_TIMEOUT);
    const ws = await connect(target.webSocketDebuggerUrl);
    cdp = new CDP(ws);
    cdp.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const args = (msg.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type)));
        consoleLines.push(`${msg.params.type}: ${args.join(' ')}`);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        pageErrors.push((d.exception && (d.exception.description || d.exception.value)) || d.text || 'exception');
      } else if (msg.method === 'Log.entryAdded') {
        consoleLines.push(`${msg.params.entry.level}: ${msg.params.entry.text}`);
      }
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: COLLECTOR });

    const page = makePage(cdp);

    // A reload gives the collectors the whole boot. Without it the rejections,
    // which fire before we can attach, would be invisible.
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(400);
    await page.waitFor("document.readyState === 'complete'", BOOT_TIMEOUT, 'document readyState');
    // Naming the document the CDP session actually landed on saves a whole
    // debugging round when the app serves an error page instead of the shell.
    const where = await page.evaluate(`(() => ({
      url: location.href,
      title: document.title,
      nodes: document.querySelectorAll('*').length,
      text: (document.body ? document.body.textContent : '').replace(/\\s+/g, ' ').trim().slice(0, 200)
    }))()`);
    console.log(`page       ${where.url} — ${where.nodes} nodes, title ${JSON.stringify(where.title)}`);
    if (where.nodes < 100) console.log(`page text  ${JSON.stringify(where.text)}`);
    if (/^about:/i.test(where.url)) throw new Error(`attached to ${where.url}; the app page never loaded`);
    const rows = await page.waitFor(
      "(() => { const n = document.querySelectorAll('.row').length; return n > 0 ? n : 0; })()",
      BOOT_TIMEOUT,
      '.row painted',
    ).catch(() => 0);
    // Late rejections (a promise chain that settles after paint) still belong to
    // the boot we are judging.
    await sleep(1500);

    const bootRejections = await page.evaluate('window.__smoke.rejections.slice()');
    console.log(`rows       ${rows}`);
    // A library that never painted would turn every playback assertion below
    // into BLOCKED, and without this row the run could still exit 0 with no
    // working player at all. Assert it where the cause is still visible.
    results.push({
      name: 'library rows rendered',
      status: rows >= 1 ? 'PASS' : 'FAIL',
      detail: `${rows} row(s)`,
      ms: 0,
    });
    line(rows >= 1 ? 'PASS' : 'FAIL', 'library rows rendered', `${rows} row(s)`);
    console.log('');

    // ------------------------------------------------------------- steps

    // Sheet state survives in settings.json, so a previous run can leave the
    // now-playing cover over the transport.
    await page.esc();

    await step('settings sheet opens', async () => {
      await page.click('#gear');
      const state = await page.evaluate(`(() => ({
        expanded: document.getElementById('gear').getAttribute('aria-expanded'),
        hidden: document.getElementById('sheet').hidden,
        sheetOpen: document.body.classList.contains('sheet-open'),
        note: (document.getElementById('act-note') || {}).textContent || ''
      }))()`);
      if (state.expanded !== 'true' || state.hidden || !state.sheetOpen) {
        return { ok: false, detail: JSON.stringify(state) };
      }
      return { ok: true, detail: `aria-expanded=true, sheet visible` };
    });

    await step('theme cycle (dark → liquid → light)', async () => {
      const got = [];
      for (const [id, want] of [['#th-dark', 'dark'], ['#th-liquid', 'liquid'], ['#th-light', 'light']]) {
        await page.click(id);
        const theme = await page.evaluate('document.documentElement.getAttribute("data-theme")');
        got.push(`${id}→${theme}`);
        if (theme !== want) return { ok: false, detail: `${id} set ${theme}, wanted ${want} (${got.join(', ')})` };
      }
      return { ok: true, detail: got.join(', ') };
    });

    await step('settings sheet closes', async () => {
      await page.click('#sheet-x');
      await sleep(350);
      const r = await page.evaluate(`(() => ({
        expanded: document.getElementById('gear').getAttribute('aria-expanded'),
        open: document.body.classList.contains('sheet-open')
      }))()`);
      if (r.expanded !== 'false' || r.open) return { ok: false, detail: JSON.stringify(r) };
      return { ok: true, detail: 'aria-expanded=false' };
    });

    // The library drawer and the Nowhere pane are mobile-width UI (app.css hides
    // .lib-btn above 760 px), so those steps run at a phone-sized viewport. The
    // app has to work at both widths anyway.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(300);

    await step('library drawer opens', async () => {
      await page.click('#lib-btn');
      try {
        const r = await page.evaluate(`(() => ({
          open: document.body.classList.contains('lib-open'),
          expanded: document.getElementById('lib-btn').getAttribute('aria-expanded')
        }))()`);
        if (!r.open || r.expanded !== 'true') return { ok: false, detail: JSON.stringify(r) };
        return { ok: true, detail: 'lib-open, aria-expanded=true' };
      } catch (e) {
        // Leave the drawer state alone for the diagnostic in the throw.
        throw e;
      }
    });

    // Rows live in the drawer, so the first playback test happens while it is
    // open — a coordinate click on a closed drawer would hit nothing.
    await step('a track plays', async () => {
      const n = await page.evaluate(`document.querySelectorAll('#list .row').length`);
      if (!n) return { blocked: 'library is empty' };
      await page.click('#list .row');
      await sleep(1200);
      const s = await page.evaluate(`(() => {
        const a = document.getElementById('audio');
        return { paused: a.paused, t: a.currentTime, dur: a.duration, src: (a.currentSrc || '').slice(0, 60), err: a.error ? a.error.code : null };
      })()`);
      if (s.paused || !(s.t > 0.2) || !isFinite(s.dur)) {
        return { ok: false, detail: JSON.stringify(s) };
      }
      return { ok: true, detail: `playing at ${s.t.toFixed(2)}s of ${s.dur.toFixed(1)}s` };
    });

    await step('Nowhere search (network)', async () => {
      const before = await page.evaluate(`document.querySelectorAll('#yt-list .vt-row').length`);
      const reachable = await page.evaluate(`(() => { try { return PlayerAPI.canDownload ? !!PlayerAPI.canDownload() : false; } catch (e) { return false; } })()`);
      if (!reachable) return { blocked: 'no downloader on this build (yt-dlp absent)' };
      // Picking a track closes the drawer, so reopen it for the Nowhere pane.
      if (!(await page.evaluate(`document.body.classList.contains('lib-open')`))) {
        await page.click('#lib-btn');
        await sleep(400);
      }
      await page.click('#tab-yt');
      await page.click('#yt-q');
      await page.evaluate(`(() => { const q = document.getElementById('yt-q'); q.value = 'citizen the artist'; q.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await page.click('#yt-go');
      const got = await page
        .waitFor(`(() => document.querySelectorAll('#yt-list .vt-row').length || 0)()`, 25000, 'yt results')
        .catch(() => 0);
      const note = await page.evaluate(`(document.getElementById('yt-note') || {}).textContent || ''`);
      if (!got) return { blocked: `search returned no results in 25 s (note: ${note || 'empty'}, before: ${before})` };
      return { ok: true, detail: `${got} results (note: ${note || 'empty'})` };
    });

    await step('like a stream', async () => {
      const n = await page.evaluate(`document.querySelectorAll('#yt-list .vt-row .like').length`);
      if (!n) return { blocked: 'no search results to like' };
      const before = await page.evaluate(`(() => { const b = document.querySelector('#yt-list .vt-row .like'); return b ? b.getAttribute('aria-pressed') : null; })()`);
      // The heart is inside a .vt-row button; a coordinate click would land on
      // the row and start playback instead, so activate the button itself.
      await page.evaluate(`(() => { const b = document.querySelector('#yt-list .vt-row .like'); if (b) b.click(); return true; })()`);
      await sleep(300);
      const after = await page.evaluate(`(() => { const b = document.querySelector('#yt-list .vt-row .like'); return b ? b.getAttribute('aria-pressed') : null; })()`);
      // Likes are persisted in settings, so a stream liked by an earlier run is
      // still liked when this run reaches it. The contract is that the heart
      // toggles; asserting the end state is always 'true' failed on every run
      // after the first one, for the wrong reason.
      if (after === null || after === before) return { ok: false, detail: `aria-pressed ${before} → ${after}` };
      return { ok: true, detail: `aria-pressed ${before} → ${after}` };
    });

    await page.click('#lib-x').catch(() => {});
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);

    await step('shuffle toggles', async () => {
      await page.click('#shuffle');
      const on = await page.evaluate(`document.getElementById('shuffle').getAttribute('aria-pressed')`);
      await page.click('#shuffle');
      const off = await page.evaluate(`document.getElementById('shuffle').getAttribute('aria-pressed')`);
      if (on !== 'true' || off !== 'false') return { ok: false, detail: `on=${on} off=${off}` };
      return { ok: true, detail: 'aria-pressed true → false' };
    });

    await step('repeat cycles off → all → one → off', async () => {
      const seen = [];
      for (let i = 0; i < 3; i++) {
        await page.click('#repeat');
        seen.push(await page.evaluate(`document.getElementById('repeat').getAttribute('data-mode')`));
      }
      const want = ['all', 'one', 'off'];
      if (seen.join(',') !== want.join(',')) return { ok: false, detail: `${seen.join(' → ')} (wanted ${want.join(' → ')})` };
      return { ok: true, detail: seen.join(' → ') };
    });

    await step('seek drag moves the playhead', async () => {
      const before = await page.evaluate('document.getElementById("audio").currentTime');
      const dur = await page.evaluate('document.getElementById("audio").duration');
      if (!isFinite(dur) || dur <= 0) return { blocked: 'no loaded track to seek' };
      await page.drag('#seek', 0.2, 0.7);
      await sleep(400);
      const after = await page.evaluate('document.getElementById("audio").currentTime');
      if (!(after > before + 0.5) || after < dur * 0.5) {
        return { ok: false, detail: `t ${before.toFixed(2)} → ${after.toFixed(2)} of ${dur.toFixed(1)}` };
      }
      return { ok: true, detail: `t ${before.toFixed(2)} → ${after.toFixed(2)} of ${dur.toFixed(1)}` };
    });

    await step('vinyl scrub grabs and moves the platter', async () => {
      const geo = await page.evaluate(`(() => {
        const d = document.getElementById('vd-spin') || document.getElementById('vd-disc');
        const deck = document.getElementById('deck');
        const a = document.getElementById('audio');
        if (!d || !deck || !a.src || !isFinite(a.duration) || a.duration <= 0) return null;
        d.scrollIntoView({ block: 'center' });
        const r = d.getBoundingClientRect();
        // The grab class can be added and dropped inside one frame, so sampling it
        // between mouse moves missed it: a run failed with is-scrubbing=false while
        // the playhead had still moved. Record every class change on the deck.
        window.__scrubSeen = false;
        if (window.__scrubObs) window.__scrubObs.disconnect();
        window.__scrubObs = new MutationObserver(() => {
          if (deck.classList.contains('is-scrubbing')) window.__scrubSeen = true;
        });
        window.__scrubObs.observe(deck, { attributes: true, attributeFilter: ['class'] });
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, rad: Math.min(r.width, r.height) * 0.35, t: a.currentTime };
      })()`);
      if (!geo) return { blocked: 'no loaded track / platter not addressable' };
      const x0 = geo.cx + geo.rad;
      const y0 = geo.cy;
      const x1 = geo.cx;
      const y1 = geo.cy - geo.rad;   // a quarter turn clockwise? (top) — 90° of arc
      await page.mouse('mouseMoved', x0, y0, { buttons: 0 });
      await page.mouse('mousePressed', x0, y0, { button: 'left', buttons: 1 });
      for (let i = 1; i <= 8; i++) {
        const a = (Math.PI / 2) * (i / 8);
        await page.mouse('mouseMoved', geo.cx + geo.rad * Math.cos(a), geo.cy - geo.rad * Math.sin(a), { button: 'left', buttons: 1 });
        await sleep(60);
      }
      await page.mouse('mouseReleased', x1, y1, { button: 'left', buttons: 0 });
      await sleep(300);
      const moved = await page.evaluate(`(() => {
        if (window.__scrubObs) { window.__scrubObs.disconnect(); window.__scrubObs = null; }
        return !!window.__scrubSeen;
      })()`);
      const after = await page.evaluate('document.getElementById("audio").currentTime');
      const delta = after - geo.t;
      if (!moved || Math.abs(delta) < 0.2) {
        return { ok: false, detail: `is-scrubbing=${moved} t ${geo.t.toFixed(2)} → ${after.toFixed(2)}` };
      }
      return { ok: true, detail: `is-scrubbing=true, t ${geo.t.toFixed(2)} → ${after.toFixed(2)}` };
    });

    // Grabbing the platter leaves the now-playing cover up on release.
    await page.esc();

    await step('transport buttons respond', async () => {
      const before = await page.evaluate('document.getElementById("audio").paused');
      await page.click('#mute');
      const muted = await page.evaluate('document.getElementById("audio").muted');
      await page.click('#mute');
      await page.click('#next');
      await sleep(700);
      const s = await page.evaluate('(() => { const a = document.getElementById("audio"); return { paused: a.paused, muted: a.muted, t: a.currentTime }; })()');
      if (s.muted !== false) return { ok: false, detail: `mute did not clear: ${JSON.stringify(s)}` };
      return { ok: true, detail: `mute toggled (${muted} → ${s.muted}), next → t=${s.t.toFixed(2)} (was paused=${before})` };
    });

    // ---------------------------------------------------------- collectors

    // The page collectors are the verdict's input and they must be read while
    // the page still answers. Clicking #act-add raises the native picker, and a
    // modal OS dialog stops the renderer's event loop: Runtime.evaluate never
    // returns. Reading them afterwards is what turned an earlier run into a
    // harness error (exit 2, "Runtime.evaluate: timed out") instead of the
    // blocked picker it really was. Snapshot once, short timeout, and take the
    // verdict from this snapshot.
    const snapshot = { rejections: [], errors: [], console: [] };
    try {
      Object.assign(snapshot, await page.evaluate(`(() => {
        const S = window.__smoke || {};
        return { rejections: (S.rejections || []).slice(), errors: (S.errors || []).slice(), console: (S.console || []).slice() };
      })()`, SNAPSHOT_TIMEOUT));
    } catch (e) {
      // An unreadable collector set cannot be assumed clean — that is exactly
      // the false green this harness exists to prevent — so it is a FAIL, and
      // the verdict then cannot pass on empty lists either.
      results.push({ name: 'collectors read before the picker', status: 'FAIL', detail: e.message, ms: 0 });
      line('FAIL', 'collectors read before the picker', e.message);
    }
    // The ACL denial this harness has actually seen (plugin:event|listen)
    // arrives at boot, and any other page-side denial lands in one of these
    // lists too; counting them here is what lets the blocked detail below say
    // the denial was absent rather than merely unobserved.
    const denialCount = [...snapshot.rejections, ...snapshot.errors, ...snapshot.console]
      .filter((s) => /not allowed by ACL|denied/i.test(String(s))).length;
    console.log('');
    console.log(`snapshot   ${snapshot.rejections.length} rejection(s), ${snapshot.errors.length} error(s), ` +
      `${snapshot.console.length} console line(s), ${denialCount} matching /not allowed by ACL|denied/ — read before the picker`);
    console.log('');

    // Last: this opens a native OS file dialog on the Rust side. Nothing in the
    // page can close it, so it runs after every other assertion AND after the
    // collectors snapshot; no unguarded CDP call may follow the click.
    await step('add songs invokes the native picker', async () => {
      await page.click('#gear');
      await sleep(300);
      await page.evaluate(`(() => { document.getElementById('act-note').textContent = ''; return true; })()`);
      const t0 = Date.now();
      await page.click('#act-add');
      // app.js writes #act-note only AFTER `await PlayerAPI.pickSongs()` returns,
      // and a modal OS dialog stops the renderer before it can get there. So one
      // short read is the probe: it answers → no dialog is up; it does not answer
      // → the dialog is up, which is BLOCKED (CDP cannot observe or dismiss an OS
      // modal), unless the process died, which is a real failure.
      await sleep(PICKER_SETTLE_MS);
      // Sampled where it is used, not once up front: a crash during the probe
      // read would otherwise be misreported as a dialog that is just being modal.
      const gone = () => (exited
        ? `the process exited (${exited.code === null ? 'signal ' + (exited.signal || 'unknown') : 'code ' + exited.code}) after the click`
        : '');
      let note;
      try {
        note = await page.evaluate(`(document.getElementById('act-note') || {}).textContent || ''`, PICKER_READ_TIMEOUT);
      } catch (e) {
        if (gone()) return { ok: false, detail: `#act-add clicked and ${gone()}; the read that failed was #act-note (${e.message})` };
        return {
          blocked:
            `#act-add clicked; the page stopped answering (#act-note unreadable ${Date.now() - t0} ms after the click: ${e.message}). ` +
            'That is what a modal native file dialog looks like — it runs on the OS side, so CDP can neither see nor dismiss it. ' +
            `The snapshot read before the click holds ${denialCount} matching /not allowed by ACL|denied/ line(s), ` +
            'and the verdict is computed from that snapshot, so a denied command cannot hide behind this step.',
        };
      }
      if (/Pick audio files/.test(note)) return { ok: true, detail: `note after ${Date.now() - t0} ms: ${note}` };
      if (/Could not open|No file picker|denied/i.test(note)) return { ok: false, detail: `note: ${note}` };
      if (gone()) return { ok: false, detail: `#act-add clicked, #act-note still empty, and ${gone()}` };
      return {
        blocked:
          `#act-add clicked, the page still answers but #act-note is empty after ${PICKER_SETTLE_MS} ms ` +
          '(it is written only once pickSongs resolves), so the picker surface was not exercised. ' +
          `No denial in the pre-click snapshot (${denialCount} matching line(s)).`,
      };
    });

    // ------------------------------------------------------------- verdict
    // Computed from the pre-picker snapshot only: the modal dialog may still be
    // holding the renderer, so nothing below may call into the page.
    // The snapshot is cumulative for the reloaded document, so it already
    // contains the boot state. Do not dedupe rejections: the count IS the
    // assertion, and the known defect is two events with an identical message.
    const rejections = [...snapshot.rejections];
    const errors = dedupe([...pageErrors, ...snapshot.errors]);
    const aclLines = dedupe([...consoleLines, ...snapshot.console]).filter((l) => /not allowed by ACL|Uncaught/i.test(l));

    // Exit info, if the window died on its own (a panic is a failure too).
    await sleep(300);
    const childText = childOut.trim();

    console.log('');
    const stepFails = results.filter((r) => r.status === 'FAIL');
    // The native picker is the only step CDP cannot see; every other BLOCKED
    // step means a named surface was never exercised, so it fails the run.
    const PICKER_STEP = 'add songs invokes the native picker';
    const stepBlocked = results.filter((r) => r.status === 'BLOCKED');
    const blockedOther = stepBlocked.filter((r) => r.name !== PICKER_STEP);

    let verdict;
    if (expectRejections !== null) {
      // Negative control: the run passes only if the known defect showed up with
      // exactly the expected signature.
      const want = Number(expectRejections);
      const missing = expectMatches.filter((m) => !rejections.some((r) => r.includes(m)));
      const okCount = rejections.length === want;
      verdict = okCount && missing.length === 0 && blockedOther.length === 0;
      console.log(`mode       negative control (--expect-rejections ${want})`);
      console.log(`signature  ${JSON.stringify(expectMatches)}`);
      console.log(`rejections ${rejections.length}/${want}${okCount ? ' counted' : ' MISMATCH'}`);
      if (missing.length) console.log(`missing    ${JSON.stringify(missing)}`);
    } else {
      verdict = rejections.length === 0 && errors.length === 0 && aclLines.length === 0
        && stepFails.length === 0 && blockedOther.length === 0;
    }

    if (rejections.length) {
      console.log('');
      console.log('unhandled rejections:');
      rejections.forEach((r, i) => console.log(`  [${i + 1}] ${r.split('\n')[0]}`));
    }
    if (errors.length) {
      console.log('');
      console.log('uncaught errors:');
      errors.forEach((r, i) => console.log(`  [${i + 1}] ${r.split('\n')[0]}`));
    }
    if (aclLines.length) {
      console.log('');
      console.log('ACL / Uncaught console lines:');
      aclLines.forEach((l, i) => console.log(`  [${i + 1}] ${l}`));
    }
    if (blockedOther.length) {
      console.log('');
      console.log(`blocked steps other than ${JSON.stringify(PICKER_STEP)} (a fail):`);
      blockedOther.forEach((r) => console.log(`  [${r.name}] ${r.detail}`));
    }
    if (childText) {
      console.log('');
      console.log('child stdout/stderr:');
      console.log(childText.split('\n').map((l) => '  ' + l).join('\n'));
    }
    if (exited && expectRejections === null && exited.code !== null && exited.code !== 0) {
      verdict = false;
      console.log(`\nprocess    exited with code ${exited.code}`);
    }

    console.log('');
    const passed = results.filter((r) => r.status === 'PASS').length;
    console.log(`steps      ${passed} pass, ${stepFails.length} fail, ${stepBlocked.length} blocked (${blockedOther.length} not the picker)`);
    console.log(`VERDICT    ${verdict ? 'PASS' : 'FAIL'}`);
    return verdict ? 0 : 1;
  } finally {
    if (cdp) cdp.close();
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (e) { /* best effort */ }
    await sleep(300);
  }
}

function dedupe(list) {
  return [...new Set(list.map((s) => String(s)))];
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('');
    console.error('harness error: ' + (e && e.stack ? e.stack : e));
    process.exit(2);
  });
