/* HTTP layer shared by the dev server (server.cjs) and the Electron shell.
   Serves the UI from pageDir and streams audio from every library source with
   Range support, which is what makes seeking work. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { buildLibrary, statsOf } = require('./library.cjs');

const MIME = {
  '.mp3': 'audio/mpeg', '.webm': 'audio/webm', '.flac': 'audio/flac',
  '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.m4b': 'audio/mp4',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.spx': 'audio/ogg',
  '.wav': 'audio/wav', '.wave': 'audio/wav', '.weba': 'audio/webm',
  '.aac': 'audio/aac', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.aifc': 'audio/aiff',
  '.caf': 'audio/x-caf', '.wma': 'audio/x-ms-wma', '.ape': 'audio/x-ape',
  '.alac': 'audio/mp4', '.mka': 'audio/x-matroska', '.wv': 'audio/x-wavpack',
  '.tta': 'audio/x-tta', '.amr': 'audio/amr', '.ac3': 'audio/ac3', '.dts': 'audio/vnd.dts',
  '.mlp': 'audio/vnd.dolby.mlp', '.dsf': 'audio/x-dsf', '.dff': 'audio/x-dff',
  '.au': 'audio/basic', '.snd': 'audio/basic',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendFile(req, res, abs) {
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= st.size) end = st.size - 1;
      if (start > end) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, {
        'content-type': type,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${st.size}`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-cache',
      });
      return fs.createReadStream(abs, { start, end }).pipe(res);
    }
    res.writeHead(200, {
      'content-type': type,
      'content-length': st.size,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
    });
    fs.createReadStream(abs).pipe(res);
  });
}

/** pageDir: folder holding index.html + thumbs. sources: [{key, dir}] as in library.cjs
    staticDirs: {key: dir} served like sources but never scanned (converted audio cache). */
function createServer({ pageDir, sources, extra, staticDirs }) {
  const rootPage = path.resolve(pageDir);
  const srcMap = new Map(sources.map((s) => [s.key, path.resolve(s.dir)]));
  for (const [k, dir] of Object.entries(staticDirs || {})) srcMap.set(k, path.resolve(dir));

  return http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch { res.writeHead(400); return res.end('bad request'); }

    if (pathname === '/api/tracks' || pathname === '/api/library') {
      const tracks = buildLibrary(sources, path.join(rootPage, 'thumbs'));
      return sendJSON(res, 200, { count: tracks.length, tracks, stats: statsOf(sources) });
    }
    if (pathname === '/api/stats') {
      return sendJSON(res, 200, statsOf(sources));
    }
    if (extra && extra(req, res, pathname)) return;

    // UI assets win when a real file exists: the page's lib/ folder
    // must not be shadowed by a source whose key is "lib".
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/player\//, '').replace(/^\//, '');
    const pageAbs = path.normalize(path.join(rootPage, rel));
    const inPage = pageAbs.startsWith(rootPage + path.sep);
    if (inPage) {
      try {
        if (fs.statSync(pageAbs).isFile()) return sendFile(req, res, pageAbs);
      } catch { /* not a page asset — fall through */ }
    }

    // /<sourceKey>/<file>
    const seg = pathname.split('/').filter(Boolean);
    if (seg.length >= 2 && srcMap.has(seg[0])) {
      const dir = srcMap.get(seg[0]);
      const abs = path.normalize(path.join(dir, seg.slice(1).join('/')));
      if (!abs.startsWith(dir + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
      return sendFile(req, res, abs);
    }

    if (!inPage) { res.writeHead(403); return res.end('forbidden'); }
    return sendFile(req, res, pageAbs);
  });
}

module.exports = { createServer, MIME };
