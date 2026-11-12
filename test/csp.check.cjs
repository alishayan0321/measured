/* Runtime check for the desktop CSP, without building a Tauri exe.

   Serves rust/desktop/dist with the exact Content-Security-Policy string from
   rust/desktop/tauri.conf.json, loads it in headless Chromium, and asserts:
     - zero securitypolicyviolation events
     - the YouTube iframe_api script the app injects actually loads
     - the deck paints and the transport is present
   WebView2 is Chromium, so this is a valid proxy for the packaged window; it is
   not the packaged window itself. Run: node test/csp.check.cjs            */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const repo = path.resolve(__dirname, '..');
const dist = path.join(repo, 'rust', 'desktop', 'dist');
const PORT = Number(process.env.CSP_PORT || 8791);
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

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(dist, rel);
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Security-Policy': CSP });
    return res.end('not found');
  }
  res.writeHead(200, {
    'Content-Security-Policy': CSP,
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
  });
  fs.createReadStream(file).pipe(res);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const url = `http://127.0.0.1:${PORT}/index.html`;

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
      '--remote-debugging-port=9333',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
      target = list.find((t) => t.type === 'page');
    } catch {}
  }
  if (!target) throw new Error('chrome did not expose a page target');

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

  const probe = await send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
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
    })()`,
  });

  const r = probe.result && probe.result.result && probe.result.result.value;
  if (!r) throw new Error('probe returned nothing: ' + JSON.stringify(probe).slice(0, 400));

  const ok =
    r.violations.length === 0 &&
    r.yt.loaded &&
    r.yt.hasYT &&
    r.deck && r.deck.w > 0 && r.deck.h > 0 &&
    r.transport && r.transport.buttons > 0;

  console.log(JSON.stringify({ ok, ...r, consoleErrors }, null, 2));

  ws.close();
  chrome.kill();
  server.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('CSP CHECK FAILED:', e.message);
  server.close();
  process.exit(1);
});
