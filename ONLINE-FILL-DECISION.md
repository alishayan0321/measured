# MEASURED — online fill: decision record

Status: **rejected as specified** (auto-search + auto-download) · **approved narrowly** (shelf + previews,
human-gated) · owner decision pending.
Companion to `SIGNAL-PLAN.md`. Every claim below is either checked in code (`file:line`) or quoted from a
measurement already recorded in `SIGNAL-PLAN.md`. Estimates are estimates, marked as such.

---

## 0. One-way door vs two-way door

| Option | Door | Verdict |
|---|---|---|
| Shelf on exhaustion ("best of the rest" / "find something new") | two-way | **build** |
| Curated radio from existing fingerprints, fully local | two-way | **build first** |
| 30 s preview + explicit keep | two-way | **build, week 4** |
| Unattended search → fetch → library | **one-way** | **reject** |

The missing 20 % of the requested feature is the liability. The fetch machinery already exists:

- `rust/desktop/src/net.rs:107` `yt_search` — InnerTube web endpoint, no auth
- `rust/desktop/src/net.rs:186` `yt_audio` — shells out to vendored `yt-dlp.exe` (23.5 MB)
- `rust/desktop/src/net.rs:223` `yt_download` — writes into the added-songs folder
- `index.html:2645–2668` — like on a streamed row **already downloads it into the library**

So "the app can find and fetch a song" shipped in 2.0.0. What is being asked for is *automation*: (i) nobody
presses anything, (ii) the ranker picks the query, (iii) no human decides to acquire. (i) and (iii) carry
the entire legal surface. (ii) carries the entire product value. Build (ii). Refuse (i) and (iii).

---

## 1. Why auto-download is rejected

**(a) It destroys the only defence that exists.** Every one of the 148 files was chosen by a human. "I chose
each one" is the sentence that makes a personal tool a personal tool. Auto-fill makes that sentence false:
dozens of tracks arrive that were never chosen, and the owner cannot testify to any of them.

**(b) Anonymity and "publisher of an automated harvester" are incompatible.** A notice goes to the repo
host, which holds the account email and IP; a counter-notice requires a legal name, an address and consent
to jurisdiction. Three years of anonymity costs one notice. Zero budget means no counsel, no entity, no
insurance — solo + anonymous + public MIT repo is the worst exposure-per-dollar configuration available.

Automated access outside a platform's public interface, and download-anything-but-the-download-button, are
both prohibited by the terms that apply. Manual single fetches by the user are a different fact pattern from
a client that harvests on its own. The README currently advertises the automation as a feature, which is the
exhibit a rights-holder would attach. (Not legal advice. The point is that this is the class of decision you
cannot afford to get advice on, so do not create it.)

**(c) It makes the taste model worse.** `lib/recommend-features.js:54–71` standardises every band vector
against `normStats(lib.tracks.map(t => t.bands))`. Adding tracks to `lib.tracks` recomputes mean/sd, so
`fpCos` and `fpCosRecent` — two of the strongest features — shift for **every existing track**, under weights
that were fit on the old coordinates. Same failure class as `SIGNAL-PLAN.md` defect #10 (fitting across a
schema change), except it happens silently and permanently on every fetch.

**(d) Support surface is superlinear.** Already carrying three fragile upstreams: undocumented InnerTube,
monthly-breaking `yt-dlp`, chronically-broken NewPipeExtractor. Each further source adds key handling, rate
limits, attribution rendering, metadata mapping, dedupe against local, and a failure mode to design. That is
not a feature, it is a second product with no revenue.

---

## 2. Approved shape: "never runs dry" = queue guarantee, not library guarantee

| Layer | Source | Form | Downloads | Account / key | Honest risk |
|---|---|---|---|---|---|
| L0 | local 148, ranked | play | — | none | none |
| L1 | Internet Archive / Wikimedia Commons | stream | no | none | taste mismatch |
| L2 | iTunes Search / Deezer 30 s preview | preview + suggest | no | none | terms permit preview, forbid substitute library; no bulk caching |
| L3 | Nowhere (existing) | **human-triggered only** | human | none | already carried, do not amplify |

