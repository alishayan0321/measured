# MEASURED — signal plan (n = 1 listener)

Scope: what to capture, what it maps to, how to train without ground truth, when to grow the model,
and how to evaluate without lying to yourself. Everything below was checked against the shipped code in
`lib/recommend.js`, `lib/recommend-wire.js`, `lib/recommend-features.js`, `index.html` and measured with
`_pw_tmp/probe-signals.cjs`. Claimed numbers are measured, not estimated.

Baseline first: the suite is green (`recommend.test.cjs` 42 passed, `wire.test.cjs` 7 passed). Everything
below is a **design** defect that the tests do not and cannot catch — they assert the code does what it
says it does, and it does. The problem is that what it says is not what the model needs.

---

## 0. Five things that are wrong before any modeling question

You asked me to design the training pipeline. The pipeline's inlet is broken, so designing on top of it
would be designing on sand. Measured, in order of severity:

**(a) The A/B estimator is structurally dead.**
`R.delta(events)` reads `e.skip`. The event the wire writes is
`{file, artist, at, elapsed, dur, kind, arm, session}` — **there is no `skip` field**, ever.

```
event fields      file, artist, at, elapsed, dur, kind, arm, session
has .skip field   false
R.delta(events)   mean_h 0  mean_l 0  delta 0
actual skips in log 14/40  → delta() reports ZERO regardless
```

Fourteen real skips in the log, delta = 0. Every `sufficiency`/`bootstrap`/`cr2` result is therefore
"insufficient evidence, effect 0" forever. **The 20 % heuristic A/B has never produced a number.**

**(b) The middle of the distribution — where rankers actually learn — is thrown away.**
`labelFromCompletion` keeps only `>0.5` and `<0.2`, and drops `elapsed < 10` outright:

```
end(3,220,"skip")   -  1.4% listened   label null                  SGD steps 1   (observe(0) fallback)
end(3,220,"play")   -  1.4% listened   label null                  SGD steps 0
end(66,220,"play")  - 30%   listened   label null                  SGD steps 0
end(150,220,"play") - 68%   listened   label {"y":1,"weight":1}     SGD steps 1
end(215,220,"play") - 98%   listened   label {"y":1,"weight":1}     SGD steps 1
```

A 30 % abandonment trains **nothing**. A 3-second bail trains nothing (when sent as `play`, which is
always: `index.html:1657` sends `'play'`, never `'skip'`). And `68 %` gets `y=1` whether the track
*ended* or he pressed next — there is no `naturalEnd` flag, so abandonment at 68 % is taught as a
success. On a plausible outcome mix that discards **25.5 % of outcomes** (13.6 % of listening time).

**(c) Seek corrupts the label in both directions.**
The label reads `audio.currentTime`, which is a *position*, not attention:

```
listened 0→190s then seeked back to 10s  → completion 0.05  label {"y":0,"weight":1}
seeks to 195s, listens 15s, then next    → completion 0.93  label {"y":1,"weight":1}
```

The second case is the worst failure in the system: **a skip that scrubs to the end is recorded as a
perfect listen with full weight.** Any listener who drags to the end to get to the next song is training
the model to love the tracks he is escaping from. `index.html:1862` already carries a
`seekHold < 500` guard — the bug was seen, but the label path was never fixed.

**(d) The strongest prior in the model has no wire.**
`W0.likeAffinity = 1.00` — the largest weight in the model. `likeAffinity` is built from
`stats().per[file].liked`, which is populated **only** from event-log entries with `kind: 'like'`.
`index.html` never sends `kind: 'like'`. Likes live in a separate `LIKE_MAP` (`localStorage['likes']`,
`setLiked`/`isLiked` at `index.html:1570–1576`) that the ranker cannot see.

```
likeAffinity  cold 0/148   warm 0/148
```

So the highest-weighted feature is permanently 0, and an explicit human like — the least noisy label a
single user can produce — is unreachable. This is the cheapest win in the codebase.

