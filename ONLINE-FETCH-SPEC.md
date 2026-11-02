# MEASURED — online fetch: implementation spec (playback-first)

Status: implementation spec, v0 = streaming only. Companion to `ONLINE-FILL-DECISION.md`
(which rejected auto-acquisition and approved shelf + 30s preview + human keep) and `SIGNAL-PLAN.md`.
Every claim below is checked in code (`file:line`) or is flagged as an estimate.

---

## 0. Premise check before design

| Stated premise | What the repo actually does | Consequence for this spec |
|---|---|---|
| "shares one Rust core `.so`" | `measured-core` is `crate-type=["rlib","cdylib"]` (`rust/core/Cargo.toml:21`) but the shipped APK has **0 `lib/` entries** (310 entries, 148 song assets). No `jni` crate, no `#[no_mangle]` entry points, no NDK step in `android/build.cjs`. Android is Java: `Transcode.java` (MediaCodec), `Yt.java` (NewPipeExtractor). | Android cannot receive Rust net code without a new toolchain path. Treat Android as a **second implementation of the same contract**, not as a consumer of the core. |
| "`net.rs` hosts only a YouTube iframe, no downloads" | `net.rs:1-6` says so, but `net.rs:186 yt_audio` extracts a stream URL with `yt-dlp -g` and `net.rs:223 yt_download` writes files into `app_data/songs`. | The doc comment is stale; the privacy story must be corrected before it is used as a legal artifact (decision doc §5 item 7). |
| "asset protocol Range-capable, no HTTP server" | true (`tauri.conf.json:26-30`, `protocol-asset` feature at `Cargo.toml:13`) | Reuse it for complete cache objects; do not add a proxy. |
| "prepare(track) decodes exotic containers to cached WAV" | `main.rs:219-239`, output `app_cache_dir/transcode/<key>.wav`, key from `core::scan::key_for` | Remote objects reuse the same decoder, in a separate namespaced key space. |
| queue model | streamed YouTube tracks already exist as `isStream(t) = !t.file && !!t.id` (`index.html:1563`), played by assigning the remote URL to the element (`index.html:2517`) | **A remote track is not a new species.** It is the existing stream shape with a `kind` discriminator and a stable id. |

### Three decisions

**D1 — Playback is the browser's job; native code only stores bytes.**
The renderer assigns `audio.src` for remote tracks, exactly as the YouTube path already does
(`index.html:2510-2520`). Native (`remote_*` on desktop, `Remote.java` on Android) never proxies audio,
never registers a scheme, and never streams a body back to the page. Its only verbs are "store this URL's
bytes" and "give me the path of a stored object".

**D2 — The cache is never a precondition for playback.**
Resolution order, both shells: complete cache object → local URL; otherwise → the remote `https://` URL.
A `.part` is never played. This is what keeps S4 (network start p95 ≤ 2.5 s) reachable: a 60 MB Internet
Archive FLAC cannot be downloaded before it plays.

**D3 — Consent and source policy are enforced below the page.**
S5 ("zero outbound connections with sources off") must survive a page bug. `remote_fetch` checks
`remote.sources.enabled` / `remote.offline` before it opens a socket; a JS-only gate is not a gate.

Corollary for the IPC question in the brief: **"JS-side fetch" is not a viable option** — arbitrary hosts do
not send `Access-Control-Allow-Origin`, so the page cannot read the bytes; and the page has no write path.
The real choice is (a) page `fetch` + native `write(path, bytes)` — rejected, it hands the renderer a byte
stream and a filesystem verb; (b) native fetch to a cache path — chosen for caching; (c) browser media load —
chosen for playback. (a) is dead on security and on CORS.

---

## 1. Where remote tracks enter the queue, and the IPC contract

### 1.1 Entry point

```
shelf card tap  →  tracks.push({kind:'remote', id, url, source, ext, title, artist,
                                dur, thumb, attribution})          // index.html, shelf handler
               →  playRemote(t)
                    const e = await api.remote.status(t.url, t.id)   // cache-only, no network
                    audio.src = e ? api.remote.playable(e) : t.url
```

Rules (from `ONLINE-FILL-DECISION.md`, do not re-litigate):

- remote items live in a **separate list** (`SHELF_QUEUE`), never in `LIB.tracks` — otherwise every band
  vector re-normalises and the frozen-norm rule (§2.5 of the decision doc) is violated silently;
