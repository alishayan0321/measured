/* Runtime check for the desktop CSP, without building a Tauri exe.

   Serves rust/desktop/dist with the exact Content-Security-Policy string from
   rust/desktop/tauri.conf.json, loads it in headless Chromium, and asserts:
     - zero securitypolicyviolation events
     - the YouTube iframe_api script the app injects actually loads
     - the deck paints and the transport is present
     - every transport/nav control still responds to a real mouse click

   The click pass exists because an empty violation list only proves that no
   inline handler *fired*. A control whose onclick attribute was stripped by CSP
   is silent, not loud: the button renders, the click lands, nothing happens.
   So each control is clicked with real input events and its handler is counted.

   The negative control runs in the same process: the same page is served with
   https://www.youtube.com removed from script-src, and the check only passes if
   that pass *fails* in the expected way. A green run therefore cannot be green
   because the probe stopped working.

   WebView2 is Chromium, so this is a valid proxy for the packaged window; it is
   not the packaged window itself. Run: node test/csp.check.cjs            */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const repo = path.resolve(__dirname, '..');
const dist = path.join(repo, 'rust', 'desktop', 'dist');
const CHROME =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function findCsp(node) {
  if (!node || typeof node !== 'object') return null;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'csp' && typeof v === 'string') return v;
    const hit = findCsp(v);
    if (hit) return hit;
  }
  return null;
}
const CSP =
  process.env.CSP_OVERRIDE ||
  findCsp(
    JSON.parse(fs.readFileSync(path.join(repo, 'rust', 'desktop', 'tauri.conf.json'), 'utf8'))
  );
if (!CSP) throw new Error('no csp string in tauri.conf.json');

/* The negative control: drop the YouTube origin from script-src only, so the
   injected iframe_api is blocked while everything else stays identical. */
