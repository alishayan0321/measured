/* Shelf integration: drives the REAL injector out of app.js, not a stub.
 *
 * The bug this pins down: app.js declared `makeAudio: (src, id) => …` and called
 * `SHELF.markReady(id, …)` inside it, but shelf.js called `makeAudio(cand.url)`
 * with one argument. So `id` was undefined, markReady matched no pool entry,
 * `ready` never flipped, and next() returned null forever — the shelf was
 * unreachable in the shipped app while every unit test stayed green, because
 * shelf.test.cjs injects its own one-argument stub.
 *
 * So this file extracts the arrow function from app.js by source and runs it
 * against a real Shelf. If someone changes the injector's shape, the extraction
 * assert fires instead of the test silently testing nothing.
 *
 * Mutation check: revert `makeAudio(cand.url, cand.id)` to `makeAudio(cand.url)`
 * in lib/shelf.js and the first two tests fail. No network, no audio device.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/shelf.js');

const APP = path.join(__dirname, '..', 'app.js');
const appSrc = fs.readFileSync(APP, 'utf8');

const FIXTURE = {
  results: [
    { trackId: 1, previewUrl: 'https://x/1.m4a', trackName: 'One', artistName: 'A' },
    { trackId: 2, previewUrl: 'https://x/2.m4a', trackName: 'Two', artistName: 'B' },
  ],
};

/* Pull `(src, id) => { … }` out of app.js by matching braces from the arrow. */
function extractInjector(src) {
  const anchor = 'makeAudio: (src, id) => {';
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, 'app.js no longer declares `makeAudio: (src, id) => {` — update this test');

  const blockStart = src.indexOf('{', src.indexOf('=>', at));
  let depth = 0, end = -1;
  for (let i = blockStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.ok(end > blockStart, 'could not find the end of the makeAudio block in app.js');
  return '(src, id) => ' + src.slice(blockStart, end);
}

/* Rebuild the injector in a scope where SHELF is the same late-bound variable
   app.js uses: create() runs first, then the shelf is assigned. */
function buildInjector(AudioStub) {
  const fnSrc = extractInjector(appSrc);
  const build = new Function('Audio', `
    var SHELF = null;
    var makeAudio = ${fnSrc};
    return { makeAudio: makeAudio, setShelf: function (s) { SHELF = s; } };
  `);
  return build(AudioStub);
}

/* Minimal Audio stand-in: records instances so the test can fire the events the
   injector listens for. */
function audioClass() {
  const made = [];
  class FakeAudio {
    constructor() {
      this.src = ''; this.preload = ''; this.listeners = {}; this.loaded = false;
      made.push(this);
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    load() { this.loaded = true; }
    fire(type) { (this.listeners[type] || []).forEach((fn) => fn()); }
  }
  return { FakeAudio, made };
}

function realShelf() {
  const { FakeAudio, made } = audioClass();
  const inj = buildInjector(FakeAudio);
  const shelf = S.create({
    fetchJson: () => Promise.resolve(FIXTURE),
    makeAudio: inj.makeAudio,
  });
  inj.setShelf(shelf);
  return { shelf, made };
}

const tests = [];
function t(name, fn) { tests.push({ name, fn }); }

/* ------------------------------------------------------------------ contract */

t('fill() hands the pool id to makeAudio as the second argument', async () => {
  const seen = [];
  const shelf = S.create({
    fetchJson: () => Promise.resolve(FIXTURE),
    makeAudio: (src, id) => { seen.push([src, id]); return { src, addEventListener() {}, load() {} }; },
  });
  await shelf.search('seed');
  assert.deepStrictEqual(seen.map((s) => s[1]), ['it1', 'it2'],
    'makeAudio got no id — markReady can never match a pool entry');
});

/* ------------------------------------------------------- the real injector */

t('real app.js injector: search -> fill -> canplaythrough -> next() returns it', async () => {
  const { shelf, made } = realShelf();
  await shelf.search('seed');

  assert.strictEqual(made.length, 2, 'fill() should have buffered both candidates');
  assert.strictEqual(shelf.next(), null, 'nothing should be ready before canplaythrough');

  made[0].fire('canplaythrough');
  const cand = shelf.next();
  assert.ok(cand, 'next() returned null — markReady never matched the pool id');
  assert.strictEqual(cand.id, 'it1');
  assert.strictEqual(cand.url, 'https://x/1.m4a');
});

t('real app.js injector: an error marks the entry not-ready, so next() skips it', async () => {
  const { shelf, made } = realShelf();
  await shelf.search('seed');

  made[0].fire('error');
  assert.strictEqual(shelf.next(), null, 'a failed clip must not be handed out');

  made[1].fire('canplaythrough');
  const cand = shelf.next();
  assert.ok(cand, 'the second clip should still be reachable');
  assert.strictEqual(cand.id, 'it2');
});

t('real app.js injector: the Audio it builds is preloaded and load()ed', async () => {
  const { shelf, made } = realShelf();
  await shelf.search('seed');
  assert.strictEqual(made[0].preload, 'auto');
  assert.strictEqual(made[0].src, 'https://x/1.m4a');
  assert.strictEqual(made[0].loaded, true);
});

/* ------------------------------------------------------------------- runner */

(async () => {
  let pass = 0, fail = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log('  ok   ' + name); pass++; }
    catch (e) { console.log('>  FAIL ' + name + '\n         ' + (e && e.message)); fail++; }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
