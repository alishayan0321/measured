# MEASURED 2.0.2

UI correctness release. Playback, library, recommendation and packaging behaviour are unchanged — the desktop interface now renders its own typography.

## What changed

* **Mojibake repaired.** The desktop UI's text was UTF-8 read as CP-1252, so every separator, arrow, ellipsis and symbol reached the screen as garbage: `MEASURE Â· MK II` instead of `MEASURED · MK II`, `33â€¦` instead of `33⅓ rpm`, `â€""` where a metric had no value, `â†Dâ†'` instead of the `↹ ↑↓` key hints. 111 corrupted sequences were repaired across `index.html`, `styles/app.css` and `styles/base.css`.
* **Styles and icon now ship with the desktop build.** `rust/stage-ui.cjs` staged only `index.html` into `dist/`, so the split stylesheets and the window icon were never copied — the packaged interface would have loaded no styles at all once the CSS was split out. `styles/` and `icon.png` are now staged with it.
* **Version strings bumped** to 2.0.2 in `rust/desktop/Cargo.toml` and `rust/desktop/tauri.conf.json`. The Windows executable reports `FileVersion 2.0.2`.

## Binaries

| Platform | File | Size |
| --- | --- | --- |
| Windows 10/11 x64 | `MEASURED.exe` | 46.3 MiB |
| Android 7.0+ (API 24) | `MEASURED.apk` | 482.5 MiB (includes 148 songs) |

The Windows executable is a fresh build of this tag. The Android package is unchanged from 2.0.1 — the APK carries its own player front end, which never had this defect.

```
cc79830229aac24cc318f150c95325f3ecbea1803f70fa136af57abf28e6fefc  MEASURED.exe
dbb7b6d872d791b9c978aa903fc553c6e1ed812b5dd4a98db281d8339468df2b  MEASURED.apk
```

## Install

Windows: run `MEASURED.exe`. It is portable — no installer, no admin rights. It needs the WebView2 runtime, which is present on Windows 11 and current Windows 10. To use a local music library, drop files into a `songs` folder beside the executable or point the app at a folder from inside it.

Android: sideload `MEASURED.apk`. The library ships inside the package, so it installs and plays with the network off; internet is used only by Nowhere.

## Features

See [RELEASE-2.0.0.md](RELEASE-2.0.0.md) for the full feature list: the Rust core, the Tauri desktop build, Nowhere, Likes, Liquid Glass, vinyl scrubbing and Android streaming without a proxy.

## Known limits

* WMA and APE cannot be decoded in-app on any platform; the player says so instead of failing silently.
* On Android, conversion of exotic containers depends on the phone's own extractors — some Android builds ship a limited set, so a few files are refused by the OS.
* The APK is 482.5 MiB because the songs ship inside it.

## Security

No accounts, no telemetry, no third-party SDKs, no secrets in the source. The keystore used to sign the APK is not distributed, so nobody else can publish an update that installs over this one.