const NEGATIVE_CSP = CSP.replace(/(script-src[^;]*)/, (m) =>
  m.replace(/https:\/\/www\.youtube\.com\s*/g, '')
);
if (NEGATIVE_CSP === CSP) {
  throw new Error('negative control could not remove youtube.com from script-src');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Each control is clicked for real and its handler counted. `check` is the
   observable the handler is supposed to produce; play/next/prev have none on an
   empty library, so for those the counter is the whole assertion. */
const STEPS = [
  { id: 'mute', sel: '#mute', check: "document.getElementById('mute').getAttribute('aria-pressed') === 'true'" },
  { id: 'shuffle', sel: '#shuffle', check: "document.getElementById('shuffle').getAttribute('aria-pressed') === 'true'" },
  { id: 'repeat', sel: '#repeat', check: "document.getElementById('repeat').getAttribute('aria-label') !== 'Repeat off'" },
  { id: 'play', sel: '#play', check: null },
  { id: 'next', sel: '#next', check: null },
  { id: 'prev', sel: '#prev', check: null },
  { id: 'settings', sel: '#gear', check: "document.getElementById('gear').getAttribute('aria-expanded') === 'true'" },
  { id: 'theme', sel: '#th-dark', check: "document.documentElement.getAttribute('data-theme') === 'dark'" },
  { id: 'close-settings', sel: '#sheet-x', check: "document.getElementById('gear').getAttribute('aria-expanded') === 'false'" },
  /* .lib-btn is display:none above 760px (styles/app.css, "phone" block), so the
     drawer only exists at phone width. Narrowing the viewport is the honest way
     to click it — the control is genuinely absent on a desktop window. */
  { id: 'library', sel: '#lib-btn', viewport: { width: 420, height: 900 },
    check: "document.getElementById('lib-btn').getAttribute('aria-expanded') === 'true'" },
];

async function runPass({ label, csp, port, cdpPort, expectBlocked }) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(dist, rel);
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Security-Policy': csp });
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Security-Policy': csp,
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    });
    fs.createReadStream(file).pipe(res);
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${port}/index.html`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'measured-csp-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch {}
  }
  if (!target) throw new Error(`${label}: chrome did not expose a page target`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails.text || 'exception');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const myId = ++id;
      pending.set(myId, res);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      throw new Error(`${label}: eval threw: ${r.result.exceptionDetails.text}`);
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__csp.push({
          directive: e.violatedDirective,
          blocked: e.blockedURI,
          sample: (e.sample || '').slice(0, 120),
        });
      });
    `,
  });

  await send('Page.navigate', { url });
  await sleep(6000);

  /* Click every control with real input events.

     Two different wiring styles are in play: the transport uses `el.onclick =`,
     the settings/library/theme controls use addEventListener. So a click is
     proven twice over — a capture-phase listener counts that the event reached
     the element at all, and the observable state change proves the handler ran.
     For play/next/prev there is no state to observe on an empty library, so the
     onclick property is wrapped and counted instead. A CSP-stripped inline
     handler leaves both counts at zero, which is the failure this catches. */
  await evaluate(`(() => {
    window.__hits = {};
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      for (const sel of ${JSON.stringify(STEPS.map((s) => s.sel))}) {
        if (t.closest(sel)) window.__hits[sel] = (window.__hits[sel] || 0) + 1;
      }
    }, true);
    return true;
  })()`);

  const clicks = [];
  for (const step of STEPS) {
    if (step.viewport) {
      await send('Emulation.setDeviceMetricsOverride', {
        ...step.viewport,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(350);
    }
    const armed = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(step.sel)});
      if (!el) return { ok: false, why: 'missing' };
      el.__fired = 0;
      if (typeof el.onclick === 'function') {
        const orig = el.onclick;
        el.onclick = function (e) { el.__fired++; return orig.call(this, e); };
      }
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);

    if (!armed || !armed.ok) {
      clicks.push({ id: step.id, hits: 0, onclickFired: 0, stateOk: null, why: armed ? armed.why : 'eval-failed' });
      continue;
    }
    if (armed.w < 1 || armed.h < 1) {
      clicks.push({ id: step.id, hits: 0, onclickFired: 0, stateOk: null, why: 'zero-size' });
      continue;
    }

    const x = Math.round(armed.x);
    const y = Math.round(armed.y);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(step.id === 'settings' ? 400 : 120);

    const onclickFired = await evaluate(
      `(document.querySelector(${JSON.stringify(step.sel)}) || {}).__fired || 0`
    );
    const hits = await evaluate(`(window.__hits[${JSON.stringify(step.sel)}] || 0)`);
    const stateOk = step.check ? await evaluate(`!!(${step.check})`) : null;
    clicks.push({ id: step.id, hits, onclickFired, stateOk });
  }

  const probe = await evaluate(`(async () => {
    const deck = document.querySelector('.deck');
    const transport = document.querySelector('.transport');
    const cs = deck ? getComputedStyle(deck) : null;
    const rect = deck ? deck.getBoundingClientRect() : null;

    // Exactly the element app.js:1801-1812 appends for the IFrame API, and the
    // same readiness rule app.js:1804-1809 waits for: onload fires before the
    // API has wired YT.Player, so poll for YT.loaded rather than trusting it.
    const yt = await new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      let loaded = false;
      s.onload = () => { loaded = true; };
      s.onerror = () => resolve({ loaded: false, hasYT: false, blocked: true });
      document.head.appendChild(s);
      const spin = setInterval(() => {
        if (window.YT && window.YT.Player && window.YT.loaded) {
          clearInterval(spin);
          resolve({ loaded, hasYT: true });
        }
      }, 120);
      setTimeout(() => {
        clearInterval(spin);
        resolve({ loaded, hasYT: !!(window.YT && window.YT.Player), timeout: true });
      }, 15000);
    });

    return {
      violations: window.__csp || [],
      deck: deck ? { w: Math.round(rect.width), h: Math.round(rect.height),
                     radius: cs.borderTopLeftRadius,
                     blur: cs.backdropFilter || cs.webkitBackdropFilter || 'none' } : null,
      transport: transport ? { buttons: transport.querySelectorAll('button').length } : null,
      yt,
      title: document.title,
    };
  })()`);

  ws.close();
  chrome.kill();
  server.close();
  await sleep(200);

  /* A control counts as responding when the click reached it AND its handler
     produced the observable it owns. play/next/prev have no observable on an
     empty library, so for those the wrapped onclick is the proof instead. */
  const responded = clicks.filter(
    (c) => c.hits > 0 && (c.stateOk === null ? c.onclickFired > 0 : c.stateOk === true)
  ).length;
  const clicked = responded;

  const base = {
    label,
    violations: probe.violations,
    deck: probe.deck,
    transport: probe.transport,
    yt: probe.yt,
    clicks,
    clicked,
    consoleErrors,
  };

  if (expectBlocked) {
    /* The negative control passes only when the YouTube script is actually
       blocked and reported. Anything else means the probe is not measuring. */
    const blocked = probe.violations.some(
      (v) => /script-src/.test(v.directive) && /youtube\.com/.test(v.blocked)
    );
    return {
      ...base,
      ok: blocked && probe.yt.hasYT === false && clicked === STEPS.length,
      expected: 'youtube.com blocked, one script-src violation, clicks still land',
    };
  }

  return {
    ...base,
    ok:
      probe.violations.length === 0 &&
      probe.yt.loaded &&
      probe.yt.hasYT &&
      probe.deck && probe.deck.w > 0 && probe.deck.h > 0 &&
      probe.transport && probe.transport.buttons > 0 &&
      clicked === STEPS.length,
    expected: 'no violations, youtube loads, deck paints, every control responds',
  };
}

async function main() {
  const positive = await runPass({
    label: 'csp',
    csp: CSP,
    port: Number(process.env.CSP_PORT || 8791),
    cdpPort: Number(process.env.CSP_CDP_PORT || 9333),
    expectBlocked: false,
  });
  const negative = await runPass({
    label: 'negative-control',
    csp: NEGATIVE_CSP,
    port: Number(process.env.CSP_PORT || 8791) + 1,
    cdpPort: Number(process.env.CSP_CDP_PORT || 9333) + 1,
    expectBlocked: true,
  });

  const ok = positive.ok && negative.ok;
  console.log(JSON.stringify({ ok, positive, negative }, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('CSP CHECK FAILED:', e.message);
  process.exit(1);
});
