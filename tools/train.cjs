/* Offline trainer for the MEASURED ranker.
 *
 *   node tools/train.cjs                             # synthetic listener over the real library
 *   node tools/train.cjs --events log.json           # train on a real play log
 *   node tools/train.cjs --out train/model.json      # where the blob lands
 *
 * The synthetic mode is a DEMO fixture, not a claim about Ali's taste: it
 * invents a listener that prefers one sonic cluster of the real 148-track
 * library, plays 24 sessions, and trains on that. It exists so the artifact and
 * the numbers can be inspected before any real listening has happened. Real
 * mode consumes the same event format the app writes to `measured.rec.log`.
 *
 * Output: the model blob (JSON) plus a printed before/after comparison — AUC of
 * the learned scorer vs the hand-tuned prior on held-out picks.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('../lib/recommend.js');
const F = require('../lib/recommend-features.js');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes('--' + name);

const OUT = arg('out', path.join(ROOT, 'train', 'model.json'));
const ETA = Number(arg('eta', 0.05));
const SESSIONS = Number(arg('sessions', 24));
const PER_SESSION = Number(arg('per-session', 8));
const SEED = Number(arg('seed', 20261031));

/* ---- library ------------------------------------------------------------- */
const rawFp = JSON.parse(fs.readFileSync(path.join(ROOT, 'fingerprints.json'), 'utf8'));
const fpList = Array.isArray(rawFp) ? rawFp : rawFp.tracks || [];
const tracks = fpList.filter((t) => Array.isArray(t.bands) && t.bands.length).map((t) => ({
  file: t.file, artist: t.artist || 'Unknown', title: t.title || '',
  dur: t.dur || 0, lufs: t.lufs || 0, bands: t.bands
}));
if (tracks.length < 10) { console.error('library too small to train on'); process.exit(2); }
const byFile = new Map(tracks.map((t) => [t.file, t]));
const medianDur = F.medianDur(tracks);
const NORM = F.normStats(tracks.map((t) => t.bands));

let seed = SEED;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ---- events: either a real log or a synthetic listener -------------------- */
/* Synthetic listener. IMPORTANT: this is a FIXTURE, not Ali's taste. It models
 * behaviour the feature set can actually describe — listens on from a track that
 * sounds like the last one, rewards familiar artists, punishes what it skipped
 * before — so the pipeline has something learnable to fit. A persona whose taste
 * lives outside the features (eg a fixed external cluster) trains to AUC ~0.5,
 * which is the honest ceiling for data the model cannot see. */
function syntheticEvents() {
  const ev = [];
  let at = Date.now() - SESSIONS * 86400000;
  const skips = Object.create(null), artists = Object.create(null);
  let cur = tracks[Math.floor(rnd() * tracks.length)];

  for (let s = 0; s < SESSIONS; s++) {
    for (let k = 0; k < PER_SESSION; k++) {
      const sim = (t) => { const c = F.cosineC(t.bands, cur.bands, NORM); return c === undefined ? 0 : (c + 1) / 2; };
      const w = tracks.map((t) => Math.max(0.02,
        0.05 + Math.pow(sim(t), 2) + 0.90 * rnd() - 0.15 * (skips[t.file] ? 1 : 0)));
      const total = w.reduce((a, b) => a + b, 0);
      let r = rnd() * total, idx = 0;
      while (idx < w.length - 1 && r > w[idx]) { r -= w[idx]; idx++; }
      const t = tracks[idx];

      const affinity = sim(t);
      const fam = Math.min(1, (artists[t.artist] || 0) / 4);
      const p = clamp(0.08 + 0.80 * affinity + 0.12 * fam - 0.05 * (skips[t.file] || 0), 0.05, 0.95);
      const completes = rnd() < p;
      const dur = t.dur || medianDur || 200;
      at += (dur + 20) * 1000 * (0.6 + 0.8 * rnd());
      ev.push({
        file: t.file, artist: t.artist, at,
        dur, elapsed: completes ? dur * (0.85 + 0.15 * rnd()) : 5 + 40 * rnd(),
        kind: completes ? 'play' : 'skip', session: 's' + s
      });
      if (completes) artists[t.artist] = (artists[t.artist] || 0) + 1;
      else skips[t.file] = (skips[t.file] || 0) + 1;
      cur = t;
    }
  }
  return ev;
}

function loadEvents() {
  const p = arg('events', null);
  if (!p) return { events: syntheticEvents(), source: 'synthetic-persona' };
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const ev = Array.isArray(j) ? j : j.events || [];
  return { events: ev, source: 'real-log' };
}

