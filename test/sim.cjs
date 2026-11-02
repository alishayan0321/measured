/* End-to-end smoke sim for the ranker.
 * A synthetic library where the true driver is "unheard is good" (novelty),
 * while the hand-tuned prior has novelty weak (0.3) and playCount POSITIVE
 * (0.2) — i.e. the heuristic is mis-scaled in a way the learner must correct.
 * Sessions alternate arms. Not a test; a run with numbers.
 */
'use strict';
const R = require('../lib/recommend.js');

let seed = 12345 >>> 0;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const tracks = [];
for (let i = 0; i < 400; i++) tracks.push({ id: 't' + i, plays: 0, skips: 0, ema: 0.5, days: rnd() * 30 });

function feats(t) {
  const novelty = 1 - Math.min(1, t.plays / 5);
  return {
    novelty: novelty,
    playCount: Math.min(1, t.plays / 10),
    skipInv: 1 - (t.plays ? t.skips / t.plays : 0),
    recency: Math.exp(-t.days / 14),
    completionEma: t.ema
  };
}

/* truth: unheard tracks are good; a track that got skipped decays further */
function play(t) {
  const novelty = 1 - Math.min(1, t.plays / 5);
  const completion = Math.max(0, Math.min(1, 0.15 + 0.8 * novelty + (rnd() - 0.5) * 0.2));
  t.plays++;
  t.ema = 0.7 * t.ema + 0.3 * completion;
  t.days = 0;
  if (completion < 0.5) t.skips++;
  for (const o of tracks) if (o !== t) o.days += 0.1;
  return completion;
}

const model = new R.Model();
const events = [], rates = { h: [], l: [] };
const SESSIONS = 24, PICKS = 40, POOL = 40;
const BOTH = !process.argv.includes('--only-l');

for (let s = 0; s < SESSIONS; s++) {
  const arm = s % 2 === 0 ? 'l' : 'h';
  let skips = 0;
  for (let k = 0; k < PICKS; k++) {
    const seen = new Set(), cands = [];
    while (cands.length < POOL) {
      const t = tracks[Math.floor(rnd() * tracks.length)];
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const x = model.features(feats(t));
      cands.push({ id: t.id, sL: model.score(x, 'l'), sH: model.score(x, 'h'), x, t });
    }
    let chosen;
    if (arm === 'h') {
      chosen = cands.slice().sort((a, b) => (b.sH - a.sH) || (a.id < b.id ? -1 : 1))[0];
    } else {
      const ranked = model.blend(cands, true).sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1));
      chosen = cands.find((c) => c.id === ranked[0].id);
    }
    const completion = play(chosen.t);
    const label = model.labelFromCompletion(completion, 60, 200);
    if (label && (BOTH || arm === 'l')) model.observe(chosen.x, label.y, label.weight, arm);
    const skipped = completion < 0.5;
    if (skipped) skips++;
    events.push({ session: 's' + s, arm, skip: skipped ? 1 : 0 });
  }
  rates[arm].push(skips / PICKS);
}

const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const d = R.delta(events), b = R.bootstrap(events, 4000), cr = R.cr2(events);
const w = R.FEATURES.map((f, i) => ({ f, w: model.w[i] })).sort((a, c) => Math.abs(c.w) - Math.abs(a.w));
const shift = (f) => (model.w[R.FEATURES.indexOf(f)] - R.W0[f]).toFixed(2);

console.log('\n24 sessions x 40 picks · heuristic is mis-scaled (novelty 0.30, playCount +0.20)');
console.log('  heuristic skip rate   ' + (avg(rates.h) * 100).toFixed(1) + '%');
console.log('  learned   skip rate   ' + (avg(rates.l) * 100).toFixed(1) + '%');
console.log('  learned first 4 / last 4  ' + (avg(rates.l.slice(0, 4)) * 100).toFixed(1) + '%  ->  ' + (avg(rates.l.slice(-4)) * 100).toFixed(1) + '%');
console.log('  delta (h - l)         ' + d.delta.toFixed(3) + '   [' + d.sessions_h + ' vs ' + d.sessions_l + ' sessions]');
console.log('  bootstrap lo / hi     ' + b.lo.toFixed(3) + ' / ' + b.hi.toFixed(3) + '   p=' + b.p_one_sided.toFixed(3));
console.log('  CR2 t                 ' + cr.t.toFixed(2) + '  (se ' + cr.se.toFixed(3) + ')');
console.log('  alpha / n             ' + model.alpha().toFixed(3) + ' / ' + model.n);
console.log('  learned shifts        novelty ' + shift('novelty') + ', playCount ' + shift('playCount') + ', skipInv ' + shift('skipInv'));
console.log('  dominant |w|          ' + w.slice(0, 4).map((o) => o.f + ' ' + o.w.toFixed(2)).join(', '));
console.log('  sufficient            ' + b.sufficient + '\n');
