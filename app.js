(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const audio = $('audio');
  audio.crossOrigin = 'anonymous';   // the proxy answers with ACAO, so this is clean

  /* Every remote or asset URL goes through the loopback proxy: it re-serves the
     bytes with CORS headers (and speaks googlevideo's bounded-range dialect), so
     the element stays readable by Web Audio. Empty PROXY = direct playback. */
  let PROXY = '';
  const proxied = (url, total) => {
    if (!url || !PROXY || String(url).startsWith(PROXY)) return url;
    return PROXY + '/u?u=' + encodeURIComponent(url) + (total ? '&n=' + total : '');
  };

  /* ---- equaliser ---------------------------------------------------------
     Web Audio can only read a source it is allowed to touch, and both of ours
     are cross-origin (the asset protocol and googlevideo). The Rust side runs a
     loopback proxy that re-serves either one with CORS headers, so the audible
     element becomes same-origin and a real filter chain is possible. One chain:
     element -> preamp -> five peaking bands -> analyser -> loudness gain ->
     speakers. Bands sit at 0 dB by default, so with the EQ off the sound is
     unchanged. */
  const EQ_BANDS = [60, 230, 910, 3600, 14000];
  const EQ_PRESETS = {
    Flat: [0, 0, 0, 0, 0],
    'Bass boost': [7, 5, 1, 0, 0],
    Vocal: [-2, 0, 3, 4, 1],
    Rock: [5, 2, -1, 3, 5],
    Pop: [-1, 2, 4, 2, -1],
    Electronic: [6, 3, 0, 2, 5],
    'Late night': [-3, -1, 2, 1, -2],
  };
  let eqCtx = null, eqPre = null, eqBands = [], eqOn = false, eqGains = EQ_BANDS.map(() => 0);
  let eqBound = false;                     // the one-way door is behind us: audio is claimed
  let eqDead = false;                      // claimed, but the graph never finished wiring

  function eqLoad() {
    try {
      const raw = JSON.parse(localStorage.getItem('measured.eq') || '{}');
      if (Array.isArray(raw.gains) && raw.gains.length === EQ_BANDS.length) eqGains = raw.gains.map(Number);
      eqOn = !!raw.on;
    } catch (e) { /* first run */ }
  }
  function eqSave() {
    try { localStorage.setItem('measured.eq', JSON.stringify({ on: eqOn, gains: eqGains })); } catch (e) {}
  }
  function eqBuild() {
    /* Order is load-bearing. createMediaElementSource() is a one-way door: once it
       returns, the element belongs to this context forever and no other context can
       ever claim it. So the whole chain is built and wired to ac.destination FIRST,
       and the element is claimed LAST — a failure before the claim leaves the
       element untouched and the next call can retry cleanly. */
    if (eqDead) return false;            // claimed, then never finished: do not report success
    if (eqCtx) return true;
    if (!PROXY) return false;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      eqCtx = new AC();
      eqPre = eqCtx.createGain();
      eqPre.gain.value = 1;
      let node = eqPre;
      eqBands = EQ_BANDS.map((f) => {
        const b = eqCtx.createBiquadFilter();
        b.type = 'peaking';
        b.frequency.value = f;
        b.Q.value = 1.1;
        b.gain.value = 0;
        node.connect(b);
        node = b;
        return b;
      });
      const an = eqCtx.createAnalyser();
      an.fftSize = 4096;
      an.smoothingTimeConstant = 0.82;
      node.connect(an);
      /* The loudness gain sits AFTER the analyser so the meter keeps showing EQ
         shape only; putting it upstream would make the spectrum jump on every
         track change and read as a rendering bug. `node` is deliberately NOT
         rebound to eqPost: an -> eqPost -> destination is the single audio path,
         and any surviving node.connect(destination) would bypass the gain. */
      eqPost = eqCtx.createGain();
      eqPost.gain.value = 1;               // explicit unity start, not the default
      an.connect(eqPost);
      eqPost.connect(eqCtx.destination);
      analyser = an;                       // the visualiser now reads the real output
      freq = new Uint8Array(an.frequencyBinCount);
      /* Last, and only last: claim the audible element. The flag is set on the very
         next line, not after the connect — from the instant this call returns, the
         catch below must never null eqCtx, or the next attempt would re-enter
         createMediaElementSource() and throw InvalidStateError on every play. */
      const src = eqCtx.createMediaElementSource(audio);
      eqBound = true;
      src.connect(eqPre);
      return true;
    } catch (e) {
      if (eqBound) {
        /* The element is already captive and the graph is incomplete, so playback is
           silent and unrecoverable. Say so once and stop retrying: returning false
           here is honest, returning true would make eqApply configure a chain that
           can never reach the speakers. */
        eqDead = true;
      } else {
        /* analyser/freq are the visualiser's shared state, not this graph's private
           nodes: line 430 points analyser at eqCtx, but initGraph owns the fallback
           path and would be broken by nulling it here. They are left alone on
           purpose; the next successful build reassigns both. */
        eqCtx = null; eqPre = null; eqPost = null; eqBands = [];
      }
      return false;
    }
  }
  function eqApply() {
    if (!eqBuild()) return;
    /* eqBuild() is lazy — it only runs on the element's first play event — so the
       setLoudnessGain(t) inside select() is a silent no-op for the first track of
       a session (eqPost is still null then). Re-apply now that the node exists.
       Idempotent: repeated play/pause rewrites the same target, which
       setTargetAtTime treats as a no-op, not a recompute. */
    setLoudnessGain(VIEW[cur]);
    if (eqCtx.state === 'suspended') eqCtx.resume().catch(() => {});
    eqBands.forEach((b, i) => { b.gain.value = eqOn ? eqGains[i] : 0; });
  }

  (function eqWire() {
    const on = document.getElementById('eq-on');
    const sel = document.getElementById('eq-preset');
    const read = document.getElementById('eq-read');
    const sliders = EQ_BANDS.map((_, i) => document.getElementById('eq-b' + i));
    const paint = () => {
      sliders.forEach((s, i) => { if (s) s.value = String(eqGains[i]); });
      if (read) read.textContent = eqOn ? 'On' : 'Off';
      if (on) on.checked = eqOn;
    };
    sliders.forEach((s, i) => {
      if (!s) return;
      s.addEventListener('input', () => {
        eqGains[i] = Number(s.value);
        eqOn = true;
        eqApply(); eqSave(); paint();
      });
    });
    if (sel) sel.addEventListener('change', () => {
      const p = EQ_PRESETS[sel.value];
      if (!p) return;
      eqGains = p.slice();
      eqOn = true;
      eqApply(); eqSave(); paint();
    });
    if (on) on.addEventListener('change', () => { eqOn = on.checked; eqApply(); eqSave(); paint(); });
    eqLoad(); paint();
    audio.addEventListener('play', () => eqApply());






  })();

  const cv = $('scope');
  const g = cv.getContext('2d');
  const LS = { vol: 'measured.vol', track: 'measured.file', pos: 'measured.pos', mute: 'measured.mute',
               shuffle: 'measured.shuffle', repeat: 'measured.repeat' };

  /* ── shuffle and repeat ─────────────────────────────────────────────────────
     Shuffle is a queue, not a coin flip. The up-next strip promises what plays
     next, so the order has to exist before the track ends; a pick made at the
     moment of the switch could not be shown in advance. */
  const REPEAT_WINDOW = 12;   // mirrors recommend-wire.js: distinct tracks kept out of the next pick
  let shuffleOn = PlayerAPI.get(LS.shuffle, '0') === '1';
  let repeatMode = PlayerAPI.get(LS.repeat, 'off');
  if (repeatMode !== 'all' && repeatMode !== 'one') repeatMode = 'off';
  let shufQueue = [];
  let shufHist = [];
  let shufDone = false;   // the current pass through the pool has been played out

  /* The ranker's repeat window is a hard filter, not a penalty, so shuffle has to
     honour it too — otherwise turning shuffle on would be a way to hear the same
     artist twice in a row. */
  function recentFiles() {
    const out = new Set();
    try {
      const ev = RANK ? RANK.events() : [];
      for (let i = ev.length - 1; i >= 0 && out.size < REPEAT_WINDOW; i--) {
        const f = ev[i] && ev[i].file;
        if (f) out.add(f);
      }
    } catch (e) { /* no ranker yet: nothing counts as recent */ }
    return out;
  }

  function shuffleFill() {
    const recent = recentFiles();
    const pool = [];
    for (let i = 0; i < VIEW.length; i++) {
      if (i === cur) continue;
      const f = VIEW[i] && VIEW[i].file;
      if (f && recent.has(f)) continue;
      pool.push(i);
    }
    /* Every remaining track is inside the window (a tiny library, or one artist).
       Repeating is better than silence, so fall back to the whole view. */
    if (!pool.length) {
      for (let i = 0; i < VIEW.length; i++) if (i !== cur) pool.push(i);
    }
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    shufQueue = pool;
    shufDone = false;
  }

  function shuffleNext() {
    if (!shufQueue.length) {
      /* One pass through the shuffled pool is the queue. Repeat off means the
         pass ends there; repeat all starts a fresh one. */
      if (shufDone && repeatMode === 'off') return -1;
      shuffleFill();
    }
    if (!shufQueue.length) return -1;
    const i = shufQueue.shift();
    if (!shufQueue.length) shufDone = true;
    if (cur >= 0) { shufHist.push(cur); if (shufHist.length > 50) shufHist.shift(); }
    return i;
  }

  /* The head of the queue without consuming it: the strip has to show what will
     play, and showing it must not change what plays. */
  function shufflePeek(n) {
    if (!shufQueue.length) {
      if (shufDone && repeatMode === 'off') return [];
      shuffleFill();
    }
    return shufQueue.slice(0, n);
  }

  function paintModes() {
    const s = $('shuffle'), r = $('repeat');
    if (s) {
      s.setAttribute('aria-pressed', shuffleOn ? 'true' : 'false');
      s.setAttribute('aria-label', shuffleOn ? 'Shuffle on' : 'Shuffle off');
    }
    if (r) {
      r.setAttribute('aria-pressed', repeatMode === 'off' ? 'false' : 'true');
      r.setAttribute('aria-label', repeatMode === 'one' ? 'Repeat one'
        : repeatMode === 'all' ? 'Repeat all' : 'Repeat off');
      r.setAttribute('data-mode', repeatMode);
    }
  }

  function setShuffle(on) {
    shuffleOn = !!on;
    shufQueue = []; shufHist = [];
    PlayerAPI.set(LS.shuffle, shuffleOn ? '1' : '0');
    paintModes();
    announce(shuffleOn ? 'Shuffle on' : 'Shuffle off');
    try { renderQueueStrip(); } catch (e) {}
  }

  function cycleRepeat() {
    repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
    PlayerAPI.set(LS.repeat, repeatMode);
    paintModes();
    announce(repeatMode === 'one' ? 'Repeat one' : repeatMode === 'all' ? 'Repeat all' : 'Repeat off');
  }

  /* Repeat off at the end of the queue: stop where the music stopped. The listen
     still has to be booked, or the last track of every session would be invisible
     to the ranker. */
  function stopAtEnd() {
    if (RANK && cur >= 0 && VIEW[cur] && curFile) {
      try {
        RANK.end(audio.currentTime || 0, audio.duration || VIEW[cur].dur || 0, undefined, { naturalEnd: true });
      } catch (e) { /* a lost listen is better than a stuck player */ }
    }
    naturalEnded = false;
    icon(false);
    announce('End of the queue.');
  }
  let curFile = '';
  let lastNativeFile = '';
  let seekHold = 0;
  /* Where the last listen stopped, waiting for the matching track to load. */
  let pendingResume = null;
  let savedAt = 0;
  const annNode = () => $('sr-status');
  let annTimer = 0;
  function announce(msg) {
    const el = annNode(); if (!el) return;
    clearTimeout(annTimer);
    annTimer = setTimeout(() => { el.textContent = msg; likeToast(msg); }, 80);
  }

  /* ---- where you were ------------------------------------------------------
     Volume and the last file always survived a relaunch; the position did not,
     so every session restarted the same song at 0:00. The pair is written from
     timeupdate on a slow timer and once more on the way out — PlayerAPI.set is a
     localStorage write on every platform, so this is cheap, but it still should
     not run per second. A position inside the last three seconds is stored as 0:
     resuming one second before the end just skips the track you asked for. */
  function resumeFor(file) {
    if (!file) return null;
    try {
      const r = JSON.parse(PlayerAPI.get(LS.pos, '') || 'null');
      if (r && r.file === file && Number.isFinite(r.pos) && r.pos > 3) return r;
    } catch (e) {}
    return null;
  }
  function savePos(force) {
    if (!curFile || !audio.duration) return;
    const now = Date.now();
    if (!force && now - savedAt < 10000) return;
    savedAt = now;
    const d = audio.duration || 0;
    const at = d && d - audio.currentTime < 3 ? 0 : audio.currentTime;
    try { PlayerAPI.set(LS.pos, JSON.stringify({ file: curFile, pos: Math.round(at * 10) / 10 })); } catch (e) {}
  }

  let TRACKS = [], VIEW = [], cur = -1, playing = false, median = null;

  /* ---- ranker plug ---------------------------------------------------------
     The math lives in lib/recommend.js, the feature building in
     lib/recommend-features.js, the storage/arm/gating in lib/recommend-wire.js.
     This adapter only reports what the player currently holds. */
  let RANK = null;
  const RANK_TRACK = new Map();
  /* Online shelf: previews buffered in memory, plus the clip currently playing
     from it (null when a local file is playing). */
  let SHELF = null, ONLINE = null;
  /* 768 floats per track, produced offline by tools/embed (EmbeddingGemma 2 q4).
     ~1 MB of JSON for a 148-track library; a miss is not an error. */
  async function loadEmbeddings() {
    try {
      const r = await fetch('embeddings.json', { cache: 'no-cache' });
      if (!r.ok) return 0;
      const j = await r.json();
      const v = (j && j.vectors) || {};
      let hit = 0;
      for (const t of TRACKS) { if (t.file && v[t.file]) { t.emb = v[t.file]; hit++; } }
      if (hit) console.info('embeddings: ' + hit + ' tracks');
      return hit;
    } catch (e) { return 0; }
  }

  function rankLib() {
    return {
      tracks: TRACKS, view: VIEW, curIndex: cur, cur: VIEW[cur] || null,
      bandsOf(file) {
        const t = RANK_TRACK.get(file);
        return t && t.bands && t.bands.length ? t.bands : null;
      },
      lufsOf(file) {
        const t = RANK_TRACK.get(file);
        return t && typeof t.lufs === 'number' && t.lufs ? t.lufs : null;
      },
    };
  }
  let STATS = {};
  let analyser = null, freq = null, ac = null;
  let eqPost = null;                       // loudness gain on the EQ path (see eqBuild)
  let loudTarget = 1, abRaw = false;       // last computed gain + A/B bypass (see setLoudnessGain)
  let analysisEl = null;
  let liveSmooth = [], livePeak = [];

  /* Loudness normalisation to -14 LUFS. Cuts freely, boosts at most 1.25x
     (~+1.94 dB) because nothing downstream limits: eqPre feeds the bands and
     eqPost feeds the destination directly, so a big boost would clip with no
     one to stop it. A measured true peak caps the boost too: peak plus gain must
     stay under -1 dBTP (EBU R128), otherwise the 1.25x ceiling ignores the peak
     it was stored for.
     `t.lufs` is truthy-guarded, not typeof-guarded — an
     unanalysed track carries 0 and (-14 - 0) would be a -14 dB cut on it.
     An absent or unanalysed track must reset the node to unity, otherwise the
     previous track's gain rides into the next one.
     Scope: on desktop PROXY is set for local files too — the loopback re-serves
     asset.localhost with CORS headers — so this is live for local playback as
     well as YouTube. Do NOT fall back to audio.volume — that is the user's
     slider (setVol) and the mute icon reads it. */
  function setLoudnessGain(t) {
    if (!eqPost || !eqCtx) return;
    const lufs = t && typeof t.lufs === 'number' && t.lufs ? t.lufs : 0;
    let g = 1;
    if (lufs) {
      g = Math.min(1.25, Math.pow(10, (-14 - lufs) / 20));
      /* tp is the inverse of lufs: 0 dBTP is a real measurement (the peak sits on
         the ceiling) and the value that most needs the cap, so it is typeof-guarded
         while lufs stays truthy-guarded. Absent tp means no measurement was made. */
      if (t && typeof t.tp === 'number' && Number.isFinite(t.tp)) {
        g = Math.min(g, Math.pow(10, (-1 - t.tp) / 20));
      }
    }
    const now = eqCtx.currentTime;
    eqPost.gain.cancelScheduledValues(now);
    eqPost.gain.setValueAtTime(eqPost.gain.value, now);
    /* Remember the target even while bypassed, so toggling back is instant. */
    loudTarget = g;
    /* 20 ms: fast skips get a short fade, which is intended, not a glitch. */
    eqPost.gain.setTargetAtTime(abRaw ? 1 : g, now, 0.02);
  }

  /* The live EQ must never tap the element people are listening to.
     createMediaElementSource() is a one-way door: it diverts the element's output
     into the graph. Both our sources (asset.localhost and googlevideo) are
     cross-origin, so Chromium marks the media-element source as tainted and the
     node emits digital silence ("MediaElementAudioSource outputs zeroes due to CORS
     access restrictions"). The graph was also the only path to ac.destination, so
     the app played silence for every track. Local files can be made CORS-clean
     (crossOrigin='anonymous' works against the asset protocol), YouTube cannot, and
     the capture cannot be undone — so the EQ taps a second, silent element and the
     real one stays wired straight to the speakers. */
  function initGraph() {
    if (analyser) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      ac = new AC();
      analyser = ac.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0.82;
      freq = new Uint8Array(analyser.frequencyBinCount);
      const sink = ac.createGain();
      sink.gain.value = 0;                       // analysis only — never audible
      analyser.connect(sink); sink.connect(ac.destination);
      analysisEl = new Audio();
      analysisEl.crossOrigin = 'anonymous';      // keeps the tap untainted for local assets
      analysisEl.preload = 'auto';
      ac.createMediaElementSource(analysisEl).connect(analyser);
    } catch (e) { analyser = null; analysisEl = null; }
  }

  // The tap follows the audible element by hand; it is decoration, so best-effort.
  function tapSource(url) {
    initGraph();
    if (!analysisEl || !url) return;
    if (analysisEl.src !== url) { analysisEl.src = url; analysisEl.load(); }
    if (!audio.paused) analysisEl.play().catch(() => {});
  }
  function tapStop() {
    if (!analysisEl) return;
    try { analysisEl.pause(); analysisEl.removeAttribute('src'); analysisEl.load(); } catch (e) {}
  }
  function tapPlay() { if (analysisEl && analysisEl.src) analysisEl.play().catch(() => {}); }
  function tapPause() { if (analysisEl) { try { analysisEl.pause(); } catch (e) {} } }

  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const looksLikeJunk = (v) => {
    const t = String(v || '').trim();
    if (!t) return true;
    if (t.replace(/[^A-Za-z]/g, '').length < 3) return true;
    if (/^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}/.test(t)) return true;
    if (/^\d{4}_\d+/.test(t)) return true;
    return false;
  };
  const clean = (s) => {
    const raw = String(s || '');
    const out = raw.replace(/^\s*(\[[^\]]*\]|\([^)]*\))\s*/g, '').replace(/\s{2,}/g, ' ').trim();
    return out || raw;
  };

  // micro spectral signature for a queue row (40×24 viewBox)
  function sig(bands) {
    const w = 40, h = 24, pad = 2.5;
    const base = '<line class="base" x1="0" y1="' + (h - 1) + '" x2="' + w + '" y2="' + (h - 1) + '"/>';
    if (!bands || !bands.length) return base;
    const n = bands.length;
    let d = '';
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h - pad - clamp(bands[i], 0, 1) * (h - pad * 2);
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    return base + '<path class="sig" d="' + d + '"/>';
  }

  async function boot(opts) {
    try { PROXY = (await PlayerAPI.proxyBase()) || ''; } catch (e) { PROXY = ''; }
    const keepPlayback = !!(opts && opts.keep);
    const prevFile = (cur >= 0 && VIEW[cur] && VIEW[cur].file) ? VIEW[cur].file : null;
    const prevTime = (audio && audio.currentTime) || 0;
    const wasPlaying = !!(audio && !audio.paused && !audio.ended);
    const wasOnline = !!ONLINE;
    let lib = { tracks: [], stats: {} };
    let fp = [];
    try {
      [lib, fp] = await Promise.all([PlayerAPI.load(), PlayerAPI.fingerprints()]);
    } catch (err) {
      $('count').textContent = 'NO LIBRARY';
      announce('Could not read the library');
      throw err;
    }
    const fmap = new Map();
    for (const t of fp) { if (t && t.file) fmap.set(t.file, t); if (t && t.key) fmap.set(t.key, t); }
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 48);
    TRACKS = (lib.tracks || []).map((t) => {
      const f = fmap.get(t.file) || (t.videoId && fmap.get(t.videoId)) || fmap.get(norm(t.file)) || {};
      return {
        ...t,
        bands: f.bands || [],
        lufs: f.lufs, tp: f.tp, crest: f.crest, rolloff: f.rolloff,
        kbps: f.kbps, sr: f.sr, codec: f.codec || t.ext, dur: f.dur || t.dur || 0,
      };
    }).sort((a, b) => (a.artist + a.title).localeCompare(b.artist + b.title, undefined, { sensitivity: 'base' }));
    STATS = lib.stats || {};

    /* Perceptual vectors from EmbeddingGemma 2 (offsets baked at build time).
       Optional: a track without one simply has no embCos feature, which the
       ranker treats as unknown rather than as a made-up mid value. */
    const EMB_N = await loadEmbeddings();

    $('count').textContent = TRACKS.length + ' TRACKS';
    VIEW = TRACKS.slice();

    /* The ranker stores through the same get/set the rest of the app uses, so
       the model and the play log travel with the library on every platform. */
    TRACKS.forEach((t) => { if (t.file) RANK_TRACK.set(t.file, t); });
    if (window.RecommendWire) {
      /* PlayerAPI.get is async in the desktop/android shells (invoke) and sync in
         the web shell, so resolve both keys first and hand the ranker a sync view
         of them. A Promise reaching Model.fromJSON would throw and silently leave
         RANK null — that is exactly what happened in the packaged app. */
      const KM = 'measured.rec.model', KL = 'measured.rec.log';
      try {
        PlayerAPI.set('measured.rec.boot', JSON.stringify({
          wire: !!window.RecommendWire, scripts: !!window.RecommendFeatures, emb: EMB_N, at: Date.now(),
        }));
      } catch (e) {}
      Promise.all([Promise.resolve(PlayerAPI.get(KM, null)), Promise.resolve(PlayerAPI.get(KL, []))])
        .then((pair) => {
          const cache = {};
          cache[KM] = pair[0] == null ? null : pair[0];
          cache[KL] = pair[1] == null ? [] : pair[1];
          try { PlayerAPI.set('measured.rec.boot', JSON.stringify({ wire: true, rank: true, emb: EMB_N, keys: Object.keys(cache), at: Date.now() })); } catch (e) {}
          try {
            RANK = window.RecommendWire.create({
              store: {
                get: (k, d) => (Object.prototype.hasOwnProperty.call(cache, k) && cache[k] != null ? cache[k] : d),
                set: (k, v) => { cache[k] = v; try { PlayerAPI.set(k, v); } catch (e) {} },
              },
            });
          } catch (e) {
            RANK = null;
            try { PlayerAPI.set('measured.rec.boot', JSON.stringify({ wire: true, rank: false, err: String(e && e.message || e), at: Date.now() })); } catch (e2) {}
          }
          /* The ranker is built after select() has already drawn the strip, so
             without this the "Up next" row stays hidden until the first track
             change — the feature is there, you just never see it. */
          try { renderQueueStrip(); } catch (e3) {}
        })
        .catch((e) => {
          RANK = null;
          try { PlayerAPI.set('measured.rec.boot', JSON.stringify({ wire: true, rank: false, err: 'prefetch: ' + String(e && e.message || e), at: Date.now() })); } catch (e2) {}
        });
    }

    /* The shelf talks to a licensed preview API through the shell (invoke on
       desktop, fetch in the web build). Its Audio objects are what actually
       buffers the 30 s clip; nothing is written to disk. */
    if (window.MEASURED && MEASURED.Shelf) {
      try {
        SHELF = MEASURED.Shelf.create({
          fetchJson: (u) => (PlayerAPI.searchOnline ? PlayerAPI.searchOnline(u) : fetch(u).then((r) => r.json())),
          makeAudio: (src, id) => {
            const a = new Audio();
            a.preload = 'auto';
            a.src = src;
            a.addEventListener('canplaythrough', () => { try { SHELF.markReady(id, true); } catch (e) {} });
            a.addEventListener('error', () => { try { SHELF.markReady(id, false); } catch (e) {} });
            try { a.load(); } catch (e) {}
            return a;
          },
        });
      } catch (e) { SHELF = null; }
    }

    // library median fingerprint (drawn as the reference spine)
    const withBands = TRACKS.filter((t) => t.bands && t.bands.length);
    if (withBands.length > 4) {
      const n = withBands[0].bands.length;
      median = Array.from({ length: n }, (_, i) => {
        const col = withBands.map((t) => t.bands[i]).sort((a, b) => a - b);
        return col[Math.floor(col.length / 2)];
      });
    }

    renderList();
    setVol(clamp(Number(PlayerAPI.get(LS.vol, '0.7')), 0, 1));
    syncMute(PlayerAPI.get(LS.mute, '0') === '1');
    pendingResume = null;
    const lastFile = PlayerAPI.get(LS.track, '');
    let startIdx = lastFile ? VIEW.findIndex((t) => t.file === lastFile) : -1;
    if (startIdx >= 0) {
      /* A remembered file wins even without a fingerprint. The measured-first
         jump below is for a cold start, not a licence to overrule the track you
         were listening to a minute ago. */
      pendingResume = resumeFor(lastFile);
    } else {
      const full = VIEW.findIndex((t) => t.bands && t.bands.length && t.lufs);
      startIdx = full >= 0 ? full : 0;
    }
    if (keepPlayback && wasOnline) {
      /* an online preview is playing: the download only adds to the library */
      renderList();
      return;
    }
    if (keepPlayback && prevFile) {
      const idx = VIEW.findIndex(function (t) { return t.file === prevFile; });
      if (idx >= 0) {
        /* This path keeps the live position, so the stored one must not win. */
        pendingResume = null;
        select(idx, false);
        try { audio.currentTime = prevTime; } catch (e) {}
        if (wasPlaying) { try { Promise.resolve(play()).catch(function () {}); } catch (e) {} }
        loop();
        return;
      }
    }
    select(startIdx, false);
    loop();
  }


  /* ---- likes ---- */
  const LIKES_KEY = 'likes';
  const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 20.3l-1.35-1.23C5.9 14.86 2.9 12.13 2.9 8.8 2.9 6.1 5 4 7.7 4c1.53 0 3 .71 3.95 1.84L12 6.3l.35-.46A5.13 5.13 0 0116.3 4C19 4 21.1 6.1 21.1 8.8c0 3.33-3 6.06-7.75 10.27L12 20.3z" fill="currentColor"/></svg>';
  let LIKE_MAP = {};
  try { LIKE_MAP = JSON.parse(PlayerAPI.get(LIKES_KEY, '{}')) || {}; } catch (e) { LIKE_MAP = {}; }
  /* A local track carries \ile\; a search result carries only \id\. */
  function isStream(t) { return !t.file && !!t.id; }
  function likeIdOf(t) {
    if (isStream(t)) return 'yt:' + t.id;
    if (t.videoId && !t.file) return 'yt:' + t.videoId;
    return 'file:' + (t.file || t.videoId || '');
  }
  /* every local file starts liked (they are the user's own files); streams start unliked */
  function isLiked(t) {
    const id = likeIdOf(t);
    if (Object.prototype.hasOwnProperty.call(LIKE_MAP, id)) return !!LIKE_MAP[id];
    return !isStream(t);
  }
  function persistLikes() { try { PlayerAPI.set(LIKES_KEY, JSON.stringify(LIKE_MAP)); } catch (e) {} }
  function setLiked(t, on) {
    LIKE_MAP[likeIdOf(t)] = !!on; persistLikes();
    if (on && RANK) { try { RANK.mark('like'); } catch (e) {} }
  }
  let likeToastTimer = 0;
  function likeToast(msg) {
    let el = document.getElementById('like-toast');
    if (!el) { el = document.createElement('div'); el.id = 'like-toast'; el.className = 'like-toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(likeToastTimer);
    likeToastTimer = setTimeout(() => el.classList.remove('on'), 2200);
  }
  function paintHeart(btn, on) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', on ? 'Liked — click to remove' : 'Like');
    btn.innerHTML = HEART;
  }

  function renderList() {
    const frag = document.createDocumentFragment();
    VIEW.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'row' + (i === cur ? ' on' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === cur ? 'true' : 'false');
      row.tabIndex = (i === cur || (cur < 0 && i === 0)) ? 0 : -1;
      row.innerHTML = '<div class="n">' + String(i + 1).padStart(2, '0') + '</div>' +
        '<svg class="thumb" viewBox="0 0 40 24" preserveAspectRatio="none" aria-hidden="true" focusable="false">' + sig(t.bands) + '</svg>' +
        '<div class="t"><b></b><i></i></div><div class="d">' + (t.dur ? fmt(t.dur) : '—') + '</div>';
      row.querySelector('b').textContent = clean(t.title) || '(untitled)';
      const arRow = clean(t.artist);
      const shownArtist = looksLikeJunk(arRow) ? 'Unknown artist' : arRow;
      row.querySelector('i').textContent = shownArtist;
      row.title = clean(t.title) + ' — ' + shownArtist;
      const hb = document.createElement('button');
      hb.className = 'like';
      hb.type = 'button';
      paintHeart(hb, isLiked(t));
      hb.addEventListener('click', (e) => {
        e.stopPropagation();
        const on = hb.getAttribute('aria-pressed') !== 'true';
        setLiked(t, on);
        paintHeart(hb, on);
        likeToast(on ? 'Liked' : 'Like removed');
      });
      row.appendChild(hb);
      row.addEventListener('click', () => { select(i, true); row.focus(); });
      row.addEventListener('keydown', (e) => rowKey(e, i));
      frag.appendChild(row);
    });
    $('list').replaceChildren(frag);
    $('libcount').textContent = VIEW.length + '/' + TRACKS.length;
    const total = TRACKS.length;
    $('count').textContent = total ? total + (total === 1 ? ' track' : ' tracks') : 'empty';
    if ($('lib-btn-n')) {
      const narrow = window.matchMedia('(max-width:760px)').matches;
      $('lib-btn-n').textContent = total ? (narrow ? String(total) : total + ' tracks') : 'Library';
    }
  }

  function focusRow(i) {
    const rows = $('list').children;
    if (!rows[i]) return;
    [...rows].forEach((el, k) => { el.tabIndex = k === i ? 0 : -1; });
    rows[i].focus();
  }

  function rowKey(e, i) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); select(i, true); focusRow(i); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); focusRow(Math.min(VIEW.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); focusRow(Math.max(0, i - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); focusRow(0); }
    else if (e.key === 'End') { e.preventDefault(); focusRow(VIEW.length - 1); }
  }

  let selToken = 0;
  /* Set true only by the audio element's own 'ended' event: the one case where
     switching away from a track is a finished listen rather than a skip. */
  let naturalEnded = false;
  async function select(i, autoplay) {
    if (!VIEW[i]) return;
    closeOnline();
    /* Close the book on whatever was playing first. Elapsed comes off the audio
       element, so a full play and an early skip take the same path — the learner
       has to see both or it degenerates into on-policy learning. */
    if (RANK && cur >= 0 && VIEW[cur] && curFile) {
      const prevDur = audio.duration || VIEW[cur].dur || 0;
      const el = audio.currentTime || 0;
      const nat = naturalEnded;
      naturalEnded = false;
      /* The label comes from accumulated listened time inside the wire, so a
         seek to the end can no longer read as a full listen. */
      RANK.end(el, prevDur, undefined, { naturalEnd: nat });
    }
    const mine = ++selToken;
    cur = i;
    const t = VIEW[i];
    curFile = t.file || '';
    setLoudnessGain(t);             // before any await: the new track's gain lands first
    [...$('list').children].forEach((el, k) => {
      el.classList.toggle('on', k === i);
      el.setAttribute('aria-selected', k === i ? 'true' : 'false');
      el.tabIndex = k === i ? 0 : -1;
    });
    const row = $('list').children[i];
    if (row) row.scrollIntoView({ block: 'nearest' });
    paint(t);
    if (RANK) RANK.begin(t, rankLib());
    PlayerAPI.set(LS.track, t.file || String(i));
    announce('Now playing ' + (clean(t.title) || 'untitled') + ', by ' + (clean(t.artist) || 'unknown artist'));
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title || '', artist: t.artist || '', album: 'Local library' });
    }

    /* Exotic containers (ape, wma, aiff, alac…) are converted first: symphonia on
       desktop, MediaCodec on Android. Native formats skip straight through. */
    try { if (PlayerAPI.clearNowhere) PlayerAPI.clearNowhere(); } catch (e) {}
    let url = t.url;
    if (!PlayerAPI.isNative(t.file || '')) {
      if (autoplay) announce('Converting ' + (clean(t.title) || 'this file') + '…');
      try {
        const ready = await PlayerAPI.prepare(t);
        if (ready) url = ready;
        else {
          announce('This build cannot play ' + (t.ext || 'that format').toUpperCase() + ' files.');
          return;
        }
      } catch (e) { /* keep the original URL and let the element try */ }
      if (mine !== selToken) return;
      lastNativeFile = '';                /* converted already: nothing left to rescue */
    } else {
      lastNativeFile = t.file || '';      /* native extension, codec still unproven */
    }
    audio.src = proxied(url); audio.load();
    if (String(url).indexOf('asset.localhost') !== -1) tapSource(url); else tapStop();
    if (autoplay) play(); else icon(false);
    renderQueueStrip();
  }

  function paint(t) {
    const arHero = clean(t.artist);
    $('artist').textContent = looksLikeJunk(arHero) ? 'Unknown artist' : arHero;
    const h = $('title');
    h.textContent = clean(t.title) || '(untitled)';
    h.classList.remove('reveal'); void h.offsetWidth; h.classList.add('reveal');
    // sleeve: real cover when thumbs/ has one, monogram tile otherwise
    const cov = $('cover'), metaEl = $('meta');
    const mono = $('cover-mono');
    if (mono) mono.textContent = ((looksLikeJunk(arHero) ? 'Unknown' : arHero) || '?').trim().charAt(0).toUpperCase() || '?';
    if (t.cover) {
      cov.onerror = () => metaEl.classList.add('no-cover');
      cov.src = t.cover;
      metaEl.classList.remove('no-cover');
    } else {
      cov.removeAttribute('src');
      metaEl.classList.add('no-cover');
    }
    paintArt(t);
    const chips = [];
    if (t.codec) chips.push('<span class="chip">' + String(t.codec).toUpperCase() + (t.kbps ? ' ' + Math.round(t.kbps) + 'k' : '') + '</span>');
    if (t.sr) chips.push('<span class="chip">' + (t.sr / 1000).toFixed(1) + ' kHz</span>');
    if (t.bands.length) chips.push('<span class="chip acc">measured</span>');
    $('chips').innerHTML = chips.join('');
    $('r-lufs').innerHTML = t.lufs ? t.lufs.toFixed(1) + '<s>LUFS</s>' : '—';
    $('r-tp').innerHTML = Number.isFinite(t.tp) ? t.tp.toFixed(1) + '<s>dBTP</s>' : '—';
    $('r-crest').innerHTML = t.crest ? t.crest.toFixed(1) + '<s>dB</s>' : '—';
    $('r-roll').innerHTML = t.rolloff ? (t.rolloff / 1000).toFixed(1) + '<s>kHz</s>' : '—';
    $('r-src').innerHTML = t.kbps ? Math.round(t.kbps) + '<s>kbps</s>' : (t.ext || '—').toUpperCase();
    const cnv = $('scope');
    const FR = ['32','50','63','80','100','125','160','200','250','315','400','500','630','800','1k','1.25k','1.6k','2k','2.5k','3.15k','4k','5k','6.3k','8k','10k','12.5k','16k'];
    if (t.bands && t.bands.length) {
      let mx = 0; for (let k = 1; k < t.bands.length; k++) if (t.bands[k] > t.bands[mx]) mx = k;
      cnv.setAttribute('aria-label', 'Spectral fingerprint of ' + (clean(t.title) || 'this track') + '. Strongest band near ' + (FR[mx] || mx + 1) + ' hertz.');
    } else {
      cnv.setAttribute('aria-label', 'No measured spectral fingerprint for this track.');
    }
    pushMedia(true);
  }

  // Android's own player card (lock screen, shade, volume panel, headset buttons).
  // The bridge is synchronous, so this costs one JNI call per state change.
  let lastPush = 0;
  // Liquid Glass reads the record's own colour: publish the sleeve as --art so
  // the deck pane can tint itself with a blurred copy of the cover.
  const ART_VARS = ['.deck', '.np'];
  function paintArt(t) {
    const url = t && t.cover ? 'url("' + String(t.cover).replace(/"/g, '%22') + '")' : 'none';
    for (const sel of ART_VARS) {
      const el = document.querySelector(sel);
      if (el) el.style.setProperty('--art', url);
    }
    paintTint(t);
  }

  /* Dominant-colour bleed. The sleeve is drawn into a 32x32 canvas and the
     saturated pixels are averaged, weighted by saturation and brightness so a
     grey border or a black margin cannot drag the hue. The result lands in
     --art-tint as "r g b" and the hero washes itself with it, which is what
     makes the room change when the record does. Cheap: one decode per track,
     and a stale decode is dropped by the sequence guard. */
  let tintSeq = 0;
  function paintTint(t) {
    const root = document.documentElement;
    const cover = t && t.cover;
    const seq = ++tintSeq;
    if (!cover) { root.removeAttribute('data-art-tint'); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (seq !== tintSeq) return;                 // a newer track won
      try {
        const N = 32;
        const c = document.createElement('canvas');
        c.width = c.height = N;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, N, N);
        const d = g.getImageData(0, 0, N, N).data;
        let r = 0, gr = 0, b = 0, w = 0;
        for (let i = 0; i < d.length; i += 4) {
          const R = d[i], G = d[i + 1], B = d[i + 2];
          const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
          const sat = mx === 0 ? 0 : (mx - mn) / mx;
          if (sat < 0.15) continue;                // greys carry no hue
          const weight = sat * (mx / 255);
          r += R * weight; gr += G * weight; b += B * weight; w += weight;
        }
        if (w < 0.5) { root.removeAttribute('data-art-tint'); return; }
        root.style.setProperty('--art-tint',
          Math.round(r / w) + ' ' + Math.round(gr / w) + ' ' + Math.round(b / w));
        root.setAttribute('data-art-tint', '');
      } catch (e) {
        root.removeAttribute('data-art-tint');     // tainted canvas: no bleed
      }
    };
    img.onerror = () => { if (seq === tintSeq) root.removeAttribute('data-art-tint'); };
    img.src = cover;
  }
  function pushMedia(force) {
    try { syncNow(); } catch (e) {}
    if (!(window.PlayerAPI && PlayerAPI.platform === 'android')) return;
    if (!(window.AndroidBridge && AndroidBridge.media)) return;
    const now = Date.now();
    if (!force && now - lastPush < 3500) return;
    lastPush = now;
    const t = VIEW[cur] || {};
    const payload = {
      title: clean(t.title) || '',
      artist: clean(t.artist) || '',
      playing: !!playing && !audio.paused,
      pos: Math.round((audio.currentTime || 0) * 1000),
      dur: Math.round((audio.duration || t.dur || 0) * 1000),
      art: t.cover || ''
    };
    try {
      AndroidBridge.media(JSON.stringify(payload));
    } catch (err) { /* a missing bridge must never break playback */ }
  }

  // Desktop half of the same idea: Windows SMTC / macOS Now Playing / Linux
  // MPRIS. Without this the hardware media keys and the lock screen do nothing,
  // because a WebView has no OS media session of its own.
  let lastSmtc = 0;
  function pushSmtc(force) {
    const tauri = window.__TAURI__;
    if (!tauri || !tauri.core || !tauri.core.invoke) return;
    const now = Date.now();
    if (!force && now - lastSmtc < 1200) return;
    lastSmtc = now;
    const t = VIEW[cur] || {};
    tauri.core.invoke('smtc_update', {
      now: {
        title: clean(t.title) || null,
        artist: clean(t.artist) || null,
        album: clean(t.album) || null,
        cover: t.cover ? String(t.cover) : null,
        durationMs: Math.round((audio.duration || t.dur || 0) * 1000) || null,
        playing: !!playing && !audio.paused,
        positionMs: Math.round((audio.currentTime || 0) * 1000)
      }
    }).catch(() => {});
  }

  function play() {
    initGraph();
    if (ac && ac.state === 'suspended') ac.resume();
    tapPlay();
    audio.play().then(() => { playing = true; icon(true); }).catch(() => { icon(false); });
  }
  const pause = () => { audio.pause(); playing = false; icon(false); tapPause(); savePos(true); };
  const toggle = () => (audio.paused ? play() : pause());
  const icon = (p) => {
    $('ico').innerHTML = p ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5l11 7-11 7z"/>';
    const b = $('play');
    b.setAttribute('aria-label', p ? 'Pause' : 'Play');
    b.setAttribute('aria-pressed', p ? 'true' : 'false');
    pushMedia(true);
    pushSmtc(true);
  };
  /* Previous means "start this song again" while you are into it, and "go back"
     only near the top — the convention every other player has, and the only way
     to restart a track from the transport at all. Same three-second threshold
     most players use, so the muscle memory carries over. */
  function step(d) {
    if (!VIEW.length) return;
    if (d < 0 && (audio.currentTime || 0) > 3) { seekTo(0); return; }
    if (shuffleOn) {
      if (d > 0) {
        const i = shuffleNext();
        if (i >= 0) { select(i, playing); return; }
        if (repeatMode === 'off') return;   // the pass is over and nothing repeats
      } else {
        /* Back through the shuffle history, not back one row: with shuffle on the
           row above is not where the listener came from. */
        const back = shufHist.pop();
        if (back !== undefined && VIEW[back]) { select(back, playing); return; }
      }
    }
    let i = cur + d;
    if (i < 0) i = repeatMode === 'all' ? VIEW.length - 1 : 0;
    if (i >= VIEW.length) i = repeatMode === 'all' ? 0 : VIEW.length - 1;
    /* Repeat off at the end of the queue: there is no next track, and restarting
       the last one would be a repeat the mode says not to do. */
    if (i === cur && repeatMode === 'off') return;
    select(i, playing);
  }

  // Commands arriving from Android's player card, headset or Bluetooth.
  PlayerAPI.mediaCommand = (cmd, arg) => {
    if (cmd === 'play') play();
    else if (cmd === 'pause') pause();
    else if (cmd === 'toggle') toggle();
    else if (cmd === 'next') step(1);
    else if (cmd === 'prev') step(-1);
    else if (cmd === 'seek' && audio.duration) audio.currentTime = clamp((arg || 0) / 1000, 0, audio.duration - 0.05);
    pushMedia(true);
  };

  // OS transport buttons (hardware media keys, lock screen, volume flyout) come
  // back as Tauri events. Route them through the same command handler Android
  // uses, so exactly one place decides what "next" means.
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('smtc-event', (e) => {
      try { PlayerAPI.mediaCommand(e.payload); } catch (err) {}
    });
    window.__TAURI__.event.listen('smtc-seek', (e) => {
      try { PlayerAPI.mediaCommand('seek', Number(e.payload) || 0); } catch (err) {}
    });
  }

  audio.addEventListener('timeupdate', () => {
    const d = audio.duration || 0, c = audio.currentTime || 0;
    if (RANK) { try { RANK.tick(c); } catch (e) {} }
    if (!audio.paused) savePos(false);
    $('time').textContent = fmt(c) + ' / ' + fmt(d);
    const p = d ? (c / d) * 100 : 0;
    $('sfill').style.width = p + '%'; $('shead').style.left = p + '%';
    const sk = $('seek');
    sk.setAttribute('aria-valuemax', String(Math.round(d)));
    sk.setAttribute('aria-valuenow', String(Math.round(c)));
    sk.setAttribute('aria-valuetext', fmt(c) + ' of ' + fmt(d));
    if (analysisEl && analysisEl.src) {
      if (audio.paused || audio.muted) { if (!analysisEl.paused) analysisEl.pause(); }
      else {
        if (analysisEl.paused) analysisEl.play().catch(() => {});
        if (Math.abs(analysisEl.currentTime - c) > 0.4) { try { analysisEl.currentTime = c; } catch (e) {} }
      }
    }
    if (npOpen()) syncNow();
    pushMedia(false);
    pushSmtc(false);
  });
  audio.addEventListener('loadedmetadata', () => {
    const d = audio.duration || 0;
    /* Pick the stored position up here rather than in select(): the element has
       no duration until metadata lands, and currentTime before that is a no-op.
       One-shot, keyed to the file it was stored for — this event also fires for
       the transcode rescue and for a library reload. */
    let at = 0;
    if (pendingResume && pendingResume.file === curFile) {
      at = Math.min(pendingResume.pos, Math.max(0, d - 3));
      pendingResume = null;
      if (at > 0) { try { audio.currentTime = at; } catch (e) { at = 0; } }
    }
    $('time').textContent = fmt(at) + ' / ' + fmt(d);
    const sk = $('seek');
    sk.setAttribute('aria-valuemax', String(Math.round(d)));
    sk.setAttribute('aria-valuetext', fmt(at) + ' of ' + fmt(d));
    /* Paint the rail here too: it used to be written only by timeupdate, so a
       launch that sat paused at 0:00 showed a full orange rail and the knob at
       the far right until playback started. */
    const p0 = d ? (at / d) * 100 : 0;
    $('sfill').style.width = p0 + '%'; $('shead').style.left = p0 + '%';
    sk.setAttribute('aria-valuenow', String(Math.round(at)));
  });
  audio.addEventListener('error', async () => {
    const t = VIEW[cur];
    /* A "native" extension can still hide a codec the WebView refuses to decode
       (ALAC inside .m4a). One forced transcode rescues those instead of telling the
       user the file was moved or deleted. */
    if (t && t.file && t.file === lastNativeFile && PlayerAPI.prepareForce) {
      lastNativeFile = '';
      try {
        const wav = await PlayerAPI.prepareForce(t);
        if (wav) {
          const resume = playing || !audio.paused;
          audio.src = proxied(wav); audio.load();
          tapSource(wav);
          if (resume) play();
          announce('Converted ' + (clean(t.title) || 'this track') + ' to play it.');
          return;
        }
      } catch (e) { /* fall through to the visible failure */ }
    }
    $('r-src').innerHTML = '<span style="color:var(--accent-ink)">unreadable</span>';
    announce('This file could not be loaded' + (t && t.title ? ': ' + t.title : '') + '. It may have been moved or deleted.');
    playing = false; icon(false);
  });
  /* ------------------------------------------------------------ online shelf */

  function shelfSeeds() {
    try {
      const st = window.RecommendFeatures.stats((RANK && RANK.events()) || [], TRACKS);
      return SHELF.seedsFrom(st, 4);
    } catch (e) { return []; }
  }

  /* Close the book on an online clip: the same 20% rule decides whether it is
     ever offered again, and three listens in this sitting (or a like) is what
     makes it worth keeping. */
  function closeOnline(fromEnd) {
    if (!ONLINE) return;
    const c = ONLINE;
    ONLINE = null;
    if (!SHELF) return;
    const dur = c.seconds || 30;
    const heard = fromEnd ? dur : (audio.currentTime || 0);
    try {
      const g = SHELF.noteListen(c.id, heard, dur, false);
      const verdict = SHELF.noteEnd(c.id, heard, dur);
      if (g && g.ok) {
        try { PlayerAPI.set('measured.shelf.want', JSON.stringify(SHELF.stats().downloads)); } catch (e) {}
      }
      if (verdict === 'ban' && SHELF.isBanned(c.id)) console.info('shelf: never again — ' + c.artist + ' · ' + c.title);
    } catch (e) {}
  }

  async function playOnline(cand) {
    ONLINE = cand;
    cur = -1;
    curFile = '';
    [...$('list').children].forEach((el) => { el.classList.remove('on'); el.setAttribute('aria-selected', 'false'); });
    paint({
      file: 'online:' + cand.id, title: cand.title, artist: cand.artist, album: cand.album,
      cover: cand.art || '', bands: [], codec: 'AAC', dur: cand.seconds || 30, ext: 'm4a',
    });
    announce('Online preview: ' + (clean(cand.title) || 'untitled'));
    try { audio.src = proxied(cand.url); await audio.play(); } catch (e) { announce('That preview would not play.'); }
  }

  /* The local pool is spent: buffer a clip from the shelf and stream it. */
  async function onlineNext(depth) {
    depth = depth || 0;
    if (!SHELF) { step(1); return; }
    /* Offline, the refill below cannot succeed: it would stall the listen for up
       to six seconds and then announce that nothing is left. Step instead. */
    if (navigator.onLine === false) { step(1); return; }
    let cand = SHELF.next();
    if (!cand) {
      try { await SHELF.refill(shelfSeeds()); } catch (e) {}
      for (let i = 0; i < 24 && !cand; i++) {
        await new Promise((r) => setTimeout(r, 250));
        cand = SHELF.next();
      }
    }
    if (cand) { await playOnline(cand); return; }
    if (depth < 2) { await onlineNext(depth + 1); return; }
    announce('Nothing left to play.');
    step(1);
  }

  /* A finished track: ask the ranker where to go. It refuses (returns null) on a
     library it has not been told enough about yet, and the player keeps its
     sequential behaviour in that case. */
  audio.addEventListener('ended', () => {
    if (Date.now() - seekHold < 500) return;
    if (ONLINE) { closeOnline(true); onlineNext(0); return; }
    naturalEnded = true;
    /* Repeat one is the whole point of the mode: the same track again, without
       asking the ranker, which would otherwise move on. */
    if (repeatMode === 'one') { select(cur, true); return; }
    if (shuffleOn) {
      const i = shuffleNext();
      if (i >= 0) { select(i, true); return; }
      if (repeatMode === 'off') { stopAtEnd(); return; }
    }
    let pick = null;
    try { pick = RANK ? RANK.nextIndex(rankLib()) : null; } catch (e) { pick = null; }
    if (Number.isInteger(pick) && VIEW[pick] && pick !== cur) { select(pick, true); return; }
    /* The ranker stays quiet until it has been told enough about the library.
       Walking out to a streamed preview on the very first finished track is the
       wrong first impression for a player whose promise is the local library, so
       an unknown listener simply steps. The shelf keeps its turn once the ranker
       is actually making a choice — or when it has run out of fresh local picks,
       which is the case it was built for. */
    let cold = true;
    try {
      const r = RANK ? RANK.rank(rankLib(), 1) : null;
      cold = !r || !r.length || !!r[0].cold;
    } catch (e) { cold = true; }
    if (cold && VIEW.length) {
      if (cur + 1 < VIEW.length) { select(cur + 1, true); return; }
      if (repeatMode === 'all') { select(0, true); return; }
      stopAtEnd();
      return;
    }
    onlineNext(0);
  });

  window.addEventListener('beforeunload', () => { savePos(true); if (RANK) { try { RANK.save(); } catch (e) {} } });

  /* One place decides whether a seek arms the end-of-track guard. Dragging to the
     far right leaves a fraction of a second, so the element's own 'ended' lands
     inside the 500 ms window the handler below watches for and gets swallowed —
     the track never advanced, the pause icon stayed up, and the player looked
     frozen. A landing point inside the last 600 ms is a scrub-to-the-end and must
     not arm the guard. */
  function seekTo(t, dur) {
    const d = dur || audio.duration || 0;
    if (!d) return;
    const at = clamp(t, 0, d * 0.999);
    audio.currentTime = at;
    seekHold = d - at < 0.6 ? 0 : Date.now();
  }

  function bindDrag(el, set) {
    let on = false;
    const at = (e) => { const r = el.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
    el.addEventListener('pointerdown', (e) => { on = true; el.setPointerCapture(e.pointerId); set(at(e)); });
    el.addEventListener('pointermove', (e) => { if (on) set(at(e)); });
    el.addEventListener('pointerup', (e) => { on = false; try { el.releasePointerCapture(e.pointerId); } catch (x) {} });
    el.addEventListener('pointercancel', () => { on = false; });
  }
  bindDrag($('seek'), (p) => {
    seekTo(p * (audio.duration || 0));
    $('sfill').style.width = (p * 100) + '%'; $('shead').style.left = (p * 100) + '%';
  });
  bindDrag($('vol'), setVol);

  $('seek').addEventListener('keydown', (e) => {
    const d = audio.duration; if (!d) return;
    const k = e.key;
    if (k === 'Home') { e.preventDefault(); seekTo(0); return; }
    if (k === 'End') { e.preventDefault(); seekTo(d); return; }
    let step2 = k === 'ArrowRight' ? 5 : k === 'ArrowLeft' ? -5 : k === 'PageUp' ? 30 : k === 'PageDown' ? -30 : null;
    if (step2 !== null) { e.preventDefault(); seekTo(audio.currentTime + step2); }
  });
  $('vol').addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'Home') { e.preventDefault(); setVol(0); return; }
    if (k === 'End') { e.preventDefault(); setVol(1); return; }
    const d2 = (k === 'ArrowRight' || k === 'ArrowUp') ? 0.05 : (k === 'ArrowLeft' || k === 'ArrowDown') ? -0.05 : null;
    if (d2 !== null) { e.preventDefault(); setVol(clamp(audio.volume + d2, 0, 1)); }
  });
  /* Mute used to exist only inside the now-playing card, and it forgot itself on
     the next launch. One owner now: the transport button, the m key, the card's
     button and the volume slider all go through here, so the two icons can never
     disagree. */
  function syncMute(on) {
    audio.muted = !!on;
    try { PlayerAPI.set(LS.mute, on ? '1' : '0'); } catch (e) {}
    const b = $('mute');
    if (b) {
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.setAttribute('aria-label', on ? 'Unmute' : 'Mute');
    }
    const ico = $('mute-ico');
    if (ico) {
      ico.innerHTML = on
        ? '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 9l4.5 6M21 9l-4.5 6" stroke="currentColor" stroke-width="1.6" fill="none"/>'
        : '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 010 7" stroke="currentColor" stroke-width="1.6" fill="none"/>';
    }
    if (npOpen()) syncNow();
  }
  const toggleMute = () => syncMute(!audio.muted);

  function setVol(v) {
    audio.volume = v;
    $('vfill').style.width = (v * 100) + '%'; $('vhead').style.left = (v * 100) + '%';
    PlayerAPI.set(LS.vol, String(v));
    const vv = $('vol');
    vv.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    vv.setAttribute('aria-valuetext', Math.round(v * 100) + '%');
    /* Raising the slider while muted and hearing nothing reads as a broken
       player, so a deliberate volume change is also an unmute. */
    if (v > 0 && audio.muted) syncMute(false);
  }

  $('play').onclick = toggle;
  $('prev').onclick = () => step(-1);
  $('next').onclick = () => step(1);
  $('mute').onclick = toggleMute;
  $('shuffle').onclick = () => setShuffle(!shuffleOn);
  $('repeat').onclick = cycleRepeat;
  paintModes();
  /* Field-scoped filter. "artist:radiohead plays:0" narrows by field; a bare
     word still matches title+artist, so the old behaviour is unchanged. */
  function smartMatch(t, q, per) {
    const hay = ((t.title || '') + ' ' + (t.artist || '')).toLowerCase();
    const s = per && per[t.file];
    const toks = q.split(/\s+/).filter(Boolean);
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i];
      const m = tok.match(/^(artist|title|plays|skips):(.+)$/);
      if (!m) { if (!hay.includes(tok)) return false; continue; }
      const f = m[1], v = m[2];
      if (f === 'artist') { if (!String(t.artist || '').toLowerCase().includes(v)) return false; }
      else if (f === 'title') { if (!String(t.title || '').toLowerCase().includes(v)) return false; }
      else {
        const n = s ? (s[f] || 0) : 0;
        if (v.charAt(0) === '>') { if (!(n > Number(v.slice(1)))) return false; }
        else if (v.charAt(0) === '<') { if (!(n < Number(v.slice(1)))) return false; }
        else if (n !== Number(v)) return false;
      }
    }
    return true;
  }

  $('q').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    const per = playlistPer();
    VIEW = !q ? TRACKS.slice() : TRACKS.filter((t) => smartMatch(t, q, per));
    const keepFile = curFile || (VIEW[cur] && VIEW[cur].file) || '';
    cur = keepFile ? VIEW.findIndex((t) => t.file === keepFile) : -1;
    renderList();
    const rows = $('list').children;
    if (cur < 0 && rows.length) rows[0].tabIndex = 0;
    announce(VIEW.length ? VIEW.length + (VIEW.length === 1 ? ' track matches' : ' tracks match') : 'No tracks match that filter');
  });
  window.addEventListener('keydown', (e) => {
    const ae = document.activeElement || {};
    const typing = /input|textarea/i.test(ae.tagName || '') || (ae.getAttribute && ae.getAttribute('role') === 'slider');
    if (typing) return;
    if (e.key === ' ' && !document.body.classList.contains('video-mode')) { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowRight' && audio.duration) audio.currentTime = clamp(audio.currentTime + 5, 0, audio.duration);
    else if (e.key === 'ArrowLeft' && audio.duration) audio.currentTime = clamp(audio.currentTime - 5, 0, audio.duration);
    else if (e.key === 'ArrowUp') { e.preventDefault(); setVol(clamp(audio.volume + 0.05, 0, 1)); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setVol(clamp(audio.volume - 0.05, 0, 1)); }
    else if (e.key === 'n' || e.key === 'N') step(1);
    else if (e.key === 'p' || e.key === 'P') step(-1);
    else if (e.key === 's' || e.key === 'S') setShuffle(!shuffleOn);
    else if (e.key === 'r' || e.key === 'R') cycleRepeat();
    else if (e.key === 'b' || e.key === 'B') {
      /* A/B the loudness match: bypassing is a gain of 1, so it is one ramp, no
         re-analysis. eqCtx only exists once the EQ graph was built on play. */
      if (!eqPost || !eqCtx) { announce('A/B needs the EQ chain — play a track first.'); return; }
      abRaw = !abRaw;
      const t = eqCtx.currentTime;
      eqPost.gain.cancelScheduledValues(t);
      eqPost.gain.setValueAtTime(eqPost.gain.value, t);
      eqPost.gain.setTargetAtTime(abRaw ? 1 : loudTarget, t, 0.008);
      announce(abRaw ? 'A/B: raw' : 'A/B: loudness matched');
    }
    else if (e.key === 'm' || e.key === 'M') toggleMute();
    else if (e.key === '/') { e.preventDefault(); $('q').focus(); }
  });
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', play);
    navigator.mediaSession.setActionHandler('pause', pause);
    navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
    navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
  }

  let W = 1, H = 1;
  function sizeCanvas() {
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', sizeCanvas);
  const plateEl = document.querySelector('.plate');
  if (window.ResizeObserver && plateEl) new ResizeObserver(() => sizeCanvas()).observe(plateEl);
  sizeCanvas();
  requestAnimationFrame(sizeCanvas);
  setTimeout(sizeCanvas, 120);

  function draw() {
    if (!cv.offsetParent || !W || !H) return;
    const t = VIEW[cur];
    const padB = 18, top = 6;
    const barBase = H - padB;
    const hMax = Math.max(10, barBase - top);
    g.clearRect(0, 0, W, H);
    g.strokeStyle = 'rgba(20,19,16,.09)'; g.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const y = Math.round(top + (hMax * i) / 3) + .5;
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    }
    g.strokeStyle = 'rgba(20,19,16,.28)';
    g.beginPath(); g.moveTo(0, barBase + .5); g.lineTo(W, barBase + .5); g.stroke();
    /* baseline is drawn above; no second hairline */

    const bands = (t && t.bands) || [];
    const n = bands.length || 26;
    const slot = W / n;
    const bw = Math.max(2, slot - Math.min(5, slot * 0.26));
    if (bands.length) {
      const grad = g.createLinearGradient(0, top, 0, H - padB);
      grad.addColorStop(0, 'rgba(20,19,16,.78)');
      grad.addColorStop(0.55, 'rgba(20,19,16,.62)');
      grad.addColorStop(1, 'rgba(20,19,16,.58)');
      g.fillStyle = grad;
      for (let i = 0; i < n; i++) {
        const v = clamp(bands[i], 0, 1);
        const h = Math.max(2, v * hMax);
        const x = i * slot + (slot - bw) / 2;
        const y = barBase - h;
        const r = Math.min(2.5, bw / 2);
        g.beginPath();
        g.moveTo(x, barBase);
        g.lineTo(x, y + r);
        g.quadraticCurveTo(x, y, x + r, y);
        g.lineTo(x + bw - r, y);
        g.quadraticCurveTo(x + bw, y, x + bw, y + r);
        g.lineTo(x + bw, barBase);
        g.closePath();
        g.fill();
      }
    }

    // library median spine — the reference this track sits against
    if (median && median.length) {
      g.beginPath();
      for (let i = 0; i < median.length; i++) {
        const v = clamp(median[i], 0, 1);
        const x = i * slot + slot / 2;
        const y = barBase - v * hMax;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.strokeStyle = 'rgba(20,19,16,.62)';
      g.lineWidth = 1.4;
      g.lineJoin = 'round';
      g.setLineDash([3.5, 3.5]);
      g.stroke();
      g.setLineDash([]);
      for (let i = 0; i < median.length; i += 5) {
        const v = clamp(median[i], 0, 1);
        g.beginPath();
        g.arc(i * slot + slot / 2, barBase - v * hMax, 2.2, 0, Math.PI * 2);
        g.fillStyle = '#e2ded4'; g.fill();
        g.strokeStyle = 'rgba(20,19,16,.62)'; g.lineWidth = 1.1; g.stroke();
      }
    }

    // LIVE: orange bars overlapping the measured ones — same slot, same width, same rounding,
    // so the moving EQ reads as the same instrument with a needle run over it.
    {
      const live = analyser && !audio.paused && !audio.muted;
      if (live) analyser.getByteFrequencyData(freq);
      const nyq = (ac ? ac.sampleRate : 48000) / 2, fmin = 40, fmax = 16000;
      if (liveSmooth.length !== n) { liveSmooth = new Array(n).fill(0); livePeak = new Array(n).fill(0); }
      const rr = Math.min(2.5, bw / 2);
      for (let i = 0; i < n; i++) {
        let target = 0;
        if (live) {
          const f0 = fmin * Math.pow(fmax / fmin, i / n);
          const f1 = fmin * Math.pow(fmax / fmin, (i + 1) / n);
          const b0 = clamp(Math.floor((f0 / nyq) * freq.length), 0, freq.length - 1);
          const b1 = clamp(Math.ceil((f1 / nyq) * freq.length), b0 + 1, freq.length);
          let m = 0; for (let k = b0; k < b1; k++) if (freq[k] > m) m = freq[k];
          target = m / 255;
        }
        const cur = liveSmooth[i];
        liveSmooth[i] = target > cur ? cur + (target - cur) * 0.55 : cur + (target - cur) * 0.14;
        livePeak[i] = Math.max(liveSmooth[i], livePeak[i] - 0.009);
        const v = clamp(liveSmooth[i], 0, 1);
        const pk = clamp(livePeak[i], 0, 1);
        if (v <= 0.004 && pk <= 0.02) continue;
        const x = i * slot + (slot - bw) / 2;
        if (v > 0.004) {
          const h = Math.max(1, v * hMax), y = barBase - h;
          g.beginPath();
          g.moveTo(x, barBase);
          g.lineTo(x, y + rr);
          g.quadraticCurveTo(x, y, x + rr, y);
          g.lineTo(x + bw - rr, y);
          g.quadraticCurveTo(x + bw, y, x + bw, y + rr);
          g.lineTo(x + bw, barBase);
          g.closePath();
          g.fillStyle = 'rgba(214,56,18,.84)';
          g.fill();
        }
        const py = barBase - Math.max(pk * hMax, 2);
        if (py < barBase - 3) { g.fillStyle = 'rgba(146,34,6,.92)'; g.fillRect(x, py, bw, 2); }
      }
    }

    const d = audio.duration || 0;
    if (d) {
      const x = Math.round(clamp(audio.currentTime / d, 0, 1) * W) + .5;
      g.strokeStyle = '#dc3f19'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, barBase); g.stroke();
      g.fillStyle = '#dc3f19';
      g.beginPath(); g.moveTo(x - 4, barBase + 4); g.lineTo(x + 4, barBase + 4); g.lineTo(x, barBase + 10); g.closePath(); g.fill();
    }
  }

  let loopOn = false;
  function loop() {
    if (loopOn) return;
    loopOn = true;
    const tick = () => {
      // The scope canvas is hidden in every current layout (see the
      // `.scope{display:none}` rule), so an unconditional rAF would burn a
      // frame callback forever for a draw() that immediately returns. Stop
      // when it is not visible; the next loop() call restarts it.
      if (!cv.offsetParent) { loopOn = false; return; }
      draw();
      requestAnimationFrame(tick);
    };
    tick();
  }

  /* ── settings sheet · theme · library management ─────────────── */
  const THEME_KEY = 'theme';
  let sheetOpen = false, libOpen = false, lastFocus = null;

  // Android WebView: backdrop-filter flickers and leaves unpainted tiles, so the
  // glass material is rebuilt from opaque tones there (see the .no-blur block).
  if (PlayerAPI.engine === 'android') document.documentElement.classList.add('no-blur');
  function applyTheme(mode, persist) {
    // Three appearances: 'light' (paper), 'dark' (ink) and 'liquid' (Apple's
    // Liquid Glass material floating over a light colour field).
    const m = mode === 'dark' || mode === 'liquid' ? mode : 'light';
    const dark = m === 'dark';
    const root = document.documentElement;
    root.setAttribute('data-theme', m);
    // the glass appearance is a light-scheme material, so native widgets,
    // scrollbars and the WebView's own chrome must stay light
    root.style.colorScheme = dark ? 'dark' : 'light';
    $('th-light').setAttribute('aria-checked', String(m === 'light'));
    $('th-dark').setAttribute('aria-checked', String(m === 'dark'));
    const liq = $('th-liquid');
    if (liq) liq.setAttribute('aria-checked', String(m === 'liquid'));
    if (persist) {
      PlayerAPI.set(THEME_KEY, m);
      // Android paints the status/nav bars from this call; glass is a light look
      if (PlayerAPI.theme) PlayerAPI.theme(dark ? 'dark' : 'light');
    }
  }

  function humanBytes(n) {
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(n >= 10737418240 ? 0 : 1) + ' GB';
    if (n >= 1048576) return Math.round(n / 1048576) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  async function fillSheet() {
    const web = PlayerAPI.platform === 'web';
    $('st-plat').textContent = PlayerAPI.platform;
    $('act-add').hidden = web;
    if (web) $('act-note').textContent = 'Adding songs works in the desktop and Android app.';
    $('st-tracks').textContent = TRACKS.length ? String(TRACKS.length) : '—';
    $('st-audio').textContent = STATS && STATS.bytes ? humanBytes(STATS.bytes) : '—';
    const added = TRACKS.filter((t) => t.added);
    const addedBytes = added.reduce((a, t) => a + (Number(t.bytes) || 0), 0);
    $('st-added').textContent = added.length ? added.length + ' · ' + humanBytes(addedBytes) : 'none yet';
    $('act-clear').hidden = !added.length;
    $('sec-storage').hidden = true;
    try {
      const s = await PlayerAPI.storage();
      if (s && Number(s.totalBytes) > 0) {
        const pct = Math.max(2, Math.min(100, Math.round(((s.totalBytes - s.freeBytes) / s.totalBytes) * 100)));
        $('st-bar').style.width = pct + '%';
        $('st-free').textContent = humanBytes(s.freeBytes);
        $('sec-storage').hidden = false;
      }
    } catch (e) { /* storage is optional */ }
  }

  function openSheet() {
    if (sheetOpen) return;
    sheetOpen = true;
    lastFocus = document.activeElement;
    $('scrim').hidden = false;
    $('sheet').hidden = false;
    document.body.classList.add('no-scroll');
    requestAnimationFrame(() => $('sheet').classList.add('on'));
    $('gear').setAttribute('aria-expanded', 'true');
    document.body.classList.add('sheet-open');
    $('act-note').textContent = '';
    fillSheet();
    setTimeout(() => { const s = $('sheet'); if (s) s.focus({ preventScroll: true }); }, 60);
  }

  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = false;
    $('sheet').classList.remove('on');
    $('scrim').hidden = true;
    setTimeout(() => { $('sheet').hidden = true; }, 240);
    document.body.classList.remove('no-scroll');
    document.body.classList.remove('sheet-open');
    $('gear').setAttribute('aria-expanded', 'false');
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }

  function openLib() {
    if (libOpen) return;
    libOpen = true;
    document.body.classList.add('lib-open');
    $('lib-btn').setAttribute('aria-expanded', 'true');
  }

  function closeLib() {
    if (!libOpen) return;
    libOpen = false;
    document.body.classList.remove('lib-open');
    $('lib-btn').setAttribute('aria-expanded', 'false');
  }

  document.addEventListener('pointerdown', (e) => {
    if (!libOpen) return;
    const t = e.target;
    if (t && t.closest && (t.closest('.lib') || t.closest('#lib-btn'))) return;
    closeLib();
  }, true);

  async function reloadLibrary() {
    try { await boot(); announce('Library reloaded'); } catch (e) { announce('Library reload failed'); }
  }

  $('gear').addEventListener('click', openSheet);
  $('sheet-x').addEventListener('click', closeSheet);
  $('scrim').addEventListener('click', () => { if (sheetOpen) closeSheet(); if (libOpen) closeLib(); });
  $('lib-btn').addEventListener('click', () => (libOpen ? closeLib() : openLib()));
  $('lib-x').addEventListener('click', closeLib);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (sheetOpen) { e.preventDefault(); e.stopImmediatePropagation(); closeSheet(); } else if (libOpen) { e.preventDefault(); closeLib(); } }
  });
  document.querySelectorAll('[data-set-theme]').forEach((b) => {
    b.addEventListener('click', () => applyTheme(b.dataset.setTheme, true));
  });

  $('act-add').addEventListener('click', async () => {
    const note = $('act-note');
    note.textContent = '';
    if (PlayerAPI.platform === 'web') {
      note.textContent = 'Picking songs works in the desktop and Android app.';
      return;
    }
    try {
      const opened = await PlayerAPI.pickSongs();
      note.textContent = opened === false
        ? 'No file picker on this platform.'
        : 'Pick audio files in the window that just opened…';
    } catch (e) {
      note.textContent = 'Could not open the file picker.';
    }
  });

  let clearArmed = 0;
  $('act-clear').addEventListener('click', async () => {
    const btn = $('act-clear');
    if (!clearArmed) {
      clearArmed = 1;
      btn.dataset.armed = '1';
      btn.textContent = 'Tap again to remove';
      setTimeout(() => { clearArmed = 0; btn.dataset.armed = '0'; btn.textContent = 'Remove added songs'; }, 4200);
      return;
    }
    clearArmed = 0;
    btn.dataset.armed = '0';
    btn.textContent = 'Remove added songs';
    try {
      await PlayerAPI.clearAdded();
      $('act-note').textContent = 'Removed every song you added.';
      setTimeout(reloadLibrary, 500);
    } catch (e) {
      $('act-note').textContent = 'Could not remove the files.';
    }
  });

  PlayerAPI.onLibraryChange(() => { reloadLibrary(); });

  /* keyboard-only focus rings */
  let kbdMode = false;
  const setKbd = (on) => { if (on !== kbdMode) { kbdMode = on; document.body.classList.toggle('kbd', on); } };
  window.addEventListener('keydown', () => setKbd(true), true);
  window.addEventListener('pointerdown', () => setKbd(false), true);

  // The phone package opens on the glass material: it is the look the APK is
  // built around, and the .no-blur rebuild above keeps it stable in WebView.
  // An explicit choice still wins, because the stored value comes first.
  applyTheme(PlayerAPI.get(THEME_KEY, PlayerAPI.engine === 'android' ? 'liquid' : 'light'), false);





  // ── now playing card (player theme) ───────────────────────────────────────
  let npLastFocus = null;
  const npOpen = () => $('np').classList.contains('on');
  function syncNow() {
    const card = $('np');
    const t = VIEW[cur] || {};
    $('np-title').textContent = clean(t.title) || '(untitled)';
    const ar = clean(t.artist);
    $('np-artist').textContent = looksLikeJunk(ar) ? 'Unknown artist' : ar;
    const art = $('np-art');
    if (t.cover) {
      if (art.getAttribute('src') !== t.cover) art.src = t.cover;
      card.classList.remove('np-mono');
    } else {
      art.removeAttribute('src');
      card.classList.add('np-mono');
    }
    const d = audio.duration || t.dur || 0;
    const c = audio.currentTime || 0;
    $('np-fill').style.width = (d ? clamp(c / d, 0, 1) * 100 : 0) + '%';
    $('np-elapsed').textContent = fmt(c);
    $('np-left').textContent = '-' + fmt(Math.max(0, Math.round(d - c)));
    const rail = $('np-rail');
    rail.setAttribute('aria-valuemax', String(Math.round(d)));
    rail.setAttribute('aria-valuenow', String(Math.round(c)));
    rail.setAttribute('aria-valuetext', fmt(c) + ' of ' + fmt(d));
    const paused = audio.paused;
    $('np-toggle').setAttribute('aria-label', paused ? 'Play' : 'Pause');
    $('np-ico').innerHTML = paused ? '<path d="M8 5l11 7-11 7z"/>' : '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';
    card.classList.toggle('playing', !paused);
    const muted = audio.muted || audio.volume === 0;
    const mb = $('np-mute');
    mb.setAttribute('aria-pressed', muted ? 'true' : 'false');
    mb.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    $('np-mute-ico').innerHTML = muted
      ? '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 9l5 6M21.5 9l-5 6"/>'
      : '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 8.5a5 5 0 0 1 0 7"/>';
  }
  function openNow() {
    syncNow();
    npLastFocus = document.activeElement;
    const card = $('np');
    $('np-scrim').hidden = false;
    card.hidden = false;
    document.body.classList.add('no-scroll', 'np-open');
    requestAnimationFrame(() => card.classList.add('on'));
    try { card.focus({ preventScroll: true }); } catch (e) { card.focus(); }
  }
  function closeNow() {
    const card = $('np');
    card.classList.remove('on');
    document.body.classList.remove('no-scroll', 'np-open');
    setTimeout(() => {
      card.hidden = true;
      $('np-scrim').hidden = true;
    }, 280);
    if (npLastFocus && npLastFocus.focus) npLastFocus.focus({ preventScroll: true });
  }
  $('np-scrim').addEventListener('click', closeNow);
  $('np-prev').addEventListener('click', () => step(-1));
  $('np-next').addEventListener('click', () => step(1));
  $('np-toggle').addEventListener('click', () => toggle());
  $('np-mute').addEventListener('click', () => toggleMute());
  bindDrag($('np-rail'), (p) => {
    const d = audio.duration || (VIEW[cur] && VIEW[cur].dur) || 0;
    if (d) seekTo(p * d, d);
    syncNow();
  });
  $('np-rail').addEventListener('keydown', (e) => {
    const d = audio.duration; if (!d) return;
    const k = e.key;
    const delta = k === 'ArrowRight' ? 5 : k === 'ArrowLeft' ? -5 : k === 'PageUp' ? 30 : k === 'PageDown' ? -30 : null;
    if (delta === null) return;
    e.preventDefault();
    seekTo(audio.currentTime + delta, d);
    syncNow();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && npOpen()) { e.preventDefault(); closeNow(); }
  });
  const sleeveEl = document.querySelector('.sleeve');
  if (sleeveEl) {
    sleeveEl.setAttribute('role', 'button');
    sleeveEl.setAttribute('tabindex', '0');
    sleeveEl.setAttribute('aria-label', 'Open now playing');
    sleeveEl.addEventListener('click', openNow);
    sleeveEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openNow(); }
    });
  }
  const deckEl = $('deck');
  if (deckEl) deckEl.addEventListener('click', () => openNow());
  audio.addEventListener('volumechange', () => { if (npOpen()) syncNow(); });
  if (window.PlayerAPI) { PlayerAPI.openCard = openNow; PlayerAPI.closeCard = closeNow; }

  
