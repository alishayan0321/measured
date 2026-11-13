# MEASURED 2.1.0

Reliability and measurement release. The interface gains shuffle and repeat; the loudness numbers become measurements instead of a shape; the two filename parsers become one spec with one fixture; and the packaging, the caches and the Android bridge stop claiming things they were not doing.

## What changed

* **Shuffle and repeat.** Off/all/one in the transport, `s` and `r` on the keyboard, both remembered across relaunches through `PlayerAPI.set`. Shuffle is a queue, not a coin flip: it draws from the filtered view you are looking at rather than the whole library, and it honours the same 12-track repeat window the ranker uses (`REPEAT_WINDOW = 12`, mirroring `lib/recommend-wire.js`), so turning shuffle on is not a way to hear the same song twice. Repeat-one restarts the track, repeat-all wraps the queue, and the modes are exposed with `aria-pressed` and 44 px hit areas.
* **Loudness is measured.** `fp.rs` now runs K-weighting, 400 ms blocks on a 100 ms hop, a -70 LUFS absolute gate and a -10 LU relative gate, with true peak 4x oversampled. A -23 LUFS synthetic tone reads -23 within the ±0.5 LU the tests assert, at both 44.1 and 48 kHz. Long tracks are read in head, middle and tail windows instead of being decoded end to end.
* **One filename parser.** `lib/parse-name.js` and `rust/core/src/scan.rs` run the same 33-case fixture (`test/parse-vectors.json`), so a name parses identically in the browser and in the Rust core. Promo words match whole tokens only, so Clean Bandit and Video Games survive; version tags are kept so two masters of the same song stay distinguishable.
* **Tags are read, and they win.** `rust/core/src/tags.rs` opens each file's tag set through lofty's probe path with audio properties and cover art switched off, so nothing is decoded; the scanner takes a non-empty tag title or artist and falls back to the filename parser only for a field the tag leaves blank. Formats lofty cannot parse (downloaded WebM/Matroska, TTA, AC-3) keep their filename metadata, which is why YouTube tracks still show the downloader's name.
* **The stage script left the page.** The ~2,400-line inline script is now `app.js`, the same text line-ending aside, which is what let the CSP drop `'unsafe-inline'` from `script-src`. The only script origins allowed are `'self'` and `https://www.youtube.com`, for the IFrame API.
* **Long jobs left the UI thread.** `library`, `prepare` and `fingerprint` are `#[tauri::command(async)]`, so a cold scan no longer freezes the window. yt-dlp runs through `tokio::process` with `kill_on_drop` and a real budget: 120 s for a resolve, 900 s for a download, because a download is minutes of transfer and not a lookup.
* **Caches key on content, not names.** The transcode cache keys on (name, mtime, size) and the duration cache on the same triple, so replacing a file with a different one converts it again instead of serving the old audio, and reloading an unchanged library decodes nothing.
* **A filename can no longer escape its folder.** `safe_name` accepts a single path component and nothing else, and is applied where `prepare` and `remove_added` join a user-supplied name onto a directory.
* **Android.** The bridge's `prepare` is token-async like the YouTube calls, so it no longer blocks the WebView; downloads write `<name>.part` and rename on success, deleting the part file on failure; playback pauses when another app takes audio focus or headphones are unplugged; the foreground service always posts a notification before it parses its payload, which is what used to throw `RemoteServiceException` on Android 8+; and the transcode cache is capped instead of growing forever.
* **Packaging.** `embeddings.json` is staged by both `rust/stage-ui.cjs` and `android/build.cjs` — it was 404ing in every packaged build, so the recommender's embedding feature was silently dead. The keystore password is no longer hardcoded: it is read from `MEASURED_KS_PASS`, else from the gitignored `android/measured.keystore.pass`, else generated and written there.
* **The packaged window can listen to the media session again.** `rust/desktop` shipped with no `capabilities/` directory at all, and Tauri's ACL therefore refused the two `plugin:event|listen` calls the page makes for the SMTC bridge (`smtc-event`, `smtc-seek`). Both rejections were unhandled at boot, the listeners never registered, and the OS media keys and the system seek bar were silently dead in the installed app. `rust/desktop/capabilities/default.json` now grants exactly `core:event:allow-listen` to the `main` window and nothing else; every other shell call is an app command declared in `invoke_handler`, which the ACL does not gate.
* Version strings bumped to 2.1.0 in `rust/desktop/Cargo.toml` and `rust/desktop/tauri.conf.json`. The executable reports `FileVersion 2.1.0`.