Rules:

1. **The app never decides to acquire. It decides to offer.** The keep button is the human's acquisition act;
   it may reuse the existing download-on-like path, unchanged.
2. **Preview is the heartbeat.** 30 s, then a heart or "not for me". Heart = keep (existing path),
   "not for me" = an explicit negative label. Both are labels the ranker needs and neither exists today.
3. **Shelf cards carry a human-readable reason**, or they do not render. `same artist · you finished 3 of his` /
   `similar fingerprint · same cluster` / `same era · close energy`. Explainability is the ranker's only
   user-visible value proof.
4. **Curated radio is a JSON file, not an algorithm.** 5–8 hand-authored stations (late night / same artist /
   fingerprint cluster / least-played 20 %). Uses existing `fingerprints.json`. Zero network, zero legal.
5. **Online candidates are scored with frozen local norms and prior weights only.** Never add them to
   `lib.tracks` before normalisation; never score them with learned `w`. Add this as a comment above the
   scoring call so the next change cannot undo it by accident.
6. **Per-source consent, default off.** Settings → Sources. One sheet, once: what leaves the device (search
   text + timestamps), what does not (files, history, fingerprints), one primary button, one "Not now".

---

## 3. Exhaustion rule (machine-checkable)

Implementation prerequisite: `nextIndex()` (`lib/recommend-wire.js:146–180`) computes the whole pool's scores
and throws them away. Expose them —

```js
// lib/recommend-wire.js — reuse the existing loop, do not duplicate scoring
ranked: function (lib) { /* -> [{ i, sL, sH }] for lib.view, excluding nothing */ }
```

Hook point is not a poll; it is where the decision already lives: `index.html:1862` (`audio` `ended`) and the
`step(1)` fallback.

```
eligible := playable file ∧ not in block list (explicit dislike / delete)

ARMED    := events ≥ MIN_OBSERVED(20) ∧ coverage ≥ COV_THRESHOLD(0.60)
          ∧ |eligible| ≥ 20 ∧ lifetime plays ≥ 12

TAIL     := lowest 20% of eligible by sL      // served pool, NOT VIEW
(a) tailRatio    := share of TAIL among the last 8 auto-advances ≥ 6/8
(b) rejectStreak := last 3 plays each skipAt < 0.15 ∨ explicit dislike/delete
cooldown          := 10 plays after a trigger

EXHAUSTED := ARMED ∧ (a) ∧ (b) ∧ ¬cooldown
RESET     := user plays a non-TAIL track → (b)=0, enter cooldown
```

Why both terms: (a) is the model admitting it is scraping the barrel; (b) is the human confirming. (a) alone
false-fires on a small library with a healthy listener. (b) alone false-fires on one bad mood. `sL` not `sH`
because the served arm is the learned one. `VIEW` is excluded as a denominator for the same reason
`SIGNAL-PLAN.md` §4 rejects it for AUC — search silently changes the denominator.

Requires `skipAt`: today `index.html:1657` sends `RANK.end(audio.currentTime || 0, prevDur, 'play')`, i.e. a
*position* labelled `elapsed`, with a constant `kind`. See §4.

---

## 4. P0 label delta (prerequisite, before any of this is meaningful)

From `SIGNAL-PLAN.md` §5, with one correction this review adds.

1. `listenedSec` (wall clock, `!paused && !seeking`) replaces `currentTime` as the label input.
2. `naturalEnd` boolean; "finished" separated from "left at 68 %".
3. Write real `kind` (`end`/`skip`/`like`/`delete`/`replay`) at `index.html:1657`; write `skip`. Revives
   `delta()`, which reads `e.skip` (`lib/recommend.js:344`) — a field that has never existed, so the A/B has
   always reported 0 against 14/40 real skips.