**(e) The control arm starves itself, which will fake a win for the learned arm.**
Arm `h` is a deterministic `argmax` with no exploration floor. `recency` has `w0 = +0.50` and rewards
"played recently"; `nextIndex` excludes only the *current* track. So the argmax alternates between the
two most-recent tracks. Closed loop, same synthetic listener, 120 plays:

```
arm h: distinct  23/148   top track 16% of plays   skip rate 76.7%
       first 10 picks  Daddy Mu Katy Per Daddy Mu Katy Per Daddy Mu Aashir W Doja Cat …
arm l: distinct  56/148   top track  7% of plays   skip rate 40.0%
       first 10 picks  Ransom [ FloyyMen 24 July  Bazzi -  Anne-Mar Low Fade Doja Cat …
```

The exposure collapse (23 vs 56 distinct, visible 2-cycle) is **arithmetic of the policy**, not an
assumption. The 37-point skip gap is partly the repeat-fatigue penalty I put in the simulated listener,
so read it as *direction, not size*. Consequence: the moment you fix (a), `delta()` will announce a huge
"learned beats heuristic" effect that is mostly the control arm being starved into a 2-cycle.

**(f) Three of the seventeen "features" are one feature in disguise.**
`recommend-features.js:158–160`:

```js
if (rec.plays > 0) out.skipInv = 1 - clamp(rec.skips / rec.plays, 0, 1);
out.playCount = clamp(rec.plays / 10, 0, 1);
out.novelty   = 1 - clamp(rec.plays / 5, 0, 1);
```

`rec.skips` is incremented only on `e.kind === 'skip'` (`:93`), which production never sends — so
**`skipInv` is exactly `1.0` for every played track and absent otherwise**: a binary "has been played",
not a skip proneness. And for `plays ≤ 5`, `novelty = 1 − 2·playCount` **exactly** — perfect collinearity,
with prior weights `+0.30` and `+0.20` pointing in opposite directions along it. `skipInv` at `+0.70` is
then a third copy of the same bit.

Net: playing one track 0→5 times moves the prior by `−0.30 (novelty) +0.10 (playCount) +0.70 (skipInv, step)`,
i.e. the "repeat it" pressure is carried by a step function, not by a smooth count. The 17 declared
features are **~13 independent directions, ~10 of them non-degenerate**. That is the number to use in every
"labels per parameter" calculation below — a ladder built on 17 is off by half.

Also measured, minor but it makes the readiness gate a false green: `albumAffinity` and `genreAffinity` are
declared in `FEATURES`/`W0` but **never emitted by `raw()`**, and `likeAffinity`/`cooccur` never fire. The
shipped diag agrees — it reports `cold 5/16 → NOT READY`, `warm 12/16 → READY`, and the four names missing
from its own live list are exactly `albumAffinity`, `genreAffinity`, `likeAffinity`, `cooccur`:

```
features carrying data  12 / 16  (75%)
  artistAffinity 58% · completionEma 58% · durationFit 95% · energyFit 100% · fpCos 100%
  fpCosRecent 100% · hourFit 2% · novelty 58% · playCount 58% · queueDistance 100%
  recency 58% · skipInv 46%
```

Note what passes the 60 % bar: **four** features that cannot carry data are excluded from the numerator but
counted in the denominator, `skipInv` is a constant (§0f), `hourFit` fires on 2 %, and `novelty`/`playCount`
share one presence rate (58 % each) because they are one axis. The gate reads 75 %; the honest count of
informative directions is **~9**. Any ladder built on "17 features" or a "12/16 ready" verdict will
mis-size every parameter budget below.

---

## 1. Signal table

Verdict legend: **CORE** = build the model on it · **USEFUL** = adds real information, weight it
carefully · **FEATURE-ONLY** = never a label, only an input · **NOISE** = ignore · **POISON** = currently
generating wrong labels, fix before training.

