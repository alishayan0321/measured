# MEASURED 2.1.1

Data-safety release. The 2.1.0 binary was built before cards N and N2 landed, so it still carries the settings path those cards fixed: two launches each serialised their own full snapshot over the same `settings.json`, and a crash inside a save could truncate the file into something the next launch silently ignored. 2.1.1 ships the fixed path. No other behaviour changed.

The [2.1.0 notes](RELEASE-2.1.0.md) are left as they were, because they describe the 2.1.0 binary people can still download. Its "no single-instance guard" and "non-atomic write" limits are true of that artifact and false of this one.

## What changed

* **Settings are written atomically.** `save_store_to` serialises the store and hands the bytes to `write_atomic`, which writes a sibling `settings.json.tmp`, calls `sync_all` on it, and renames it over `settings.json`. `File::create` on the target truncates it before the first byte is written, so the old code left an unparsable file whenever a crash landed inside that window; now the rename is the only step that changes the live file, so an interrupted write keeps the previous content. A failed write or rename deletes its own temp file, so a partial one is never left behind for a user to trip over, and the temp file is a sibling of the target so the rename stays on one volume.
* **A second launch focuses the first instead of starting a rival.** `tauri-plugin-single-instance` is registered before the dialog plugin and before `setup`, so a second launch is caught before it can write `settings.json`. It hands its argv to the running copy and exits with code 0; the callback unminimises, shows and focuses the existing `main` window, retrying for about two seconds because a second launch can land between plugin init and window creation. The mutex is keyed on the app identifier, so it does not matter which folder the second copy is launched from. Two processes can no longer serialise rival snapshots over the same file.
* **A damaged `settings.json` is kept, not discarded.** `load_settings_from` leaves the store exactly as it was when the file does not parse, and copies the unparsable bytes to `settings.json.corrupt` first. The copy is written once per damaged file — loading the same bytes again does not rewrite it, and a different damaged file replaces it, because only the newest damage is still worth recovering from. Before this, the save that follows the failed load rewrote `settings.json` from the defaults and the damaged bytes were gone.
* **Saves left the UI thread.** `set` is an async command that inserts under the store lock and then runs `save_settings` through `spawn_blocking`. The page fires `set` on pointermove while the volume is dragged, and serialising, fsyncing and renaming the whole store on the thread the UI waits on stalled it. The insert still happens under the same lock the save takes its snapshot under, so two saves publish whole snapshots in lock order and a stale snapshot cannot land last and drop the other writer's key.
* Version strings bumped to 2.1.1 in `rust/desktop/Cargo.toml`, `rust/desktop/tauri.conf.json`, `index.html` and `README.md`. The executable reports `FileVersion 2.1.1`.

## Verification

Everything below was run on this tree. Numbers are the actual output, not a summary of intent.

| Gate | Result |
| --- | --- |
| `cargo fmt --all --check` | exit 0 |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| `cargo test --workspace` | 24 passed, 0 failed (18 `measured_core` — the 15 unit tests plus `tests/corrupt_tags.rs` and `tests/tag_matrix.rs` — and 6 `measured_desktop`, 0 doc-tests) |
| `node test/*.test.cjs` | 114 passed, 0 failed across 7 suites (recommend 42, parse 37, shelf 13, embed 7, wire 7, stage 5, repeat 3) |
| `node test/csp.check.cjs` | exit 0 — positive pass and negative control both behaved |
| `cargo build --release -p measured-desktop` | exit 0, 30,102,528 B (28.71 MiB), SHA-256 `3ACE60C9…05D3`, `FileVersion 2.1.1` |
| `node test/webview2-smoke.mjs --exe "%LOCALAPPDATA%\MEASURED\MEASURED.exe"` | exit 0 — 14 steps pass, 0 fail, 1 blocked (the native picker, by design); 0 unhandled rejections, 0 uncaught errors, 0 ACL console lines; the second launch exited with code 0 in 553 ms leaving 1 process and 1 page target |

The three settings tests are the evidence for the claims above, and each one fails if its fix is reverted:

* `save_leaves_no_temp_file_and_ignores_a_stale_one` — a completed save leaves the whole bytes in place and no temp file behind, and a temp file left by a writer that died before its rename is never read as settings.
* `truncated_settings_file_is_kept_as_corrupt_and_leaves_the_store_alone` — a truncated file does not empty the store, its bytes are copied to `settings.json.corrupt` byte for byte, and the save that follows does not delete the copy.
* `concurrent_saves_lose_no_key_and_show_no_partial_file` — two writers inserting under the store lock and saving 25 times each lose neither key, while a reader polling the file 2,000 times never observes a partial JSON document.

The Rust gates were run with `CARGO_PROFILE_DEV_DEBUG=0` and `TEMP`/`TMP` pointed at a short path inside the worktree, for the same reason as 2.1.0: in a checkout path containing a space the default dev profile dies inside `ring`'s C build with MSVC `D8050` before any crate of ours is compiled. The workspace test run also needs the same two git-ignored build inputs as the CI desktop job: the empty `yt-dlp.exe` stub beside the desktop crate, and `rust/desktop/dist` staged by `rust/stage-ui.cjs`.

### WebView2 smoke

The packaged executable is launched and clicked, not just built. `test/webview2-smoke.mjs` starts the exe with `--remote-debugging-port`, polls `/json/list`, attaches over CDP, installs its `unhandledrejection`, error and console collectors before the page settles (it reloads so they see the whole boot), and then drives real `Input.dispatchMouseEvent` clicks through the shell. It fails on any unhandled rejection, any uncaught error, any console line matching `not allowed by ACL` or `Uncaught`, a library that paints zero rows, any step that does not reach its handler, and any blocked step other than the native file picker.

