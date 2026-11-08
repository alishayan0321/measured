# MEASURED 2.0.1

Packaging release. Same player as 2.0.0 — no engine, UI or playback changes.

## What changed

* **Asset names corrected.** The Windows build is published as `MEASURED.exe`, matching the product name and the install table. It was previously uploaded as `Measure-Player.exe`.
* **Stale installer removed.** A 503 MB `Measure-2.0.0-Player-x64-setup.exe` was attached to 2.0.0. It was undocumented, contradicted the documented footprint, and was not produced by the current build. It is gone; the portable executable is the supported Windows download.
* **Version strings bumped** to 2.0.1 in `desktop/package.json`, `rust/desktop/Cargo.toml` and `rust/desktop/tauri.conf.json`.

## Binaries

The executables are the 2.0.0 build, byte for byte — SHA-256 unchanged. This release corrects packaging and metadata only; the toolchain required to rebuild was not available when it was cut.

## Install

| Platform | File | Size |
| --- | --- | --- |
| Windows 10/11 x64 | `MEASURED.exe` | 26.5 MB |
| Android 7.0+ (API 24) | `MEASURED.apk` | 482 MB (includes 148 songs) |

The Windows build needs the WebView2 runtime (present on Windows 11 and current Windows 10). The APK bundles the library, so it installs and plays with the network off; internet is used only by Nowhere.

## Features

See [RELEASE-2.0.0.md](https://github.com/alishayan0321/measured/blob/master/RELEASE-2.0.0.md) for the full 2.0.0 feature list: the Rust core, the Tauri desktop build, Nowhere, Likes, Liquid Glass, vinyl scrubbing and Android streaming without a proxy.

## Known limits

* WMA and APE cannot be decoded in-app on any platform; the player says so instead of failing silently.
* On Android, conversion of exotic containers depends on the phone's own extractors — some Android builds ship a limited set, so a few files are refused by the OS.
* The APK is 482 MB because the songs ship inside it.

## Security

No accounts, no telemetry, no third-party SDKs, no secrets in the source. The keystore used to sign the APK is not distributed, so nobody else can publish an update that installs over this one.
