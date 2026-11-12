/* Shared filename → {artist,title,videoId} parser.
   Loaded by the Node server (require) and by the UI (window.ParseName), so the
   desktop app, the web build and the Android WebView all name tracks the same way.
   rust/core/src/scan.rs implements the SAME spec; test/parse-vectors.json is the
   contract both must satisfy. Change one, change all three. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ParseName = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /* Formats the platform decoders (Chromium, WebView, Electron) can play as-is. */
  var NATIVE_EXT = ['.mp3', '.m4a', '.mp4', '.m4b', '.aac', '.flac', '.ogg', '.oga', '.opus',
    '.wav', '.wave', '.weba', '.webm'];

  /* Everything else we accept. Desktop converts these with the bundled ffmpeg;
     Android converts what its own decoders understand. */
  var EXTRA_EXT = ['.aiff', '.aif', '.aifc', '.caf', '.wma', '.ape', '.alac', '.mka',
    '.wv', '.tta', '.amr', '.ac3', '.dts', '.mlp', '.dsf', '.dff', '.spx', '.au', '.snd'];

  var AUDIO_EXT = NATIVE_EXT.concat(EXTRA_EXT);

  /* Tokens the uploader bolts onto a name. Matched as WHOLE WORDS only — a
     substring test would eat "Clean Bandit" and a token sweep would eat
     "Video Games", so nothing here is ever removed from the middle of a title. */
  var PROMO = {
    official: 1, video: 1, audio: 1, lyric: 1, lyrics: 1, lyrical: 1, music: 1,
    hd: 1, hq: 1, '4k': 1, '8k': 1, uhd: 1, mv: 1, 'm/v': 1, visualizer: 1,
    visualiser: 1, remaster: 1, remastered: 1, premiere: 1, explicit: 1,
    clean: 1, teaser: 1, trailer: 1, promo: 1, song: 1, full: 1, original: 1,
    new: 1, latest: 1, subscribe: 1, out: 1, now: 1, prod: 1, 'prod.': 1
  };

  /* Words that carry no meaning on their own but do not make a field "promo". */
  var FILLER = { a: 1, an: 1, the: 1, by: 1, of: 1, in: 1, on: 1, with: 1, and: 1, ft: 1, 'ft.': 1, feat: 1, 'feat.': 1 };

  function words(str) {
    return String(str || '').trim().split(/\s+/).filter(Boolean);
  }

  function bare(word) {
    return String(word || '').toLowerCase().replace(/^[^a-z0-9/]+|[^a-z0-9/]+$/g, '');
  }

  /* Removes nothing from the middle of a name, so it is safe to run on a title. */
  function trimPromoTail(str) {
    var w = words(str);
    while (w.length > 1) {
      var t = bare(w[w.length - 1]);
      if (!PROMO[t]) break;
      w.pop();
    }
    return w.join(' ');
  }

  function tidy(str) {
    return String(str || '')
      .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
      .replace(/\s*[\u3001\uff5c]/g, ' | ')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s\-\u2013\u2014|,;:]+|[\s\-\u2013\u2014|,;:]+$/g, '')
      .trim();
  }

  /* True only when the field says nothing but promo noise. A field that merely
     STARTS with a promo word ("Clean Bandit", "New Order") is a real name, and
     so is a field made only of filler ("A"). */
  function looksPromo(str) {
    var w = words(str);
    if (!w.length) return true;
    if (w.length > 9) return true;                       // long tail is a description
    var promo = false;
    for (var i = 0; i < w.length; i++) {
      var t = bare(w[i]);
      if (PROMO[t]) { promo = true; continue; }
      if (FILLER[t]) continue;
      return false;
    }
    return promo;
  }

  /* (Official Video), [Lyrics], （HD） — removed only when the whole bracket is promo. */
  function dropPromoBrackets(base) {
    var re = /\s*[(（\[]([^)）\]]*)[)）\]]/g;
    return base.replace(re, function (all, inner) {
      return looksPromo(inner) ? ' ' : all;
    });
  }

  function splitFields(base) {
    return base.split(/\s*[|｜]\s*/).map(tidy).filter(Boolean);
  }

  function parseName(file) {
    var base = String(file || '');
    base = base.replace(/^.*[\\/]/, '');                 // callers pass basenames, but be safe
    var dot = base.lastIndexOf('.');
    if (dot > 0) base = base.slice(0, dot);

    /* Copy markers and the id can come in either order — "Song [id] (2)" and
       "Song (2) [id]" are both common — so peel them in a loop. */
    var videoId = null;
    for (var peel = 0; peel < 3; peel++) {
      var copy = base.match(/\s*\(\d+\)\s*$/);
      if (copy) { base = base.slice(0, copy.index).replace(/\s+$/, ''); continue; }
      var idMatch = base.match(/\s*\[([A-Za-z0-9_-]{11})\]\s*$/);
      if (idMatch && !videoId) {
        videoId = idMatch[1];
        base = base.slice(0, idMatch.index).replace(/\s+$/, '');
        continue;
      }
      break;
    }
    base = dropPromoBrackets(base);

    var artist = 'Unknown';
    var title = base.trim();

    var fields = splitFields(base);
    if (fields.length >= 2) {
      // scraped shape: title | artist | extra
      title = fields[0];
      for (var i = 1; i < fields.length; i++) {
        if (!looksPromo(fields[i])) { artist = fields[i]; break; }
      }
    } else {
      var parts = base.split(/\s+[\-\u2013\u2014]\s+/);
      if (parts.length >= 2) {
        artist = tidy(parts[0]);
        title = tidy(parts.slice(1).join(' - '));
        if (!artist || looksPromo(artist)) { artist = 'Unknown'; title = tidy(base); }
      } else {
        title = tidy(base);
        var m = base.match(/\s+(?:ft\.?|feat\.?)\s+(.+)$/i);
        if (m && tidy(base.slice(0, m.index)).split(/\s+/).length <= 4) artist = tidy(m[1]);
      }
    }

    var fallback = tidy(base) || base;
    title = trimPromoTail(tidy(title)) || fallback;
    artist = tidy(artist) || 'Unknown';
    if (title.toLowerCase() === artist.toLowerCase()) title = fallback;

    return { artist: artist, title: title, videoId: videoId };
  }

  // thumbs are keyed by video id when the filename carries one, else by a short hash
  function keyFor(file, videoId) {
    if (videoId) return videoId;
    var m = String(file).replace(/\.[^.]+$/, '').match(/\s*\[([A-Za-z0-9_-]{11})\]\s*$/);
    if (m) return m[1];
    return null;   // caller falls back to its own hash
  }

  function extOf(file) {
    var m = String(file).match(/(\.[^.]+)$/);
    return m ? m[1].toLowerCase() : '';
  }

  function isAudio(file) { return AUDIO_EXT.indexOf(extOf(file)) >= 0; }

  function isNative(file) { return NATIVE_EXT.indexOf(extOf(file)) >= 0; }

  return { AUDIO_EXT: AUDIO_EXT, NATIVE_EXT: NATIVE_EXT, tidy: tidy, looksPromo: looksPromo, parseName: parseName, keyFor: keyFor, extOf: extOf, isAudio: isAudio, isNative: isNative };
});
