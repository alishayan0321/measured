/* MEASURED · feature builder for the ranker
 * ---------------------------------------------------------------------------
 * Turns what the app actually knows (tracks, fingerprints, play history) into
 * the raw feature object lib/recommend.js expects. Keep every computation here
 * pure: no storage, no DOM, no clock reads — `now` is passed in. That is what
 * makes the coverage diagnostic meaningful.
 *
 * Missing is `undefined`, never 0 and never 0.5: recommend.js maps a missing
 * value to 0 ("no signal"), and an undefined here is how the diagnostic counts
 * a feature as dead.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RecommendFeatures = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY = 86400000;
  var RECENT_N = 3;          // how many recent plays the "recent" fingerprint uses
  var ENERGY_SPAN = 20;      // LUFS: full penalty at 20 dB away
  var RECENCY_TAU = 14;      // days

  function num(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* Cosine over the 26-band fingerprint. Bands are all >= 0, so this lands in
   * [0,1] in practice but the full [-1,1] contract is preserved. */
  function cosine(a, b) {
    if (!a || !b || !a.length || a.length !== b.length) return undefined;
    var dot = 0, na = 0, nb = 0, i;
    for (i = 0; i < a.length; i++) {
      var x = num(a[i]) ? a[i] : 0, y = num(b[i]) ? b[i] : 0;
      dot += x * y; na += x * x; nb += y * y;
    }
    if (na === 0 || nb === 0) return undefined;
    return clamp(dot / Math.sqrt(na * nb), -1, 1);
  }

  function meanBands(list) {
    var rows = list.filter(function (b) { return b && b.length; });
    if (!rows.length) return null;
    var out = new Array(rows[0].length).fill(0), i, k;
    for (i = 0; i < rows.length; i++) for (k = 0; k < out.length; k++) out[k] += rows[i][k] || 0;
    for (k = 0; k < out.length; k++) out[k] /= rows.length;
    return out;
  }

  /* Per-band mean/sd across a library. Raw fingerprint vectors are nearly
   * collinear (cosine 0.989–1.000 on the real 148-track library), so a plain
   * cosine of two tracks says "identical" for everything and carries no
   * information. Centering by the library mean turns that cosine into the
   * correlation of the two spectra, which is what actually differs between
   * tracks. */
  function normStats(vectors) {
    var rows = (vectors || []).filter(function (b) { return b && b.length; });
    if (!rows.length) return null;
    var n = rows.length, d = rows[0].length, mean = new Array(d).fill(0), sd = new Array(d).fill(0), i, k, v;
    for (i = 0; i < n; i++) for (k = 0; k < d; k++) mean[k] += rows[i][k] || 0;
    for (k = 0; k < d; k++) mean[k] /= n;
    for (i = 0; i < n; i++) for (k = 0; k < d; k++) { v = (rows[i][k] || 0) - mean[k]; sd[k] += v * v; }
    for (k = 0; k < d; k++) sd[k] = Math.sqrt(sd[k] / Math.max(1, n - 1)) || 1e-6;
    return { mean: mean, sd: sd };
  }

  function cosineC(a, b, norm) {
    if (!norm || !norm.mean) return cosine(a, b);
    if (!a || !b || a.length !== b.length || a.length !== norm.mean.length) return cosine(a, b);
    var dot = 0, na = 0, nb = 0, i, x, y;
    for (i = 0; i < a.length; i++) {
      x = ((a[i] || 0) - norm.mean[i]) / norm.sd[i];
      y = ((b[i] || 0) - norm.mean[i]) / norm.sd[i];
      dot += x * y; na += x * x; nb += y * y;
    }
    if (na === 0 || nb === 0) return undefined;
    return clamp(dot / Math.sqrt(na * nb), -1, 1);
  }

  /* history: [{ file, artist, at(ms), elapsed(s), dur(s), kind:'play'|'like'|'delete'|'skip' }]
   * Everything derived from it lands in one stats object so the feature builder
   * does not re-walk the log per candidate. */
  function stats(history) {
    var per = Object.create(null), transitions = Object.create(null);
    var byArtist = Object.create(null), last = [], sessions = Object.create(null);
    var observed = 0, i;

    for (i = 0; i < (history || []).length; i++) {
      var e = history[i];
      if (!e || !e.file) continue;
      var s = per[e.file];
      if (!s) s = per[e.file] = { plays: 0, skips: 0, ema: null, lastAt: 0, hours: new Array(24).fill(0), artist: e.artist || '' };
      if (e.kind === 'like') { s.liked = true; continue; }
      if (e.kind === 'delete') { s.deleted = true; continue; }
      if (e.kind === 'skip') s.skips++;
      if (e.kind === 'play' || e.kind === 'skip') {
        s.plays++;
        observed++;
        if (num(e.at)) {
          s.lastAt = Math.max(s.lastAt, e.at);
          s.hours[new Date(e.at).getHours()] += 1;
        }
        if (e.artist) { s.artist = e.artist; byArtist[e.artist] = byArtist[e.artist] || []; }
        var c = (num(e.elapsed) && num(e.dur) && e.dur > 0) ? clamp(e.elapsed / e.dur, 0, 1) : null;
        if (c != null) {
          s.ema = s.ema == null ? c : 0.7 * s.ema + 0.3 * c;
          if (s.artist) (byArtist[s.artist] = byArtist[s.artist] || []).push(c);
        }
        last.push({ file: e.file, at: e.at || 0 });
        if (e.session != null) sessions[e.session] = true;
      }
    }

    /* transition table: previous file -> next file, from consecutive plays */
    var sorted = last.slice().sort(function (a, b) { return a.at - b.at; });
    for (i = 1; i < sorted.length; i++) {
      var from = sorted[i - 1].file, to = sorted[i].file;
      if (from === to) continue;
      var row = transitions[from] || (transitions[from] = Object.create(null));
      row[to] = (row[to] || 0) + 1;
    }

    var artistEma = Object.create(null);
    Object.keys(byArtist).forEach(function (a) {
      var v = byArtist[a];
      artistEma[a] = v.reduce(function (x, y) { return x + y; }, 0) / v.length;
    });

    return {
      per: per, transitions: transitions, artistEma: artistEma,
      recentFiles: sorted.slice(-RECENT_N).map(function (r) { return r.file; }),
      observed: observed, sessions: Object.keys(sessions).length,
      lastAt: sorted.length ? sorted[sorted.length - 1].at : 0
    };
  }

  function medianDur(tracks) {
    var d = tracks.map(function (t) { return num(t.dur) ? t.dur : 0; }).filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
    return d.length ? d[Math.floor(d.length / 2)] : 0;
  }

  /* One candidate -> raw features. `band` is the track's fingerprint bands,
   * `curBand` the playing track's, `recentBand` the mean of the last few.
   * Returns undefined for anything the library cannot actually measure. */
  /* Average of the given vectors, re-normalised to unit length. Null when the
     list is empty or none of the files has an embedding. */
  function centroid(files, emb) {
    if (!files || !files.length || !emb) return null;
    var acc = null, k = 0, i, f, v, j;
    for (i = 0; i < files.length; i++) {
      f = files[i]; v = emb[f];
      if (!v || !v.length) continue;
      if (!acc) { acc = new Array(v.length); for (j = 0; j < v.length; j++) acc[j] = 0; }
      for (j = 0; j < acc.length && j < v.length; j++) acc[j] += v[j];
      k++;
    }
    if (!k) return null;
    var n = 0;
    for (j = 0; j < acc.length; j++) { acc[j] /= k; n += acc[j] * acc[j]; }
    n = Math.sqrt(n) || 1;
    for (j = 0; j < acc.length; j++) acc[j] /= n;
    return acc;
  }

  function raw(opts) {
    var t = opts.track, st = opts.stats, i = opts.index, curIndex = opts.curIndex;
    var band = opts.band, curBand = opts.curBand, recentBand = opts.recentBand;
    var now = opts.now, median = opts.medianDur;
    var rec = st.per[t.file] || null;
    var out = {};
    if (!rec) out.novelty = 1;   // never played: maximally novel

    var fpCos = cosineC(band, curBand, opts.norm);
    if (fpCos !== undefined) out.fpCos = fpCos;
    var fpRec = cosineC(band, recentBand, opts.norm);
    if (fpRec !== undefined) out.fpCosRecent = fpRec;

    if (rec) {
      if (rec.artist && num(st.artistEma[rec.artist])) out.artistAffinity = st.artistEma[rec.artist];
      if (rec.ema != null) out.completionEma = rec.ema;
      if (rec.plays > 0) out.skipInv = 1 - clamp(rec.skips / rec.plays, 0, 1);
      out.playCount = clamp(rec.plays / 10, 0, 1);
      /* Novelty used to be 1 - plays/5, i.e. playCount rescaled: perfectly
         rank-correlated with it, so a linear model spent two columns on one
         signal. It now means "forgotten": never played, or untouched for a
         month. Missing rec handled above (never seen = fully novel). */
      out.novelty = (rec.plays === 0 || (now - (rec.lastAt || 0)) / DAY > 30) ? 1 : 0;
      if (rec.lastAt) out.recency = Math.exp(-(Math.max(0, now - rec.lastAt) / DAY) / RECENCY_TAU);
      if (rec.liked) out.likeAffinity = 1;
      var hour = new Date(now).getHours();
      var maxHour = Math.max.apply(null, rec.hours);
      if (maxHour > 0) out.hourFit = rec.hours[hour] / maxHour;
    }

    var trans = st.transitions[opts.curFile];
    if (trans && trans[t.file]) {
      var mx = Math.max.apply(null, Object.keys(trans).map(function (k) { return trans[k]; }));
      out.cooccur = mx ? trans[t.file] / mx : undefined;
    }

    if (median > 0 && num(t.dur) && t.dur > 0) out.durationFit = 1 - clamp(Math.abs(t.dur - median) / median, 0, 1);
    if (num(t.lufs) && num(opts.recentLufs)) out.energyFit = 1 - clamp(Math.abs(t.lufs - opts.recentLufs) / ENERGY_SPAN, 0, 1);
    if (num(i) && num(curIndex)) out.queueDistance = 1 / (1 + Math.abs(i - curIndex));
    /* How close this track sits to what he actually keeps, in embedding space.
       Signed cosine; the model maps it to 0..1 like the other signed features. */
    if (opts.centroid && opts.emb && opts.emb[t.file]) {
      var ec = cosine(opts.emb[t.file], opts.centroid);
      if (ec !== undefined) out.embCos = ec;
    }

    return out;
  }

  return {
    cosine: cosine, cosineC: cosineC, normStats: normStats, meanBands: meanBands, stats: stats, medianDur: medianDur, raw: raw, centroid: centroid,
    DAY: DAY, RECENT_N: RECENT_N
  };
});