| Signal | Today | Label (y, weight) | Latency | Verdict |
|---|---|---|---|---|
| Natural end (media `'ended'` fired) | approximated as `completion > 0.5`, no `naturalEnd` flag | `y=1, w=1.0` | end of track (up to 6 min) | **CORE** — but must require `naturalEnd`; `>0.5` alone is what makes the next row poison |
| **Abandon at 10 s–50 %** | **dropped** (25 % of outcomes) | `y=0, w=0.5` while the track has <3 prior completions; then **relative**: `y = (completion > completionEma)` `w=1.0` | immediate | **CORE** — the biggest recoverable signal. Relative form is what removes "he always bails on ballads at 40 %" bias |
| Abandon at 50–90 % (pressed next) | **mislabelled `y=1`** | `y=0, w=0.5` | immediate | **POISON today** — abandonment at 68 % is taught as success |
| Bail at <10 s | dropped (`elapsed<10` floor) | `y=0, w=1.5` | immediate | **CORE** — cleanest negative in the system, currently discarded |
| Explicit like (heart) | UI exists, **never reaches ranker** | `y=1, w=3.0`; also set the `liked` flag so `likeAffinity` lives | immediate | **CORE** — strongest label a single user gives, and the model already reserves w0=1.00 for it |
| Explicit dislike / delete | `labelFromEvent('delete')` exists, never fires | `y=0, w=3.0` + hard block list | immediate | **CORE** |
| Backward seek >15 s, or manual restart | not wired (`replay` dead) | `y=1, w=2.0` + `replayCount` feature | immediate | **CORE** — cheapest true positive: 20 s of re-listening is a strong like at 10 % of the time cost of a full play |
| Forward seek inside a track | not wired | **no label** → `seekFwd` count + `maxPosition` as features | — | **FEATURE-ONLY** — as a label it is ambiguous ("boring intro" vs "skip the solo") |
| Any label derived from `currentTime` | shipped | — | — | **POISON** — replace with `listenedSec` (wall-clock seconds with `!paused && !seeking`) |
| Dwell / pause | not wired | **no label**; `pauseDur > 60 s` ends the session | — | **FEATURE-ONLY** — a pause is a phone call, a doorbell, or a decision; indistinguishable |
| Skip position `skipAt = listenedSec/dur` | not captured | threshold generator: `<0.15` → `y=0,w=1.5`; `0.15–0.5` → `y=0,w=0.5`; `>0.5` → no label | immediate | **USEFUL** — best single scalar you have, and it makes the three cases above one rule |
| Repeat (same track re-picked) | `labelFromEvent('replay')` dead | `y=1, w=2.0` on the **second** play; beyond 3 consecutive, **stop adding positives** and log `loop=true` | immediate | **USEFUL** with a cap — without the cap one loop teaches the model that one track is the world |
| Add-to-queue | not captured | `y=1, w=1.5` | immediate | **USEFUL** — deliberate, and uncontaminated by whatever is currently playing |
| Remove-from-queue **before** it starts | not captured | `y=0, w=1.0` | immediate | **USEFUL** |
| Remove-from-queue **during** playback | not captured | **no label** — it *is* a skip, already counted | — | **NOISE** (double-count) |
| Queue reorder | not captured | no label | — | **NOISE** (pure UI) |
| "Play next" on the current track | not captured | `y=1` as repeat, not as a new preference | — | **USEFUL**, must not be counted as two |
| Volume up in first 20 s | not captured | `y=1, w=0.3` | immediate | **FEATURE-ONLY** at best |
| Volume down / mute | not captured | `y=0, w=0.5` | immediate | **FEATURE-ONLY** |
| Volume as a *primary* label | — | — | — | **POISON** — learns "loud is better", and is confounded by headphones/speaker/room |
| Session bounds (30 min idle) | absent; `stats()` counts **cross-session adjacency** | session id + `cooccur` restricted to within-session | — | **CORE fix** — cross-session transitions are why `cooccur` is near-binary and wrong |
| Search query → chosen result | pool changes, nothing logged | `y=1, w=1.5` for that one track; log `candCount` | immediate | **USEFUL** — but see §4: search shrinks `VIEW`, which silently changes every AUC denominator |
| Playlist save | not captured | `y=1, w=3.0`, and the playlist is a curated cluster for step 4 | slow, rare | **CORE (long game)** — highest-intent signal available, and the natural seed for item grouping |
| Thumbs up/down | not captured | like/dislike equivalent, `w=3.0` | immediate | **USEFUL** — only if both poles exist; up-only earns ~1 label per 20 tracks |
| Hour-of-day fit | shipped, 4/148 nonzero | feature only, expect `w≈0` | — | **NOISE at this volume** — do not spend weight on it |
| Play while tab hidden / window unfocused | not detected | **no label**; count `listenedSec` only when `document.hasFocus()` | — | **POISON** — auto-advance while he walks away manufactures fake completions. On a desktop+phone app this is the largest silent contamination source |
| First-ever play of a track | full weight | `w=0.5` | — | **USEFUL** — the first week is exploration, not preference |
| Scrub to end → next | **mislabelled `y=1`** | `y=0, w=1.5` when a seek lands within 5 s of `dur` and the track changes within 2 s | immediate | **POISON** — the single most damaging current bug |