## Verification

Everything below was run on this tree. Numbers are the actual output, not a summary of intent.

| Gate | Result |
| --- | --- |
| `node test/*.test.cjs` | 114 passed, 0 failed across 7 suites (recommend 42, parse 37, shelf 13, embed 7, wire 7, stage 5, repeat 3) |
| `node test/csp.check.cjs` | exit 0 — positive pass and negative control both behaved |
| `cargo test --workspace` | 18 passed, 0 failed (15 `measured_core`, 3 `measured_desktop`, 0 doc-tests) |
| `cargo fmt --all --check` | exit 0 |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| `cargo check -p measured-desktop` | exit 0 |
| `cargo build --release -p measured-desktop` | exit 0, 28.6 MiB (29,984,768 B), `FileVersion 2.1.0` |
| `node android/build.cjs --fast` | aapt2 compile/link, javac, d8, dex append and zipalign all pass; stops at signing (see below) |

The Rust gates above were run with `CARGO_PROFILE_DEV_DEBUG=0`. In this checkout path — which contains a space — the default dev profile dies inside `ring`'s C build with MSVC `D8050: failed to get command line into debug records` before any crate of ours is compiled, so `clippy`, `check` and `test` were all run with the flag set. That is a toolchain and path problem, not a lint finding: the same three gates pass unchanged with it, and the release profile compiles the same code with exit 0 either way.

Three facts about that 28.6 MiB, because a size in a table is easy to over-read. The bare `cargo build --release` exe does not embed its bundle resources: `yt-dlp.exe` is copied beside it, and the exe's own byte count is unchanged whether that file is the real 23,575,744-byte downloader or an empty stub. The binary is not byte-reproducible — this tree built to 29,984,768 bytes with SHA-256 `6DE62DC6…9B0B`, and the merged-HEAD gate build was the same size with SHA-256 `BFEC224E…AA1E` — so a digest names one binary, not the source. And the 46 MB the README carried until now matched the 2.0.2 asset, measured at 48,576,000 bytes, which is simply not what this tree builds.

### WebView2 smoke

The packaged executable is launched and clicked now, not just built. `test/webview2-smoke.mjs` starts the exe with `--remote-debugging-port`, polls `/json/list`, attaches over CDP, installs its `unhandledrejection`, error and console collectors before the page settles (it reloads so they see the whole boot), and then drives real `Input.dispatchMouseEvent` clicks through the shell. It fails on any unhandled rejection, any uncaught error, any console line matching `not allowed by ACL` or `Uncaught`, a library that paints zero rows, any step that does not reach its handler, and any blocked step other than the native file picker.

| Run | Artifact | Result |
| --- | --- | --- |
| negative control, plain | 28,902,400 B, SHA-256 `9C27ED7F…4CF9` (pre-fix) | exit 1 — exactly 2 unhandled rejections, both `Command plugin:event\|listen not allowed by ACL`, plus one uncaught error with the same text |
| negative control, asserted | same | exit 0 — `rejections 2/2 counted`. Without an explicit `--expect-match`, a negative run requires the signature `not allowed by ACL`; the same binary with `--expect-match "some other text"` exits 1, so a green run cannot hide a different defect |
| the fix | 29,984,768 B, SHA-256 `6DE62DC6…9B0B` | exit 0 — 0 unhandled rejections, 0 uncaught errors, 0 ACL console lines, 13 steps pass, 1 blocked |

The fixed binary was run from the shipped path shape, `%LOCALAPPDATA%\MEASURED\MEASURED.exe`; the pre-fix negative control ran from its saved copy at `C:\mt\artifacts\MEASURED-prefix.exe` (SHA-256 `9C27ED7F…4CF9`, printed by each run). Runtime WebView2 157.0.4341.46, page `http://tauri.localhost/`, title `MEASURED`, 5 library rows. Steps that ran in the fixed build: settings sheet opens and closes, theme cycle dark→liquid→light, library drawer opens, a row plays (1.20 s of 159.3 s), Nowhere search returns 20 results, like a stream (`aria-pressed` toggles — likes persist across runs, so the step asserts the toggle, not a starting state), shuffle on/off, repeat off→all→one→off, seek drag (2.89 s → 111.95 s of 159.3 s), vinyl scrub (`is-scrubbing` observed, 111.95 s → 72.44 s), mute and next on the transport.

