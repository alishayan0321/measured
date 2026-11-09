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

## What's new in 2.0.2

- **Mojibake repaired.** The desktop UI's text was UTF-8 read as CP-1252, so every separator, arrow, ellipsis and symbol arrived as garbage — `MEASURE Â· MK II`, `33â€¦ rpm`, `â€""` where a metric had no value. 111 corrupted sequences fixed across `index.html`, `styles/app.css` and `styles/base.css`.
- **Styles and icon now ship with the desktop build.** The staging script copied only `index.html` into `dist/`, so the split stylesheets and the window icon never reached the package. `styles/` and `icon.png` are staged with it now.
- Version strings bumped to 2.0.2. The executable reports `FileVersion 2.0.2`.

Full history: [2.0.1](RELEASE-2.0.1.md) · [2.0.0](RELEASE-2.0.0.md).

## The 2.0 feature set

- **Rust core** (`rust/core`): decoding through [symphonia], tagging through [lofty], spectral fingerprints through [rustfft], cover thumbnails through [image]. One library, shared by the desktop shell and (via the same algorithms) the Android build.
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
| Android | WebView over `file:///android_asset` (min SDK 26) | Bundled songs, system file picker, media notification, on-device streaming |

The interface is one page in all three. `index.html` carries the markup and the stage script; `styles/base.css` and `styles/app.css` carry the presentation, split out of the single file they used to live in. `api.js` is the single bridge: on the web it fetches `/api/tracks`, on desktop it `invoke`s Rust commands, on Android it calls `AndroidBridge` through `@JavascriptInterface`.

## Architecture

```
index.html              the player: markup and stage script
styles/base.css         reset, tokens, type scale
styles/app.css          the player chrome, deck and transport
api.js                  one bridge for web / Tauri / Android
lib/parse-name.js       "Artist - Title [videoId].webm" → fields, format tables
lib/server.cjs          http server with Range support (web shell)
fingerprints.js|json    measured loudness / true peak / crest / bands per track
library.json            Android asset manifest (id-named files)
thumbs/                 cover art, one jpg per track
rust/core/              decode (symphonia), tags (lofty), fingerprints (rustfft), thumbs (image)
rust/desktop/           Tauri 2 shell: commands, asset protocol, Nowhere, likes
android/                WebView shell, JNI bridge, NewPipeExtractor wrapper, Gradle-free build.cjs
```

### Rust core

| Module | Responsibility |
| --- | --- |
| `decode.rs` | open any symphonia-supported container, decode to f32 PCM, write a 44-byte-header WAV for the converter cache, report duration |
| `scan.rs` | walk a folder, parse names, build `Track`/`Library`, stable sort by artist+title |
| `fp.rs` | LUFS, true peak, crest, 95 % roll-off and 26 log-spaced bands (2048-point FFT, first 60 s) |
| `thumb.rs` | cover-crop, resize (Lanczos3), JPEG encode, average colour |

### Desktop commands (Tauri IPC)

`library`, `is_native`, `prepare`, `fingerprint`, `storage`, `pick_songs`, `remove_added`, `clear_added`, `get`, `set`, `set_theme`, `version`, `platform`, `yt_search`, `yt_audio`, `yt_download`.

`prepare` is the converter: a format symphonia can read but WebView2 cannot (AIFF, CAF, ALAC, …) is decoded once into `<cache>/transcode/<md5>.wav` and handed to the audio element as a local asset URL.

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

`rust/stage-ui.cjs` assembles the web assets into `rust/desktop/dist` before the desktop build; it stages `index.html`, `api.js`, `thumbs/`, `styles/` and `icon.png`.

`android/build.cjs` is deliberately Gradle-free: `aapt2 compile/link`, `javac`, `d8`, a zip append for `classes.dex`, `zipalign`, `apksigner`. It resolves the SDK through `player/build` in this workspace — point `BUILD` at your own SDK if you fork this.

## Privacy and security

- **No accounts, no analytics, no crash reporting.** Nothing is uploaded unless you search Nowhere or play a downloaded station.
- **No secrets in this repository.** The signing keystore, the songs, the built binaries and every token live outside git (see `.gitignore`). The only key in the source is YouTube's *public* InnerTube web client key (`AIza…`), the same one youtube.com ships in its own JavaScript; it is not an account credential.
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
[lofty]: https://github.com/Serial-ATA/lofty-rs
[rustfft]: https://github.com/ejmahler/RustFFT
[image]: https://github.com/image-rs/image
