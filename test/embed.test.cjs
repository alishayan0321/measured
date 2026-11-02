/* embCos: the embedding feature must be absent when there is no vector, and a
 * real signed cosine when there is. Run: node test/embed.test.cjs */
const assert = require('node:assert');
const F = require('../lib/recommend-features.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + ': ' + e.message); }
}

const base = {
  stats: F.stats([]), index: 0, curIndex: 0, band: [0.5, 0.5], curBand: [0.5, 0.5],
  recentBand: [0.5, 0.5], recentLufs: null, now: Date.now(), medianDur: 180, curFile: 'a'
};

t('no vector -> no feature', () => {
  const r = F.raw({ ...base, track: { file: 'x', dur: 180 }, emb: {}, centroid: [1, 0, 0] });
  assert.strictEqual(r.embCos, undefined, 'absent vector must not invent a value');
});

t('no centroid -> no feature', () => {
  const r = F.raw({ ...base, track: { file: 'x', dur: 180 }, emb: { x: [1, 0, 0] }, centroid: null });
  assert.strictEqual(r.embCos, undefined);
});

t('orthogonal -> 0, parallel -> 1, opposed -> -1', () => {
  const mk = (v) => F.raw({ ...base, track: { file: 'x', dur: 180 }, emb: { x: v }, centroid: [1, 0, 0] }).embCos;
  assert.ok(Math.abs(mk([1, 0, 0]) - 1) < 1e-9, 'parallel');
  assert.ok(Math.abs(mk([0, 1, 0])) < 1e-9, 'orthogonal');
  assert.ok(Math.abs(mk([-1, 0, 0]) + 1) < 1e-9, 'opposed');
});

t('centroid averages then normalises', () => {
  const c = F.centroid(['a', 'b'], { a: [1, 0], b: [1, 2] });
  assert.ok(Math.abs(Math.hypot(c[0], c[1]) - 1) < 1e-9, 'unit length');
  assert.ok(Math.abs(c[0] - c[1]) < 1e-9, 'equal parts after averaging');
});

t('centroid skips files without a vector', () => {
  const c = F.centroid(['a', 'zz'], { a: [3, 4] });
  assert.ok(Math.abs(c[0] - 0.6) < 1e-9 && Math.abs(c[1] - 0.8) < 1e-9);
});

t('18 features, embCos last', () => {
  const R = require('../lib/recommend.js');
  assert.strictEqual(R.FEATURES.length, 18);
  assert.strictEqual(R.FEATURES[17], 'embCos');
});

t('a blob saved with 17 features still loads and scores', () => {
  const R = require('../lib/recommend.js');
  const m = new R.Model({});
  const blob = m.toJSON();
  blob.w = blob.w.slice(0, 17);
  blob.w0 = blob.w0.slice(0, 17);
  blob.fisher = blob.fisher.slice(0, 17);
  const back = R.Model.fromJSON(blob);
  assert.strictEqual(back.w.length, 18, 'padded');
  assert.strictEqual(back.w[17], back.w0[17], 'appended feature starts at its prior');
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