### Event schema to write (one row per offer, one per outcome)

```js
// outcome event — replaces the current {file, artist, at, elapsed, dur, kind, arm, session}
{
  file, artist, at, dur,
  kind: 'end' | 'skip' | 'like' | 'unlike' | 'delete' | 'replay' | 'queue_add' | 'queue_drop' | 'save',
  listenedSec,       // wall clock, paused/seeking excluded  <-- the whole fix in one field
  maxPosition,       // max currentTime reached, for seek detection
  seekFwd, seekBack, // counts
  naturalEnd,        // boolean: did the media element fire 'ended'
  skipAt,            // listenedSec / dur
  session, arm,
  propensity,        // p(item) from pick()'s softmax — currently discarded
  candCount,         // |lib.view| at offer time — makes AUC denominators comparable
  hadFocus,          // document.hasFocus() during playback
  schema: 2          // version the label semantics; never mix v1 and v2 in one fit
}
```

---

## 2. Training safely with one user and no ground truth

**Train on choices, not on taste.** "Is track X good" is unanswerable at n=1. "Given these 6 offered, he
engaged with #2 and bailed on #5" is answerable **today**. So the objective should be a
**within-slate (Bradley–Terry / listwise logistic)** comparison, with the current pointwise logistic kept
as a fallback while every slate offers ≤3 items.

**Label weights** (reliability, not volume): delete/playlist-save 3.0 · like 3.0 · replay 2.0 ·
natural end 1.0 · relative completion 1.0 · bail <10 s 1.5 · mid-band 0.5 · first-ever play 0.5 ·
hidden-tab 0 (excluded).

**Shrink the over-served.** The gradient is dominated by the top-5 tracks, which are exactly the ones the
policy already favours — the loop that produced finding (e). Multiply each label by
`1/sqrt(1 + n_observations_of_this_track/10)`.

**Two different clocks, do not confuse them.**
- *Feature* recency: existing `RECENCY_TAU = 14 d` is correct — taste-locality, not learning.
- *Label* half-life: **45–60 days**, not 14. At ~5 plays/day, 14 days is 70 labels — not enough to
  re-estimate 16 weights (≈4 labels/param). 60 days is ~300 labels (≈19/param). The prior anchoring
  (`lam` → `w0`) already provides shrinkage; do not add a second decay mechanism on top.