- remote items are never written to `library.json`, `songs/`, or `LIKE_MAP` under a local key;
- play logging is extended at `index.html:~1657` (`RANK.end(..., 'play')`) with `kind:'remote'` so remote
  plays never enter the local delta/AUC pipeline;
- `likeIdOf()` (`index.html:1572`) must namespace remote ids (`remote:<source>:<id>`) so a YouTube id and an
  archive.org id can never collide;
- `isStream()` gains a sibling rather than changing meaning: `isRemote(t) = t.kind === 'remote'`.

### 1.2 Desktop commands — new `rust/desktop/src/remote.rs`, registered at `main.rs:436-453`

```rust
#[derive(Serialize, Clone)]
pub struct CacheEntry {
    pub key: String,        // 32 hex chars
    pub path: String,       // absolute, canonicalised
    pub ext: String,        // lower, no dot
    pub bytes: u64,
    pub sha256: String,
    pub tier: String,       // "preview" | "stream"
    pub expires_at: u64,    // unix secs; 0 = no TTL (stream tier)
    pub source: String,     // "archive" | "wikimedia" | "itunes" | "deezer" | "user"
    pub attribution: String,// rendered by the UI; empty only for tier=user
}

#[derive(Serialize)]
pub struct RemoteError { pub code: &'static str, pub message: String }  // Serialize → page sees {code,message}

#[tauri::command] pub async fn remote_fetch(app: AppHandle, url: String, id: Option<String>,
                                            tier: Option<String>) -> Result<CacheEntry, RemoteError>;
#[tauri::command] pub fn remote_status(app: AppHandle, url: String, id: Option<String>) -> Option<CacheEntry>;
#[tauri::command] pub fn remote_cancel(key: String) -> bool;
#[tauri::command] pub fn remote_remove(app: AppHandle, key: String) -> bool;
#[tauri::command] pub fn remote_stats(app: AppHandle) -> RemoteStats; // {bytes,count,quota_bytes,by_source}
```

Event: `remote:progress` → `{key, received, total}`, throttled to ~10 Hz (UI only; no functional role).

