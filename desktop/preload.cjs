'use strict';
/* The page only ever sees window.DesktopBridge — the same shape the Android
   JavascriptInterface gives it, so player/api.js needs no per-platform logic
   beyond which object exists. */
const { contextBridge, ipcRenderer } = require('electron');

/* Settings and disk reads are SYNCHRONOUS on purpose: the page assigns them
   straight into audio.volume / data-theme at load, exactly like the Android
   bridge does, so a Promise would poison those values. */
const sendSync = (channel, ...args) => ipcRenderer.sendSync(channel, ...args);
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('DesktopBridge', {
  /* the native picker is the only async call: it waits for a human */
  pickSongs: () => invoke('measured:pick'),

  /* converting an exotic format also waits, so it is a Promise too */
  prepare: (srcKey, file) => invoke('measured:prepare', srcKey, file),

  /* everything else is synchronous so the page can use it inline, exactly
     like AndroidBridge, whose Java methods all return directly. */
  removeAdded: (file) => sendSync('measured:remove', file),
  clearAdded: () => sendSync('measured:clear'),
  storage: () => sendSync('measured:storage'),
  get: (key) => sendSync('measured:get', key),
  set: (key, value) => sendSync('measured:set', key, value),
  setTheme: (mode) => sendSync('measured:theme', mode),
});