**Online SGD at 1 step/play cannot converge.** 120 plays × 1 step at `eta=0.05` moves the weights a few
percent of the way toward anything. Switch to **periodic batch fit on app start**: last 300 labels,
3–5 epochs, `eta=0.02`, same Ridge-to-prior objective and same `lam`. Same math, enough steps to actually
fit, and no state to corrupt mid-session.

**Constrain the hypothesis space — this is the cheapest variance reduction available.**
- Clamp per-feature weights to **±1.5 × w0**, not the current `±5`. With 16 features and 200 labels, `w=5`
  means one feature *is* the score. That is overfitting wearing a confidence costume.
- **Sign constraints**: `fpCos`, `fpCosRecent`, `artistAffinity`, `completionEma`, `likeAffinity` must
  stay ≥ 0. A "more similar = worse" solution is a data artefact, not a preference.
- **Delete** `albumAffinity` and `genreAffinity` rather than carrying two permanently-zero weights through
  every serialization and migration.

**Negative-sample bias (the one that will actually bite).** The model only ever sees what it served. With
a 10 % uniform floor over 148 tracks, the least-served track gets ~0.07 % of plays, so
`P(engaged | track)` is estimated on a set the policy already likes → rich-get-richer. Fixes in order of
value:
1. **Log `propensity`** and do propensity-weighted gradients (divide by the serving probability). `pick()`
   already computes that softmax; it is thrown away one line later.
2. **Raise the exploration floor to 15 %** until 300 plays. Ten percent of a small library is not enough
   coverage to correct a wrong prior on any individual track.
3. **Cold-queue rule**: any track not offered in the last 200 picks gets forced into the next slate. A
   track never offered can never be corrected, and at 148 tracks this is cheap.

**Never train on arm `h`.** Those sessions are the control and the only unbiased sample of prior behaviour.
Log them, weight them zero in the fit.

**Drift**: rolling AUC is meaningless at n=1. Use a **CUSUM on the residual `y − sigmoid(score)`** with a
5σ threshold, plus trailing-40-pick skip rate by arm. Trigger a *refit*, never an architecture change.

---

## 3. The ladder, with the volume where each rung becomes honest

`N` = logged plays, `L` = labels that actually trained (i.e. survived the label function), `T` = tracks
with ≥3 plays.

| Rung | Gate | Model | Params | Why the gate |
|---|---|---|---|---|
| **0 — instrument** | `N < 80` | none. Serve `w0` pure. A/B runs for **exposure diversity only** | 0 | 40 plays cannot distinguish "learned" from "noise". Learning here is theatre, and it poisons the log you will later fit on |
| **1 — anchor logistic** | `N ≈ 80–150`, `L ≥ 60`, `T ≥ 15` | logistic on the **5 features that carry variance** (`fpCos`, `fpCosRecent`, `completionEma`, `artistAffinity`, `recency`); `skipInv` held *fixed* as an intercept shift for played tracks; everything else frozen at `w0` | 5 | ~12 labels/param. Learning 16 (really 13) from 100 labels is guaranteed in-sample gain, zero out-of-sample. `skipInv` is excluded because it has no variance to learn (§0f) |
| **2 — full logistic** | `N ≈ 150–400`, `L ≥ 250`, likes ≥ 10 | all non-degenerate features; `likeAffinity` now live; relative completion labels; **decide collinearity**: drop `skipInv` and `playCount`, keep `novelty` (one repeat axis, not three) | 11–12 | likes cannot exist before the wire exists (§0d); relative labels need ≥3 completions of a track |
| **3 — structured, not deep** | `N ≈ 400–1000`, `L ≥ 400` | **do not add a hidden layer.** Add (a) within-slate pairwise loss, (b) 3–4 hand-picked interactions: `artistAffinity × novelty`, `completionEma × recency`, `fpCos × skipInv` | +4 | 400 labels / 12 hidden units / 16 inputs = 192 params ≈ 2 labels/param. A net here is dead on arrival. The interactions encode "he loves this artist but is tired of it", which a linear model cannot |
| **4 — item grouping** | `N ≥ 1500`, `≥ 300` **within-session** adjacency pairs, each track in ≥3 pairs | fingerprint clusters (K-means on **centered** 26-band vectors, k = 12–20) + one weight per cluster | 20 | 148 × d=8 = 1184 params from 300 pairs is still thin. Clustering is the honest low-rank model at a 148-item library — **and it is the answer to your online-extension goal**: a new streamed track is scored by cluster membership from its fingerprint, with zero plays |
| **5 — collaborative / MLP** | `N ≥ 5000` (≈3 years at 5 plays/day) | matrix factorization or a small MLP | 500+ | Not a roadmap item. Do not plan around it |

