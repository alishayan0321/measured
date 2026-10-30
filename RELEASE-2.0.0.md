# MEASURED 2.0.0

The first release of the Rust rewrite. Same cream-paper player, new engine underneath.

## Highlights

* **Rust core** — decoding (symphonia), tagging (lofty), fingerprints (rustfft) and cover art (image) in `rust/core`; one library shared by every shell.
* **Tauri 2 desktop build** — 24.9 MB executable, ~200 ms to a painted window, ~60 MB resident with 148 tracks. Down from an 886 MB Electron install and 1.5–3 s first paint.
* **No local server on desktop** — audio goes through Tauri's asset protocol, which handles HTTP Range natively, so seeking is instant and nothing listens on a port.
* **Nowhere** — an in-app YouTube surface. Audio-first playback (webm/opus) to keep data low, an optional video mode that swaps the platter for a player and widens the layout, plus recent searches and history kept on the device.
* **Likes** — local tracks start liked; liking a streamed track downloads it into the library and it becomes local.
* **Liquid Glass** — a third appearance (Settings → Appearance → Liquid): cream paper stays, the chrome becomes warm glass with a specular rim, a seated shadow and a tint sampled from the playing sleeve.
* **Vinyl scrubbing** — drag the platter clockwise to go forward, anticlockwise to rewind; one turn spans the track, Shift for fine control.
* **Android streaming without a proxy** — NewPipeExtractor runs on the phone, so search and playback work with no Piped/Invidious instance and no API key.

## Fixes since 1.0.0

* Android: the page no longer aborts boot when the YouTube surface probes a desktop-only bridge (`window.__TAURI__.core`), which had left the library empty.
* Android: the Liquid appearance no longer pushes the player below the fold (the desktop-only library rule leaked into the phone's off-canvas drawer).
* Android: the dock is an in-flow card on phones instead of a 999 px stadium that clipped the seek rail under the gesture bar.
* Liquid: removed every `backdrop-filter` in that appearance. Stacked backdrop filters plus a fixed blurred wash made Chromium drop composited tiles, which read as flicker on both desktop and phone.
* Desktop: the media-element graph no longer silences cross-origin streams (the analyser now taps a separate `crossOrigin='anonymous'` element instead of the audible one).
* Playback: clicking a row with nothing playing now starts the track instead of only selecting it.
* Keyboard: Space in video mode no longer starts local audio over the video, and one Escape no longer closes the sheet and the video together.

## Install

| Platform | File | Size |
| --- | --- | --- |
| Windows 10/11 x64 | `MEASURED.exe` | 24.9 MB |
| Android 7.0+ (API 24) | `MEASURED.apk` | 482 MB (includes 148 songs) |

The Windows build needs the WebView2 runtime (present on Windows 11 and current Windows 10). The APK bundles the library, so it installs and plays with the network off; internet is used only by Nowhere.

## Known limits

* WMA and APE cannot be decoded in-app on any platform; the player says so instead of failing silently.
* On Android, conversion of exotic containers depends on the phone's own extractors — some Android builds ship a limited set, so a few files are refused by the OS.
* The APK is 482 MB because the songs ship inside it.

## Security

No accounts, no telemetry, no third-party SDKs, no secrets in the source. The keystore used to sign the APK is not distributed, so nobody else can publish an update that installs over this one.
