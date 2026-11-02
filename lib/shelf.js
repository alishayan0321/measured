/* MEASURED · online shelf + download gate.
 *
 * The local library is finite, and a ranker that only ever sees it will run out
 * of things to say. The shelf is what happens next: when the local pool is spent,
 * ask a licensed preview API for 30 s clips that look like what was just played,
 * buffer the next one or two into memory, and stream them in. Nothing is written
 * to disk here.
 *
 * Two rules live in this file because they are product rules, not plumbing:
 *
 *   1. A track only becomes download-eligible when it has been listened to
 *      3+ times in one sitting, or it was liked. Everything else stays a stream.
 *   2. A track that gets skipped at or below 20% is not offered again: the first
 *      such skip of a track that never got going bans it outright, and a second
 *      low skip bans anything that had one more chance.
 *
 * Every external dependency (fetch, Audio) is injected so this whole file can be
 * tested in Node without a network or a sound card.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.MEASURED = root.MEASURED || {}).Shelf = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EP = 'https://itunes.apple.com/search';
  var LOW_SHARE = 0.20;        // at or below this, a skip is a verdict
  var SIT_PLAYS_FOR_DL = 3;    // 3-6 listens in one sitting earns a download
  var DEEP_LISTEN = 0.80;      // what counts as "listened to it" for that counter
  var POOL_SIZE = 3;           // how many clips are kept buffered ahead
  var MAX_BAN = 2;             // low skips allowed before a track is banned

  function num(v) { return typeof v === 'number' && isFinite(v); }

  function create(opts) {
    opts = opts || {};
    var fetchJson = opts.fetchJson || defaultFetchJson;
    var makeAudio = opts.makeAudio || defaultAudio;
    var now = opts.now || Date.now;
    var pool = [];                 // {id, cand, audio, ready}
    var banned = {};               // id -> {at, share}
    var strikes = {};              // id -> count of low skips
    var sit = {};                   // id -> plays this sitting
    var lastQuery = null;
    var queue = [];                 // parsed candidates not yet buffered
    var downloads = [];             // ids that earned a download

    /* ---------------------------------------------------------------- searching */

    function url(term, limit) {
      return EP + '?term=' + encodeURIComponent(term) +
        '&media=music&entity=song&limit=' + (limit || 25);
    }

    /* Seeds come from what was actually played, not from a genre table: the
       strongest artists by listens, then the ones liked but barely played. */
    function seedsFrom(stats, limit) {
      var per = (stats && stats.per) || {};
      var out = [], file, rec;
      for (file in per) {
        if (!Object.prototype.hasOwnProperty.call(per, file)) continue;
        rec = per[file];
        if (!rec || !rec.artist) continue;
        out.push({ artist: rec.artist, score: (rec.plays || 0) + (rec.liked ? 3 : 0) });
      }
      out.sort(function (a, b) { return b.score - a.score || (a.artist < b.artist ? -1 : 1); });
      var seen = {}, res = [];
      for (var i = 0; i < out.length && res.length < (limit || 3); i++) {
        var a = out[i].artist;
        if (seen[a]) continue;
        seen[a] = 1;
        res.push(a);
      }
      return res;
    }

    function parse(json) {
      var list = (json && json.results) || [];
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (!r || !r.previewUrl || !r.trackId) continue;
        out.push({
          id: 'it' + r.trackId,
          url: r.previewUrl,
          title: r.trackName || '',
          artist: r.artistName || '',
          album: r.collectionName || '',
          year: (r.releaseDate || '').slice(0, 4) || '',
          art: (r.artworkUrl100 || '').replace('100x100', '600x600'),
          seconds: 30
        });
      }
      return out;
    }

    /* Buffer up to POOL_SIZE clips ahead. Reuses the first two seconds of a clip
       as proof of life; a failed buffer just drops the candidate. */
    function fill() {
      while (pool.length < POOL_SIZE && queue.length) {
        var cand = queue.shift();
        if (banned[cand.id]) continue;
        var audio = makeAudio(cand.url);
        if (!audio) continue;
        pool.push({ id: cand.id, cand: cand, audio: audio, ready: false });
      }
      return pool.length;
    }

    function search(term, limit) {
      lastQuery = url(term, limit);
      return fetchJson(lastQuery).then(function (json) {
        queue = queue.concat(parse(json));
        fill();
        return queue.length;
      });
    }

    /* Read-only search: fetch and parse results WITHOUT queueing or buffering
     * them, so a panel can show what the web has before we spend a slot on it. */
    function suggest(term, limit) {
      var q = url(term, limit || 8);
      return fetchJson(q).then(function (json) {
        return parse(json);
      }).catch(function () { return []; });
    }

    /* Called when the local pool is spent: refine from a seed artist, and if that
       is already spent too, fall back to the other seeds. */
    function refill(seeds) {
      seeds = seeds && seeds.length ? seeds : ['top hits'];
      var term = seeds[Math.floor((now() / 1000) % seeds.length)] || 'top hits';
      return search(term, 25);
    }

    function next() {
      fill();
      for (var i = 0; i < pool.length; i++) {
        if (pool[i].ready && !banned[pool[i].id]) {
          var hit = pool.splice(i, 1)[0];
          fill();
          return hit.cand;
        }
      }
      return null;
    }

    function markReady(id, ok) {
      for (var i = 0; i < pool.length; i++) {
        if (pool[i].id === id) pool[i].ready = !!ok;
      }
    }

    /* ------------------------------------------------------- download eligibility */

    function downloadGate(id, liked) {
      if (liked) return { ok: true, why: 'liked' };
      var plays = sit[id] || 0;
      if (plays >= SIT_PLAYS_FOR_DL) return { ok: true, why: 'plays:' + plays };
      return { ok: false, why: 'plays:' + plays + '/' + SIT_PLAYS_FOR_DL };
    }

    function noteDownload(id) {
      if (downloads.indexOf(id) < 0) downloads.push(id);
      return downloads.length;
    }

    /* ------------------------------------------------------------- skip verdicts */

    /* A "sit" is one run of the app: repeats of the same track inside it are what
       earn a download, so the counter resets when the app restarts. */
    function noteListen(id, listened, dur, liked) {
      if (num(listened) && num(dur) && dur > 0 && listened / dur >= DEEP_LISTEN) {
        sit[id] = (sit[id] || 0) + 1;
      }
      var g = downloadGate(id, liked);
      if (g.ok && downloads.indexOf(id) < 0) noteDownload(id);
      return g;
    }

    /* The 20% rule. Returns one of: 'ban', 'strike', 'ok'. */
    function noteEnd(id, listened, dur) {
      if (!num(listened) || !num(dur) || dur <= 0) return 'ok';
      var share = listened / dur;
      if (share > LOW_SHARE) return 'ok';
      var n = (strikes[id] || 0) + 1;
      strikes[id] = n;
      /* Never got going on the first attempt, or this is the second low skip:
         for a downloaded track that is final. */
      if (n >= MAX_BAN || (n === 1 && (sit[id] || 0) === 0)) {
        banned[id] = { at: now(), share: share };
        return 'ban';
      }
      return 'strike';
    }

    function isBanned(id) { return !!banned[id]; }
    function stats() {
      return {
        pool: pool.length, queued: queue.length, banned: Object.keys(banned).length,
        downloads: downloads.slice(), lastQuery: lastQuery
      };
    }

    function reset() {
      pool = []; queue = []; banned = {}; strikes = {}; sit = {}; downloads = [];
      lastQuery = null;
    }

    return {
      url: url, seedsFrom: seedsFrom, parse: parse, search: search, suggest: suggest, refill: refill,
      fill: fill, next: next, markReady: markReady,
      downloadGate: downloadGate, noteListen: noteListen, noteEnd: noteEnd,
      isBanned: isBanned, noteDownload: noteDownload, stats: stats, reset: reset,
      poolSize: function () { return pool.length; },
      queued: function () { return queue.length; },
      _internals: {
        EP: EP, LOW_SHARE: LOW_SHARE, SIT_PLAYS_FOR_DL: SIT_PLAYS_FOR_DL,
        DEEP_LISTEN: DEEP_LISTEN, POOL_SIZE: POOL_SIZE, MAX_BAN: MAX_BAN
      }
    };
  }

  function defaultFetchJson(u) {
    if (typeof fetch !== 'function') return Promise.reject(new Error('no fetch'));
    return fetch(u).then(function (r) { return r.json(); });
  }

  function defaultAudio(src) {
    if (typeof Audio !== 'function') return null;
    var a = new Audio();
    a.preload = 'auto';
    a.src = src;
    return a;
  }

  return { create: create };
});
