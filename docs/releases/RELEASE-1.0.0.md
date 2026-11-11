## MEASURED 1.0.0

A local music player: one library, three shells. No account, no network, no telemetry.

### Download

| File | What it is |
| --- | --- |
| `MEASURED-1.0.0-setup.exe` | Windows installer (Windows 10/11, x64). Songs are bundled inside. |
| `MEASURED.apk` | Android app (SDK 26+). 148 songs bundled inside; sideload it, Play Protect warnings are expected for self-signed builds. |

### What is in 1.0.0

- **One interface, three shells.** The same `index.html` runs in the browser, in Electron, and in the Android WebView, so the look and behaviour never drift.
- **Measured readouts.** Loudness, true peak, crest factor and top octave are computed from the actual audio, not invented.
- **Any audio format.** Extensions beyond the platform's native set are accepted everywhere and converted on first play: bundled `ffmpeg` on Windows, the phone's own `MediaCodec` on Android. Native: `.mp3 .m4a .mp4 .m4b .aac .flac .ogg .oga .opus .wav .wave .weba .webm`.
- **Add your own songs.** A real folder/file picker on both desktop and Android; added files are copied into the app's own storage, and you can remove them again from Settings.
- **Light and dark**, with a settings sheet that shows library size, added songs, storage and the active platform.
- **Android media notification** with working play/pause/next, and tapping it opens the player.
- **No network permission on Android.** Nothing leaves the device.

### Known limits

- The Android conversion path depends on the phone's extractors: some ROMs cannot parse AIFF/WMA/APE containers, and the app then says so plainly instead of failing silently. Windows converts all of them.
- Builds are self-signed, so Windows SmartScreen and Android Play Protect will both ask once.
