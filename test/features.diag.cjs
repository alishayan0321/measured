/* Coverage diagnostic for the feature builder.
 * Answers one question before any wiring: does this library actually fill the
 * feature vector, or does the ranker end up blending a mostly-empty row?
 *
 *   node test/features.diag.cjs
 *
 * Prints, per feature, the share of candidates that carry a real (non-zero)
 * value, with no history and after a plausible amount of play history.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const F = require('../lib/recommend-features.js');

const ROOT = path.join(__dirname, '..');
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'fingerprints.json'), 'utf8'));
const list = Array.isArray(raw) ? raw : raw.tracks || [];

const tracks = list.filter((t) => Array.isArray(t.bands) && t.bands.length).map((t) => ({
  file: t.file, artist: t.artist || 'Unknown', title: t.title || '',
  dur: t.dur || 0, lufs: t.lufs || 0, bands: t.bands
}));

if (!tracks.length) { console.log('no fingerprints — cannot diagnose'); process.exit(2); }

const NOW = Date.now();
const median = F.medianDur(tracks);
const cur = 0;
const curBand = tracks[cur].bands;
const recentBand = F.meanBands(tracks.slice(0, 3).map((t) => t.bands));
const recentLufs = tracks.slice(0, 3).reduce((a, t) => a + (t.lufs || 0), 0) / 3;

function sample(n) {
  const step = Math.max(1, Math.floor(tracks.length / n));
  const out = [];
  for (let i = 0; i < tracks.length && out.length < n; i += step) out.push(i);
  return out;
}

function coverage(history, label) {
  const st = F.stats(history);
  const idx = sample(100);
  const per = {};
  let zeroRows = 0;
  for (const i of idx) {
    const r = F.raw({
      track: tracks[i], stats: st, index: i, curIndex: cur,
      band: tracks[i].bands, curBand, recentBand, recentLufs,
      now: NOW, medianDur: median, curFile: tracks[cur].file
    });
    let live = 0;
    for (const k of Object.keys(r)) if (r[k] !== undefined && Math.abs(r[k]) > 1e-9) { per[k] = (per[k] || 0) + 1; live++; }
    if (live === 0) zeroRows++;
  }
  const total = 16;
  const rows = Object.keys(per).sort();
  console.log('\n' + label);
  console.log('  candidates sampled     ' + idx.length + ' / ' + tracks.length + ' tracks');
  console.log('  features carrying data  ' + rows.length + ' / ' + total + '  (' + (100 * rows.length / total).toFixed(0) + '%)');
  console.log('  rows with zero live     ' + zeroRows);
  console.log('  ' + rows.map((k) => k + ' ' + Math.round(100 * (per[k] || 0) / idx.length) + '%').join(' · '));
  return rows.length / total;
}

/* A plausible 20-session history: 120 plays, some skipped early, some completed. */
function syntheticHistory() {
  const ev = [];
  let at = NOW - 40 * 86400000;
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let s = 0; s < 20; s++) {
    for (let k = 0; k < 6; k++) {
      const i = Math.floor(rnd() * tracks.length);
      const t = tracks[i];
      at += 180000 + rnd() * 240000;                 // 3-7 min apart
      const dur = t.dur || 200;
      const early = rnd() < 0.35;
      ev.push({ file: t.file, artist: t.artist, at, dur, elapsed: early ? 8 + rnd() * 20 : dur * (0.8 + rnd() * 0.2),
                kind: early ? 'skip' : 'play', session: 's' + s });
    }
  }
  return ev;
}

const a = coverage([], 'cold start (no play history)');
const b = coverage(syntheticHistory(), 'after 20 sessions / 120 plays');

const verdict = (x) => x >= 0.60 ? 'READY' : 'NOT READY';
console.log('\n  cold start  ' + (a * 100).toFixed(0) + '%  -> ' + verdict(a));
console.log('  with history ' + (b * 100).toFixed(0) + '%  -> ' + verdict(b));
console.log('  library median duration ' + median.toFixed(0) + 's · tracks with LUFS ' +
  tracks.filter((t) => t.lufs).length + '/' + tracks.length + '\n');
process.exit(0);