/* ---- Nowhere: audio-first YouTube, optional video, history ---- */
(function nowhere() {
  try {

const pane = document.getElementById('yt-pane');
if (!pane) return;
const listEl = document.getElementById('yt-list');
const qEl = document.getElementById('yt-q');
const noteEl = document.getElementById('yt-note');
const tabLib = document.getElementById('tab-lib');
const tabYt = document.getElementById('tab-yt');
const modeEl = document.getElementById('yt-mode');

const canYt = !!(window.AndroidBridge && AndroidBridge.ytSearch) || !!(window.__TAURI__ && PlayerAPI.engine === 'tauri');
const hero = document.querySelector('.hero');
const deck = document.querySelector('.deck');
if (!hero || !deck) return;

const HKEY = 'yt_history';
const QKEY = 'yt_queries';
const MKEY = 'yt_mode';
let mode = PlayerAPI.get(MKEY, 'audio') === 'video' ? 'video' : 'audio';

function readList(key) {
  try { const raw = PlayerAPI.get(key, '[]'); const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; }
  catch (e) { return []; }
}
function writeList(key, arr) { PlayerAPI.set(key, JSON.stringify(arr.slice(0, 12))); }

const stage = document.createElement('div');
stage.className = 'vstage';
stage.id = 'vstage';
const bar = document.createElement('div');
bar.className = 'vbar';
bar.id = 'vbar';
bar.innerHTML = '<div class="vbar-id"><span class="vbar-t" id="vbar-t"></span><span class="vbar-a" id="vbar-a"></span></div><button class="btn vback" id="vback">Back to library</button>';
deck.parentNode.insertBefore(stage, deck);
deck.parentNode.insertBefore(bar, deck);

const badge = document.createElement('div');
badge.className = 'yt-badge';
badge.hidden = true;
badge.innerHTML = '<span class="yt-badge-t">YouTube audio \u00b7 low data</span><button class="btn yt-badge-b" id="yt-to-video">Watch video</button><button class="yt-badge-x" id="yt-badge-x" aria-label="Stop">\u2715</button>';
const metaEl = document.getElementById('meta');
metaEl.parentNode.insertBefore(badge, metaEl.nextSibling);

let player = null;
let apiPromise = null;
let currentVideo = null;
let ytGen = 0;          // bumps on every start/stop so a slow yt-dlp run cannot play later

function loadApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onload = () => {
      const spin = setInterval(() => {
        // YT.Player exists before the API finishes wiring its DOM hooks; the
        // constructor then throws "undefined (reading 'bind')". Wait for loaded.
        if (window.YT && window.YT.Player && window.YT.loaded) { clearInterval(spin); resolve(); }
      }, 120);
      setTimeout(() => { clearInterval(spin); if (!(window.YT && window.YT.Player)) reject(new Error('api timeout')); }, 15000);
    };
    s.onerror = () => reject(new Error('api blocked'));
    document.head.appendChild(s);
  });
  return apiPromise;
}