The one blocked step is a stated gap, not a pass: "Add songs" opens a native OS picker, and `app.js` writes `#act-note` only after `await PlayerAPI.pickSongs()` resolves, so an empty note is exactly what an open modal looks like from the page. The dialog is not part of the page, so CDP can neither observe nor dismiss it. A denied `pick_songs` would have logged `not allowed by ACL` and the run asserts there are none; the picker's own behaviour is not asserted. Every other blocked step fails the run.

The three claims most likely to be fake-green were checked adversarially rather than by reading the diff:

* **The CSP check can fail.** It runs the page twice. The positive pass reports `violations: []`, the YouTube IFrame API loads, and ten real `Input.dispatchMouseEvent` clicks (mute, shuffle, repeat, play, next, prev, settings, theme, close, library) each reach a handler and change observable state. The negative pass strips `https://www.youtube.com` from `script-src` and must produce exactly one `script-src-elem` violation with the loader blocked. It does. A check that cannot fail is not a check.
* **The windowed decode is really windowed.** A mutation probe replacing `if dur > WINDOW_SECS * 3.0` with `if false` fails exactly `long_track_reads_the_middle_window` and `long_track_reads_the_tail_window` (`7 passed; 2 failed`), which is what proves those tests exercise the windowing rather than the happy path.
* **The extracted script is the same script.** `app.js` is 114,262 bytes, 0 CR, 2,623 LF, SHA-256 prefix `0f69f74854151249`, diffed against `d0191ff:index.html` lines 369–2992. The file contains no template literals, so normalising CRLF to LF cannot have altered a string's contents.

The parser fixture is the other shared contract: 33 vectors, run by `test/parse.test.cjs` in JavaScript and by `parser_matches_shared_vectors` in Rust, so a divergence between the two implementations fails CI on whichever side drifted.

## Not verified

Stated plainly, because the alternative is a release note that reads better than the software:

* **Loudness by ear.** The DSP is verified against synthetic signals with known answers. Nobody has sat down and confirmed that the level matching sounds right on real music.
* **Android on a device.** The build pipeline produces a dexed, aligned APK, but it was not signed here (the existing keystore's password is not available in this environment, and `build.cjs` correctly refuses to guess rather than overwrite the signing identity), so it was not installed or launched on a phone.
* **The media keys themselves.** The smoke proves both `plugin:event|listen` calls resolve, so the `smtc-event` and `smtc-seek` listeners are registered. Whether the OS then delivers a real key press through `souvlaki` needs a human at the keyboard, and was not tested.
* **The download path.** The verified build was compiled with an empty `yt-dlp.exe` stub as its bundle resource, so nothing exercised yt-dlp. The Nowhere search that returned 20 results resolved through the app's own InnerTube path, not through yt-dlp, and no download was started.

## Known limits

* **Tags are read, but not from every format.** `rust/core/src/tags.rs` reads title, artist, album, track and disc through lofty's probe path with audio properties and cover art switched off, so no audio is decoded. Tag title and artist are primary and the filename is the fallback for a field a tag leaves blank; only title and artist reach the `Track` record today. Formats lofty cannot parse — downloaded WebM/Matroska, TTA, AC-3 — still fall back to the filename, so YouTube tracks keep the downloader's name.
* **The RLB high-pass leaves its numerator undivided by `a0`**, matching the reference `pyloudnorm` implementation. That is a flat gain error of +0.047 dB at 44.1 kHz and +0.043 dB at 48 kHz across everything the filter passes — inside the ±0.5 LU the tests assert, but it means "BS.1770-shaped", not "BS.1770 compliant". No ITU conformance suite was run.
* **Early-stop decoding still reads whole files** whose container declares no length. The windowing saves the decode of a long track with a header; it cannot save one without.
* **WMA and APE** cannot be decoded in-app on any platform; the player says so instead of failing silently.
* **On Android**, conversion of exotic containers depends on the phone's own extractors, so a few files are refused by the OS.
* **JDK 17 is required for the Android build.** JDK 21 makes `d8` (R8 8.2.2 from build-tools 34.0.0) die with an internal `NullPointerException`; the same sources dex cleanly under JDK 17.

## Security

No accounts, no telemetry, no third-party SDKs, no secrets in the source. The keystore used to sign the APK is not distributed, so nobody else can publish an update that installs over this one. The CSP now forbids inline script outright, which is a real reduction in what a compromised dependency could execute.
