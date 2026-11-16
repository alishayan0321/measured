/* Card Z — stream recovery.
 *
 * The bug: a preview whose URL is expired or refused left the player parked at
 * 0:00 with the pause icon up, because playOnline() only caught a rejected
 * play() and the global error handler then blamed a local file that had nothing
 * to do with it.
 *
 * This drives the REAL startClip() out of app.js against a fake element, so the
 * "did it actually start" decision is tested rather than assumed.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'app.js');
const src = fs.readFileSync(APP, 'utf8');

/* Pull one function out of app.js by brace matching, so the test runs the code
   that ships instead of a copy that can drift. */
function extract(anchor) {
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, 'anchor not found in app.js: ' + anchor);
  let i = src.indexOf('{', at);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(at, j + 1);
    }
  }
  throw new Error('unbalanced braces after ' + anchor);
}

const startClipSrc = extract('function startClip(url) {');
const makeStartClip = new Function('audio', 'proxied', startClipSrc + '\nreturn startClip;');

class FakeAudio {
  constructor(mode) {
    this.mode = mode;
    this.listeners = {};
    this.paused = true;
    this.readyState = 0;
    this.src = '';
    this.loaded = 0;
  }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); }
  load() { this.loaded++; }
  emit(t) { (this.listeners[t] || []).slice().forEach((f) => f()); }
  play() {
    if (this.mode === 'reject') return Promise.reject(new Error('NotSupportedError'));
    if (this.mode === 'playing') { setTimeout(() => this.emit('playing'), 5); return Promise.resolve(); }
    if (this.mode === 'error') { setTimeout(() => this.emit('error'), 5); return new Promise(() => {}); }
    return Promise.resolve();
  }
}

const proxied = (u) => 'proxy://' + u;

async function run(mode) {
  const audio = new FakeAudio(mode);
  const startClip = makeStartClip(audio, proxied);
  return { ok: await startClip('https://audio-ssl.itunes.apple.com/x.m4a'), audio };
}

(async () => {
  let pass = 0;
  let fail = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log('  ok   ' + name); pass++; }
    catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
  };

  console.log('startClip — did the clip actually start?');

  await t('a clip that fires playing reports true', async () => {
    const { ok, audio } = await run('playing');
    assert.strictEqual(ok, true);
    assert.strictEqual(audio.src, 'proxy://https://audio-ssl.itunes.apple.com/x.m4a');
    assert.strictEqual(audio.loaded, 1);
  });

  await t('a clip that fires error reports false', async () => {
    const { ok } = await run('error');
    assert.strictEqual(ok, false);
  });

  await t('a rejected play() reports false', async () => {
    const { ok } = await run('reject');
    assert.strictEqual(ok, false);
  });

  await t('a resolved play() reports true', async () => {
    const { ok } = await run('resolve');
    assert.strictEqual(ok, true);
  });

  await t('listeners are removed once the clip settles', async () => {
    const { audio } = await run('playing');
    assert.strictEqual((audio.listeners.playing || []).length, 0);
    assert.strictEqual((audio.listeners.error || []).length, 0);
  });

  console.log('wiring — the recovery path is actually connected');

  await t('the local-file rescue ignores streamed sources', async () => {
    assert.ok(src.includes("if (srcKind !== 'local') return;"),
      'the global error handler must bail out for non-local sources');
  });

  await t('every source kind is tagged where the element is loaded', async () => {
    assert.ok(src.includes("srcKind = 'local';"), 'local tag missing');
    assert.ok(src.includes("srcKind = 'online';"), 'online tag missing');
    assert.ok(src.includes("srcKind = 'yt';"), 'youtube tag missing');
  });

  await t('a failed preview re-resolves once before giving up', async () => {
    const at = src.indexOf('async function playOnline(cand, depth) {');
    assert.ok(at >= 0, 'playOnline signature changed');
    const body = src.slice(at, src.indexOf('\n  }', at));
    assert.ok(body.includes('SHELF.suggest('), 'no re-resolve');
    assert.ok(body.includes('startClip(fresh.url)'), 'the re-resolved URL is never tried');
    assert.ok(body.includes("announce('Skipped '"), 'no toast naming the reason');
    assert.ok(body.includes('icon(false)'), 'a stopped player would keep the pause icon');
    assert.ok(body.includes('onlineNext(depth + 1)'), 'no skip to the next clip');
  });

  await t('the skip is bounded, so a dead pool cannot loop forever', async () => {
    const at = src.indexOf('async function playOnline(cand, depth) {');
    const body = src.slice(at, src.indexOf('\n  }', at));
    assert.ok(body.includes('if (depth < 2)'), 'the skip has no depth bound');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
