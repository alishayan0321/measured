# MEASURED 2.0.3

Playback correctness release. The library, the recommendation ranker and the audio decoder are unchanged — everything here is the path from a decoded sample to the speaker, and the packaging that carries it.

## What changed

* **Loudness normalisation.** Tracks are driven to -14 LUFS by a gain node that sits *after* the analyser (`src → preamp → 5 bands → analyser → eqPost → destination`), so the spectrum meter keeps showing EQ shape instead of jumping on every track change. Boosts stop at 1.25x, and at whatever keeps the measured true peak under -1 dBTP (EBU R128) — a -20 LUFS master sitting at 0 dBTP is not pushed into clipping. Press `b` to A/B the matched level against the raw one.
* **The first track of a session is normalised too.** `eqBuild()` is lazy, so the gain computed in `select()` was being written to a node that did not exist yet; the opening track played at unity. It is re-applied once the graph is built.
* **A half-built chain can no longer silence the player.** `createMediaElementSource()` is a one-way door: the old body claimed the element first and wired the rest afterwards, so any throw in between left the element captive to a dead context and every later play threw `InvalidStateError`. The chain is now wired to `destination` first and the element is claimed last, with the claimed/unclaimed cases separated — unclaimed retries cleanly, claimed latches to silent-once instead of looping.
* **Transport fixes.** The play position now survives a relaunch (written on a ten-second timer and on the way out, restored at `loadedmetadata`; a position inside the last three seconds is stored as zero). Previous restarts the current track past three seconds. A dock speaker that was a decorative svg is a real mute button with one owner (button, `m`, card, slider) and it persists. Dragging the rail to the very end no longer leaves a paused player showing a pause icon. The `Up next` strip renders as soon as the ranker exists instead of staying hidden until the first track change.
* **Dead selectors repaired.** The selected row was styled `.row.is-on` while `renderList()` emits `on`, so the playing track looked exactly like a hovered one; the liquid theme's `.seek .rail b` / `.seek .knob` rules now point at the `.fill` / `.head` markup that actually exists, and the seek and volume rails grow under the pointer.
* **APKs get their styles.** `android/build.cjs` staged every web asset except `styles/`. Since 2.0.2 moved the interface's CSS out of an inline `<style>` block into `styles/app.css` and `styles/base.css`, **any APK built from 2.0.2 onwards would have installed an unstyled player**. `styles/` is staged now, and the built package was checked to contain `assets/player/styles/app.css`, `assets/player/styles/base.css` and an `index.html` that links them.
* Version strings bumped to 2.0.3 in `rust/desktop/Cargo.toml` and `rust/desktop/tauri.conf.json`. The executable reports `FileVersion 2.0.3`.

## Binaries

| Platform | File | Size |
| --- | --- | --- |
| Windows 10/11 x64 | `MEASURED.exe` | 27.1 MiB |
| Android 7.0+ (API 24) | `MEASURED.apk` | 482.5 MiB (includes 148 songs) |

Both are fresh builds of this tag. The Windows executable is portable and needs only the WebView2 runtime.

```
64583caa83216d40526528d6ba51cc048b6a034eb40037fdb934f5d763f7acad  MEASURED.exe
c037856792d250ad40f81fe86ffe99a5c1d7e1377afb41b493d42075656e80d6  MEASURED.apk
```

## Install

Windows: run `MEASURED.exe`. No installer, no admin rights. Your songs folder, likes and settings live in `%APPDATA%\com.measured.player`, so replacing the executable keeps them.

Android: sideload `MEASURED.apk`. The library ships inside the package, so it installs and plays with the network off; internet is used only by Nowhere. Installing over an existing 2.0.x keeps its library and likes.

## Verification

* `node test/{recommend,shelf,wire,repeat,embed}.test.cjs` — all five suites pass.
* The desktop executable was built, checked to report `FileVersion 2.0.3`, launched, and confirmed to paint the styled interface (vinyl deck, loudness strip reading a real measurement, `Up next` populated, dock with mute and the `space ← → ↑↓ n/p b m /` hints) before being closed.
* The APK was built, `apksigner verify` passed, and the package was opened to confirm the stylesheets are inside it.

## Known limits

* The Web Audio chain is gated on `PROXY`: on the desktop shell the loopback proxy makes even local files same-origin, so the EQ and loudness gain are live there. In a plain browser with no proxy, and on Android, the chain is not built — the spectrum meter still runs off the element, but EQ and level matching do nothing. The controls are not hidden; that is a known cosmetic gap.
* Loudness matching is a measurement, not a mastering decision: it will not fix a bad master, and `b` exists precisely so you can hear what it did.
* WMA and APE cannot be decoded in-app on any platform; the player says so instead of failing silently.
* On Android, conversion of exotic containers depends on the phone's own extractors — some Android builds ship a limited set, so a few files are refused by the OS.

## Security

No accounts, no telemetry, no third-party SDKs, no secrets in the source. The keystore used to sign the APK is not distributed, so nobody else can publish an update that installs over this one.