4. **Correction — `SIGNAL-PLAN.md` §0d is necessary but not sufficient.** `index.html:1573` returns
   `!isStream(t)`, so *every local track is liked by default*. Wiring `LIKE_MAP` into the ranker as-is yields a
   148/148 constant — the exact `skipInv` defect (§0f) wearing a different name, and `W0.likeAffinity = 1.00`
   still learns nothing. Likes must become **tri-state**: `unrated` (default) / `liked` (explicit) /
   `disliked` (explicit). `likeAffinity` consumes explicit events only.
5. Log `propensity` + `candCount` per offer.
6. Session break on 30 min idle **and** on hidden/unfocused; restrict `cooccur` to within-session.
7. Exploration floor on arm `h` (`recommend-wire.js:168–169` is bare `argmax`; excluding only the current
   track alternates between the two most recent).

Estimate: ~1–1.5 days. This is a strict prerequisite, not hygiene: without it, "similar to what he liked" has
no "liked" in it.

---

## 5. Order and cuts

| # | Item | Est. | Gate to proceed |
|---|---|---|---|
| 1 | P0 label delta (§4) | 1–1.5 d | tests green, `skip`/`listenedSec` present in a real log |
| 2 | `RANK.ranked()` + exhaustion rule (§3) + tail-offer shelf, no network | 1.5–2 d | fires on a simulated exhausted log; silent on a healthy one |
| 3 | Curated radio JSON (5–8 stations from existing fingerprints) | 1 d | plays offline, zero network requests |
| 4 | Shelf + 30 s preview + consent + disk budget + undo + provenance | 3–5 d | S5 (zero egress when off) and K6 hold |
| 5 | Transcode prefetch | 1–2 d | after 4; only exotic containers benefit |
| 6 | desktop/APK parity | — | **a gate, not a task**: no feature ships to one shell only |
| 7 | docs | — | **an acceptance item per feature**: the README privacy section is a legal artifact |

Cut permanently: auto-download, library auto-fill, "grow to 300 tracks", third+ source, anything needing a
client secret or an app registration, rung 3+ of the model ladder this quarter.

---

## 6. Success / kill (2 weeks = items 1–3; 4 weeks = + item 4)

Success — all must hold:

| # | Metric | Bar | Instrument |
|---|---|---|---|
| S1 | continuity | ≥ 60 % of exhaustion events start a play from the shelf within 60 s | local jsonl, user-visible |
| S2 | taste quality | ≥ 40 % of shelf-started streams reach `skipAt ≥ 0.7` or are kept; < 30 % = worse than silence | local jsonl |
| S3 | no regression | local auto-advance skip rate +≤ 5 pt vs prior 2 weeks; 0 overwritten/duplicated local files | A/B log, file count |
| S4 | latency | local shelf ≤ 400 ms; network p95 ≤ 2.5 s; offline falls back ≤ 100 ms | manual + one proxy log |
| S5 | legal hygiene | zero outbound connections with sources off | proxy log, offline run |

Kill — any one:

| # | Trigger | Action |
|---|---|---|
| K1 | P0 not writing correct `kind`/`skip`/`listenedSec` within 5 working days | kill the feature entirely |
| K2 | shelf start rate < 20 % over 10 real exhaustion events | premise false → drop the network layers, keep the local tail-offer |
| K3 | ≥ 2 of 4 sources break within 30 days | collapse to exactly one source |
| K4 | any source needs its key inside the repo | that source is out; anonymity beats capability |
| K5 | any rights-holder contact or repo takedown | remove the network layer immediately, keep local |
| K6 | disk over budget, or orphan files after removal | kill the download path, keep the stream path |

Final gate: **if shipping the feature requires the automation to live in the public repo, it fails the
anonymity test and does not ship.**

---

## 7. Non-goals (write these down or they will be re-proposed)

- Never "top up" the library automatically. The library is what the human chose; that is the product.
- Never put online candidates through the library's normalisation path (§1c).
- Never score an unseen track with learned weights; prior + frozen norms only.
- Never show a reasonless recommendation.
- Never degrade a dead source into "no more songs".
- Never delete by folder heuristic; delete by provenance field.
