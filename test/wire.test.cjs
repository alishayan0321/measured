/* Wiring tests: gating, arms, observation on skip, persistence.
 *   node test/wire.test.cjs
 * These test the PLUG (storage, session arm, refusal to recommend on an
 * under-described library), not the math — that is recommend.test.cjs.
 */
'use strict';
const assert = require('assert');
const W = require('../lib/recommend-wire.js');
const R = require('../lib/recommend.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

/* A library that looks like the real one: 26-band fingerprints, durations, LUFS. */
const tracks = [];
for (let i = 0; i < 40; i++) {
  const bands = new Array(26).fill(0).map((_, k) => 0.4 + 0.3 * Math.sin(i * 0.7 + k * 0.3));
  tracks.push({ file: 'f' + i, artist: 'artist' + (i % 6), title: 't' + i, dur: 180 + i, lufs: -12 + (i % 5), bands });
}
const byFile = new Map(tracks.map((t) => [t.file, t]));
const lib = {
  tracks, view: tracks, curIndex: 0, cur: tracks[0],
  bandsOf: (f) => (byFile.get(f) || {}).bands,
  lufsOf: (f) => (byFile.get(f) || {}).lufs
};

function memStore(seed) {
  const m = Object.assign({}, seed || {});
  return { get: (k, d) => (k in m ? m[k] : d), set: (k, v) => { m[k] = v; }, _m: m };
}

/* Enough history that the feature row is real: 60 plays over 20 sessions,
 * several of them consecutive from f0 so the transition table is populated. */
function history(n, withTransitions) {
  const ev = [];
  const base = Date.now() - 30 * 86400000;
  for (let i = 0; i < n; i++) {
    const f = withTransitions && i % 3 === 0 ? 'f0' : 'f' + (i % 12);
    ev.push({ file: f, artist: byFile.get(f).artist, at: base + i * 3600000,
      elapsed: i % 5 === 0 ? 6 : 170, dur: 180, kind: i % 5 === 0 ? 'skip' : 'play', session: 's' + Math.floor(i / 3) });
  }
  return ev;
}

t('cold start refuses to recommend (no history)', () => {
  const eng = W.create({ store: memStore(), random: () => 0.9 });
  assert.strictEqual(eng.ready(lib), false);
  assert.strictEqual(eng.nextIndex(lib), null);
});

t('history fills the feature row and recommendations turn on', () => {
  const store = memStore(); store.set(W.KEY_LOG, JSON.stringify(history(60, true)));
  const eng = W.create({ store, random: () => 0.9 });
  const st = (eng.ready(lib), eng.stats());
  assert.ok(st.coverage >= W.COV_THRESHOLD, `coverage=${st.coverage}`);
  const i = eng.nextIndex(lib);
  assert.ok(Number.isInteger(i) && i >= 0 && i < lib.view.length, `bad index ${i}`);
  assert.notStrictEqual(lib.view[i].file, lib.cur.file, 'recommended the track already playing');
});

t('20% of sessions get the pure-heuristic arm', () => {
  const store = memStore(); store.set(W.KEY_LOG, JSON.stringify(history(60, true)));
  assert.strictEqual(W.create({ store, random: () => 0.1 }).arm, 'h');
  assert.strictEqual(W.create({ store, random: () => 0.9 }).arm, 'l');
});

t('a skip is observed, not ignored', () => {
  const store = memStore(); store.set(W.KEY_LOG, JSON.stringify(history(60, true)));
  const eng = W.create({ store, random: () => 0.9 });
  const before = eng.model().n;
  eng.begin(tracks[3], lib);
  const label = eng.end(6, 180, 'skip');
  assert.ok(label === null || label.y === 0, 'a 6s play must not be a positive label');
  assert.strictEqual(eng.model().n, before + 1, 'the skip did not reach the learner');
  assert.strictEqual(eng.events()[eng.events().length - 1].kind, 'skip');
});

t('a completed play is a positive label', () => {
  const store = memStore(); store.set(W.KEY_LOG, JSON.stringify(history(60, true)));
  const eng = W.create({ store, random: () => 0.9 });
  eng.begin(tracks[4], lib);
  const label = eng.end(178, 180, 'play');
  assert.deepStrictEqual(label, { y: 1, weight: 1 });
});

t('persistence: save() restores the model and the log in a new session', () => {
  const store = memStore(); store.set(W.KEY_LOG, JSON.stringify(history(60, true)));
  const a = W.create({ store, random: () => 0.9 });
  a.begin(tracks[5], lib); a.end(179, 180, 'play');
  a.save();
  const b = W.create({ store, random: () => 0.9 });
  assert.strictEqual(b.model().n, a.model().n);
  assert.strictEqual(b.events().length, a.events().length);
});

t('the heuristic arm is served by argmax, not by the blend', () => {
  const store = memStore(); store.set(W.KEY_LOG, JSON.stringify(history(60, true)));
  const eng = W.create({ store, random: () => 0.1 });       // pure heuristic session
  assert.strictEqual(eng.arm, 'h');
  const i = eng.nextIndex(lib);
  assert.ok(Number.isInteger(i), 'heuristic arm returned no pick');
  const second = eng.nextIndex(lib);
  assert.strictEqual(i, second, 'heuristic arm is not deterministic');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