This release adds one step, run after the collector snapshot and before the picker: it launches a second copy of the same exe **without** `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` (inheriting the debugging port would make the second copy fight the first for the same CDP endpoint, which is a different failure from the one under test), waits up to 8 s, and asserts four things — the second process exited, the first child is still alive, exactly one process whose image path is this exe is running (`Get-Process -ErrorAction SilentlyContinue`, filtered on `.Path`), and `/json/list` still reports exactly one page target. A second window fails the run.

| Run | Artifact | Result |
| --- | --- | --- |
| the publish build | 30,102,528 B, SHA-256 `3ACE60C9…05D3` | exit 0 — 0 unhandled rejections, 0 uncaught errors, 0 ACL console lines, 14 steps pass, 0 fail, 1 blocked |

The publish build was run from the shipped path shape, `%LOCALAPPDATA%\MEASURED\MEASURED.exe`; the harness prints the byte count and SHA-256 it actually opened, and both match the table above. Runtime WebView2 157.0.4341.46, page `http://tauri.localhost/`, title `MEASURED`, 5 library rows. Steps that ran: settings sheet opens and closes, theme cycle dark→liquid→light, library drawer opens, a row plays (1.20 s of 159.3 s), Nowhere search returns 20 results, like a stream (`aria-pressed` toggles — likes persist across runs, so the step asserts the toggle, not a starting state), shuffle on/off, repeat off→all→one→off, seek drag (9.09 s → 111.94 s of 159.3 s), vinyl scrub (`is-scrubbing` observed, 111.94 s → 72.44 s), mute and next on the transport, and the second launch.

The second launch is the new assertion and it is the one this release exists to prove: the second process exited with code 0 after 553 ms, the first child was still alive, `Get-Process` found exactly one process whose image path is the exe, and `/json/list` still reported exactly one page target. A rival window would have failed all four.

The one blocked step is a stated gap, not a pass: "Add songs" opens a native OS picker, and `app.js` writes `#act-note` only after `await PlayerAPI.pickSongs()` resolves, so an empty note is exactly what an open modal looks like from the page. The dialog is not part of the page, so CDP can neither observe nor dismiss it. A denied `pick_songs` would have logged `not allowed by ACL` and the run asserts there are none; the picker's own behaviour is not asserted. Every other blocked step fails the run.

The CSP check is the other half of the packaged-window evidence, and it can fail: the positive pass reports `violations: []`, the YouTube IFrame API loads, and ten real `Input.dispatchMouseEvent` clicks (mute, shuffle, repeat, play, next, prev, settings, theme, close, library) each reach a handler and change observable state. The negative pass strips `https://www.youtube.com` from `script-src` and must produce exactly one `script-src-elem` violation with the loader blocked. It does.

## Not verified

Stated plainly, because the alternative is a release note that reads better than the software:

* **Android on a device.** The APK is still 2.0.3. It was not rebuilt, not signed and not installed on a phone for this release; the Android bridge is unchanged by 2.1.1, but "unchanged" is not "tested".
* **The media keys themselves.** The smoke's zero-unhandled-rejection and zero-ACL-line assertions cover the two `event.listen` calls at boot (`smtc-event`, `smtc-seek`), which have no `.catch`, so a denied `plugin:event|listen` would have failed the run. Whether the OS then delivers a real key press through `souvlaki` needs a human at the keyboard, and was not tested.
* **The download path.** No download was started. The Nowhere search resolves through the app's own InnerTube path, not through `yt-dlp`, so the downloader is unverified regardless of which `yt-dlp.exe` sits beside the exe.
* **The bundled `yt-dlp.exe` resource.** The release build was made with the same empty stub the CI desktop job uses, so the resource is present and the exe runs, but the real downloader was not exercised.

## Known limits

* **The atomic write covers `settings.json`, not the corrupt copy.** `keep_corrupt_settings` writes `settings.json.corrupt` with a plain `std::fs::write`. A crash inside that copy can leave it partial — but the original damaged `settings.json` is still in place at that moment, so nothing is lost that was not already unreadable.
* **The single-instance guard is per Windows session.** It is a named mutex without the `Global\` prefix, so two users logged in at once each get their own instance. That is the behaviour you want, because they have separate settings files; it is not a claim that two sessions cannot both run MEASURED.
* **A 2.1.0 instance is not caught by the guard.** 2.1.0 has no mutex and no event window, so launching 2.1.1 while 2.1.0 is running opens a second window. The guard covers two 2.1.1 copies.
* **A damaged file is preserved, not recovered.** The bytes are kept for inspection; there is no partial parse of a truncated JSON document, and the app starts from its defaults when the file does not parse.
* **Everything else is 2.1.0's.** Tags, loudness, the RLB high-pass, WMA/APE, Android conversion and the JDK 17 requirement are unchanged and carry the same limits; see [RELEASE-2.1.0.md](RELEASE-2.1.0.md).

## Security

No accounts, no telemetry, no third-party SDKs, no secrets in the source. 2.1.1 changes no network surface, no CSP and no capability grant. It adds no dependency to the tree either: `tauri-plugin-single-instance` arrived with card N, which is already in the source this release is built from, and it adds a named mutex and a hidden message-only window, not a listener.