**Why rung 4 is the one that matters for the stated goal.** You want to extend the queue with online
tracks. Collaborative signal is useless for a track nobody has played, so the *only* mechanism that can
score a brand-new track is content: 26-band fingerprint → compare to the local library → nearest cluster →
that cluster's learned weight, plus `energyFit`/`durationFit` from stream metadata. That works the day the
first online track arrives, at any `N`. Build the cluster layer for that reason, not as a stepping stone
to embeddings.

---

## 4. Evaluation that will not fool itself

**Primary metric: session-clustered skip rate**, using the existing CR2 / wild-bootstrap machinery —
*after* `skip` is actually written. Cluster by session (already done), refuse below 3 sessions (already
done, returns NaN + `degenerate: true` — that behaviour is good, keep it).

**Stratify by prior plays.** The learned arm will serve more repeats early (it has `recency` at +0.50 and
will learn to lean on it), and repeats have a structurally different skip rate. An unstratified
comparison measures the arm's novelty mix, not its quality.

**Secondary: completion on first-ever plays only.** This is the only subset comparable across arms,
because it cannot be contaminated by the arm's own accumulated history.

**Fix the control arm before trusting any delta.** Arm `h` needs the same 10 % uniform exploration floor
as arm `l`, or the comparison is "starved argmax vs exploring softmax" and the answer is known in advance.

**AUC is a diagnostic, never the headline.** Two specific traps in the current setup:
1. `rankLib()` passes `VIEW` — the **filtered, visible** list — as the candidate pool. A search or filter
   changes the denominator, so AUC moves with no model change. Reconstruct slates from the logged
   `candCount`, or evaluate on the full library with the served item's rank recorded.
2. AUC over *served* data measures "can the model rank what it chose to serve" — a policy-conditioned
   quantity that improves mechanically as the policy narrows. Use it only for "did the new features help
   rank *within* a slate", session-held-out, and report it next to the served-set composition.

**Overfitting guards, both cheap:**
- **Placebo test**: shuffle labels *within session* and refit. If the shuffled model also beats `w0` on
  your metric, the metric is broken, not the model. Run this once per rung; it costs one script.
- **Promotion rule**: a new weight vector must beat `w0` on held-out last-20 %-of-sessions AUC by ≥ 0.03
  **and** not increase live skip rate. Either alone is gameable.

**The one honest offline test available at n=1: counterfactual replay.** You log `propensity` for every
served item, so IPS/SNIPS can estimate the skip rate of a *candidate* policy without burning listening
time. At 200 events the variance will swamp the estimate — report it with an explicit
`"not actionable below 1000 events"` flag. Do it anyway: it is the only way to reject a bad candidate
before it costs the user a week of listening.

**Ways this will lie to you, specifically:**
- `alpha()` rising because Fisher information grew, **not** because predictions improved. Fisher grows with
  exposure, and the h-arm 2-cycle manufactures exactly that exposure. Track `alpha` next to skip rate.
- AUC rising because the candidate pool shrank (search/filter).
- Skip rate "improving" because the learned arm serves low-base-skip tracks — the stratification above is
  the defence.
- Weekday/weekend seasonality: he listens to different music on Saturdays. Compare same-weekday or control
  for day-of-week.