async function ensurePlayer() {
  await loadApi();
  if (player) return player;
  const holder = document.createElement('div');
  holder.style.cssText = 'position:absolute;inset:0';
  stage.appendChild(holder);
  player = await new Promise((resolve, reject) => {
    new window.YT.Player(holder, {
      width: Math.max(320, stage.clientWidth || 640),
      height: Math.max(180, stage.clientHeight || 360),
      playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1, iv_load_policy: 3, origin: location.origin },
      events: {
        onReady: (e) => {
          const pl = e.target;
          try { pl.addEventListener('onError', onPlayerError); } catch (err) {}
          resolve(pl);
        },
        onError: () => reject(new Error('video refused to play')),
      },
    });
  });
  return player;
}

/* loadVideoById() resolves even when YouTube refuses the video, so the only
   reliable signal is the player's onError event. */
function onPlayerError(e) {
  const code = Number(e && e.data);
  const why = (code === 2 || code === 100) ? 'that video is private or was removed'
    : (code === 101 || code === 150) ? 'the uploader does not allow this video to be embedded'
    : code === 5 ? 'YouTube could not play that format in the web player'
    : 'the player could not play that video';
  if (pane.hidden) showYt(true);   // the message is useless if Nowhere is hidden
  stopAll();
  noteEl.textContent = 'Could not play this video \u2014 ' + why + '. Pick another result.';
  announce('Nowhere video failed \u00b7 ' + why);
}

