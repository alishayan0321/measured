/* MEASURED · ranker wiring
 * ---------------------------------------------------------------------------
 * The only place that knows about storage, sessions and the A/B arm.
 * lib/recommend.js is the math, lib/recommend-features.js is the data, this is
 * the plug.
 *
 * Decisions encoded here (they are not the library's to make):
 *   · A session gets a random arm. 20% of sessions serve PURE heuristic so the
 *     two-week skip rate has a baseline; without it the blend is unmeasured.
 *   · Recommendation is gated on history: fewer than 20 observed plays and the
 *     caller keeps its sequential behaviour. The coverage diagnostic shows 5/16
 *     features live at cold start — recommending then would be a model of a
 *     library it has not been told about yet.
 *   · observe() fires on EVERY track exit, including skips. Learning from
 *     completions only degenerates into on-policy learning, which cannot
 *     correct a wrong prior.
 *   · pick() runs once per play; sigma_ref advances once per play.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(
    require('./recommend.js'), require('./recommend-features.js'));
  else root.RecommendWire = factory(root.Recommend, root.RecommendFeatures);
})(typeof self !== 'undefined' ? self : this, function (R, F) {
  'use strict';

  var KEY_MODEL = 'measured.rec.model';
  var KEY_LOG = 'measured.rec.log';
  var MIN_OBSERVED = 20;      // plays before a recommendation is worth making
  var HEUR_SHARE = 0.20;      // share of sessions served pure heuristic (A/B)
  var LOG_CAP = 2000;
  var COV_THRESHOLD = 0.60;   // the diagnostic's bar, applied at runtime too
  var REPEAT_WINDOW = 12;     // distinct tracks kept out of the next pick

  function safeJson(s, fallback) {
    try { var v = JSON.parse(s); return v == null ? fallback : v; } catch (e) { return fallback; }
  }

  /* The files heard most recently, newest first, de-duplicated. A picker that
     re-serves the song it just played reads as broken no matter how good its
     score maths is, so this window is a hard filter, not a penalty. */
  function repeatSet(events, n) {
    var out = {}, count = 0;
    for (var i = events.length - 1; i >= 0 && count < n; i--) {
      var f = events[i] && events[i].file;
      if (!f || out[f]) continue;
      out[f] = 1;
      count++;
    }
    return out;
  }

  function create(opts) {
    var o = opts || {};
    var store = o.store || { get: function () { return null; }, set: function () {} };
    var now = o.now || function () { return Date.now(); };
    var rnd = o.random || Math.random;

    var arm = rnd() < HEUR_SHARE ? 'h' : 'l';
    var model = R.Model.fromJSON(safeJson(store.get(KEY_MODEL, ''), null), {});
    var events = safeJson(store.get(KEY_LOG, ''), []);
    if (!Array.isArray(events)) events = [];

    var pending = null;          // { file, artist, x, at, arm } — the play in progress
    var picked = null;           // { file, x } — the pick that started it
    var saveTimer = null;
    var lastStats = null;

    function save() {
      try { store.set(KEY_MODEL, JSON.stringify(model.toJSON())); } catch (e) {}
      try { store.set(KEY_LOG, JSON.stringify(events.slice(-LOG_CAP))); } catch (e) {}
    }
    function saveSoon() {
      if (saveTimer) return;
      saveTimer = setTimeout(function () { saveTimer = null; save(); }, 1200);
      if (saveTimer && saveTimer.unref) saveTimer.unref();
    }

    /* Model embeddings, if the library carries them (t.emb, 768 floats). */
    function embMap(lib) {
      var m = {};
      var list = lib.tracks || [];
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (t && t.file && t.emb && t.emb.length) m[t.file] = t.emb;
      }
      return m;
    }

    /* The taste pole: mean embedding of the tracks he keeps (completion EMA
       above a half, or liked), most-loved first. Falls back to what just
       played, so a fresh install still has a pole. */
    function keepCentroid(st, emb) {
      var files = [], f, rec;
      for (f in st.per) {
        if (!Object.prototype.hasOwnProperty.call(st.per, f)) continue;
        rec = st.per[f];
        if (!rec) continue;
        if (rec.liked || (rec.ema != null && rec.ema > 0.5)) files.push(f);
      }
      files.sort(function (a, b) { return ((st.per[b] && st.per[b].ema) || 0) - ((st.per[a] && st.per[a].ema) || 0); });
      if (files.length > 20) files = files.slice(0, 20);
      if (!files.length) files = (st.recentFiles || []).slice();
      return F.centroid(files, emb);
    }

    function buildContext(lib) {
      var st = F.stats(events);
      var emb = embMap(lib);
      var bands = lib.bandsOf || function () { return null; };
      var recent = (st.recentFiles || []).map(function (f) { return bands(f); }).filter(Boolean);
      var recentLufs = null;
      var lu = (st.recentFiles || []).map(function (f) { return lib.lufsOf && lib.lufsOf(f); }).filter(function (v) { return typeof v === 'number' && isFinite(v) && v; });
      if (lu.length) recentLufs = lu.reduce(function (a, b) { return a + b; }, 0) / lu.length;
      return {
        st: st,
        curBand: bands(lib.cur && lib.cur.file),
        recentBand: F.meanBands(recent),
        recentLufs: recentLufs,
        median: F.medianDur(lib.tracks || []),
        norm: F.normStats((lib.tracks || []).map(function (t) { return t.bands; })),
        emb: emb,
        centroid: keepCentroid(st, emb)
      };
    }

    /* Which feature count is live right now, measured on the real pool. */
    function coverage(ctx, lib) {
      var seen = {}, live = 0;
      for (var i = 0; i < (lib.view || []).length; i++) {
        var t = lib.view[i];
        var r = F.raw({
          track: t, stats: ctx.st, index: i, curIndex: lib.curIndex,
          band: lib.bandsOf && lib.bandsOf(t.file), curBand: ctx.curBand,
          recentBand: ctx.recentBand, recentLufs: ctx.recentLufs,
          now: now(), medianDur: ctx.median, norm: ctx.norm, curFile: lib.cur && lib.cur.file,
          emb: ctx.emb, centroid: ctx.centroid
        });
        for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k) && r[k] !== undefined && Math.abs(r[k]) > 1e-9) seen[k] = 1;
      }
      for (var f in seen) if (seen[f]) live++;
      return live / R.FEATURES.length;
    }

    function ready(lib) {
      if (!lib || !lib.tracks || !lib.tracks.length) return false;
      var cov = coverage(buildContext(lib), lib);
      lastStats = { coverage: cov, observed: events.length, sessions: F.stats(events).sessions, arm: arm };
      return events.length >= MIN_OBSERVED && cov >= COV_THRESHOLD;
    }

    /* Called when a track becomes the current one. */
    function begin(track, lib) {
      if (!track) return;
      /* A recommendation already computed and scored the row it chose; keep that
       * exact vector so the label pairs with the prediction it graded. */
      var x = picked && picked.file === track.file ? picked.x : null;
      if (!x) {
        var ctx = buildContext(lib);
        x = model.features(F.raw({
          track: track, stats: ctx.st, index: lib.curIndex, curIndex: lib.curIndex,
          band: lib.bandsOf && lib.bandsOf(track.file), curBand: ctx.curBand,
          recentBand: ctx.recentBand, recentLufs: ctx.recentLufs,
          now: now(), medianDur: ctx.median, norm: ctx.norm, curFile: track.file
        }));
      }
      picked = null;
      /* Listened time is accumulated from playback deltas, never from the
         position: a seek to the end must not read as a full listen. */
      listenSec = 0; lastT = -1;
      pending = { file: track.file, artist: track.artist, at: now(), x: x, arm: arm };
    }

    /* Called when the current track stops being current, for any reason.
     * elapsed in seconds; dur in seconds. */
    /* Audio calls this on every timeupdate. Only forward, near-real-time
       deltas count, so seeks and background jumps cannot inflate a listen. */
    function tick(t) {
      if (!pending || typeof t !== 'number') return;
      if (lastT >= 0 && t > lastT && t - lastT <= 2) listenSec += t - lastT;
      lastT = t;
    }

    /* Hard rating from the UI; graded on the pending row without consuming it,
       so the play's own completion label still lands. */
    function mark(kind) {
      if (!pending) return null;
      var label = model.labelFromEvent(kind);
      if (label) model.observe(pending.x, label.y, label.weight, pending.arm);
      events.push({ file: pending.file, artist: pending.artist, at: now(), elapsed: 0, dur: 0, kind: kind, arm: pending.arm, session: sessionId, listenedSec: 0, naturalEnd: false, skip: false });
      if (events.length > LOG_CAP) events = events.slice(-LOG_CAP);
      saveSoon();
      return label;
    }

    /* Called when the current track stops being current, for any reason.
     * elapsed in seconds; dur in seconds; opts.naturalEnd when the track ended. */
    function end(elapsed, dur, kind, opts) {
      if (!pending) return null;
      var p = pending;
      pending = null;
      var natural = !!(opts && opts.naturalEnd);
      var listened = listenSec > 0 ? listenSec : (natural ? (dur || 0) : Math.max(0, elapsed || 0));
      var completion = natural ? 1 : ((typeof dur === 'number' && dur > 0) ? listened / dur : 0);
      var k = kind || (natural ? 'play' : (completion < 0.2 ? 'skip' : 'play'));
      var label = k === 'delete' ? model.labelFromEvent('delete')
        : k === 'like' ? model.labelFromEvent('like')
        : model.labelFromCompletion(completion, listened, dur);
      var ev = {
        file: p.file, artist: p.artist, at: p.at, elapsed: elapsed, dur: dur, kind: k,
        arm: p.arm, session: sessionId,
        listenedSec: Math.round(listened * 10) / 10, naturalEnd: natural,
        skip: !natural && completion < 0.2,
        candCount: candCount || 0, propensity: candCount > 0 ? 1 / candCount : 0
      };
      events.push(ev);
      if (events.length > LOG_CAP) events = events.slice(-LOG_CAP);
      /* A deliberate skip is a verdict even when the completion maths is
         ambiguous: it is the cheapest negative label this app can produce. */
      if (label) model.observe(p.x, label.y, label.weight, p.arm);
      else if (k === 'skip') model.observe(p.x, 0, 1, p.arm);
      saveSoon();
      return label;
    }

    /* index into lib.view of the recommended next track, or null to let the
     * caller do its normal sequential thing. */
    function nextIndex(lib) {
      if (!lib || !lib.view || lib.view.length < 2) return null;
      var ctx = buildContext(lib);
      if (events.length < MIN_OBSERVED || coverage(ctx, lib) < COV_THRESHOLD) return null;

      var recent = repeatSet(events, REPEAT_WINDOW);
      var cands = [], xs = {};
      for (var i = 0; i < lib.view.length; i++) {
        var t = lib.view[i];
        if (lib.cur && t.file === lib.cur.file) continue;
        if (recent[t.file]) continue;
        var raw = F.raw({
          track: t, stats: ctx.st, index: i, curIndex: lib.curIndex,
          band: lib.bandsOf && lib.bandsOf(t.file), curBand: ctx.curBand,
          recentBand: ctx.recentBand, recentLufs: ctx.recentLufs,
          now: now(), medianDur: ctx.median, norm: ctx.norm, curFile: lib.cur && lib.cur.file,
          emb: ctx.emb, centroid: ctx.centroid
        });
        var x = model.features(raw);
        xs[t.file] = x;
        cands.push({ id: t.file, i: i, x: x, sL: model.score(x, 'l'), sH: model.score(x, 'h') });
      }
      /* A small library cannot afford a 12-track hole; fall back to excluding
         only what is playing now. */
      if (cands.length < 2) {
        cands = []; xs = {};
        for (var j = 0; j < lib.view.length; j++) {
          var t2 = lib.view[j];
          if (lib.cur && t2.file === lib.cur.file) continue;
          var raw2 = F.raw({
            track: t2, stats: ctx.st, index: j, curIndex: lib.curIndex,
            band: lib.bandsOf && lib.bandsOf(t2.file), curBand: ctx.curBand,
            recentBand: ctx.recentBand, recentLufs: ctx.recentLufs,
            now: now(), medianDur: ctx.median, norm: ctx.norm, curFile: lib.cur && lib.cur.file,
            emb: ctx.emb, centroid: ctx.centroid
          });
          var x2 = model.features(raw2);
          xs[t2.file] = x2;
          cands.push({ id: t2.file, i: j, x: x2, sL: model.score(x2, 'l'), sH: model.score(x2, 'h') });
        }
      }
      if (!cands.length) return null;

      candCount = cands.length;
      var chosen;
      if (arm === 'h') {
        var ranked = cands.slice().sort(function (a, b) { return (b.sH - a.sH) || (String(a.id) < String(b.id) ? -1 : 1); });
        /* A deterministic control arm collapses into a two-song loop, which
           would make the A/B compare a loop against a sampler. Keep a small
           exploration floor so the baseline stays a baseline. */
        var hExplore = (o && typeof o.hExplore === 'number') ? o.hExplore : 0.15;
        if (ranked.length > 1 && rnd() < hExplore) {
          var top = ranked.slice(0, Math.min(5, ranked.length));
          ranked = [top[Math.min(top.length - 1, Math.floor(rnd() * top.length))]];
        }
        chosen = ranked[0];
      } else {
        chosen = model.pick(cands);
        var hit = chosen && cands.filter(function (c) { return c.id === chosen.id; })[0];
        chosen = hit || chosen;
      }
      if (!chosen) return null;
      /* stash the x so the observation that follows this play is graded against
       * the row that was actually scored — begin() picks it up. */
      picked = { file: chosen.id, x: chosen.x };
      return chosen.i;
    }

    /* Top-N rows for an "up next" list. Read-only: it scores exactly what
     * nextIndex() would score, but returns the ranking instead of consuming a
     * pick, so showing the list never pollutes the A/B log. */
    function rank(lib, n) {
      var out = [];
      if (!lib || !lib.view || !lib.view.length) return out;
      var want = Math.max(1, Math.min(20, n || 8));

      var cold = events.length < MIN_OBSERVED;
      var ctx = buildContext(lib);
      if (cold || coverage(ctx, lib) < COV_THRESHOLD) {
        for (var c = 0; c < lib.view.length && out.length < want; c++) {
          var tc = lib.view[c];
          if (lib.cur && tc.file === lib.cur.file) continue;
          out.push({ index: c, file: tc.file, title: tc.title, artist: tc.artist, score: 0, cold: true });
        }
        return out;
      }

      var recent = repeatSet(events, REPEAT_WINDOW);
      for (var i = 0; i < lib.view.length; i++) {
        var t = lib.view[i];
        if (lib.cur && t.file === lib.cur.file) continue;
        if (recent[t.file]) continue;
        var raw = F.raw({
          track: t, stats: ctx.st, index: i, curIndex: lib.curIndex,
          band: lib.bandsOf && lib.bandsOf(t.file), curBand: ctx.curBand,
          recentBand: ctx.recentBand, recentLufs: ctx.recentLufs,
          now: now(), medianDur: ctx.median, norm: ctx.norm, curFile: lib.cur && lib.cur.file,
          emb: ctx.emb, centroid: ctx.centroid
        });
        var x = model.features(raw);
        out.push({ index: i, file: t.file, title: t.title, artist: t.artist, score: model.score(x, 'l') });
      }
      out.sort(function (a, b) { return (b.score - a.score) || (String(a.file) < String(b.file) ? -1 : 1); });
      return out.slice(0, want);
    }

    function sessionStart(sid) { sessionId = sid; }

    var sessionId = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var listenSec = 0, lastT = -1, candCount = 0;

    return {
      arm: arm,
      sessionId: sessionId,
      sessionStart: sessionStart,
      begin: begin,
      tick: tick,
      mark: mark,
      end: end,
      ready: ready,
      nextIndex: nextIndex,
      rank: rank,
      stats: function () { return lastStats; },
      model: function () { return model; },
      events: function () { return events.slice(); },
      save: save,
      keys: { model: KEY_MODEL, log: KEY_LOG }
    };
  }

  return { create: create, KEY_MODEL: KEY_MODEL, KEY_LOG: KEY_LOG, MIN_OBSERVED: MIN_OBSERVED, COV_THRESHOLD: COV_THRESHOLD, HEUR_SHARE: HEUR_SHARE };
});
