# MEASURED

Local music player — one library, three shells: browser, Windows (Tauri + Rust), Android.

## Download

Everything is on the [Releases](../../releases/latest) page.

| File | What it is |
|---|---|
| `MEASURED.exe` | **Windows 10/11 x64, 46 MB** — the one to take. Portable: no installer, no admin rights. Put it in a folder with a `songs\` directory beside it, or point it at a folder from Settings → Add songs. |
| `MEASURED.apk` | Android 7.0+ (API 24), 483 MB — all 148 songs already inside. |

The Windows build is x64 only and needs the WebView2 runtime, which ships with Windows 11 and current Windows 10. Your saved songs, likes and settings live in `%APPDATA%\com.measured.player`, so replacing the executable keeps them.

On Android, tap the APK, allow your browser or file manager to *install unknown apps* (the normal Android prompt for any app not from the Play Store), then install.

## What's new in 2.1.0

- **Shuffle and repeat.** Off/all/one in the transport, `s` and `r` on the keyboard, remembered across relaunches. Shuffle is a queue rather than a coin flip: it draws from the view you are looking at, not the whole library, and it keeps the same 12-track repeat window the recommender uses, so turning shuffle on is not a way to hear the same song twice.
- **Loudness is measured, not guessed.** `fp.rs` runs K-weighting, 400 ms blocks on a 100 ms hop, a -70 LUFS absolute gate and a -10 LU relative gate, with true peak 4x oversampled. A -23 LUFS synthetic tone reads -23 within the ±0.5 LU the tests assert, at both 44.1 and 48 kHz. Long tracks are read in head, middle and tail windows instead of being decoded end to end.
- **One filename parser.** `lib/parse-name.js` and `rust/core/src/scan.rs` run the same 30-case fixture (`test/parse-vectors.json`), so a name parses identically in the browser and in the Rust core. Promo words match whole tokens, so Clean Bandit and Video Games survive.
- **The stage script moved out of the page.** `app.js` holds it now — the same text that used to sit inline, line endings aside — which let the CSP drop `'unsafe-inline'` from `script-src`. The only script origins allowed are `'self'` and `https://www.youtube.com`, for the IFrame API.
- **Long jobs left the UI thread.** Library scans, conversion, fingerprinting and yt-dlp all run off the main thread. yt-dlp is killed at 120 s for a resolve and 900 s for a download, because a download is minutes of transfer, not a lookup.
- **Caches key on content, not names.** The transcode cache keys on (name, mtime, size) and the duration cache on the same triple, so replacing a file with a different one re-converts it, and reloading an unchanged library decodes nothing.
- **Android fixes.** The bridge's `prepare` is token-async like the YouTube calls, downloads write `<name>.part` and rename on success, playback pauses when another app takes audio focus or headphones are unplugged, and the foreground service always posts a notification before it parses its payload.
- Version strings bumped to 2.1.0. The executable reports `FileVersion 2.1.0`.

Full history: [2.0.3](docs/releases/RELEASE-2.0.3.md) · [2.0.2](docs/releases/RELEASE-2.0.2.md) · [2.0.1](docs/releases/RELEASE-2.0.1.md) · [2.0.0](docs/releases/RELEASE-2.0.0.md).

## The 2.0 feature set

- **Rust core** (`rust/core`): decoding through [symphonia], filename parsing shared with the web build, spectral fingerprints through [rustfft], cover thumbnails through [image]. One library, shared by the desktop shell and (via the same algorithms) the Android build.
- **Tauri 2 desktop shell** (`rust/desktop`): ~200 ms to a painted window, ~60 MB resident with 148 tracks loaded. The old Electron shell was 886 MB on disk and 1.5–3 s to first paint.
- **No local HTTP server on desktop.** Audio is served through Tauri's asset protocol, which handles Range requests natively, so seeking is instant without a process sitting on a port.
- **Nowhere** — an in-app YouTube surface: audio-first playback (webm/opus, low data), an optional video mode that swaps the platter for a player and stretches the layout, recent searches and history stored locally.
- **Likes** — every local track starts liked; liking a streamed track downloads it into the added-songs folder and it becomes a local, liked track.
- **Liquid Glass** appearance (Settings → Appearance → Liquid): a third theme next to Light and Dark. Cream paper stays the backdrop, the chrome becomes warm glass with a specular rim, seated shadow and a tint taken from the playing sleeve.
- **Vinyl scrubbing** — drag the platter: clockwise seeks forward, anticlockwise rewinds, one full turn is the whole track, Shift for fine control.
- **Android streaming without a server**: NewPipeExtractor runs on the device, so Nowhere works on the phone with no proxy, no Piped instance and no API key.