function videoMode(on) { document.body.classList.toggle('video-mode', on); }

function pauseLocal() {
  try { audio.pause(); playing = false; icon(false); } catch (e) {}
}

function remember(v) {
  const hist = readList(HKEY).filter((x) => x.id !== v.id);
  hist.unshift({ id: v.id, title: v.title, author: v.author || '', thumb: v.thumb || '', at: Date.now() });
  writeList(HKEY, hist);
}

async function playAudio(v) {
  const gen = ++ytGen;
  try {
    noteEl.textContent = 'Getting the audio stream\u2026';
    pauseLocal();          // the previous track must not keep playing under the yt-dlp wait
    tapStop();             // googlevideo is not CORS-readable, so no live EQ for YouTube
    const res = await PlayerAPI.ytAudio(v.id);
    const url = res && res.url ? res.url : res;
    if (!url) { noteEl.textContent = 'This video has no playable audio.'; return; }
    if (gen !== ytGen) return;   // Stop, or another track, was picked while we waited
    videoMode(false);
    try { if (player) player.stopVideo(); } catch (e) {}
    currentVideo = v;

    $('artist').textContent = (v.author || 'YouTube').toUpperCase();
    $('title').textContent = v.title;
    const chips = $('chips');
    if (chips) chips.innerHTML = '<span class="chip">YT</span><span class="chip">AUDIO</span>';
    const cov = document.getElementById('cover');
    const mt = document.getElementById('meta');
    if (cov && v.thumb) { cov.onerror = () => mt.classList.add('no-cover'); cov.src = v.thumb; mt.classList.remove('no-cover'); }
    else if (mt) mt.classList.add('no-cover');

    // googlevideo URLs occasionally 403 when the request's UA differs from
    // yt-dlp's, so try once, and if the element errors, fetch a fresh URL.
    // Playback is started immediately: the element used to be loaded and then left
    // paused while this code waited for a `playing` event that could never fire, so
    // every YouTube track sat silent for the whole 9 s timeout.
    async function tryStream(attempt) {
      let link = url;
      if (attempt > 0) {
        const again = await PlayerAPI.ytAudio(v.id);
        link = (again && again.url) ? again.url : (typeof again === 'string' ? again : url);
      }
      if (gen !== ytGen) return false;
      audio.src = proxied(link, res && res.contentLength);
      audio.load();
      playing = true;
      const started = audio.play().catch(() => {});   // start now, not after the wait
      const ok = await new Promise((resolve) => {
        let done = false;
        const finish = (val) => { if (!done) { done = true; cleanup(); resolve(val); } };
        const cleanup = () => {
          audio.removeEventListener('playing', onPlaying);
          audio.removeEventListener('error', onError);
          clearTimeout(timer);
        };
        const onPlaying = () => finish(true);
        const onError = () => finish(false);
        const timer = setTimeout(() => finish(!audio.paused && audio.readyState >= 2), attempt === 0 ? 2500 : 4000);
        audio.addEventListener('playing', onPlaying);
        audio.addEventListener('error', onError);
        if (!audio.paused && audio.readyState >= 2) finish(true);
      });
      await started;
      if (gen !== ytGen) return false;
      if (ok) { icon(true); return true; }
      try { audio.pause(); } catch (e) {}
      playing = false;
      return false;
    }

    noteEl.textContent = 'Buffering\u2026';
    let started = await tryStream(0);
    if (!started && gen === ytGen) { noteEl.textContent = 'Retrying the stream\u2026'; started = await tryStream(1); }
    if (gen !== ytGen) return;
    if (!started) {
      icon(false);
      noteEl.textContent = 'YouTube would not give us the audio for this one \u2014 try again, or switch to video mode.';
      return;
    }
    audio.play().then(() => { icon(true); }).catch(() => { playing = false; icon(false); });
    badge.hidden = false;
    noteEl.textContent = 'Audio only \u2014 lighter on data.';
    announce('Nowhere \u00b7 ' + v.title);
    remember(v);
    closeLib();
  } catch (err) {
    noteEl.textContent = 'Could not get audio: ' + String(err).slice(0, 120);
  }
}

