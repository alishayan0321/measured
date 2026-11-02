/* MEASURED · ranker tests — `node test/recommend.test.cjs`
 * These are the spec. None of these bugs are compiler-detectable: anchor
 * direction, Fisher counts, blend scale, session weighting, sign conventions. */
'use strict';

const assert = require('assert');
const R = require('../lib/recommend.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
function approx(a, b, eps) { assert.ok(Math.abs(a - b) <= (eps == null ? 1e-9 : eps), `${a} !~ ${b}`); }

const F = R.FEATURES;
const idx = (n) => F.indexOf(n);

console.log('\nrecommend.js · ' + F.length + ' features\n');

/* ---------- prior anchor ---------- */

t('zero vector leaves w untouched (anchor holds)', () => {
  const m = new R.Model();
  const before = m.w.slice();
  m.observe(new Array(F.length).fill(0), 1, 1);
  assert.deepStrictEqual(m.w.slice(), before);
});

t('1000 zero-vector steps keep w at w0 (no drift toward 0)', () => {
  const m = new R.Model();
  for (let i = 0; i < 1000; i++) m.observe(new Array(F.length).fill(0), 1, 1);
  for (let i = 0; i < F.length; i++) approx(m.w[i], m.w0[i], 1e-12);
});

t('anchor pulls a hand-pushed weight back toward w0', () => {
  const m = new R.Model();
  const i = idx('recency');
  m.w[i] = m.w0[i] + 5;
  const x = new Array(F.length).fill(0); x[i] = 1;
  for (let k = 0; k < 400; k++) m.observe(x, 0.5, 0);
  assert.ok(m.w[i] < m.w0[i] + 5, 'weight did not move back');
  assert.ok(m.w[i] > m.w0[i], 'anchor overshot past the prior');
});

t('weights are hard-capped at ±WMAX', () => {
  const m = new R.Model();
  const i = idx('fpCos');
  m.w[i] = 4.99;
  const x = m.features({ fpCos: 1 });
  for (let k = 0; k < 500; k++) m.observe(x, 1, 10);       // aggressive, wrong-direction-free
  assert.ok(m.w[i] <= R.WMAX + 1e-12, `w=${m.w[i]} escaped the cap`);
  assert.ok(m.w[i] >= -R.WMAX - 1e-12);
});

/* ---------- Fisher counts ---------- */

t('n_i accumulates sum(x^2), not sum(x)', () => {
  const m = new R.Model();
  const i = idx('fpCos');
  const x = new Array(F.length).fill(0); x[i] = 0.5;
  for (let k = 0; k < 100; k++) m.observe(x, 1, 1);
  approx(m.fisher[i], 25, 1e-9);            // 100 * 0.25, not 100 * 0.5
  assert.ok(m.fisher[i] < 30, 'looks like a sample count, not Fisher information');
});

t('fisher[0] is the play count because x[0] === 1', () => {
  const m = new R.Model();
  for (let k = 0; k < 7; k++) m.observe(m.features({ fpCos: 0.3 }), 1, 1);
  approx(m.fisher[0], 7, 1e-9);
  approx(m.n, 7, 1e-9);
});

/* ---------- features ---------- */

t('features: bias is 1, missing is 0, out-of-range clamped', () => {
  const m = new R.Model();
  const x = m.features({ artistAffinity: 4, recency: -3 });
  assert.strictEqual(x[0], 1);
  approx(x[idx('artistAffinity')], 1);
  approx(x[idx('recency')], 0);
  approx(x[idx('cooccur')], 0);
  assert.strictEqual(x.length, F.length);
});

t('signed features map [-1,1] to [0,1]', () => {
  const m = new R.Model();
  approx(m.features({ fpCos: -1 })[idx('fpCos')], 0);
  approx(m.features({ fpCos: 0 })[idx('fpCos')], 0.5);
  approx(m.features({ fpCos: 1 })[idx('fpCos')], 1);
});

t('a missing signed feature is 0, not a fake 0.5', () => {
  const m = new R.Model();
  approx(m.features({})[idx('fpCos')], 0);              // absent, not "orthogonal"
  approx(m.features({ fpCos: 0 })[idx('fpCos')], 0.5);  // explicit unknown is allowed
});
t('labels: completion bands, duration floor, hard events', () => {
  const m = new R.Model();
  assert.deepStrictEqual(m.labelFromCompletion(0.9), { y: 1, weight: 1 });
  assert.deepStrictEqual(m.labelFromCompletion(0.1), { y: 0, weight: 1 });
  assert.strictEqual(m.labelFromCompletion(0.35), null);
  assert.strictEqual(m.labelFromCompletion(0.1, 4, 200), null, '4s is not a verdict');
  assert.deepStrictEqual(m.labelFromCompletion(0.1, 31, 30), { y: 1, weight: 1 }, 'played to the end wins');
  assert.deepStrictEqual(m.labelFromEvent('delete'), { y: 0, weight: 2 });
  assert.deepStrictEqual(m.labelFromEvent('replay'), { y: 1, weight: 1 });
  assert.strictEqual(m.labelFromEvent('nonsense'), null);
});

/* ---------- learning ---------- */

t('learned arm separates a synthetic preference', () => {
  const m = new R.Model();
  const hi = m.features({ fpCos: 0.9 }), lo = m.features({ fpCos: 0.1 });
  for (let k = 0; k < 400; k++) { m.observe(hi, 1, 1); m.observe(lo, 0, 1); }
  const priorMargin = m.score(hi, 'h') - m.score(lo, 'h');
  const learned = m.score(hi, 'l') - m.score(lo, 'l');
  assert.ok(m.w[idx('fpCos')] > m.w0[idx('fpCos')], 'weight did not rise above the prior');
  /* A positive weight already ranks hi above lo, so a bare "hi > lo" passes at
   * zero learning. The claim is that learning WIDENED the prior's margin. */
  assert.ok(learned > priorMargin + 1e-9, `margin did not widen (${learned} vs ${priorMargin})`);
});

t('score() refuses an unstated arm', () => {
  const m = new R.Model();
  assert.throws(() => m.score(m.features({}), 'learned'), /arm must be/);
  assert.ok(isFinite(m.score(m.features({}), 'h')));
  assert.ok(isFinite(m.score(m.features({}), 'l')));
});

t('learnArm confines learning to the served arm', () => {
  const m = new R.Model({ learnArm: 'l' });
  m.observe(m.features({ fpCos: 1 }), 1, 1, 'h');
  approx(m.n, 0);
  m.observe(m.features({ fpCos: 1 }), 1, 1, 'l');
  approx(m.n, 1);
});

/* ---------- alpha ---------- */

t('alpha is 0 before anything has fired (no fake confidence)', () => {
  const m = new R.Model();
  approx(m.alpha(), 0, 1e-12);
  assert.ok(m.alpha() >= R.DEFAULTS.alphaMin && m.alpha() <= R.DEFAULTS.alphaMax);
});

t('alpha comes from median Fisher of features that fired, not the play count', () => {
  /* x = 0.1 on one feature: fisher = 100 * 0.01 = 1 while n = 100.
   * median-Fisher alpha = 1/(1+20) = 0.048; play-count alpha = 100/120 = 0.833.
   * The old version used equal fire masses, where both formulas give the same
   * number and the test proved nothing. */
  const m = new R.Model();
  const x = new Array(F.length).fill(0); x[0] = 1; x[idx('recency')] = 0.1;
  for (let k = 0; k < 100; k++) m.observe(x, 1, 1);
  approx(m.fisher[idx('recency')], 1, 1e-9);
  approx(m.n, 100, 1e-9);
  approx(m.alpha(), 1 / 21, 1e-9);
  assert.ok(m.alpha() < 0.1, 'alpha tracked the play count, not the information');

  const rich = new R.Model();
  for (let k = 0; k < 100; k++) rich.observe(rich.features({ fpCos: 1, recency: 1, cooccur: 1 }), 1, 1);
  approx(rich.alpha(), 100 / 120, 1e-9);            // median of three equal masses
});

t('alpha is clamped at both ends', () => {
  const m = new R.Model();
  m.fisher = new Float64Array(F.length).fill(1e12);
  approx(m.alpha(), R.DEFAULTS.alphaMax, 1e-12);
  approx(new R.Model().alpha(), 0, 1e-12);
});

/* ---------- blend scale ---------- */

t('per-arm standardization gives each arm unit variance', () => {
  const m = new R.Model();
  const cands = [];
  for (let i = 0; i < 40; i++) cands.push({ id: 'c' + i, sL: 5 + 3 * (i / 39), sH: 0 + 1 * (i / 39) });
  const out = m.blend(cands, true);
  const mean = (k) => out.reduce((s, o) => s + o[k], 0) / out.length;
  const sd = (k) => Math.sqrt(out.reduce((s, o) => s + o[k] * o[k], 0) / out.length);
  approx(mean('zL'), 0, 1e-9);
  approx(mean('zH'), 0, 1e-9);
  approx(sd('zL'), 1, 0.05);
  approx(sd('zH'), 1, 0.05);
});

t('degeneracy is pool-level: one flat arm falls back BOTH arms to raw', () => {
  const m = new R.Model();
  const cands = [];
  for (let i = 0; i < 40; i++) cands.push({ id: 'c' + i, sL: 100 * (i / 39), sH: 1 });  // sH has no spread
  const out = m.blend(cands, true);
  for (const o of out) {
    assert.ok(isFinite(o.score), 'score is not finite');
    approx(o.zH, 0, 1e-12);                                  // raw centered, not (0/1e-3)
    assert.ok(Math.abs(o.zL) > 1, 'learned arm was standardized while the other was not');
  }
  assert.strictEqual(m.sigmaRef.l, null, 'degenerate pool must not seed the EMA');
});

t('diagnostic blend() does not advance sigma_ref; serving does', () => {
  const m = new R.Model();
  const cands = [];
  for (let i = 0; i < 20; i++) cands.push({ id: 'c' + i, sL: i, sH: i * 2 });
  m.blend(cands, false);
  assert.strictEqual(m.sigmaRef.l, null);
  assert.strictEqual(m.sigmaRef.h, null);
  m.blend(cands, true);
  assert.ok(m.sigmaRef.l > 0 && m.sigmaRef.h > 0);
});

t('sigma_ref is tracked per arm, not shared', () => {
  const m = new R.Model();
  const cands = [];
  for (let i = 0; i < 40; i++) cands.push({ id: 'c' + i, sL: 100 * (i / 39), sH: 1 * (i / 39) });
  m.blend(cands, true);
  assert.ok(m.sigmaRef.l > m.sigmaRef.h * 10, 'arms share one sigma');
  assert.ok(m.sigmaRef.l <= R.DEFAULTS.sigmaMax && m.sigmaRef.h >= R.DEFAULTS.sigmaMin);
});

t('at n=0 the blend is the heuristic exactly (alpha 0)', () => {
  const m = new R.Model();
  const cands = [{ id: 'a', sL: 10, sH: 0 }, { id: 'b', sL: 0, sH: 10 }];
  const out = m.blend(cands, true);
  approx(out[0].alpha, 0, 1e-12);
  approx(out[0].score, out[0].zH, 1e-12);
});

t('blend is alpha-weighted between the two z arms', () => {
  const m = new R.Model();
  m.fisher = new Float64Array(F.length).fill(100);          // alpha = 100/120
  const cands = [{ id: 'a', sL: 10, sH: 0 }, { id: 'b', sL: 0, sH: 10 }];
  const out = m.blend(cands, true);
  const a = m.alpha();
  approx(out[0].score, a * out[0].zL + (1 - a) * out[0].zH, 1e-12);
  assert.ok(out[0].score > 0 && out[1].score < 0, 'learned arm should lead at high alpha');
});

/* ---------- sampling ---------- */

t('pick() honours the exploration floor in its actual output distribution', () => {
  /* The old test re-implemented the softmax formula and asserted it summed to 1
   * — that tests the test. This calls pick() and histograms what it returns. */
  const m = new R.Model();
  const cands = [];
  for (let i = 0; i < 10; i++) cands.push({ id: 'c' + i, sL: -4 * i, sH: -4 * i });  // steep pool
  const counts = new Map();
  const REPS = 3000;
  for (let s = 0; s < REPS; s++) { const c = m.pick(cands, s + 1); counts.set(c.id, (counts.get(c.id) || 0) + 1); }

  const floorShare = m.opt.explore / cands.length;          // 0.01
  const worst = counts.get('c9') || 0;
  assert.ok(worst > 0, 'the floor never reached the worst candidate');
  assert.ok(worst / REPS > floorShare * 0.4, `floor collapsed: ${(worst / REPS).toFixed(4)} vs ${floorShare}`);
  assert.ok(Math.max(...counts.values()) < REPS * 0.9, 'the pool is effectively deterministic');
  approx([...counts.values()].reduce((a, b) => a + b, 0), REPS);
});

t('explicit seed is reproducible; default nonce varies with play count', () => {
  const m = new R.Model();
  const cands = [];
  for (let i = 0; i < 8; i++) cands.push({ id: 'c' + i, sL: i % 3, sH: i % 2 });
  assert.strictEqual(m.pick(cands, 7).id, m.pick(cands, 7).id);
  const seen = new Set();
  for (let n = 0; n < 40; n++) { m.n = n; seen.add(m.pick(cands).id); }
  assert.ok(seen.size > 1, 'a static pool never explores: the floor is decorative');
});

t('pick breaks ties by id, independent of input order', () => {
  /* The old version re-implemented pick()'s sort and checked its own sort. This
   * calls pick() with both orderings: the ranking is normalized, so the same
   * seed must select the same id either way. */
  const m = new R.Model();
  const a = { id: 'a', sL: 1, sH: 1 }, b = { id: 'b', sL: 1, sH: 1 };
  for (let s = 1; s <= 50; s++) {
    assert.strictEqual(m.pick([b, a], s).id, m.pick([a, b], s).id, 'tie-break depends on pool order');
  }
  assert.strictEqual(m.pick([], 1), null);
});

/* ---------- persistence ---------- */

t('JSON round-trip preserves w, fisher, n and sigma', () => {
  const m = new R.Model();
  for (let k = 0; k < 50; k++) m.observe(m.features({ fpCos: 0.8, recency: 0.2 }), 1, 1);
  m.blend([{ id: 'a', sL: 1, sH: 2 }, { id: 'b', sL: 3, sH: 1 }], true);
  const back = R.Model.fromJSON(JSON.parse(JSON.stringify(m.toJSON())));
  assert.deepStrictEqual(back.w, Array.prototype.slice.call(m.w));
  assert.deepStrictEqual(Array.prototype.slice.call(back.fisher), Array.prototype.slice.call(m.fisher));
  approx(back.n, m.n);
  approx(back.sigmaRef.l, m.sigmaRef.l);
});

t('null / corrupt fields are ignored, not trusted (Number(null) === 0)', () => {
  const w = new Array(F.length).fill(null); w[1] = 1;
  const m = R.Model.fromJSON({ v: R.VERSION, w, fisher: new Array(F.length).fill(-5), n: NaN, sigma: { l: -1e300, h: 'x' } });
  approx(m.w[0], m.w0[0]);                                  // null must not become a 0 weight\n  approx(m.w[1], 1);                                        // real numbers still load\n  approx(m.w[2], m.w0[2]);
  assert.ok(Array.prototype.slice.call(m.fisher).every((v) => v === 0));
  approx(m.n, 0);
  assert.ok(m.sigmaRef.l == null || m.sigmaRef.l >= R.DEFAULTS.sigmaMin);
});

t('append-only: a shorter blob loads its prefix and keeps the prior for new features', () => {
  const m = R.Model.fromJSON({ v: R.VERSION, w: [1, 2, 3], w0Version: R.W0_VERSION });
  approx(m.w[0], 1); approx(m.w[1], 2); approx(m.w[2], 3);
  approx(m.w[3], m.w0[3]);
});

t('a shipped prior change migrates the residual instead of freezing the old anchor', () => {
  const oldW0 = R._internals.w0Array();
  oldW0[3] -= 1;                                           // pretend the old heuristic differed
  const w = oldW0.slice(); w[3] += 2;                     // learned +2 on top of the old prior
  const m = R.Model.fromJSON({ v: R.VERSION, w, w0: oldW0, w0Version: R.W0_VERSION - 1 });
  approx(m.w[3], m.w0[3] + 2, 1e-9);                       // residual preserved on the new anchor
});

t('unknown blob version keeps the prior', () => {
  const m = R.Model.fromJSON({ v: 999, w: new Array(F.length).fill(9) });
  assert.deepStrictEqual(m.w, m.w0);
});

t('reset() returns to the prior and drops the counts', () => {
  const m = new R.Model();
  for (let k = 0; k < 30; k++) m.observe(m.features({ fpCos: 1 }), 1, 1);
  m.blend([{ id: 'a', sL: 1, sH: 2 }, { id: 'b', sL: 3, sH: 1 }], true);
  m.reset();
  assert.deepStrictEqual(m.w, m.w0);
  approx(m.n, 0);
  approx(m.fisher[1], 0);
  assert.strictEqual(m.sigmaRef.l, null);
});

/* ---------- A/B: one estimator everywhere ---------- */

const win = [];
const noise = [];
for (let s = 0; s < 30; s++) {
  const skipH = s % 5;                                    // per-session rates vary, so the interval has width
  for (let i = 0; i < 5; i++) { win.push({ session: 'w' + s, arm: 'h', skip: i < skipH }); win.push({ session: 'w' + s, arm: 'l', skip: 0 }); }
  for (let i = 0; i < 5; i++) {
    noise.push({ session: 'n' + s, arm: 'h', skip: s % 2 });
    noise.push({ session: 'n' + s, arm: 'l', skip: s % 2 });
  }
}

t('delta is session-weighted, not play-weighted', () => {
  const ev = [];
  for (let i = 0; i < 10; i++) ev.push({ session: 'A', arm: 'h', skip: i === 0 });      // 1/10
  for (let i = 0; i < 90; i++) ev.push({ session: 'B', arm: 'h', skip: i < 45 });       // 45/90
  const d = R.delta(ev);
  approx(d.mean_h, (0.1 + 0.5) / 2, 1e-9);                  // equal weight per session
  assert.ok(Math.abs(d.mean_h - 46 / 100) > 0.1, 'fell back to a pooled play-weighted mean');
});

t('delta sign: a better learned arm gives a positive delta', () => {
  approx(R.delta(win).delta, 0.4, 1e-9);
  approx(R.delta(noise).delta, 0, 1e-12);
});

t('sufficiency counts sessions PER ARM (arms are assigned per session)', () => {
  const ev = [];
  for (let s = 0; s < 25; s++) {
    for (let i = 0; i < 5; i++) ev.push({ session: 'h' + s, arm: 'h', skip: 0 });   // one arm per session
    for (let i = 0; i < 5; i++) ev.push({ session: 'l' + s, arm: 'l', skip: 0 });
  }
  const s = R.sufficiency(ev);
  assert.strictEqual(s.ok, true, JSON.stringify(s));
  assert.strictEqual(s.sessions_h, 25);
  assert.strictEqual(s.sessions_l, 25);

  const few = ev.filter((e) => e.session.startsWith('h') || Number(e.session.slice(1)) < 5);
  assert.strictEqual(R.sufficiency(few).ok, false);
});

t('bootstrap: interval is percentile-based, p is null-imposed, CR2 agrees in sign', () => {
  const b = R.bootstrap(win, 2000);
  assert.ok(b.lo > 0, `lo=${b.lo} should clear zero`);
  assert.ok(b.hi > b.lo);
  assert.ok(b.hi <= 1 + 1e-12, 'hi must be a percentile, not a runaway max');
  assert.ok(b.p_one_sided < 0.05, `p=${b.p_one_sided}`);
  assert.ok(b.sufficient);

  const bn = R.bootstrap(noise, 2000);
  approx(bn.delta, 0, 1e-12);
  assert.ok(bn.lo <= 0 && bn.hi >= 0, 'noise must not clear zero');
  assert.ok(bn.p_one_sided > 0.05, `noise p=${bn.p_one_sided}`);

  const c = R.cr2(win);
  assert.ok(c.t > 0 && c.delta > 0, 'CR2 t must agree with the delta sign');
  assert.ok(c.se > 0 && isFinite(c.se), `se=${c.se} should be a positive finite number`);
  approx(c.t, c.delta / c.se, 1e-12);                       // t IS d/se; the factor cancels
});

t('bootstrap tolerates missing session ids instead of merging them', () => {
  const ev = win.map((e) => ({ arm: e.arm, skip: e.skip }));   // no session field at all
  const b = R.bootstrap(ev, 500);
  assert.ok(isFinite(b.delta) && isFinite(b.lo) && isFinite(b.hi));
});

/* ---------- review round 2: the assertions that were not load-bearing ---------- */

t('every signed feature maps [-1,1] identically (a new one cannot skip its test)', () => {
  const m = new R.Model();
  const signed = Object.keys(R._internals.SIGNED);
  assert.ok(signed.length >= 2, 'SIGNED shrank');
  for (const f of signed) {
    assert.ok(F.includes(f), `${f} is signed but not a feature`);
    approx(m.features({ [f]: -1 })[idx(f)], 0, 1e-12);
    approx(m.features({ [f]: 0 })[idx(f)], 0.5, 1e-12);
    approx(m.features({ [f]: 1 })[idx(f)], 1, 1e-12);
    approx(m.features({})[idx(f)], 0, 1e-12);            // absent is 0, not 0.5
  }
});

t('alpha saturates at alphaMax at the predicted Fisher mass', () => {
  const m = new R.Model();
  const n0 = R.DEFAULTS.n0, cap = R.DEFAULTS.alphaMax;
  const at = (med) => { m.fisher = new Float64Array(F.length).fill(med); return m.alpha(); };
  approx(at(180), cap, 1e-12);                            // 180/(180+20) = 0.9 exactly
  assert.ok(at(179) < cap, 'saturated early');
  approx(at(1e6), cap, 1e-12);                            // and stays there
});

t('learnArm selects the data, and a typo is refused', () => {
  const m = new R.Model({ learnArm: 'h' });
  m.observe(m.features({ fpCos: 1 }), 1, 1, 'l');
  approx(m.n, 0, 1e-12);                                  // 'l' plays are ignored
  m.observe(m.features({ fpCos: 1 }), 1, 1, 'h');
  approx(m.n, 1, 1e-12);                                  // 'h' plays train the learned weights
  assert.throws(() => new R.Model({ learnArm: 'learned' }), /learnArm must be/);
});

t('score() refuses a short vector instead of silently using a prefix', () => {
  const m = new R.Model();
  assert.throws(() => m.score([1, 2, 3], 'l'), /must have/);
  assert.throws(() => m.score(null, 'h'), /must have/);
});

t('bootstrap refuses a degenerate cluster count instead of faking an interval', () => {
  const one = [{ session: 's', arm: 'h', skip: 1 }, { session: 's', arm: 'l', skip: 0 }];
  const b = R.bootstrap(one, 500);
  assert.ok(Number.isNaN(b.lo) && Number.isNaN(b.hi) && Number.isNaN(b.p_one_sided), JSON.stringify(b));
  assert.strictEqual(b.sufficient, false);
  assert.strictEqual(b.degenerate, true);
});

t('append-only blob + shipped prior change still migrates the prefix', () => {
  const oldW0 = R._internals.w0Array();
  oldW0[3] -= 1;                                          // old heuristic differed here
  const w = oldW0.slice(); w[3] += 2;                     // learned +2 on the old prior
  const m = R.Model.fromJSON({
    v: R.VERSION, w: w.slice(0, 6), w0: oldW0.slice(0, 6), w0Version: R.W0_VERSION - 1
  });
  approx(m.w[3], m.w0[3] + 2, 1e-9);                      // residual preserved, not skipped
  approx(m.w[10], m.w0[10], 1e-12);                       // untouched tail keeps the new prior
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
