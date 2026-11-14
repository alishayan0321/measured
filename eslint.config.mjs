/* Flat ESLint config for the hand-written page scripts.
 *
 * There is no package.json and no node_modules in this repo on purpose: the app
 * ships as plain files the browser loads directly, so this config imports
 * nothing and runs through npx:
 *
 *   npx --yes eslint@9 app.js api.js lib/*.js
 *
 * Correctness rules are errors: they catch real bugs (a typo'd global, a dead
 * binding, a duplicated key). The few style rules below are warnings that record
 * what the tree already does consistently (single quotes, semicolons, no
 * trailing whitespace, final newline); they are not errors because the tree is
 * deliberately not being reformatted.
 */
export default [
  {
    files: ['app.js', 'api.js', 'lib/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        /* Browser surface the page scripts use. */
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        history: 'readonly',
        screen: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        XMLHttpRequest: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        FormData: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        AbortController: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        queueMicrotask: 'readonly',
        performance: 'readonly',
        crypto: 'readonly',
        structuredClone: 'readonly',
        CustomEvent: 'readonly',
        Event: 'readonly',
        Image: 'readonly',
        Audio: 'readonly',
        AudioContext: 'readonly',
        webkitAudioContext: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly',
        matchMedia: 'readonly',
        getComputedStyle: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        self: 'readonly',
        globalThis: 'readonly',
        indexedDB: 'readonly',
        DOMParser: 'readonly',
        MediaMetadata: 'readonly',
        devicePixelRatio: 'readonly',
        innerWidth: 'readonly',
        innerHeight: 'readonly',
        scrollTo: 'readonly',
        addEventListener: 'readonly',
        removeEventListener: 'readonly',
        dispatchEvent: 'readonly',
        open: 'readonly',
        close: 'readonly',
        focus: 'readonly',
        blur: 'readonly',
        /* Globals the page scripts create or receive from their host:
           api.js sets window.PlayerAPI, lib/shelf.js sets window.MEASURED, and
           the Android WebView injects window.AndroidBridge. */
        PlayerAPI: 'readonly',
        MEASURED: 'readonly',
        AndroidBridge: 'readonly',
        /* lib/*.js are UMD: the Node branch of the wrapper is real code. */
        module: 'writable',
        require: 'readonly',
      },
    },
    rules: {
      /* Correctness: these are the rules that catch bugs, so they gate. */
      'no-undef': 'error',
      'no-unused-vars': ['error', {
        args: 'after-used',
        caughtErrors: 'none',   // empty catch blocks are deliberate here
        ignoreRestSiblings: true,
      }],
      'no-fallthrough': 'error',
      'no-dupe-keys': 'error',

      /* Style: warnings only. They describe the tree as it is; reformatting it
         would bury real changes in whitespace.
         indent and comma-dangle are off on purpose: the tree aligns continuation
         lines by hand and mixes trailing commas, so those rules report hundreds
         of lines that are not wrong (704 and 26 on the first run). Turning them
         on would demand exactly the reformat this change must not do. */
      quotes: ['warn', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
      semi: ['warn', 'always'],
      'no-trailing-spaces': 'warn',
      'eol-last': ['warn', 'always'],
    },
  },
  {
    files: ['eslint.config.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'error',
    },
  },
];
