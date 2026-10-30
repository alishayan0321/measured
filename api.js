/* One adapter for the places this page runs:
     web      http://127.0.0.1:8142  — Node server does the scanning
     electron same Node server + native dialogs (DesktopBridge via preload)
     tauri    Rust core, no server: asset protocol + invoke commands
     android  file:///android_asset  — native bridge, no server, no network
   The UI only ever talks to window.PlayerAPI. */
(function () {
  'use strict';

  const android = window.AndroidBridge || null;
  const electron = window.DesktopBridge || null;
  const tauri = !android && !electron && window.__TAURI__ ? window.__TAURI__ : null;
  const invoke = tauri && tauri.core ? tauri.core.invoke : null;
  const assetUrl = tauri && tauri.core && tauri.core.convertFileSrc
    ? tauri.core.convertFileSrc
    : (p) => p;

  const platform = android ? 'android' : (electron || tauri) ? 'desktop' : 'web';
  const engine = tauri ? 'tauri' : electron ? 'electron' : platform;
  const PN = window.ParseName || null;

  const listeners = new Set();
  function emit() { listeners.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } }); }

  function normKey(file) { return String(file || '').toLowerCase().replace(/\.[^.]+$/, ''); }

  function parseAdded(entry) {
    const parsed = PN ? PN.parseName(entry.file) : { artist: 'Unknown', title: entry.file, videoId: null };
    const ext = (entry.file.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
    return {
      file: entry.file,
      src: 'add',
      url: entry.url,
      cover: entry.cover || null,
      artist: parsed.artist,
      title: parsed.title,
      videoId: parsed.videoId,
      ext,
      bytes: entry.bytes || 0,
      mtime: entry.mtime || 0,
      dur: entry.dur || 0,
      added: true,
    };
  }

  function sortTracks(list) {
    return list.sort((a, b) =>
      (a.artist + a.title).localeCompare(b.artist + b.title, undefined, { sensitivity: 'base' }));
  }

  const YT_PENDING = new Map();
let ytSeq = 0;

function ytCall(method, ...args) {
  return new Promise((resolve) => {
    const token = 'y' + (++ytSeq) + Date.now().toString(36);
    YT_PENDING.set(token, resolve);
    // YouTube: desktop uses bundled yt-dlp, Android uses NewPipeExtractor.
    setTimeout(() => {
      if (YT_PENDING.has(token)) { YT_PENDING.delete(token); resolve(null); }
    }, 45000);
    try {
      android[method].apply(android, args.concat([token]));
    } catch (e) {
      YT_PENDING.delete(token);
      resolve(null);
    }
  });
}

const api = {
    platform,
    engine,

    /** Everything the library needs: tracks plus the headline numbers. */
    async load() {
      if (platform === 'android') {
        const raw = JSON.parse(android.library() || '{}');
        const tracks = (raw.bundled || []).map((t) => ({ ...t, src: 'lib', added: false }));
        for (const a of raw.added || []) tracks.push(parseAdded(a));
        sortTracks(tracks);
        return {
          tracks,
          stats: {
            files: tracks.length,
            bytes: tracks.reduce((n, t) => n + (t.bytes || 0), 0),
            addedCount: tracks.filter((t) => t.added).length,
          },
        };
      }

      if (tauri) {
        const lib = await invoke('library');
        const tracks = (lib.tracks || []).map((t) => ({
          file: t.file,
          src: t.src,
          url: assetUrl(t.path),
          cover: t.cover ? assetUrl(t.cover) : null,
          artist: t.artist || 'Unknown',
          title: t.title,
          videoId: t.video_id || null,
          ext: (t.ext || '').toLowerCase(),
          bytes: t.bytes || 0,
          mtime: t.duration_ms || 0,
          dur: (t.duration_ms || 0) / 1000,
          added: !!t.added,
        }));
        sortTracks(tracks);
        return {
          tracks,
          stats: {
            files: lib.count,
            bytes: lib.bytes,
            addedCount: lib.stats ? lib.stats.added_files : 0,
          },
        };
      }

      const r = await fetch('api/tracks', { cache: 'no-store' });
      if (!r.ok) throw new Error('library request failed: ' + r.status);
      const data = await r.json();
      return { tracks: data.tracks || [], stats: data.stats || { files: 0, bytes: 0 } };
    },

    /** Fingerprints: baked script on android, JSON file elsewhere. */
    async fingerprints() {
      if (Array.isArray(window.FINGERPRINTS)) return window.FINGERPRINTS;
      try {
        const r = await fetch('fingerprints.json', { cache: 'no-store' });
        if (!r.ok) return [];
        const data = await r.json();
        return Array.isArray(data) ? data : data.tracks || [];
      } catch (e) {
        return [];
      }
    },

    /** True when this build can save a streamed song into the local library. */
    // YouTube: desktop uses bundled yt-dlp, Android uses NewPipeExtractor.
  // Desktop resolves streams with bundled yt-dlp; Android uses NewPipeExtractor
  // inside the WebView bridge. Both answer through the same two helpers, and the
  // Android side answers asynchronously through a token, because a blocking call
  // would freeze the page for the five or so seconds extraction takes.
  async ytSearch(q, limit) {
    if (tauri) {
      try { return await invoke('yt_search', { query: q, limit: limit || 24 }); } catch (e) { return []; }
    }
    if (android && android.ytSearch) return (await ytCall('ytSearch', q, String(limit || 24))) || [];
    return [];
  },

  async ytAudio(id) {
    if (tauri) {
      try { const u = await invoke('yt_audio', { id }); return u ? { url: u } : null; } catch (e) { return null; }
    }
    if (android && android.ytAudio) return await ytCall('ytAudio', id);
    return null;
  },

  // Called by the Android side when a bridge job finishes.
  ytDone(token, ok, payload) {
    const p = YT_PENDING.get(token);
    if (!p) return 0;
    YT_PENDING.delete(token);
    if (!ok) { p(null); return 1; }
    let v = payload;
    try { v = JSON.parse(payload); } catch (e) { /* plain string */ }
    p(v);
    return 2;
  },

  canDownload() { return !!(tauri || (android && android.ytDownload)); // Android resolves via NewPipeExtractor
    },

    /** Downloads a streamed song into the added-songs folder. Returns the file name or null. */
    async download(video) {
    if (android && android.ytDownload) {
      const name = await ytCall('ytDownload', JSON.stringify({
        id: video.id,
        title: video.title || '',
        author: video.author || '',
      }));
      if (!name) return null;
      emit();
      return name;
    }
      if (!tauri || !video || !video.id) return null;
      try {
        const name = await invoke('yt_download', {
          id: video.id,
          title: video.title || '',
          author: video.author || '',
        });
        if (name) emit();
        return name || null;
      } catch (e) {
        return null;
      }
    },

    /** Opens the OS file picker. Returns true when a picker was shown. */
    async pickSongs() {
      if (platform === 'android') { android.pickSongs(); return true; }
      if (engine === 'electron') { electron.pickSongs(); return true; }
      if (tauri) {
        const added = await invoke('pick_songs');
        if (added && added.length) emit();
        return true;
      }
      return false;
    },

    async storage() {
      if (platform === 'android') {
        try { return JSON.parse(android.storage() || '{}'); } catch (e) { return {}; }
      }
      if (engine === 'electron') {
        try {
          const s = electron.storage();          // already an object over IPC
          return s && typeof s === 'object' ? s : {};
        } catch (e) { return {}; }
      }
      if (tauri) {
        try { return await invoke('storage'); } catch (e) { return {}; }
      }
      return null;
    },

    async removeAdded(file) {
      if (platform === 'android') return android.removeAdded(file);
      if (engine === 'electron') return electron.removeAdded(file);
      if (tauri) { const ok = await invoke('remove_added', { file }); emit(); return ok ? '{"ok":true}' : '{"ok":false}'; }
      return '{"ok":false}';
    },

    async clearAdded() {
      if (platform === 'android') return android.clearAdded();
      if (engine === 'electron') return electron.clearAdded();
      if (tauri) { const n = await invoke('clear_added'); emit(); return '{"removed":' + n + '}'; }
      return '{"removed":0}';
    },

    get(key, fallback) {
      let v = null;
      if (platform === 'android') { try { v = android.get(key); } catch (e) { v = null; } }
      else if (engine === 'electron') { try { v = electron.get(key); } catch (e) { v = null; } }
      else { try { v = localStorage.getItem(key); } catch (e) { v = null; } }
      return v === null || v === '' || v === undefined ? fallback : v;
    },

    set(key, value) {
      const v = String(value);
      if (platform === 'android') { try { android.set(key, v); return; } catch (e) { /* fall through */ } }
      else if (engine === 'electron') { try { electron.set(key, v); return; } catch (e) { /* fall through */ } }
      try { localStorage.setItem(key, v); } catch (e) { /* private mode */ }
      if (tauri) { try { invoke('set', { key, value: v }); } catch (e) { /* ignore */ } }
    },

    /** Keeps the OS window/status bars in step with the page theme. */
    theme(mode) {
      if (platform === 'android') { try { android.setTheme(mode); } catch (e) { /* ignore */ } }
      else if (engine === 'electron') { try { electron.setTheme(mode); } catch (e) { /* ignore */ } }
      else if (tauri) { try { invoke('set_theme', { mode }); } catch (e) { /* ignore */ } }
    },

    /** True when this platform's decoders play the file without conversion. */
    isNative(file) { return PN ? PN.isNative(file) : true; },

    /** A URL the <audio> element can actually play.
        Native formats come back untouched; everything else is converted first.
        null = this platform cannot play it. */
    async prepare(track) {
      if (!track) return null;
      if (api.isNative(track.file || '')) return track.url;
      if (engine === 'electron') {
        try { return (await electron.prepare(track.src || 'lib', track.file)) || null; } catch (e) { return null; }
      }
      if (tauri) {
        try {
          const wav = await invoke('prepare', { src: track.src || 'lib', file: track.file });
          return wav ? assetUrl(wav) : null;
        } catch (e) { return null; }
      }
      if (platform === 'android') {
        try { return android.prepare(track.src || 'lib', track.file) || null; } catch (e) { return null; }
      }
      return track.url;   // web: hand it to the browser and let it try
    },

    /** Convert even when the extension claims the platform is fine with it.
        Extensions lie: .m4a can hold ALAC, which WebView2 will not decode, and the
        element only finds out after the native path already failed. */
    async prepareForce(track) {
      if (!track || !track.file) return null;
      if (engine === 'electron') {
        try { return (await electron.prepare(track.src || 'lib', track.file)) || null; } catch (e) { return null; }
      }
      if (tauri) {
        try {
          const wav = await invoke('prepare', { src: track.src || 'lib', file: track.file, force: true });
          return wav ? assetUrl(wav) : null;
        } catch (e) { return null; }
      }
      if (platform === 'android') {
        try { return android.prepare(track.src || 'lib', track.file) || null; } catch (e) { return null; }
      }
      return null;
    },

    onLibraryChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** Called from native after an import finished. */
    onSongsChanged() { emit(); return 1; },

    normKey,
  };

  window.PlayerAPI = api;
})();