async function playVideo(v) {
  try {
    noteEl.textContent = 'Loading the player\u2026';
    pauseLocal();
    badge.hidden = true;
    videoMode(true);
    document.getElementById('vbar-t').textContent = v.title;
    document.getElementById('vbar-a').textContent = v.author || 'youtube';
    // A player that never becomes ready used to leave the app in video mode
    // with an empty stage and no way back except Escape.
    const p = await Promise.race([
      ensurePlayer(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('the player did not start in time')), 12000)),
    ]);
    p.loadVideoById(v.id);
    currentVideo = v;
    noteEl.textContent = 'Video mode \u2014 uses much more data.';
    announce('Nowhere video \u00b7 ' + v.title);
    remember(v);
    closeLib();
  } catch (err) {
    videoMode(false);
    noteEl.textContent = 'Could not start the video: ' + String((err && err.stack) || err).slice(0, 150);
  }
}

function stopAll() {
  ytGen++;                 // cancels an in-flight yt-dlp run / stream start
  videoMode(false);
  badge.hidden = true;
  currentVideo = null;
  try { if (player) player.stopVideo(); } catch (e) {}
  try { audio.pause(); playing = false; icon(false); } catch (e) {}
  setLoudnessGain(null);   // transport stopped: drop the loudness gain back to unity
  tapPause();
  // leaving video mode used to leave "Video mode - uses much more data" on screen
  noteEl.textContent = mode === 'video' ? 'Video mode \u2014 uses much more data.' : 'Audio mode \u2014 lighter on data.';
}

