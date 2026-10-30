/* Shared filename → {artist,title,videoId} parser.
   Loaded by the Node server (require) and by the UI (window.ParseName), so the
   desktop app, the web build and the Android WebView all name tracks the same way. */
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

  var PROMO = /^(new|latest|full|official|original|audio|video|lyrical?|lyrics?|song|music|hd|4k|uhd|mv|m\/v|explicit|clean|remaster(ed)?|visuali[sz]er|teaser|trailer|promo|out now|now playing|subscribe)\b/i;
  var BOILER = /\b(full|official|original|lyric|lyrical|video|audio|music|song|visuali[sz]er|remaster(ed)?|hd|4k|uhd|m\/v|mv)\b/gi;

  function tidy(str) {
    return String(str || '')
      .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
      .replace(/\s*[\u3001\uff5c]/g, ' | ')
      .replace(BOILER, ' ')
      .replace(/\(\s*\)|\[\s*\]/g, ' ')
      .replace(/\s*\b(19|20)\d{2}\b\s*$/g, ' ')
      .replace(/\s*(ft\.?|feat\.?)\s+/gi, ' feat. ')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s\-\u2013\u2014|,;:]+|[\s\-\u2013\u2014|,;:]+$/g, '')
      .trim();
  }

  function looksPromo(str) {
    var t = str.trim();
    if (!t) return true;
    if (PROMO.test(t)) return true;
    if (/\bsong\b/i.test(t) && t.split(/\s+/).length <= 6) return true;
    if (t.split(/\s+/).length > 9) return true;          // long tail is a description, not a name
    return false;
  }

  function parseName(file) {
    var base = String(file || '').replace(/\.[^.]+$/, '');
    var idMatch = base.match(/\s*\[[A-Za-z0-9_-]{11}\]\s*$/);
    var videoId = idMatch ? idMatch[0].replace(/[\[\]]/g, '').trim() : null;
    if (idMatch) base = base.slice(0, idMatch.index);

    // drop bracketed qualifiers: (Official Video), [Lyrics], (Audio) ...
    base = base.replace(/\s*[（(\[][^)）\]]*(official|lyric|audio|video|visuali[sz]er|remaster|explicit|hd|4k)[^)）\]]*[)）\]]/gi, ' ');

    var artist = 'Unknown', title = base.trim();

    // 1) pipe-separated scraped shape: first field is the title, second the artist
    var fields = base.split(/\s*[|｜]\s*/).map(function (f) { return tidy(f); }).filter(Boolean);
    if (fields.length >= 2) {
      title = fields[0];
      artist = fields.slice(1).filter(function (f) { return !looksPromo(f); })[0] || 'Unknown';
    } else {
      // 2) classic "Artist - Title"
      var dash = base.split(/\s+[\-–—]\s+/);
      if (dash.length >= 2) {
        artist = tidy(dash[0]);
        title = tidy(dash.slice(1).join(' - '));
        if (!artist || looksPromo(artist)) { artist = 'Unknown'; title = tidy(base); }
      } else {
        title = tidy(base);
        var m = base.match(/\s+(?:ft\.?|feat\.?)\s+(.+)$/i);
        if (m && tidy(base.slice(0, m.index)).split(/\s+/).length <= 4) artist = tidy(m[1]);
      }
    }

    title = tidy(title) || tidy(base) || base;
    artist = tidy(artist) || 'Unknown';
    if (title.toLowerCase() === artist.toLowerCase()) title = tidy(base) || title;

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