Not in the contract, deliberately: HEAD probe, generic `download(url, path)`, headers/cookies/auth,
HLS/DASH, multi-part, torrents, "download into the library" (that is `yt_download`'s job and stays human-gated).

### 1.3 Key derivation — must be byte-identical in Rust and Java

```
canonical = id != null ? "id:" + id.trim().to_lowercase()
                       : "u:" + lower(scheme) + "://" + lower(host)
                                + (port if non-default) + path + "?" + query      // no fragment, no userinfo
key       = hex(sha256(canonical))[0..32]
```

`id` must match `^[A-Za-z0-9_.:-]{1,128}$`. Query is kept verbatim: signed URLs must not collide when `id`
is absent, and a stable `id` is what prevents signed-URL rotation from busting the cache.
Conformance vectors: `rust/desktop/tests/remote_vectors.json` (Rust test) + the same file asserted by a tiny
`main()` in `android/test/KeyVectors.java`. One file, two readers — drift becomes a failing test, not a bug.

### 1.4 Android bridge (mirror, same semantics)

```java
@JavascriptInterface public void    remoteFetch(String url, String id, String tier, String token) // → PlayerAPI.remoteDone(token, ok, json)
@JavascriptInterface public String  remoteStatus(String url, String id)   // sync, cache-only, "" when absent
@JavascriptInterface public boolean remoteRemove(String key)
@JavascriptInterface public boolean remoteCancel(String key)
@JavascriptInterface public String  remoteStats()                          // JSON
```

Progress: `web.evaluateJavascript("(window.PlayerAPI&&PlayerAPI.remoteProgress)?PlayerAPI.remoteProgress(" + key + "," + got + "," + total + "):0", null)`
— same pattern as `ytDone` (`Yt.java:242-246`).

### 1.5 JS seam — `api.js` (`measured/android/assets/player/api.js`, and the desktop copy)

```js
api.remote = {
  async fetch(url, id, tier)  // → CacheEntry | throws {code,message}
  async status(url, id)       // → CacheEntry | null      (never network, target ≤ 100 ms)
  async playable(entry)       // desktop: assetUrl(entry.path); android: 'file://' + entry.path
  async remove(key), cancel(key), stats()
};
```

Platform branch mirrors the existing style (`api.js:10-19, 144-170`): `tauri` → `invoke`, `android` →
token call, `web`/`electron` → feature-disabled (returns null, shelf still plays by direct URL).

### 1.6 Validation on the privileged side (the actual security boundary)

| Check | Desktop | Android |
|---|---|---|
| https only (`http` behind `remote.allow_cleartext`, default false) | parsed URL | `URL.getProtocol()` |
| resolved IP not loopback/private/link-local/any | `to_socket_addrs` + reject list | `isLoopbackAddress/isSiteLocalAddress/isLinkLocalAddress/isAnyLocalAddress` |
| pin socket to the validated IP (anti-rebinding) | `ClientBuilder::resolve(host, ip)` | **not possible** — documented residual gap |
| redirects: ≤ 2 hops, same host, https | `redirect::Policy::custom` | `setInstanceFollowRedirects(false)` + manual loop |
| size cap (`remote.max_bytes`, default 200 MiB) | Content-Length + running counter | same |
| content-type ∈ {audio/*, application/ogg, video/webm, video/mp4, application/octet-stream} | header | header |
| no cookies, no auth headers, fixed UA | client built without them | same |
| extension ← content-type map → path ext → reject | shared map | shared map |
| consent / offline gate | `remote.sources.enabled`, `remote.offline` | same prefs keys |

---

## 2. Playback: remote and partially cached, on both shells

| Case | Windows (Tauri/WebView2) | Android (WebView) | Notes |
|---|---|---|---|
| complete cache object, native ext | `convertFileSrc(path)` → `http://asset.localhost/…` (Range-capable), same mechanism as `library()` (`main.rs:154`) | `file://` + absolute path, same as added songs (`MainActivity` library `url`) | start ≤ 100 ms offline |
| complete cache object, convertible ext (aiff/caf/alac/mka) | `core::decode_to_wav` → `app_cache_dir/transcode/remote-<key>.wav`, then asset URL | `Transcode` → wav in `getCacheDir()`, then `file://` | reuses `prepare()` machinery |
| `.part` present, object incomplete | **ignored for playback**; play the remote URL; background fetch may resume | same | avoids container/truncation roulette |
| no cache | `audio.src = https://…` — Range handled by the server | same | this is exactly `index.html:2517` today |
| direct remote URL + WebAudio analyser | `crossOrigin='anonymous'` only when the source registry marks `cors:true`; otherwise `tapStop()` (current YouTube behaviour, `index.html:2487`) | same flag; `file://` origin is opaque so cached `file://` media is also tainted — EQ degrades exactly as YouTube does | per-source `cors` capability, not a global guess |
| custom scheme / local HTTP proxy | rejected: no Tauri twin on Android → parity break, and it reintroduces the server the app deliberately lacks | n/a | |

Playback order implementation sketch (page):

```js
async function playRemote(t) {
  const e = await PlayerAPI.remote.status(t.url, t.id);
  const src = e ? PlayerAPI.remote.playable(e) : t.url;
  audio.crossOrigin = (!e && t.cors) ? 'anonymous' : null;   // cached local files never need it
  audio.src = src; audio.load();
  if (e) tapPlay(); else tapStop();                         // honest: no EQ while streaming cross-origin
  audio.play().catch(() => {});
}
```

---

## 3. Cache spec

### 3.1 Layout (same relative tree on both shells)

```
<root>/remote/                     desktop: app_data_dir()/remote      android: getFilesDir()/remote
  index.json                       rows: key,url,id,ext,bytes,sha256,etag,tier,source,attribution,
                                         fetched_at,last_used,expires_at,pinned
  objects/<key>.<ext>              complete, immutable, atomic-renamed
  part/<key>.<ext>.part            in-flight only
  part/<key>.<ext>.part.json       {url,etag,total,started_at} for a single resume attempt
```

Desktop root = `%APPDATA%\com.measured.player\remote`; Android root = `/data/user/0/com.measured.player/files/remote`.
Why `app_data` and not `app_cache`: Android may purge `getCacheDir()` mid-session, and a queued preview
vanishing is a bug, not a cache miss. Eviction must be ours (decision doc K6).

`transcode` stays at `app_cache_dir/transcode` (`main.rs:118-126`); remote WAVs are prefixed `remote-` and are
deleted by the same eviction hook that deletes the object.

### 3.2 Write protocol (atomic on NTFS and ext4)

1. `remote_status` hit (exists && `len == index.bytes`) → return cached, no socket.
2. Open `part/<key>.<ext>.part` (`create_new`), or resume when `.part.json` matches `etag` + `total` and the
   server honours `Range` — exactly one resume attempt per fetch.
3. Stream with `reqwest::Response::chunk()` (available without the `stream` feature —
   `reqwest-0.12.28/src/async_impl/response.rs:315`; current `Cargo.toml:18` needs no change) → write →
   progress every 1 MiB → abort when the running counter exceeds `max_bytes`.
4. EOF: `sync_all()` (desktop) / `FileDescriptor.sync()` (Android); compare against Content-Length; hash.
5. `rename(part → objects/<key>.<ext>)` inside the same root: readers never observe a half file.
6. Rewrite `index.json` via `index.json.tmp` + rename. Crash between 5 and 6 leaves an orphan object: the
   startup reconciler adopts it (size + hash) or deletes it after 24 h.
7. Delete `.part.json` last.

### 3.3 Tiers

| Tier | Sources | TTL | Quota default | Shown in library? | Play next time |
|---|---|---|---|---|---|
| `preview` | iTunes / Deezer 30 s clips | 1 h | 64 MiB | **never** | only while unexpired |
| `stream` | archive.org / Wikimedia (freely licensed) | none, LRU | 2 GiB desktop / 512 MiB Android | never (queue only) | yes |

The preview tier exists because the decision doc records that preview terms permit preview but forbid a
substitute library; a TTL-bounded, library-invisible object is the engineering expression of that sentence.
`stream` tier ships disabled (`remote.tier.stream.enabled=false`) until the L1 source lands.

### 3.4 Integrity

- Every `remote_status`: existence + `len == bytes`; mismatch → delete row + object, return null (page falls
  back to direct streaming, no user-visible error).
- Full `sha256` on: adoption of an orphan, and `stream` tier at write time. Previews (≤ 4 MiB) are hashed too —
  cheap, and it makes "same URL, different bytes" detectable.
- `etag`/`last_modified` stored for the single resume attempt and for future revalidation.
- Extension is authoritative for the decoder; derive it from content-type, never from the URL alone.

### 3.5 Eviction

- Two quotas, enforced after every successful write and at startup: `preview.quota` (64 MiB) and
  `stream.quota` (`2 GiB` / `512 MiB`).
- Order: expired previews first → oldest `last_used` (LRU) → nothing. `pinned` (currently playing) is skipped;
  the page must call `remote_pin(key)`/`remote_unpin(key)` in v0.1 — v0 skips keys with `last_used` < 60 s.
- `.part` older than 24 h at startup is deleted; a `.part` belonging to a live in-memory job is never touched.
- `remote_remove` deletes by **provenance field** (`index.key`), not by scanning the directory — the decision
  doc's non-goal "never delete by folder heuristic" applies to the cache too.
- `remote_stats.by_source` feeds the settings sheet so the user can see what is being spent per source.

### 3.6 Interaction with `prepare()`

| Case | Behaviour |
|---|---|
| remote + native ext | never calls `prepare`; `audio.src` is the object path |
| remote + convertible ext | desktop `core::decode_to_wav(cached, app_cache_dir/transcode/remote-<key>.wav)`; Android `Transcode` |
| eviction | deletes `objects/<key>.*` **and** `transcode/remote-<key>.wav` in one step |
| key space | `prepare()` keys come from `scan::key_for(file)`; remote keys are `remote-` + 32 hex — no collision |
| orphan WAVs | startup sweep removes `transcode/remote-*.wav` with no matching index row |

---

## 4. Desktop vs APK: what must stay identical

| Concern | Windows Tauri | Android APK | Identical? |
|---|---|---|---|
| playback mechanism (remote) | `audio.src = https://…` | same | **yes** |
| playback mechanism (cached) | asset protocol | `file://` | no — abstracted by `remote.playable()` |
| fetch code | Rust `remote.rs` (reqwest/rustls) | Java `Remote.java` (HttpURLConnection) | contract only |
| TLS roots | webpki-roots in the binary | Android system store (user CAs work) | no — document |
| cache root | `%APPDATA%\com.measured.player\remote` | `/data/…/files/remote` | layout yes, root no |
| index schema + key algorithm | same JSON, same SHA-256 prefix | same | **yes** |
| permissions | none | **none new**: `INTERNET` + `ACCESS_NETWORK_STATE` already declared (`AndroidManifest.xml:9-10`) | yes |
| storage permission | n/a | app-private dir → **no** `WRITE_EXTERNAL_STORAGE`, no SAF, no `MANAGE_EXTERNAL_STORAGE` | — |
| background downloads | process alive while downloading | FGS would need `dataSync` type + new permission + Android 15 6 h cap → **foreground only on both** | **yes** |
| metered network | setting `remote.metered` (default: previews yes, stream tier no) | `ConnectivityManager.isActiveNetworkMetered` gates automatic fetches; a manual tap is always allowed | behaviour same, detection platform-specific |
| offline behaviour | direct URL fails → keep queue, show "offline" | same | yes |
| progress payload | `{key,received,total}` | same | **yes** |
| error codes | one literal set | same | **yes** |
| free space | `free_space()` is a stub returning `(0,0)` (`main.rs:273-278`) | `StatFs` available (`MainActivity.java:259`) | no — v0 relies on ENOSPC |

Release / signing implications:

- **Android**: no manifest permission change; bump `versionCode`/`versionName` in **two places**
  (`AndroidManifest.xml:4-5` and the literals at `build.cjs:136-137`) or they drift. Keystore and the
  `apksigner` step (`build.cjs:190-207`) are unchanged. APK grows by dex only (~10–20 KB); no new jars in
  `android/libs` (`build.cjs:42-45`), so `d8` input set is unchanged (`build.cjs:177-183`).
- **Desktop**: zero new crates (`chunk()` is feature-free), so binary size is unchanged within noise; bundle
  targets (`nsis`, `msi`) unchanged. Installers remain unsigned — pre-existing, not caused by this feature.
- Neither shell ships cache content: `assets/songs` is build-time only.

---

## 5. Failure modes

| Failure | Detection | Behaviour | Left behind |
|---|---|---|---|
| offline / DNS failure | reqwest connect error; `UnknownHostException` | `remote.offline`; remote item stays in queue marked unavailable; local playback unaffected | nothing |
| 403 / 401 | status | `remote.http_403`; page may re-resolve a fresh signed URL **once** (same as the YouTube retry at `index.html:2510-2515`); no internal retry loop | nothing |
| 404 / 410 | status | `remote.http_404`; item marked dead, offer remove | nothing |
| 5xx | status | one retry after 2 s, then `remote.http_5xx` | nothing |
| expired signed URL | 403 on a host with `expire=` in query, or `expire` < now | treated as 403; page re-resolves | existing complete object untouched |
| truncated body | bytes < Content-Length at EOF | delete `.part`, `remote.interrupted`, retry from zero once | nothing |
| app killed mid-fetch | `.part` at startup | resume once if `etag`+`total` match and Range is honoured; else delete; reload | `.part` + `.part.json`, GC after 24 h |
| disk full | `ENOSPC` / `IOException` ENOSPC | delete `.part`, `remote.disk_full`, offer "clear cache"; **queue must not stall** — the item still plays by direct URL | `.part` removed |
| quota exceeded | running sum > quota | evict before starting, re-check after; `remote.quota` if still over | nothing |
| server returns HTML/JSON (consent wall, error page) | content-type not audio | `remote.bad_content`, first 200 bytes of body in `message` (truncated, no PII) | nothing |
| bad URL / bad id | validation | `remote.bad_url` before any DNS | nothing |
| concurrent fetch of the same key | in-memory job set | second caller gets `remote.busy` (v0) | — |
| orphan object (crash between rename and index write) | startup reconcile | adopt if size+hash match, else delete | adopted object |
| cache file deleted behind the app | `remote_status` miss at play time | falls back to direct URL, no user-visible error | cache row cleaned |
| consent off / offline mode | settings check before socket | `remote.consent_off`; **no DNS, no TCP** (S5) | nothing |

Shared error-code literals: `remote.bad_url`, `remote.consent_off`, `remote.offline`, `remote.http_403`,
`remote.http_404`, `remote.http_5xx`, `remote.too_large`, `remote.bad_content`, `remote.disk_full`,
`remote.quota`, `remote.cancelled`, `remote.interrupted`, `remote.busy`, `remote.io`.

---

## 6. Smallest shippable slice, and the test plan

### 6.1 Slice v0 — playback only, **zero native code**

Scope: shelf card → 30 s preview → play (direct URL) → heart/skip. No cache, no Rust, no Java.

Files: `index.html` (source registry + shelf queue + `playRemote` + remote-aware `RANK.end` prefix ≈ 120 lines),
`api.js` (`remote.status` returns `null`, `remote.playable` identity ≈ 8 lines).

Why this is the right first slice: it answers "can a remote track enter the queue and play on both shells"
without touching the `.so`, `build.cjs`, or the signing chain. If it ships and holds S1/S2/S4, the cache
earns its complexity budget. If it does not, the cache would have been wasted work (decision doc kill K2/K3).

### 6.2 Slice v0.1 — preview cache

Adds `rust/desktop/src/remote.rs` (≈ 320 lines) + `Remote.java` (≈ 260 lines) + `api.remote.fetch/status/
remove/stats` (≈ 70 lines) + the storage sheet row. `stream` tier stays disabled.

### 6.3 Test plan

Rust, no network (the cache/validation layer is pure logic and must be tested without sockets):

```
$env:CARGO_HOME = '<repo>\rust\cargo-home'
$env:RUSTUP_HOME = '<repo>\rust\rustup-home'
cargo test --manifest-path rust/desktop/Cargo.toml --lib
```

- key vectors (id vs url, default-port drop, fragment drop, case folding) — same JSON the Java main() reads;
- validation table: http rejected, `127.0.0.1` / `10.0.0.1` / `169.254.169.254` / `[::1]` rejected, bad `id`
  charset rejected, `content-type: text/html` rejected, oversize `Content-Length` rejected;
- `select_evictions(entries, quota, now)` table-driven (expired first, LRU order, pinned skipped);
- resume decision function (`etag` match / mismatch / no `Accept-Ranges`);
- one hermetic test: `std::net::TcpListener` on 127.0.0.1 serving a 64 KiB body, a 403, and an early close,
  with a test-only `allow_loopback` flag so the private-IP guard does not block the fixture.

Desktop build:

```
cargo build  --manifest-path rust/desktop/Cargo.toml
cargo build --release --manifest-path rust/desktop/Cargo.toml   # what ships
```

APK build (unchanged pipeline; run fast first because it isolates aapt2/javac/d8 from asset staging):

```
node android/build.cjs --fast    # toolchain smoke test, no songs
node android/build.cjs           # full build, then: adb install -r android/out/MEASURED.apk
```

`apksigner verify --verbose` already runs inside `build.cjs:207`; `adb shell dumpsys package
com.measured.player | findstr versionCode` confirms the bump.

Manual matrix (the part CI cannot cover):

| # | Scenario | Windows | Android | Pass criterion |
|---|---|---|---|---|
| 1 | tap shelf card, audio starts | | | p95 ≤ 2.5 s on a normal connection |
| 2 | seek ±30 s on a remote stream | | | no hard failure (204/200 range, browser-driven) |
| 3 | airplane mode, tap card | | | ≤ 100 ms "offline", local library still plays |
| 4 | source toggle off, tap card | | | **zero** outbound connections (proxy/mitm log, S5) |
| 5 | preview ends | | | card closes / next card, `ended` fires |
| 6 | switch card mid-load (race) | | | old `audio` never resumes; `gen` guard holds |
| 7 | cached object (v0.1) then airplane mode | | | plays from cache, start ≤ 100 ms |
| 8 | cache quarantined: truncate an object to 1 KB | | | `remote_status` null, falls back to direct |
| 9 | kill app during fetch (Task Manager / `am force-stop`) | | | no half object in index; `.part` GC'd by TTL |
| 10 | quota=1 MiB, fetch 5 MiB | | | oldest evicted first; no orphan files after |
| 11 | delete cache dir behind the app | | | re-creates, no crash |
| 12 | EQ/analyser on a cached track | | | documented outcome: analyser active on desktop if `cors:true`, tainted → `tapStop` otherwise; **no silent regression** |
| 13 | `versionCode` after upgrade install | | | increments; cache survives upgrade (same files dir) |

Decision-doc gates that this feature must not break: S4 (start latency), S5 (zero egress when off), K6 (no
disk over budget, no orphans after removal).

---

## 7. Flags — what would break the current build stories

1. **Do not put this in `measured-core`.** The APK contains no `.so` today (0 `lib/` entries). Putting the
   fetcher in the core implies: NDK r26, 3–4 ABIs (arm64-v8a / armeabi-v7a / x86_64), ~8–12 MB per ABI,
   `System.loadLibrary`, JNI glue, and a new `lib/<abi>/` copy step before `zipalign` — because `aapt2 link
   -A` places assets, not native libraries (`build.cjs:127-141`). That is a release-risk project, not a line
   item. Keep Rust on desktop, Java on Android, share the contract + key vectors.
2. **No new Rust crates needed.** `Response::chunk()` is not feature-gated
   (`reqwest-0.12.28/src/async_impl/response.rs:315`), so `Cargo.toml:18` stays as-is. `std::fs` writes at
   64 KiB granularity inside the async command are fine; add `tokio` only if profiling says otherwise.
3. **No androidx / WorkManager / OkHttp / Conscrypt.** The Gradle-free build compiles against `android.jar`
   plus `android/libs/*.jar` (`build.cjs:42-45`) and dexes with `d8` (`build.cjs:177-183`). WorkManager is an
   AAR with manifest merging — `aapt2 link` here does not do that, so the build breaks. A `dataSync` foreground
   service adds a permission and an Android 15 time limit for no user-visible gain.
4. **Cache must stay app-private.** `getFilesDir()` needs no permission; external storage or `Downloads`
   requires SAF or `MANAGE_EXTERNAL_STORAGE` — a policy fight for zero benefit.
5. **`assetProtocol.scope: ["**"]`** (`tauri.conf.json:28`) means the renderer can read any file the user can.
   With remote objects entering the app, narrow the scope to the roots actually used (`$APPDATA/**`, bundled
   `songs/**`, dev root) before shipping; the `remote/` root must be inside it for `convertFileSrc`.
6. **`csp: null`** (`tauri.conf.json:25`): once a URL field exists, add a CSP with
   `default-src 'self'; img-src 'self' https: http://asset.localhost asset:; media-src 'self' https: asset:
   http://asset.localhost; connect-src 'none'`. `connect-src 'none'` is the structural version of D1 — if the
   page cannot fetch, it cannot leak.
7. **Stale privacy claim.** `net.rs:1-6` says nothing is extracted or downloaded, while `net.rs:186/223` do
   exactly that. The decision doc treats the README privacy section as a legal artifact (§5 item 7); fix this
   comment before any online feature makes the claim look deliberate.
8. **`versionCode` is hardcoded twice** (`AndroidManifest.xml:4`, `build.cjs:136`) and `versionName` twice more
   (manifest:5, `build.cjs:137`). One bump script, or they drift on the first release after this feature.
9. **Keystore and password are in the repo** (`android/measured.keystore`, `build.cjs:195-196`). Pre-existing,
   but any APK that can now reach the network inherits it: anyone with the repo can sign a lookalike. Fine for
   sideload; fatal the day distribution widens.
10. **Desktop `free_space()` is a stub** (`main.rs:273-278`). v0 handles `ENOSPC` correctly, but the storage
    sheet will report 0 free while the cache fills. Either implement `GetDiskFreeSpaceExW` under
    `#[cfg(windows)]` (the `windows` crate is already in Tauri's tree) or hide the meter for the remote row.
11. **`yt-dlp` leaves `.part` files on interrupt** (default behaviour; `yt_download` at `net.rs:223` does not
    pass `--no-part`). Under K6 that is an orphan source. Add `--no-part` or a startup sweep of `*.part` in
    `app_data/songs`.
12. **No updater exists** on either shell (no `tauri-plugin-updater`; APK is sideloaded). Adding network
    features will make users expect updates; decide the story before v2, not after.

---

## 8. Open questions (owner decisions, not engineering)

1. Which L1 source ships first — archive.org (big catalogue, mixed quality) or Wikimedia Commons (small, clean
   licensing)? The cache tier's quota default depends on the answer.
2. Preview source: iTunes (no key, best metadata) or Deezer (no key, better preview quality)? Decision doc
   allows both; v0 needs one.
3. Does a preview play count toward the local play log at all (S2 measures `skipAt` on shelf-started streams)?
   If yes, it must be tagged `kind:'remote'` and excluded from local deltas — the log schema change is small
   but it touches `RANK.end`.
4. Is "keep" allowed to reuse `yt_download` for non-YouTube sources? Today it shells to yt-dlp, which is not a
   general downloader for arbitrary URLs.