## The three shells

| Shell | How it runs | Notes |
| --- | --- | --- |
| Web | `node server.cjs` → <http://127.0.0.1:8142/> | Range requests; the page is served straight off disk |
| Windows | Tauri 2 + Rust core | Bundled songs, native "Add songs" dialog, asset-protocol audio |
| Android | WebView over `file:///android_asset` (min SDK 24) | Bundled songs, system file picker, media notification, on-device streaming |

The interface is one page in all three. `index.html` carries the markup and `app.js` the stage script; `styles/base.css` and `styles/app.css` carry the presentation, split out of the single file they used to live in. `api.js` is the single bridge: on the web it fetches `/api/tracks`, on desktop it `invoke`s Rust commands, on Android it calls `AndroidBridge` through `@JavascriptInterface`.

## Architecture

```
index.html              the player: markup
app.js                  the stage script: deck, transport, Nowhere, shuffle/repeat
styles/base.css         reset, tokens, type scale
styles/app.css          the player chrome, deck and transport
api.js                  one bridge for web / Tauri / Android
lib/parse-name.js       "Artist - Title [videoId].webm" → fields, format tables
lib/server.cjs          http server with Range support (web shell)
fingerprints.js|json    measured loudness / true peak / crest / bands per track
library.json            Android asset manifest (id-named files)
thumbs/                 cover art, one jpg per track
rust/core/              decode (symphonia), name parsing, fingerprints (rustfft), thumbs (image)
rust/desktop/           Tauri 2 shell: commands, asset protocol, Nowhere, likes
android/                WebView shell, JNI bridge, NewPipeExtractor wrapper, Gradle-free build.cjs
```

### Rust core

| Module | Responsibility |
| --- | --- |
| `decode.rs` | open any symphonia-supported container, decode to f32 PCM, write a 44-byte-header WAV for the converter cache, report duration |
| `scan.rs` | walk a folder, parse names, build `Track`/`Library`, stable sort by artist+title |
| `fp.rs` | LUFS, true peak, crest, 95 % roll-off and 26 log-spaced bands (2048-point FFT over 20 s head, middle and tail windows; a track under 60 s is read whole) |
| `thumb.rs` | cover-crop, resize (Lanczos3), JPEG encode, average colour |

Loudness follows BS.1770's shape — K-weighting, 400 ms blocks on a 100 ms hop, a -70 LUFS absolute gate and a -10 LU relative gate — and true peak is 4x oversampled. It is **not** certified against the ITU conformance suite. The RLB high-pass leaves its numerator undivided by `a0` (matching the reference `pyloudnorm` implementation), which is a flat gain error of +0.047 dB at 44.1 kHz and +0.043 dB at 48 kHz across everything the filter passes. That sits inside the ±0.5 LU the tests assert, but it means "BS.1770-shaped", not "BS.1770 compliant".

### Desktop commands (Tauri IPC)

`library`, `is_native`, `prepare`, `fingerprint`, `storage`, `pick_songs`, `remove_added`, `clear_added`, `shelf_search`, `get`, `set`, `set_theme`, `version`, `platform`, `proxy_base`, `smtc_update`, `smtc_clear`, `yt_search`, `yt_resolve`, `yt_audio`, `yt_download`.

`prepare` is the converter: a format symphonia can read but WebView2 cannot (AIFF, CAF, ALAC, …) is decoded once into `<cache>/transcode/<key>.wav` and handed to the audio element as a local asset URL. `<key>` is the first 16 hex characters of the md5 over the file name, its mtime and its byte size, so replacing a file with a different one converts it again instead of serving the old audio.

## Formats

- **Native in the browser/WebView**: `.mp3 .m4a .mp4 .m4b .aac .flac .ogg .oga .opus .wav .wave .weba .webm`
- **Converted on first play** (desktop, symphonia): `.aiff .aif .aifc .caf .alac .mka .wv .tta .amr .ac3 .dts .mlp .dsf .dff .spx .au .snd`
- **Not decodable anywhere in-app**: WMA and APE — the UI says so instead of silently failing.

On Android, conversion goes through the phone's own `MediaCodec` (`Transcode.java`). Several Android builds ship a limited extractor set, so a few exotic containers are refused by the OS itself — that is a platform limit, not an app one.

## Build

