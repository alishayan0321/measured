/* No-repeat window: a picker that re-serves what it just played reads as broken.
 * node test/repeat.test.cjs */
const assert = require('node:assert');
const W = require('../lib/recommend-wire.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + ': ' + e.message); }
}

function library(n, seed) {
  const out = [];
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    out.push({
      file: 't' + i, artist: 'a' + (i % 7), title: 's' + i, dur: 180 + (i % 5) * 10, lufs: -12 + (i % 4),
      bands: Array.from({ length: 26 }, () => rnd())
    });
  }
  return out;
}

function loop(tracks, plays, seed) {
  let s = seed;
  const random = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const cache = {};
  const R = W.create({ store: { get: (k, d) => (k in cache ? cache[k] : d), set: (k, v) => { cache[k] = v; } }, now: () => Date.now(), random });
  const byFile = new Map(tracks.map((t) => [t.file, t]));
  const libOf = (cur, i) => ({
    tracks, view: tracks, cur: { file: cur.file }, curIndex: i,
    bandsOf: (f) => (byFile.get(f) || {}).bands, lufsOf: (f) => (byFile.get(f) || {}).lufs
  });
  // warm the gate: MIN_OBSERVED observations, each one a real completion
  for (let i = 0; i < 25; i++) {
    const tr = tracks[i % tracks.length];
    R.begin(tr, libOf(tr, i));
    for (let c = 0; c < 10; c++) R.tick(c * 6);
    R.end(tr.dur, tr.dur, 'play', { naturalEnd: true });
  }
  const seen = [];
  let cur = tracks[0], curIndex = 0;
  for (let i = 0; i < plays; i++) {
    const lib = libOf(cur, curIndex);
    let idx = R.nextIndex(lib);
    if (idx == null) idx = (curIndex + 1) % tracks.length;
    curIndex = idx; cur = tracks[idx];
    seen.push(cur.file);
    R.begin(cur, lib);
    for (let c = 0; c < 8; c++) R.tick(c * 5);
    R.end(i % 3 === 0 ? cur.dur : 40, cur.dur, i % 3 === 0 ? 'play' : 'skip', { naturalEnd: i % 3 === 0 });
  }
  return seen;
}

t('20 picks from 40 tracks never repeat inside the window', () => {
  const seen = loop(library(40, 7), 20, 99);
  // the last 12 picks must be 12 different files
  const tail = seen.slice(-12);
  assert.strictEqual(new Set(tail).size, tail.length, 'repeat inside the 12-track window: ' + tail.join(','));
});

t('a 4-track library still returns a pick (window relaxes)', () => {
  const seen = loop(library(4, 3), 8, 5);
  assert.strictEqual(seen.length, 8);
  assert.ok(seen.every(Boolean), 'every pick resolved');
});

t('the exclusion never empties a 2-track library', () => {
  const tracks = library(2, 11);
  const seen = loop(tracks, 4, 2);
  assert.strictEqual(seen.length, 4);
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
