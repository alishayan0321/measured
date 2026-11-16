# Project status

Written 2026-11-17 to park the project. Everything a fresh session needs to pick
it up without the previous conversation.

## Where it stands

- **Version:** 2.1.1 (`rust/desktop/tauri.conf.json`).
- **Windows release:** [v2.1.1](https://github.com/alishayan0321/measured/releases/tag/v2.1.1),
  published 2026-11-14. Two assets:

  | asset | size | sha256 |
  |---|---|---|
  | `MEASURED.exe` | 30,102,528 B (28.71 MiB) | `3ace60c963f083d5a73a5416ff823e6217bfae41986041e8efeb4030119605d3` |
  | `MEASURED.apk` | 19,219,921 B (18.33 MiB) | `0755ddc738eb21dccc177f93b177933d0efe4c7266ce4ffb9735a54b12abc1cd` |

  The APK on v2.1.1 is the **2.0.3 build** re-uploaded, not a 2.1.1 Android build.
  The Android shell is still waiting on a signed, device-run build.
- **Android release:** [v2.0.3](https://github.com/alishayan0321/measured/releases/tag/v2.0.3)
  is the last real Android release.
- **Branch:** `master`, clean, in sync with `origin/master`.

## What is verified

CI (`.github/workflows/ci.yml`) runs six jobs on every push and PR: `web-tests`,
`js-lint`, `rust-lint`, `rust-core`, `rust-desktop`, `android`. All six are green
on the current `master`.

- **Tags.** `rust/core/src/tags.rs` reads real lofty tags, header-only. Tag
  title/artist win; the filename parser is the fallback. `test/tag-vectors.json`
  and `test/parse-vectors.json` (33 cases) lock both parsers; the JS and Rust
  filename parsers run the same fixture.
- **Settings durability.** `settings.json` is written to a sibling temp file,
  fsynced and renamed over the old one. A file that fails to parse is copied to
  `settings.json.corrupt` before the next save replaces it. Saves run off the UI
  thread.
- **Single instance.** `tauri-plugin-single-instance` hands the second launch's
  argv to the running copy and exits; the callback retries focusing `main` for
  about two seconds because a second launch can land before the window exists.
- **Capabilities.** `rust/desktop/capabilities/default.json` is least-privilege:
  `core:event:allow-listen` only.
- **Web shell.** `test/web-smoke.mjs` drives the page end to end over CDP;
  `test/webview2-smoke.mjs` does the same against the real WebView2 host and
  asserts the ACL blocks what it should.
- **Android build.** `android/build.cjs` fails fast unless `javac` is 17, before
  it reaches aapt2/d8.
- **Loudness.** `fp.rs` runs K-weighting, 400 ms blocks on a 100 ms hop, a -70
  LUFS absolute gate and a -10 LU relative gate, true peak 4x oversampled. A -23
  LUFS synthetic tone reads -23 within the +/-0.5 LU the tests assert, at 44.1 and
  48 kHz.

## Open items

### 1. Android device run - blocked on a human

Needs `MEASURED_KS_PASS` in the environment and a device attached. The keystore is
`android/measured.keystore` (2,636 B, created 2026-10-30). **This file is the
signing identity.** It is gitignored and it is not in any release. Losing it means
no future build can install over an existing install. Back it up before touching
anything near it.

The password file `android/measured.keystore.pass` does not exist on this machine;
the password is only in the human's head / password manager.

### 2. Loudness matching by ear - human, never done

The measurement side is tested (see above). Nobody has listened to a matched
playlist and said whether the result sounds right. The algorithm can be correct
and still be wrong musically; this needs ears, not a test.

### 3. Card U - UI refinement, written but never dispatched

The card text exists; no agent ever ran it. It covers the visual findings in
`docs/BUGS-FOUND.md` section D: the 1280x800 horizontal overflow, the liquid
`.kicker` contrast failure, the queue-strip/transport overlap, the `.d` dead
gutter, the missing library-tab hover, and the scrollbar reflow.

### 4. Debug-only `data_directory` override for parallel dev instances

The shipped build forces one instance per machine, which is correct for users and
hostile to harnesses that need several live copies (each on its own CDP port).
The obvious fix - an env var that skips the single-instance plugin - was written,
reviewed and **rejected**: it lets an environment variable disable a shipped
safety guard, and it does not even work for the WebView2 profile, which is the
part that actually collides. The right shape is a debug-only build flag that sets
`data_directory` to a per-instance path, so each copy gets its own profile and the
single-instance guard stays intact. Not started.

### 5. `0x800700AA` on launch - two causes, both known

`0x800700AA` is `ERROR_BUSY`. It has shown up for two unrelated reasons:

1. **Low mandatory integrity label.** Files created inside the sandboxed
   workspace carry a Low IL, and WebView2 refuses to use a user-data folder it
   cannot fully own. Symptom: the window never appears, the process exits with
   `0x800700AA`.
2. **User-data-folder contention.** Orphaned `msedgewebview2.exe` children from a
   previous run still hold the profile directory. Symptom: identical error, but
   only after a run that was killed rather than closed.

**Workaround for (2):** kill the orphans before launching -

```powershell
Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force
```

`WEBVIEW2_USER_DATA_FOLDER` does **not** help and must not be documented as a fix:
Tauri forces `data_directory` to `app_local_data_dir()`
(`tauri-2.12.5/src/manager/webview.rs:559-569`) and wry passes it explicitly
(`wry-0.57.1/src/webview2/mod.rs:357-359`), so WebView2 ignores the env var.

## Known bugs

`docs/BUGS-FOUND.md` holds 20 reproduced defects from the 2.1.1 hunt, with line
numbers and repro steps. The three worth fixing first:

1. Filtering the library blanks the now-playing card and can leave the transport
   icon on Pause while the audio is stopped (`app.js:1653-1658`, `app.js:1156-1162`).
2. The "Up next" strip is never re-rendered when the view changes, so it names
   tracks that will not play and can play a track it did not name (`app.js:1274`).
3. `media-src` does not allow `audio-ssl.itunes.apple.com`, so Apple previews
   cannot play.

## Building and testing on this machine

Two environment quirks, both load-bearing:

- **Cargo tests need `TEMP`/`TMP` inside the repo**, or they fail with
  `PermissionDenied`:

  ```powershell
  $env:TEMP = "$PWD\rust\target\tmp"; $env:TMP = $env:TEMP
  ```

- **`CARGO_PROFILE_DEV_DEBUG=0` is required**, or `ring` fails to link with MSVC
  error `D8050` (exit 101):

  ```powershell
  $env:CARGO_PROFILE_DEV_DEBUG = "0"
  ```

Release builds are **not** byte-reproducible: two builds of the same commit
produce the same size and different SHA-256. Do not treat a digest mismatch as
tampering.

## Layout

```
index.html, app.js, api.js, lib/     web shell (the browser build)
rust/core/                            decoding, tags, parsing, fingerprints, loudness
rust/desktop/                         Tauri 2 shell + capabilities
android/                              build.cjs, java bridge, keystore
test/                                 node tests + CDP smoke harnesses
docs/releases/                        per-version release notes
docs/BUGS-FOUND.md                    the 2.1.1 bug hunt
```