```bash
# web
node server.cjs                       # http://127.0.0.1:8142/

# desktop (Rust 1.99+, JDK not required, WebView2 runtime)
cd rust
cargo build --release -p measured-desktop
# → rust/target/release/measured-desktop.exe

# android (JDK 17, build-tools 34, platform-34)
cd android
node build.cjs            # full build with songs
node build.cjs --fast     # code-only build, skips the 465 MB of audio
```

`rust/stage-ui.cjs` assembles the web assets into `rust/desktop/dist` before the desktop build; it stages `index.html`, `app.js`, `api.js`, `fingerprints.js`, `fingerprints.json`, `library.json`, `embeddings.json`, `icon.png` and the `deck/`, `styles/` and `thumbs/` directories. `test/stage.test.cjs` runs it and `android/build.cjs --stage-only` into temp directories and fails if any file the page references is missing from either output.

`android/build.cjs` is deliberately Gradle-free: `aapt2 compile/link`, `javac`, `d8`, a zip append for `classes.dex`, `zipalign`, `apksigner`. It resolves the toolchain through `build/` in this workspace; set `MEASURED_BUILD` to relocate both roots at once, or `MEASURED_ANDROID_SDK` / `MEASURED_JAVA_HOME` to point at an SDK and JDK you already have. `node build.cjs --stage-only` stages the web assets and stops, which is what `test/stage.test.cjs` uses.

## Tests

```bash
node test/recommend.test.cjs   # 42  ranker, bootstrap, migration
node test/parse.test.cjs       # 33  the shared filename fixture
node test/shelf.test.cjs       # 13  shelf search and scoring
node test/embed.test.cjs       #  7  embedding features
node test/wire.test.cjs        #  7  the online-learning wire format
node test/stage.test.cjs       #  5  both staging scripts produce a complete bundle
node test/repeat.test.cjs      #  3  the repeat window
node test/csp.check.cjs        #     headless Chromium: CSP positive + negative control
cd rust && cargo test --workspace   # 12  9 core, 3 desktop
```

`test/csp.check.cjs` is the one that needs explaining. It serves `rust/desktop/dist` with the exact CSP from `tauri.conf.json` as a response header, loads it in headless Chromium, and asserts there are no `securitypolicyviolation` events, that the YouTube IFrame API loads, and that ten real clicks (mute, shuffle, repeat, play, next, prev, settings, theme, close, library) each reach a handler and change state. Then it runs the same page again with `https://www.youtube.com` removed from `script-src` and requires that pass to *fail* — one `script-src-elem` violation and a blocked loader. A check that cannot fail is not a check.

`test/stage.test.cjs` parses `index.html` for every local `src`, `href` and `fetch()` target, runs `rust/stage-ui.cjs` and `android/build.cjs --stage-only` into temp directories, and fails if any referenced file is missing from either output. That is the test that would have caught `embeddings.json` 404ing in both packaged builds.

CI runs all of it on every push, plus `cargo fmt --all --check` and `cargo clippy --workspace -- -D warnings`.

## Privacy and security

- **No accounts, no analytics, no crash reporting.** Nothing is uploaded unless you search Nowhere or play a downloaded station.
- **No secrets in this repository.** The signing keystore, its password, the songs, the built binaries and every token live outside git (see `.gitignore`). The keystore password is read from `MEASURED_KS_PASS`, else from the gitignored `android/measured.keystore.pass`, else generated on the first build and written there. The only key in the source is YouTube's *public* InnerTube web client key (`AIza…`), the same one youtube.com ships in its own JavaScript; it is not an account credential.
- **Android never had the INTERNET permission until Nowhere existed** — it is declared now, for YouTube only. The local library still works with the network off.
- **Signing**: the APK is signed with a private keystore that is not distributed. Publishing an update requires that key, which is what stops anyone else from shipping a look-alike build over yours.
- Found a security problem? Open an issue with the `security` label; do not post exploit details for an unpatched build.

No software is "unhackable", and it would be dishonest to claim it. What is true here: no server, no credentials to steal, no third-party SDKs in the app, a minimal permission set (storage + notification + internet-for-YouTube), and no secrets in the source.

## What is not in this repo

| Artifact | Why | Size |
| --- | --- | --- |
| `songs/` | personal audio | 465 MB |
| `MEASURED.apk` | built binary with songs baked in | 483 MB |
| `MEASURED.exe` | built binary | 46 MB |
| signing keystore | must stay private | — |

Binaries are attached to the [releases](../../releases) instead.

## License

MIT for the code. The bundled music, cover art and fingerprints are personal media and are not covered by that licence.

[symphonia]: https://github.com/pdeljanov/Symphonia
[rustfft]: https://github.com/ejmahler/RustFFT
[image]: https://github.com/image-rs/image