- **Instrumentation drift**: adding `listenedSec` changes label semantics. Never fit across a schema
  version boundary — that is why the schema carries `schema: 2`.
- Promoted-on-nothing: a 0.03 AUC gain on 60 held-out labels is inside the noise band. Require ≥ 150
  held-out labels before you act on any offline win.

**Weekly report — six lines, no prose:** `N`, `L`, label mix (pos/neg/dropped %), distinct tracks served
and top-5 share, skip rate by arm with CI, and features with `|w − w0| > 0.5·w0` (the ones that actually
learned anything).

---

## 5. Ordered change list

**P0 — before training anything (no model change, ~1 day):**
1. `listenedSec` (wall clock, excluding paused/seeking) as the label input everywhere; stop reading
   `currentTime` for labels. Kills the whole seek-corruption class (§0c).
2. `naturalEnd` flag; separate "finished" from "left at 68 %".
3. Write `skip` into the event; send `kind` correctly from `index.html:1657` (`end` / `skip` / `like` /
   `delete` / `replay` instead of always `'play'`). Revives the A/B (§0a).
4. Wire `LIKE_MAP` → ranker. Revives `likeAffinity`, the model's strongest prior (§0d).
5. Log `propensity` + `candCount` per offer. Prerequisite for every unbiased estimate below.
6. Session break on 30 min idle **and** on hidden/unfocused tab; restrict `cooccur` to within-session.
7. Exploration floor on arm `h` (§0e).

**P1 — first fit (~2 days):** graduated mid-band labels + relative completion; batch refit instead of
1-step SGD; ±1.5·w0 clamp and sign constraints; delete `albumAffinity`/`genreAffinity`; collapse the repeat
axis to one feature (`skipInv` and `playCount` out, `novelty` kept); per-track weight shrinkage.

**P2 — after 400 labels:** within-slate pairwise loss; the 3 interaction terms; propensity-weighted
gradients.

**P3 — after 1500 plays:** fingerprint clustering + per-cluster weights, which is also the online-track
extension path.

---

## 6. Defect kill list, one place

| # | Generator | Damage |
|---|---|---|
| 1 | `completion = currentTime/dur` | a scrub-to-end skip becomes a full-weight positive |
| 2 | no `naturalEnd` | abandonment at 68 % taught as success |
| 3 | 0.2–0.5 band dropped | 25 % of outcomes, the informative middle |
| 4 | `elapsed < 10` floor | deletes the cleanest negatives |
| 5 | hidden/unfocused playback | auto-advance manufactures fake completions |
| 6 | cross-session `cooccur` | adjacency pairs between Monday's last and Tuesday's first |
| 7 | `kind: 'play'` for everything | `labelFromEvent` fully dead; replay/like/delete unreachable |
| 8 | `skip` never written | `delta()` ≡ 0; the A/B is decorative |
| 9 | h-arm argmax, no floor | 2-cycle → starving control → fake win for the learned arm |
| 10 | labels fit across schema changes | silent mixing of two label definitions |
| 11 | volume as a label | learns "loud is better" |
| 12 | `VIEW` as candidate pool | AUC moves when the user types in the search box |
| 13 | repeats beyond 3 in a row | one loop teaches the model that one track is the whole world |
| 14 | `skipInv` ≡ 1.0 for every played track | a 0.70 weight sitting on a constant; the model thinks it measures skip proneness |
| 15 | `novelty` and `playCount` perfectly collinear for `plays ≤ 5` | two weights fighting along one axis; ill-conditioned fit that looks converged |
| 16 | `cooccur` normalised by row max | the single most frequent successor is always `1.0`, so one chance adjacency reads as a strong pair |
| 17 | `likeAffinity` never fed (`kind:'like'` never sent) | the model's largest weight (`1.00`) is permanently dead |
| 18 | `albumAffinity`, `genreAffinity` declared but never emitted | permanent zeros inflating the readiness denominator to a ceiling of 14/16 |