/* Called whenever the local library takes over the transport: it must also cancel
   a YouTube start that is still resolving and drop the now-wrong YT badge. */
PlayerAPI.clearNowhere = function () {
  ytGen++;
  badge.hidden = true;
  currentVideo = null;
  videoMode(false);
  try { if (player) player.stopVideo(); } catch (e) {}
};
function setMode(next) {
  mode = next === 'video' ? 'video' : 'audio';
  PlayerAPI.set(MKEY, mode);
  if (modeEl) {
    [...modeEl.querySelectorAll('[data-ymode]')].forEach((b) => {
      const on = b.getAttribute('data-ymode') === mode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  // The radios were pure decoration: picking Audio while a video was up left
  // body.video-mode on and the iframe playing behind an "Audio mode" label.
  if (mode === 'audio' && document.body.classList.contains('video-mode')) stopAll();
  noteEl.textContent = mode === 'video' ? 'Video mode \u2014 uses much more data.' : 'Audio mode \u2014 lighter on data.';
}

const fmtViews = (v) => {
  const bits = [];
  if (v.views) bits.push(v.views);
  if (v.seconds) bits.push(fmt(v.seconds));
  return bits.join(' \u00b7 ') || 'video';
};

function row(v, sub) {
  const b = document.createElement('button');
  b.className = 'vt-row';
  b.type = 'button';
  b.setAttribute('role', 'option');
  const img = v.thumb ? '<img class="vt-art" alt="" loading="lazy" src="' + String(v.thumb).replace(/"/g, '&quot;') + '">' : '<span class="vt-art"></span>';
  b.innerHTML = img + '<span class="vt-meta"><span class="vt-name"></span><span class="vt-sub"></span></span>';
  b.querySelector('.vt-name').textContent = v.title;
  b.querySelector('.vt-sub').textContent = sub;
  b.addEventListener('click', () => { if (mode === 'video') playVideo(v); else playAudio(v); });

  /* like = keep: liking a streamed song downloads it into the local library */
  const ht = document.createElement('button');
  ht.className = 'like';
  ht.type = 'button';
  paintHeart(ht, isLiked(v));
  ht.addEventListener('click', async (e) => {
    e.stopPropagation();
    const on = ht.getAttribute('aria-pressed') !== 'true';
    if (!on) { setLiked(v, false); paintHeart(ht, false); likeToast('Like removed'); return; }
    setLiked(v, true);
    paintHeart(ht, true);
    if (!PlayerAPI.canDownload || !PlayerAPI.canDownload()) { likeToast('Liked'); return; }
    ht.dataset.busy = '1';
    likeToast('Liked — downloading…');
    try {
      const file = await PlayerAPI.download(v);
      ht.dataset.busy = '0';
      likeToast(file ? 'Saved to your library' : 'Liked');
      if (file) { await boot({ keep: true }); }
    } catch (err) {
      ht.dataset.busy = '0';
      likeToast('Saved the like, download failed');
    }
  });
  b.appendChild(ht);
  return b;
}

function showHistory() {
  const hist = readList(HKEY);
  const queries = readList(QKEY);
  if (!hist.length && !queries.length) return false;

  listEl.innerHTML = '';
  if (queries.length) {
    const wrap = document.createElement('div');
    wrap.className = 'yt-chips';
    queries.slice(0, 8).forEach((q) => {
      const c = document.createElement('button');
      c.className = 'yt-chip';
      c.type = 'button';
      c.textContent = q;
      c.addEventListener('click', () => { qEl.value = q; search(q); });
      wrap.appendChild(c);
    });
    listEl.appendChild(wrap);
  }
  hist.slice(0, 12).forEach((v) => listEl.appendChild(row(v, (v.author ? v.author + ' \u00b7 ' : '') + 'recent')));
  return true;
}

async function search(q) {
  if (!canYt) { noteEl.textContent = 'Nowhere needs the desktop Rust build.'; return; }
  const term = (q || '').trim();
  if (!term) { if (!showHistory()) noteEl.textContent = 'Search, or pick something from your history.'; return; }

  const queries = readList(QKEY).filter((x) => x !== term);
  queries.unshift(term);
  writeList(QKEY, queries);

  listEl.innerHTML = '<p class="yt-note">Searching\u2026</p>';
  try {
    const out = await PlayerAPI.ytSearch(term, 24);
    listEl.innerHTML = '';
    if (!out || !out.length) { listEl.innerHTML = '<p class="yt-note">No results.</p>'; return; }
    out.forEach((v) => listEl.appendChild(row(v, (v.author ? v.author + ' \u00b7 ' : '') + fmtViews(v))));
  } catch (e) {
    listEl.innerHTML = '<p class="yt-note">Search failed: ' + String(e).slice(0, 90) + '</p>';
  }
}

function showYt(on) {
  // Clicking Library while a video was up kept the stage mounted with the
  // deck hidden, i.e. a full-screen video with no visible way back.
  if (!on && document.body.classList.contains('video-mode')) stopAll();
  pane.hidden = !on;
  $('list').hidden = on;
  tabYt.classList.toggle('is-on', on);
  tabLib.classList.toggle('is-on', !on);
  tabYt.setAttribute('aria-selected', on ? 'true' : 'false');
  tabLib.setAttribute('aria-selected', on ? 'false' : 'true');
  if (on && !listEl.childElementCount) { qEl.focus(); showHistory(); }
}

tabLib.addEventListener('click', () => showYt(false));
tabYt.addEventListener('click', () => showYt(true));
document.getElementById('yt-go').addEventListener('click', () => search(qEl.value));
qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(qEl.value); });
qEl.addEventListener('input', () => { if (!qEl.value.trim() && !listEl.querySelector('.vt-row')) showHistory(); });
if (modeEl) modeEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ymode]');
  if (b) setMode(b.getAttribute('data-ymode'));
});
document.getElementById('vback').addEventListener('click', stopAll);
/* Streaming needs the desktop shell (yt-dlp resolves the audio URL).
   On Android there is no equivalent, so the tab would be a dead end. */
