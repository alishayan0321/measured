# Recommender

How MEASURED picks the next track. One logistic neuron, 18 features, one SGD
step per play. No neural network, no cloud, no extra dependencies — the same
JS runs in the web build, the Tauri desktop app and the Android shell.

## Pipeline

```
library ──► features (18 floats) ──► score ──► pick (softmax, T=0.7)
   ▲                                   │
   │                                   ▼
 play log ◄──── label (y, weight) ◄── end of track
```

`lib/recommend.js` is the model, `lib/recommend-features.js` turns a library
plus a play log into feature rows, `lib/recommend-wire.js` is the glue the
page actually calls. Tests: `test/recommend.test.cjs` (42), `test/wire.test.cjs`
(7), `test/embed.test.cjs` (7), `test/shelf.test.cjs` (13).

## Features

| # | feature | source | range |
|---|---------|--------|-------|
| 0 | `bias` | — | 1.0 |
| 1 | `fpCos` | 26-band fingerprint vs now-playing | −1..1 → 0..1 |
| 2 | `fpCosRecent` | vs mean of the last 3 bands | −1..1 → 0..1 |
| 3 | `artistAffinity` | per-artist completion EMA | 0..1 |
| 4 | `albumAffinity` | per-album completion EMA | 0..1 |
| 5 | `genreAffinity` | per-genre completion EMA | 0..1 |
| 6 | `completionEma` | this track's own EMA | 0..1 |
| 7 | `likeAffinity` | liked / disliked (tri-state) | 0..1 |
| 8 | `skipInv` | 1 − skip rate | 0..1 |
| 9 | `recency` | days since last play, τ=14 | 0..1 |
| 10 | `playCount` | plays / max plays | 0..1 |
| 11 | `novelty` | never played | 0/1 |
| 12 | `cooccur` | transition counts | 0..1 |
| 13 | `durationFit` | closeness to library median | 0..1 |
| 14 | `energyFit` | LUFS closeness to now-playing | 0..1 |
| 15 | `hourFit` | plays this hour of day | 0..1 |
| 16 | `queueDistance` | distance from current index | 0..1 |
| 17 | `embCos` | EmbeddingGemma 2 audio vector vs taste pole | −1..1 → 0..1 |

A missing value stays `undefined` and is treated as 0 — never as 0.5. That rule
exists because an earlier version defaulted absent signals to the midpoint, and
a constant fake 0.5 drifted an unused weight (1.20 → 1.44) in testing.

`embCos` is the newest and the most informative single signal: fingerprints are
pathologically collinear (pairwise cosine 0.989–1.000, median 0.998) while
EmbeddingGemma 2 vectors spread 0.68–0.83 between different tracks. On a 28-track
slice of real listening, similarity to the keeps-centroid separated keeps from
skips with AUC 0.72 (90% CI 0.52–0.90 — thin sample, wide interval).

## Labels (what counts as a verdict)

`lib/recommend.js:210-224`.

| outcome | label |
|---|---|
| listened < 10 s | dropped (guard against taps) |
| completion > 0.5 | `{y: 1, weight: 1}` |
| completion < 0.2 | `{y: 0, weight: 1}` |
| completion 0.2–0.5 | dropped (ambiguous) |
| seek / explicit skip | `{y: 0, weight: 1}` |
| delete | `{y: 0, weight: 2}` |
| like, replay | `{y: 1, weight: 1}` |

"Listened" is accumulated by `tick()` from forward `timeupdate` deltas of at
most 2 s, so dragging the scrubber to the end cannot manufacture a completion.
Before that change, seeking to the end and switching tracks logged a full
positive.

## Blend (two arms, one score space)

The heuristic prior `W0` is a discovery bias: recency 0.50, novelty 0.30,
playCount 0.20, `embCos` 1.10, `likeAffinity` 1.00. The learned weights `w` start
as a copy of `W0` and move away from it by SGD:

```
w_i -= eta * (g * x_i + lambda_i * (w_i - w0_i))
lambda_i = clamp(lam0 * sqrt(n0 / (n0 + n_i)), lamMin, lam0)
n_i     = sum of x_i^2 over all observations   (Fisher information)
g       = p - y,  p = sigmoid(sum w_i x_i)
```

Both arms score every candidate; each arm's score is z-scored against its own
slow-EMA reference σ (persisted next to the weights), blended with
`alpha = n / (n + 20)` capped at 0.9, then sampled with softmax at T=0.7 and a
10% random floor. Ties break on a stable per-candidate key.

## Gates

`lib/recommend-wire.js`:

| knob | value | meaning |
|---|---|---|
| `MIN_OBSERVED` | 20 | no recommendation before 20 observed outcomes |
| `COV_THRESHOLD` | 0.60 | at least 60% of features must be live |
| `HEUR_SHARE` | 0.20 | 20% of sessions are pure-heuristic (A/B baseline) |
| `alphaMax` | 0.90 | the learned arm never fully replaces the prior |

Measured coverage on the real 148-track library: 5/16 features live at cold
start (31%, correctly refuses) → 12/16 after 20 sessions / 120 plays (75%).

## Storage

Three keys, all through the app's own `get`/`set` so they travel with the
settings on every platform:

| key | contents |
|---|---|
| `measured.rec.model` | `{v, w0Version, w, w0, fisher, n, sigma}` — one JSON blob |
| `measured.rec.log` | observed events, capped at 2000 |
| `measured.rec.boot` | diagnostic written at startup: `{wire, rank, emb, keys, at}` |

`measured.rec.model` must be stored as a **string**; seeding an object makes the
app discard it and start a fresh `n=1` model.

## A/B and the ship/kill rule

Heuristic sessions log `arm:"h"`, blend sessions `arm:"l"`. Every event carries
`arm`, `session`, `listenedSec`, `naturalEnd`, `skip`, `candCount`, `propensity`.
The statistic is `delta = skip_heuristic − skip_learned` (positive = learned
better), one-sided, session-blocked, with a wild cluster bootstrap and a CR2
cross-check; the gate needs 100 picks **and** 20 sessions per arm.

Kill rule: if `kept/played` on recommended tracks stays under 15% after 200
sessions, the learned arm is off.

## Retraining

```
node tools/train.cjs --events <log.json> --out train/model.json
```

The shipped blob was trained on a synthetic listener over the real library
(held-out AUC 0.66 vs 0.40 for the untouched prior). It is a **fixture**, not
his taste: with ~54 real observations there is nothing honest to train on yet.
Real retraining needs the play log to grow, which the app is now recording.

## Online shelf (`lib/shelf.js`)

When the local library is exhausted, the player streams 30 s previews from the
iTunes Search API — memory only, never to disk.

| rule | value |
|---|---|
| seeds | artists ranked by `plays + (liked ? 3 : 0)` |
| pool | 3 buffered clips, only `canplaythrough` clips are served |
| skip ≤ 20% | one strike; a second strike or a first-ever low skip bans it |
| play-through | earns one second chance |
| download gate | liked, or ≥ 3 sitting plays (≥ 80% listened each) |
| wish list | `measured.shelf.want` |

Full-track download is deliberately unimplemented: the catalogue APIs that serve
full audio forbid caching or shipping a personal client id. The gate records
intent; a licence-permissive source can satisfy it later.

## Known limits

- `albumAffinity` and `genreAffinity` are declared but never produced by `raw()`;
  `skipInv` reads ~1.0 for most tracks; `novelty` is exactly collinear with
  `playCount`. Roughly 9 of 18 features carry independent signal today.
- Labels arrive only at end of track, so a track must be abandoned or finished
  before it teaches anything.
- The model is per-install: no export, no shared learning.
- Embarrassingly small data. Every number in this document came from fewer than
  100 real observations.
