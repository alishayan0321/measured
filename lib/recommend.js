/* MEASURED · recommendation ranker
 * ---------------------------------------------------------------------------
 * One logistic unit over 16 features + bias, trained online with prior-anchored
 * per-feature regularization. No deps, no toolchain: the same file runs in the
 * web shell, the Tauri shell and the Android shell through api.js, and under
 * Node for tests (`node test/recommend.test.cjs`).
 *
 * Settled spec:
 *   · w starts at the hand-tuned heuristic w0, never random; w0 always comes
 *     from code (W0 + W0_VERSION), never from disk — a shipped heuristic change
 *     migrates the learned residual instead of being frozen out by old state.
 *   · x[0] = 1 is the bias / intercept. Because x[0] is constant, fisher[0] IS
 *     the play count; nothing else may assume x[0] == 1.
 *   · w_i -= eta * (g*x_i + lam_i*(w_i - w0_i)),
 *     lam_i = clamp(lam0*sqrt(n0/(n0+n_i)), lamMin, lam0)
 *     lam is computed from the PREVIOUS fisher[i] on purpose: incrementing
 *     first would let one big observation immediately slack its own anchor.
 *   · n_i = sum(x_i^2)  (Fisher information — NOT a sample count)
 *   · serving blends two arms in z space with PER-ARM reference sigma:
 *       z_arm = (s - mu_pool) / (clamp(sigma_ref_arm) + eps)
 *     The degenerate case is POOL-level: if either arm has no usable spread,
 *     BOTH arms fall back to raw centered scores. A per-arm fallback would
 *     leave one arm unit-scaled and the other ~0, silently deleting an arm.
 *   · sigma_ref only advances on real serving pools (isServing), so diagnostic
 *     scoring can never rescale the reference.
 *   · alpha = clamp(median(fisher over features that ever fired)/(that + n0))
 *     — a scalar is the only thing z-space blending can express.
 *   · softmax with temperature T and an exploration floor; deterministic ties.
 *   · persistence: one JSON blob, append-only feature loading.
 *   · production default is learnArm: null — learn from EVERY play. On-policy
 *     learning ('l') only ever sees tracks the learned arm chose, so it can
 *     never generate the evidence that a feature the prior is wrong about
 *     should move; the sim shows playCount staying at +0.04 under on-policy
 *     while flipping negative when every play is used. Learning from all plays
 *     is not a preference, it is the only mode that can correct the heuristic's
 *     own mistakes.
 *
 * A/B: arms are assigned per SESSION. Every estimator here is session-weighted
 * (each session counts once, not each play), so delta(), bootstrap() and cr2()
 * answer the same question. Nothing gates shipping on this — the blend is the
 * arm, the A/B is a diagnostic — so the bootstrap must not be dressed up as a
 * significance test it doesn't implement.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Recommend = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;        // blob format
  var W0_VERSION = 1;     // hand-tuned prior generation
  var WMAX = 5;           // |w| cap: a logistic weight on [0,1] features

  /* Feature order is part of the persisted format: append only, never reorder. */
  var FEATURES = [
    'bias',           // 0 · always 1.0
    'fpCos',          // spectral closeness to the track playing now (signed -1..1 in, mapped to 0..1)
    'fpCosRecent',    // closeness to the mean of the last few played (same mapping)
    'artistAffinity', // completion EMA for this artist
    'albumAffinity',  // completion EMA for this album
    'genreAffinity',  // completion EMA for this genre
    'completionEma',  // this track's own completion history
    'likeAffinity',   // liked / never deleted
    'skipInv',        // 1 - early-skip rate for this track
    'recency',        // decay over days since last play
    'playCount',      // min(1, plays / 10)
    'novelty',        // 1 - min(1, plays / 5)
    'cooccur',        // co-play strength with the current track
    'durationFit',    // closeness to the library median duration
    'energyFit',      // closeness of loudness to the last few played
    'hourFit',        // play-time-of-day affinity
    'queueDistance',  // 1/(1 + index distance) when queued nearby
    'embCos'          // perceptual closeness to what he actually keeps (signed -1..1 in)
  ];

  /* Features that arrive in [-1, 1] and are mapped to [0, 1] by features(). */
  var SIGNED = { fpCos: 1, fpCosRecent: 1, embCos: 1 };

  var W0 = {
    bias: -0.50, fpCos: 1.20, fpCosRecent: 0.80, artistAffinity: 0.60,
    albumAffinity: 0.30, genreAffinity: 0.40, completionEma: 0.90,
    likeAffinity: 1.00, skipInv: 0.70, recency: 0.50, playCount: 0.20,
    novelty: 0.30, cooccur: 0.60, durationFit: 0.20, energyFit: 0.20,
    hourFit: 0.15, queueDistance: 0.10,
    // Embedding similarity is the only feature that hears the track, so it starts
    // strong; W0_VERSION stays 1 because older blobs migrate by appending 0.
    embCos: 1.10
  };

  var DEFAULTS = {
    eta: 0.05,        // learning rate
    lam0: 0.02,       // anchor strength per feature at n_i = 0
    lamMin: 0.002,    // floor: the prior never fully lets go
    n0: 20,           // Fisher mass before a feature is trusted ~halfway
    alphaMin: 0, alphaMax: 0.90,
    T: 0.7,           // softmax temperature in z units
    explore: 0.10,    // uniform floor so the arm is not starved
    sigmaEma: 0.05, sigmaMin: 1e-3, sigmaMax: 1e3,
    eps: 1e-6,
    learnArm: null    // null = every play; 'l' = served picks only; 'h' = heuristic-arm plays only
  };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function num(v) { return typeof v === 'number' && isFinite(v); }
  function sigmoid(z) { return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)); }

  /* Length-tolerant dot: an append-only blob can carry a shorter row. score()
   * is the public entry point and rejects a short x there, where it is a caller
   * bug rather than a legacy format. */
  function dot(a, b) {
    var n = Math.min(a.length, b.length), s = 0;
    for (var i = 0; i < n; i++) { var x = a[i], y = b[i]; s += (num(x) ? x : 0) * (num(y) ? y : 0); }
    return s;
  }

  function mean(a) { if (!a.length) return 0; var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashIds(ids) {
    var h = 2166136261;
    for (var i = 0; i < ids.length; i++) {
      var s = String(ids[i]);
      for (var j = 0; j < s.length; j++) { h ^= s.charCodeAt(j); h = Math.imul(h, 16777619); }
    }
    return h >>> 0;
  }

  function w0Array() { var a = []; for (var i = 0; i < FEATURES.length; i++) a.push(W0[FEATURES[i]] || 0); return a; }

  function Model(opts) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    if (opts) for (k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    /* learnArm says WHICH arm's plays train the learned weights, and only that.
     * null = learn from every play (the production mode); 'l' = only plays served
     * by the learned arm; 'h' = only plays served by the heuristic (useful while
     * serving the heuristic but still collecting a learned arm). The arm label
     * selects the data, not the weights being trained — 'h' is intentional, but
     * silently accepting a typo is not. */
    if (o.learnArm != null && o.learnArm !== 'l' && o.learnArm !== 'h') {
      throw new Error("learnArm must be null, 'l' or 'h'");
    }
    this.opt = o;
    this.w0 = w0Array();
    this.w = this.w0.slice();
    this.fisher = new Float64Array(FEATURES.length);
    this.n = 0;
    this.sigmaRef = { l: null, h: null };
    this.looks = [];              // in-memory decision log; the event log is separate
  }

  /* ---------- features ---------- */

  /* raw: { fpCos: 0.7, recency: 0.3, ... } -> normalized vector, x[0] = 1 */
  Model.prototype.features = function (raw) {
    var x = new Array(FEATURES.length);
    x[0] = 1;
    for (var i = 1; i < FEATURES.length; i++) {
      var name = FEATURES[i], v = raw && raw[name];
      /* Missing is 0, NOT the midpoint of the signed range: mapping an absent
       * cosine to 0.5 would hand every candidate a constant "orthogonal" signal
       * and let the learner move a weight on data that does not exist. A caller
       * that means "unknown" must pass 0.5 explicitly. */
      if (!num(v)) { x[i] = 0; continue; }
      if (SIGNED[name]) v = (v + 1) / 2;          // cosine [-1,1] -> [0,1]
      x[i] = clamp(v, 0, 1);
    }
    return x;
  };

  /* arm must be said out loud: a typo silently scoring the learned arm is how
   * a "heuristic baseline" ends up being the model you were comparing against. */
  Model.prototype.score = function (x, arm) {
    if (arm !== 'h' && arm !== 'l') throw new Error("score(x, arm): arm must be 'h' or 'l'");
    /* A short x would silently score with the first few weights and look fine.
     * Only features() output (or a same-length raw vector) is meaningful. */
    if (!x || x.length !== FEATURES.length) throw new Error('score(x): x must have ' + FEATURES.length + ' entries');
    return dot(arm === 'h' ? this.w0 : this.w, x);
  };

  /* ---------- learning ---------- */

  /* One SGD step. x is a features() vector, y in {0,1}, weight for hard labels,
   * arm ('h'|'l') only matters when opt.learnArm is set. */
  Model.prototype.observe = function (x, y, weight, arm) {
    var o = this.opt;
    if (o.learnArm && arm && arm !== o.learnArm) return this;
    var wgt = num(weight) ? weight : 1;
    var g = (sigmoid(dot(this.w, x)) - y) * wgt;
    for (var i = 0; i < FEATURES.length; i++) {
      var xi = num(x[i]) ? x[i] : 0;
      var n_i = this.fisher[i];
      var lam = clamp(o.lam0 * Math.sqrt(o.n0 / (o.n0 + n_i)), o.lamMin, o.lam0);
      this.w[i] = clamp(this.w[i] - o.eta * (g * xi + lam * (this.w[i] - this.w0[i])), -WMAX, WMAX);
      this.fisher[i] += xi * xi;
    }
    this.n += 1;
    return this;
  };

  /* completion in 0..1 -> label, or null when the signal is ambiguous.
   * elapsed/duration in seconds: nothing under 10 s of real playback is a
   * verdict, otherwise a 30 s interlude's early skip looks like a 50% listen. */
  Model.prototype.labelFromCompletion = function (completion, elapsed, duration) {
    if (num(elapsed) && elapsed < 10) return null;
    if (num(duration) && duration > 0 && elapsed > duration) completion = 1;
    if (completion > 0.5) return { y: 1, weight: 1 };
    if (completion < 0.2) return { y: 0, weight: 1 };
    return null;
  };

  /* Hard labels the UI can emit without any completion math. */
  Model.prototype.labelFromEvent = function (kind) {
    if (kind === 'delete') return { y: 0, weight: 2 };
    if (kind === 'early_skip') return { y: 0, weight: 1 };
    if (kind === 'replay' || kind === 'like') return { y: 1, weight: 1 };
    return null;
  };

  /* Trust in the learned arm. A scalar, because z-space blending happens after
   * the dot product collapsed the features. Median over the features that have
   * actually fired: a library with no genre tags must not pin alpha at 0. */
  Model.prototype.alpha = function () {
    var o = this.opt, f = this.fisher, v = [], i;
    for (i = 1; i < f.length; i++) if (f[i] > 0) v.push(f[i]);
    if (!v.length) return clamp(0, o.alphaMin, o.alphaMax);
    v.sort(function (a, b) { return a - b; });
    var med = v[v.length >> 1];
    return clamp(med / (med + o.n0), o.alphaMin, o.alphaMax);
  };

  /* ---------- serving ---------- */

  /* cands: [{ id, sL, sH }] scored by the learned and the heuristic arm.
   * Only pass isServing=true from the real serving path: diagnostic calls must
   * not advance the reference sigma. */
  Model.prototype.blend = function (cands, isServing) {
    var o = this.opt, n = cands.length;
    if (!n) return [];

    var mu = { l: 0, h: 0 }, i, c;
    for (i = 0; i < n; i++) { mu.l += cands[i].sL; mu.h += cands[i].sH; }
    mu.l /= n; mu.h /= n;

    var sd = { l: 0, h: 0 };
    if (n > 1) {
      for (i = 0; i < n; i++) {
        sd.l += (cands[i].sL - mu.l) * (cands[i].sL - mu.l);
        sd.h += (cands[i].sH - mu.h) * (cands[i].sH - mu.h);
      }
      sd.l = Math.sqrt(sd.l / (n - 1));
      sd.h = Math.sqrt(sd.h / (n - 1));
    }

    /* POOL-level degeneracy: one arm without spread means neither can be
     * standardized without the other silently disappearing. */
    var degenerate = n < 2 || !(sd.l > o.sigmaMin) || !(sd.h > o.sigmaMin);

    if (isServing && !degenerate) {
      ['l', 'h'].forEach(function (arm) {
        var prev = this.sigmaRef[arm];
        this.sigmaRef[arm] = prev == null ? sd[arm] : (1 - o.sigmaEma) * prev + o.sigmaEma * sd[arm];
      }, this);
    }

    var a = this.alpha(), out = new Array(n);
    for (i = 0; i < n; i++) {
      c = cands[i];
      var zL = degenerate ? (c.sL - mu.l) : this.z(c.sL, mu.l, 'l');
      var zH = degenerate ? (c.sH - mu.h) : this.z(c.sH, mu.h, 'h');
      out[i] = { id: c.id, score: a * zL + (1 - a) * zH, zL: zL, zH: zH, alpha: a };
    }
    return out;
  };

  Model.prototype.z = function (s, mu, arm) {
    var o = this.opt, sr = this.sigmaRef[arm];
    if (sr == null) return s - mu;
    sr = clamp(sr, o.sigmaMin, o.sigmaMax);
    return (s - mu) / (sr + o.eps);
  };

  /* Softmax sample with an exploration floor and deterministic tie-breaking.
   * `seed` overrides the nonce (tests, bug reports). The default nonce depends
   * on n so a static pool does not reproducibly ignore its own exploration. */
  Model.prototype.pick = function (cands, seed) {
    var ranked = this.blend(cands, true);
    if (!ranked.length) return null;

    ranked.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
    });

    var o = this.opt, max = ranked[0].score, sum = 0, i;
    var p = new Array(ranked.length);
    for (i = 0; i < ranked.length; i++) { p[i] = Math.exp((ranked[i].score - max) / o.T); sum += p[i]; }
    for (i = 0; i < ranked.length; i++) p[i] = p[i] / sum;

    var floor = o.explore, uniform = 1 / ranked.length;
    for (i = 0; i < ranked.length; i++) p[i] = (1 - floor) * p[i] + floor * uniform;

    var ids = cands.map(function (c) { return c.id; });
    var auto = (hashIds(ids) ^ Math.imul(this.n, 2654435761)) >>> 0;
    var rnd = mulberry32(seed == null ? auto : seed);
    var r = rnd(), acc = 0;
    for (i = 0; i < ranked.length; i++) { acc += p[i]; if (r <= acc) return ranked[i]; }
    return ranked[ranked.length - 1];
  };

  /* Decision log entry. Kept in memory only: the per-pick event log is the
   * durable record and it is what re-blocking needs. */
  Model.prototype.recordLook = function (look) {
    var row = { t: Date.now() };
    for (var k in look) if (Object.prototype.hasOwnProperty.call(look, k)) row[k] = look[k];
    this.looks.push(row);
    if (this.looks.length > 200) this.looks.shift();
    return this;
  };

  Model.prototype.reset = function () {
    this.w = this.w0.slice();
    this.fisher = new Float64Array(FEATURES.length);
    this.n = 0;
    this.sigmaRef = { l: null, h: null };
    return this;
  };

  /* ---------- A/B: session-weighted, one estimator everywhere ---------- */

  function clusterStats(events) {
    var by = {}, keys = [], i;
    for (i = 0; i < events.length; i++) {
      var e = events[i];
      var key = e.session == null ? ('_' + i) : String(e.session);   // never share a sign by accident
      var c = by[key];
      if (!c) { c = by[key] = { h: 0, nh: 0, l: 0, nl: 0 }; keys.push(key); }
      var isSkip = e.skip === true || e.kind === 'skip';
      if (e.arm === 'h') { c.nh++; if (isSkip) c.h++; }
      else if (e.arm === 'l') { c.nl++; if (isSkip) c.l++; }
    }
    return { by: by, keys: keys };
  }

  function rates(cs) {
    var H = [], L = [], i, c;
    for (i = 0; i < cs.keys.length; i++) {
      c = cs.by[cs.keys[i]];
      if (c.nh) H.push(c.h / c.nh);
      if (c.nl) L.push(c.l / c.nl);
    }
    return { H: H, L: L };
  }

  /* delta = mean(session skip rate, heuristic) - mean(session skip rate, learned)
   * Positive means the learned arm skips less, i.e. it wins. */
  function delta(events) {
    var cs = clusterStats(events), r = rates(cs);
    return {
      delta: mean(r.H) - mean(r.L),
      mean_h: mean(r.H), mean_l: mean(r.L),
      sessions_h: r.H.length, sessions_l: r.L.length
    };
  }

  function sufficiency(events, minPicks, minSessions) {
    minPicks = minPicks || 100; minSessions = minSessions || 20;
    var cs = clusterStats(events), picksH = 0, picksL = 0, sessH = 0, sessL = 0, i, c;
    for (i = 0; i < cs.keys.length; i++) {
      c = cs.by[cs.keys[i]];
      picksH += c.nh; picksL += c.nl;
      if (c.nh) sessH++;
      if (c.nl) sessL++;
    }
    return {
      ok: sessH >= minSessions && sessL >= minSessions && picksH >= minPicks && picksL >= minPicks,
      picks_h: picksH, picks_l: picksL, sessions_h: sessH, sessions_l: sessL
    };
  }

  /* CR2-style cluster-robust standard error: variance of the per-session rates
   * with a Bell–McCaffrey small-sample factor. Used only to cross-check that the
   * bootstrap interval and the t-statistic agree in sign. */
  function cr2(events) {
    var cs = clusterStats(events), r = rates(cs);
    function se(a) {
      var G = a.length;
      if (G < 2) return Infinity;
      var m = mean(a), s2 = 0;
      for (var i = 0; i < a.length; i++) s2 += (a[i] - m) * (a[i] - m);
      s2 /= (G - 1);
      var adj = G / (G - 1);                       // Bell–McCaffrey, equal cluster weights
      return Math.sqrt(s2 / G) * Math.sqrt(adj);
    }
    var eh = se(r.H), el = se(r.L), sd = Math.sqrt(eh * eh + el * el);
    var d = mean(r.H) - mean(r.L);
    return { se: sd, t: sd > 0 && isFinite(sd) ? d / sd : 0, delta: d };
  }

  /* Wild cluster bootstrap on the estimator's influence function.
   *   · centered residuals (not raw counts) -> correct second moment
   *   · Rademacher sign drawn per session, shared by both arms of that session
   *   · p_one_sided is null-imposed (residuals centered on the pooled skip rate)
   *   · lo/hi are percentiles, not the sample min/max
   * Cluster weights are equal per session, matching delta(). */
  function bootstrap(events, reps, alphaLevel, minPicks, minSessions) {
    reps = reps || 2000;
    alphaLevel = alphaLevel == null ? 0.05 : alphaLevel;
    var cs = clusterStats(events), keys = cs.keys, i, k;

    var sumH = 0, sumL = 0, nh = 0, nl = 0;
    for (i = 0; i < keys.length; i++) { sumH += cs.by[keys[i]].h; sumL += cs.by[keys[i]].l; nh += cs.by[keys[i]].nh; nl += cs.by[keys[i]].nl; }
    if (!nh || !nl) return { delta: 0, lo: 0, hi: 0, p_one_sided: 1, reps: reps, sufficient: false };

    var r = rates(cs), mH = mean(r.H), mL = mean(r.L), obs = mH - mL, pooled = (sumH + sumL) / (nh + nl);
    var G = keys.length, rnd = mulberry32(0xC0FFEE);

    /* One or two sessions means one or two Rademacher signs, so every replicate
     * is the point estimate and p is a coin flip. That is not a wide interval,
     * it is no interval: refuse instead of returning lo === hi === obs. */
    if (G < 3) {
      return { delta: obs, lo: NaN, hi: NaN, p_one_sided: NaN, reps: reps, sufficient: false, degenerate: true };
    }
    var centered = new Array(reps), nulls = new Array(reps), signs = new Int8Array(G);

    for (var b = 0; b < reps; b++) {
      for (i = 0; i < G; i++) signs[i] = rnd() < 0.5 ? -1 : 1;
      var cSum = 0, cN = 0, nSum = 0, nN = 0;
      for (i = 0; i < G; i++) {
        var c = cs.by[keys[i]], sgn = signs[i];
        if (c.nh) { cSum += sgn * (c.h / c.nh - mH); cN++; nSum += sgn * (c.h / c.nh - pooled); nN++; }
        if (c.nl) { cSum -= sgn * (c.l / c.nl - mL); cN++; nSum -= sgn * (c.l / c.nl - pooled); nN++; }
      }
      centered[b] = obs + (cN ? cSum / cN : 0);
      nulls[b] = nN ? nSum / nN : 0;
    }

    function q(arr, p) { var a = arr.slice().sort(function (x, y) { return x - y; }); return a[Math.min(a.length - 1, Math.max(0, Math.floor(a.length * p)))]; }
    var above = 0;
    for (i = 0; i < reps; i++) if (nulls[i] >= obs) above++;

    return {
      delta: obs, lo: q(centered, alphaLevel), hi: q(centered, 1 - alphaLevel),
      p_one_sided: above / reps, reps: reps,
      sufficient: sufficiency(events, minPicks, minSessions).ok
    };
  }

  /* ---------- persistence: one JSON blob ---------- */

  Model.prototype.toJSON = function () {
    return {
      v: VERSION,
      w0Version: W0_VERSION,
      w: Array.prototype.slice.call(this.w),
      w0: this.w0.slice(),                       // provenance for migration only
      fisher: Array.prototype.slice.call(this.fisher),
      n: this.n,
      sigma: { l: this.sigmaRef.l, h: this.sigmaRef.h }
    };
  };

  Model.fromJSON = function (blob, opts) {
    var m = new Model(opts), o = m.opt, i;
    if (!blob || typeof blob !== 'object' || blob.v !== VERSION) return m;   // unknown layout: keep the prior

    /* Append-only: a blob written before a feature existed loads its prefix and
     * the new features start at their prior. Requiring an exact length would
     * throw away all learning the moment FEATURES grows. */
    if (Array.isArray(blob.w)) {
      var nw = Math.min(blob.w.length, FEATURES.length);
      for (i = 0; i < nw; i++) if (num(blob.w[i])) m.w[i] = clamp(blob.w[i], -WMAX, WMAX);
      if (num(blob.n) && blob.n >= 0) m.n = blob.n;
    }
    if (Array.isArray(blob.fisher)) {
      var nf = Math.min(blob.fisher.length, FEATURES.length);
      for (i = 0; i < nf; i++) if (num(blob.fisher[i]) && blob.fisher[i] >= 0) m.fisher[i] = blob.fisher[i];
    }
    if (blob.sigma) {
      if (num(blob.sigma.l)) m.sigmaRef.l = clamp(blob.sigma.l, o.sigmaMin, o.sigmaMax);
      if (num(blob.sigma.h)) m.sigmaRef.h = clamp(blob.sigma.h, o.sigmaMin, o.sigmaMax);
    }

    /* The prior is code, not user state: if the shipped heuristic moved, shift
     * the learned residual by the difference instead of freezing the old anchor.
     * An append-only blob can have a shorter w0 than today's FEATURES, so the
     * missing tail is treated as "unchanged prior" (diff 0) rather than as a
     * reason to skip the migration entirely. */
    if (blob.w0Version !== W0_VERSION && Array.isArray(blob.w0)) {
      for (i = 0; i < FEATURES.length; i++) {
        var old = num(blob.w0[i]) ? blob.w0[i] : m.w0[i];
        m.w[i] = clamp(m.w[i] + (m.w0[i] - old), -WMAX, WMAX);
      }
    }
    return m;
  };

  return {
    VERSION: VERSION, W0_VERSION: W0_VERSION, WMAX: WMAX,
    FEATURES: FEATURES, W0: W0, DEFAULTS: DEFAULTS,
    Model: Model, delta: delta, sufficiency: sufficiency, bootstrap: bootstrap, cr2: cr2,
    _internals: { clamp: clamp, sigmoid: sigmoid, mulberry32: mulberry32, hashIds: hashIds, w0Array: w0Array, clusterStats: clusterStats, SIGNED: SIGNED }
  };
});