if (!(window.AndroidBridge && AndroidBridge.ytSearch) && PlayerAPI.engine !== 'tauri') {
  const tabYtEl = document.getElementById('tab-yt');
  if (tabYtEl) { tabYtEl.hidden = true; tabYtEl.setAttribute('aria-hidden', 'true'); }
}

document.getElementById('yt-to-video').addEventListener('click', () => { if (currentVideo) playVideo(currentVideo); });
document.getElementById('yt-badge-x').addEventListener('click', stopAll);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('video-mode')) stopAll();
});
document.getElementById('list').addEventListener('click', () => {
  if (document.body.classList.contains('video-mode')) stopAll();
}, true);

setMode(mode);
if (!canYt) tabYt.hidden = true;
PlayerAPI.stopVideo = stopAll;
PlayerAPI.playAudio = playAudio;
PlayerAPI.playVideo = playVideo;
window.__ytSearch = search;
  } catch (e) { console.warn('Nowhere disabled:', e && e.message); }
})();

  
  /* ---- vinyl scrub: glide the record to move through the track ---- */
  (function scrub() {
    const deck = document.querySelector('.deck') || document.getElementById('deck');
    const disc = document.getElementById('vd-spin') || document.getElementById('vd-disc');
    if (!deck || !disc || !audio) return;

    const bubble = document.createElement('div');
    bubble.className = 'scrub-bubble';
    bubble.hidden = true;
    document.body.appendChild(bubble);

    let drag = null;
    let pinRaf = 0;

    /* The deck's rAF loop keeps integrating forward spin (vinyl.js
       angle += DEG_PER_SEC*dt*rate), so a hand-assigned angle is overwritten
       between pointer events and the record drifts ahead of the hand. While a
       grab is live, re-assert the hand angle every frame so the platter is a
       pure function of the pointer. */
    function pinPlatter() {
      if (!drag) return;
      if (window.__vinyl) window.__vinyl.angle = drag.rot0 + drag.acc;
      pinRaf = requestAnimationFrame(pinPlatter);
    }

    const angleOf = (p, c) => Math.atan2(p.y - c.y, p.x - c.x) * 180 / Math.PI;
    const centreOf = () => {
      const r = disc.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    function paintBubble(target, delta) {
      bubble.innerHTML = fmt(target) + ' <b>' + (delta >= 0 ? '+' : '−') + fmt(Math.abs(delta)) + '</b>';
      bubble.hidden = false;
    }

    deck.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!audio.src || !isFinite(audio.duration) || audio.duration <= 0) return;
      const c = centreOf();
      drag = {
        c,
        a: angleOf({ x: e.clientX, y: e.clientY }, c),
        t: audio.currentTime,
        acc: 0,
        fine: e.shiftKey,
        moved: false,
        id: e.pointerId,
        was: playing,
        dur: audio.duration,
        rot0: (window.__vinyl ? window.__vinyl.angle : 0),
      };
      try { deck.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ }
    });

    deck.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const a = angleOf({ x: e.clientX, y: e.clientY }, drag.c);
      let step = a - drag.a;
      if (step > 180) step -= 360;
      if (step < -180) step += 360;
      drag.a = a;
      drag.acc += step;
      drag.fine = e.shiftKey;

      if (!drag.moved) {
        if (Math.abs(drag.acc) < 2.5) return;   // a tap, not a glide
        drag.moved = true;
        deck.classList.add('is-scrubbing');
        if (drag.was) { audio.pause(); }
        cancelAnimationFrame(pinRaf);
        pinPlatter();
      }

      // the platter follows the hand: clockwise = forward, anti = rewind
      if (window.__vinyl) window.__vinyl.angle = drag.rot0 + drag.acc;

      const scale = drag.fine ? 0.12 : 1;
      const target = clamp(drag.t + (drag.acc / 360) * drag.dur * scale, 0, drag.dur);
      audio.currentTime = target;
      paintBubble(target, target - drag.t);
      bubble.style.left = e.clientX + 'px';
      bubble.style.top = e.clientY + 'px';
    });

    function end(e) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      const was = drag.was;
      const moved = drag.moved;
      drag = null;
      cancelAnimationFrame(pinRaf);
      pinRaf = 0;
      bubble.hidden = true;
      deck.classList.remove('is-scrubbing');
      if (moved && was) audio.play().catch(() => {});
    }

    deck.addEventListener('pointerup', end);
    deck.addEventListener('pointercancel', end);
    deck.addEventListener('lostpointercapture', end);
  })();

  boot().catch((e) => {
    const box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;inset:auto 0 0 0;padding:18px 22px;background:#f6e6e0;border-top:2px solid var(--accent);font:13px/1.5 var(--ui);color:var(--accent-ink);z-index:9';
    box.textContent = 'Library failed to load. ' + ((e && e.message) || 'Unknown error');
    document.body.appendChild(box);
  });