/* ---- feature row for one event, given the history before it --------------- */
function rowFor(ev, priorEvents, curFile) {
  const st = F.stats(priorEvents);
  const t = byFile.get(ev.file) || { file: ev.file, artist: ev.artist, dur: ev.dur, bands: null };
  const recent = st.recentFiles.map((f) => (byFile.get(f) || {}).bands).filter(Boolean);
  const lu = st.recentFiles.map((f) => (byFile.get(f) || {}).lufs).filter((v) => v);
  const cur = byFile.get(curFile) || null;
  const raw = F.raw({
    track: t, stats: st, index: 0, curIndex: 0,
    band: t.bands, curBand: cur && cur.bands,
    recentBand: F.meanBands(recent), recentLufs: lu.length ? lu.reduce((a, b) => a + b, 0) / lu.length : null,
    now: ev.at || Date.now(), medianDur, norm: NORM, curFile
  });
  return raw;
}

/* AUC of a scorer over labelled events: does it rank completions above skips? */
function auc(rows, scoreOf) {
  const pos = rows.filter((r) => r.y === 1), neg = rows.filter((r) => r.y === 0);
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const p of pos) for (const n of neg) {
    const a = scoreOf(p.x), b = scoreOf(n.x);
    if (a > b) wins++; else if (a === b) wins += 0.5;
  }
  return wins / (pos.length * neg.length);
}

/* ---- train --------------------------------------------------------------- */
const { events, source } = loadEvents();
if (events.length < 20) { console.error('need at least 20 events, got ' + events.length); process.exit(2); }
events.sort((a, b) => (a.at || 0) - (b.at || 0));

const model = new R.Model({ eta: ETA });
const rows = [];
let curFile = null;
for (const ev of events) {
  const prior = rows.map((r) => r.ev);
  const raw = rowFor(ev, prior, curFile);
  const x = model.features(raw);
  const completion = ev.dur > 0 ? clamp((ev.elapsed || 0) / ev.dur, 0, 1) : (ev.kind === 'skip' ? 0 : 1);
  const label = model.labelFromCompletion(completion, ev.elapsed || 0, ev.dur || 0);
  const y = label ? label.y : (ev.kind === 'skip' ? 0 : null);
  if (y !== null) {
    model.observe(x, y, label ? label.weight : 1, null);
    rows.push({ ev, raw, x, y });
  }
  curFile = ev.file;
}

const cut = Math.max(0, rows.length - Math.min(60, Math.floor(rows.length * 0.3)));
const held = rows.slice(cut);
const priorModel = new R.Model({});       // untouched w0 = the heuristic

const aucL = auc(held, (x) => model.score(x, 'l'));
const aucH = auc(held, (x) => priorModel.score(x, 'h'));
const skipAll = rows.filter((r) => r.y === 0).length / rows.length;

/* per-feature held-out AUC: which columns carry the label at all */
const perFeat = R.FEATURES.map((name, i) => ({ name, auc: auc(held, (x) => x[i]) }))
  .filter((r) => isFinite(r.auc)).sort((a, b) => Math.abs(b.auc - 0.5) - Math.abs(a.auc - 0.5)).slice(0, 5);
const drift = R.FEATURES.map((name, i) => ({ name, d: model.w[i] - model.w0[i] }))
  .filter((r) => Math.abs(r.d) > 0.05).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));

const meta = {
  trainedAt: new Date().toISOString(),
  source,
  library: tracks.length,
  events: events.length,
  labelled: rows.length,
  eta: ETA,
  n: model.n,
  auc: { learned: aucL, prior: aucH, heldOut: held.length },
  skipRate: skipAll,
  drift: drift.reduce((o, r) => (o[r.name] = Number(r.d.toFixed(3)), o), {}),
  model: model.toJSON()
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(meta, null, 2));

console.log('\n  source            ' + source + '  (' + events.length + ' events, ' + tracks.length + ' tracks)');
console.log('  observed/labelled ' + model.n + ' / ' + rows.length + '   skip share ' + (100 * skipAll).toFixed(1) + '%');
console.log('  held-out AUC      learned ' + aucL.toFixed(3) + '   prior ' + aucH.toFixed(3) +
  (isFinite(aucL) && isFinite(aucH) ? '   delta ' + (aucL - aucH >= 0 ? '+' : '') + (aucL - aucH).toFixed(3) : ''));
console.log('  weight drift      ' + (drift.length ? drift.map((r) => r.name + ' ' + (r.d >= 0 ? '+' : '') + r.d.toFixed(2)).join(' | ') : '(none)'));
console.log('  written           ' + OUT + '\n');
process.exit(0);