/* ---- Up next: ranker top-N + web suggestions (nothing is indexed) ---- */
(function upNext() {
  try {
    const tabLib = document.getElementById('tab-lib');
    const tabYt = document.getElementById('tab-yt');
    const tabUp = document.getElementById('tab-up');
    const tabPl = document.getElementById('tab-pl');
    const pane = document.getElementById('up-pane');
    const plPane = document.getElementById('pl-pane');
    const listEl = document.getElementById('list');
    const ytPane = document.getElementById('yt-pane');
    const localEl = document.getElementById('up-local');
    const webEl = document.getElementById('up-web');
    if (!tabUp || !pane || !localEl || !webEl) return;

    let webSeq = 0;

    function paintTabs(which) {
      [['lib', tabLib], ['yt', tabYt], ['up', tabUp], ['pl', tabPl]].forEach(function (pair) {
        const key = pair[0], el = pair[1];
        if (!el) return;
        const on = key === which;
        el.classList.toggle('is-on', on);
        el.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      if (listEl) listEl.hidden = which !== 'lib';
      if (ytPane) ytPane.hidden = which !== 'yt';
      pane.hidden = which !== 'up';
      if (plPane) plPane.hidden = which !== 'pl';
      if (which === 'up') refresh();
      if (which === 'pl') renderPlaylists();
    }

    function localRow(r) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'up-row';
      b.innerHTML = '<span class="up-i"><b></b><i></i></span><span class="up-bar"><span></span></span>';
      b.querySelector('b').textContent = (typeof clean === 'function' ? clean(r.title) : r.title) || '(untitled)';
      b.querySelector('i').textContent = r.artist || '';
      const frac = r.score ? Math.min(1, Math.max(0.06, (r.score + 1.6) / 3.2)) : 0;
      b.querySelector('.up-bar span').style.width = (frac * 100).toFixed(0) + '%';
      b.title = 'Score ' + (r.score ? r.score.toFixed(2) : '—') + (r.cold ? ' (cold start order)' : '');
      b.addEventListener('click', function () { try { select(r.index, true); } catch (e) {} });
      return b;
    }

    let upErr = '';
    let webSeen = {}, webSeedTerm = '', webHasRows = false;
    const WEB_N = 9, WEB_FROM_PICK = 5, WEB_FROM_DEFAULT = 6;

    function renderLocal() {
      localEl.textContent = '';
      let rows = [];
      upErr = '';
      try {
        const wantRows = webHasRows ? 4 : 8;
        if (typeof RANK !== 'undefined' && RANK && typeof RANK.rank === 'function' && typeof rankLib === 'function') rows = RANK.rank(rankLib(), wantRows);
      } catch (e) { rows = []; upErr = String((e && e.message) || e); }
      if (!rows.length) {
        const msg = document.createElement('div');
        msg.className = 'up-empty';
        msg.textContent = upErr ? ('Ranker error: ' + upErr) : 'Not enough listening yet — this fills in as plays accumulate.';
        localEl.appendChild(msg);
        return;
      }
      rows.forEach(function (r) { localEl.appendChild(localRow(r)); });
    }

    function webTermOf(cand) {
      const c = cand || {};
      const a = String(c.artist || '').trim();
      if (a && !/^unknown/i.test(a) && a.length <= 42 && /[a-z]{2,}/i.test(a)) return a;
      const t = String(c.title || '').split(/[|\uFF5C]/)[0].trim();
      return t.length <= 42 ? t : '';
    }
    function webRow(cand) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'up-row';
      const secs = Number(cand.seconds) || 0;
      const tag = secs ? (Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0')) : 'YT';
      b.innerHTML = '<span class="up-i"><b></b><i></i></span><span class="up-tag"></span>';
      b.querySelector('b').textContent = cand.title || '(untitled)';
      b.querySelector('i').textContent = cand.artist || '';
      b.querySelector('.up-tag').textContent = tag;
      b.addEventListener('click', function () {
        /* clicking a pick teaches the pane: it becomes the next seed and the
           list regenerates around it (the clip keeps playing). */
        webSeedTerm = webTermOf(cand) || webSeedTerm;
        webHasRows = true;
        try {
          /* playAudio is local to nowhere(); PlayerAPI.playAudio is the handle it publishes. */
          if (cand.ytId) PlayerAPI.playAudio({ id: cand.ytId, title: cand.title, author: cand.artist, seconds: cand.seconds, thumb: cand.thumb, views: '' });
          else playOnline(cand);
        } catch (e) {}
        paintTabs('up');
        renderWeb().then(function () { renderLocal(); });
      });
      return b;
    }
    function renderWeb() {
      const seq = ++webSeq;
      webEl.textContent = '';
      const note = document.createElement('div');
      note.className = 'up-empty';
      note.textContent = 'Looking for something new\u2026';
      webEl.appendChild(note);

      if (!PlayerAPI || typeof PlayerAPI.ytSearch !== 'function') {
        note.textContent = 'Web suggestions need the desktop shell.';
        return Promise.resolve();
      }
      function webSearch(term, limit) {
        return PlayerAPI.ytSearch(term, limit || 12).then(function (list) {
          return (list || []).map(function (v) {
            return { id: 'yt:' + v.id, ytId: v.id, title: v.title, artist: v.author, seconds: v.seconds, thumb: v.thumb };
          }).filter(function (c) { return c.title; });
        }).catch(function () { return []; });
      }
      function seedOk(x) {
        const v = String(x == null ? '' : x).trim();
        if (v.length < 3 || v.length > 42) return '';
        if (/^unknown/i.test(v)) return '';
        if (/[|\uFF5C]/.test(v)) return '';
        if (!/[a-z]{2,}/i.test(v)) return '';
        if (/^[\d\s._|\-\/]+$/.test(v)) return '';
        if (/\d{4,}/.test(v)) return '';
        return v;
      }
      function pipeHead(t) {
        const parts = String(t || '').split(/[|\uFF5C]/);
        return parts.length > 1 ? parts[0].trim() : '';
      }
      function cleanTitle(t) {
        return String(t || '')
          .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ')
          .replace(/\b(official|lyric|lyrics|audio|video|visuali[sz]er|hd|4k|mv|m\/v)\b/ig, ' ')
          .replace(/[\u2013\u2014]/g, ' - ')
          .replace(/\s+/g, ' ')
          .replace(/^[-\s|]+|[-\s|]+$/g, '')
          .trim();
      }
      const pickedSeed = seedOk(webSeedTerm);
      const want = pickedSeed ? WEB_N : WEB_FROM_DEFAULT;
      const defaults = [];
      function addDefault(t) { const v = seedOk(t); if (v && defaults.indexOf(v) < 0) defaults.push(v); }
      const c0 = (VIEW && VIEW[cur]) || null;
      if (c0) { addDefault(pipeHead(c0.title)); addDefault(c0.artist); const t = cleanTitle(c0.title); if (t && !/[|\uFF5C]/.test(t)) addDefault(t); }
      if (defaults.length < 2) {
        try { (SHELF.seedsFrom((typeof STATS === 'object' && STATS) || {}, 8) || []).map(pipeHead).forEach(addDefault); } catch (e) {}
      }
      if (!pickedSeed && !defaults.length) defaults.push('top hits');

      const seen = { };
      const out = [];
      function take(list, cap, fromPick) {
        let n = 0;
        (list || []).some(function (cand) {
          if (n >= cap) return true;
          if (!cand || !cand.id || seen[cand.id] || webSeen[cand.id]) return false;
          seen[cand.id] = 1; webSeen[cand.id] = 1;
          cand.fromPick = !!fromPick;
          out.push(cand); n++;
          return false;
        });
        return n;
      }
      let chain = Promise.resolve();
      if (pickedSeed) {
        chain = chain.then(function () {
          return webSearch(pickedSeed, 14).then(function (l) { take(l, WEB_FROM_PICK, true); return null; }).catch(function () { return null; });
        });
      }
      defaults.forEach(function (seed, i) {
        chain = chain.then(function () {
          if (out.length >= want) return null;
          const cap = Math.max(1, Math.ceil(WEB_FROM_DEFAULT / Math.min(3, defaults.length)));
          return webSearch(seed, 14).then(function (l) { take(l, cap, false); return null; }).catch(function () { return null; });
        });
        if (i >= 2) return;
      });
      note.textContent = 'Looking near ' + (pickedSeed ? pickedSeed : defaults.join(' \u00b7 ')) + '\u2026';

      return chain.then(function () {
        if (out.length < want) {
          const top = pickedSeed || defaults[0] || 'top hits';
          return webSearch(top, 25).then(function (l) { take(l, want - out.length, false); return null; }).catch(function () { return null; });
        }
        return null;
      }).then(function () {
        if (seq !== webSeq) return;
        if (seq !== webSeq) return;
        out.length = Math.min(out.length, want);
        const had = webHasRows;
        webHasRows = out.length > 0;
        webEl.textContent = '';
        if (!out.length) {
          const none = document.createElement('div');
          none.className = 'up-empty';
          none.textContent = 'Nothing came back \u2014 the YouTube search may be offline.';
          webEl.appendChild(none);
        } else {
          out.forEach(function (c) { webEl.appendChild(webRow(c)); });
        }
        if (had !== webHasRows && typeof renderLocal === 'function') renderLocal();
      }).catch(function (err) {
        if (seq !== webSeq) return;
        webEl.textContent = '';
        const bad = document.createElement('div');
        bad.className = 'up-empty';
        bad.textContent = 'Search failed: ' + ((err && err.message) || err || 'unknown');
        webEl.appendChild(bad);
      });
    }

    function refresh() { renderLocal(); renderWeb(); }

    tabUp.addEventListener('click', function () { paintTabs('up'); });
    if (tabPl) tabPl.addEventListener('click', function () { paintTabs('pl'); });
    if (tabLib) tabLib.addEventListener('click', function () { paintTabs('lib'); });
    if (tabYt) tabYt.addEventListener('click', function () {
      if (pane) pane.hidden = true;
      if (tabUp) tabUp.classList.remove('is-on');
    });

    const audioEl = document.getElementById('audio') || document.querySelector('audio');
    if (audioEl) audioEl.addEventListener('ended', function () { if (pane && !pane.hidden) renderLocal(); });
  } catch (e) { /* the panel is optional: never break the player for it */ }
})();

/* ---- Playlists: three smart lists read straight off the ranker's own log ----
   RANK.stats() returns { per: { file: { plays, skips, ema, lastAt, ... } } },
   so these need no extra storage and no user setup. A track with no entry has
   simply never been played. */
const PLAYLISTS = [
  { id: 'fresh', name: 'Fresh', desc: 'Never played.' },
  { id: 'forgotten', name: 'Forgotten', desc: 'Played once or twice, then left alone for 90 days.' },
  { id: 'rotation', name: 'Heavy rotation', desc: 'Ten or more plays, mostly finished.' },
];

function playlistPer() {
  try {
    if (typeof RANK === 'undefined' || !RANK || typeof RANK.stats !== 'function') return null;
    const s = RANK.stats();
    return s && s.per ? s.per : null;
  } catch (e) { return null; }
}

function playlistTracks(id, per) {
  const DAY = 86400000;
  const now = Date.now();
  return TRACKS.filter(function (t) {
    const s = per && per[t.file];
    if (id === 'fresh') return !s || !s.plays;
    if (id === 'forgotten') return s && s.plays > 0 && s.plays < 3 && (!s.lastAt || now - s.lastAt > 90 * DAY);
    if (id === 'rotation') return s && s.plays >= 10 && s.ema != null && s.ema > 0.7;
    return false;
  });
}

function renderPlaylists() {
  const box = document.getElementById('pl-cards');
  if (!box) return;
  box.textContent = '';
  const per = playlistPer();
  PLAYLISTS.forEach(function (pl) {
    const rows = playlistTracks(pl.id, per);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'pl-card';
    const h = document.createElement('h3');
    h.textContent = pl.name;
    const p = document.createElement('p');
    p.textContent = pl.desc + ' ';
    const n = document.createElement('strong');
    n.textContent = rows.length + (rows.length === 1 ? ' track' : ' tracks');
    p.appendChild(n);
    card.appendChild(h);
    card.appendChild(p);
    card.addEventListener('click', function () {
      if (!rows.length) return;
      VIEW = rows.slice();
      cur = -1;
      renderList();
      const tabLib = document.getElementById('tab-lib');
      if (tabLib) tabLib.click();
    });
    box.appendChild(card);
  });
}

/* ---- Queue strip: the ranker's next three picks, always on screen ---- */
function renderQueueStrip() {
  const strip = document.getElementById('queue-strip');
  const box = document.getElementById('queue-items');
  if (!strip || !box) return;
  let rows = [];
  if (shuffleOn) {
    /* Shuffle already decided the order, so the strip shows that order rather
       than the ranker's — otherwise it would promise tracks that will not play. */
    rows = shufflePeek(3).map(function (i) {
      const t = VIEW[i] || {};
      return { index: i, file: t.file, title: t.title, artist: t.artist, score: 0, cold: true };
    });
  } else {
    try {
      if (typeof RANK !== 'undefined' && RANK && typeof RANK.rank === 'function' && typeof rankLib === 'function') {
        rows = RANK.rank(rankLib(), 3) || [];
      }
    } catch (e) { rows = []; }
    /* A cold library gives the ranker no opinion to express, so rank() lists from
       the top of the view — which is not where "next" goes. Show the three rows
       that n and the end of a track will actually reach instead. The strip is a
       promise, not decoration. */
    if (rows.length && rows.every(function (r) { return r.cold; }) && VIEW.length > 1) {
      rows = [];
      const base = cur < 0 ? -1 : cur;
      for (let k = 1; k <= 3; k++) {
        let i = base + k;
        if (i >= VIEW.length) {
          if (repeatMode !== 'all') break;   // repeat off stops at the end
          i = i % VIEW.length;
        }
        if (i === cur) break;
        const t = VIEW[i] || {};
        rows.push({ index: i, file: t.file, title: t.title, artist: t.artist, score: 0, cold: true });
      }
    }
  }
  box.textContent = '';
  if (!rows.length) { strip.hidden = true; return; }
  strip.hidden = false;
  rows.forEach(function (r) {
    const t = VIEW[r.index] || {};
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'queue-item';
    const art = document.createElement('span');
    art.className = 'qi-art';
    if (t.cover) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = t.cover;
      art.appendChild(img);
    }
    const txt = document.createElement('span');
    txt.className = 'qi-t';
    const bb = document.createElement('b');
    bb.textContent = (typeof clean === 'function' ? clean(r.title || t.title) : (r.title || t.title)) || '(untitled)';
    const ii = document.createElement('i');
    ii.textContent = r.artist || t.artist || '';
    txt.appendChild(bb);
    txt.appendChild(ii);
    b.appendChild(art);
    b.appendChild(txt);
    b.setAttribute('aria-label', 'Play next: ' + bb.textContent);
    b.addEventListener('click', function () { try { select(r.index, true); } catch (e) {} });
    box.appendChild(b);
  });
}

})();
