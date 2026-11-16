# Bugs found in 2.1.1 (not yet fixed)

Everything below was reproduced against a live instance of the 2.1.1 build, not
read off the source alone. Line numbers are `app.js` / `index.html` at
`f798fed` unless stated otherwise. Nothing here is fixed; this file exists so the
findings survive the machine they were found on.

Two independent passes produced it: a hand-driven pass (section A) and four
adversarial agents driving the same build over CDP on ports 9331-9334
(sections B, C, D). Where an agent and the hand pass found the same defect, it
appears once, under the hand pass, with the agent's id noted.

---

## A. Hand-driven pass

### A1. HIGH - Filtering the library blanks the now-playing card

Click a row so it plays, then type `zzzzzz` in the filter.

| | before filter | after filter | after clearing filter |
|---|---|---|---|
| `#np-title` | Slow Burn | **(untitled)** | **(untitled)** |
| `#np-artist` | 01 Alpha | **Unknown artist** | **Unknown artist** |
| rows | 13 | 0 | 13 |
| audio | playing | **still playing** | playing |

The card stays broken after the filter is cleared; only clicking a row again
recovers it.

Cause - `app.js:1653-1658`:

```js
function syncNow() {
  const card = $('np');
  const t = VIEW[cur] || {};            // the FILTERED view
  $('np-title').textContent = clean(t.title) || '(untitled)';
```

`VIEW` is the filtered list, so any filter that hides the playing row makes
`VIEW[cur]` undefined and the card falls back to its empty-state strings while
the audio element keeps playing. The card should read the playing track (by
`curFile` / the `TRACKS` entry), not the filtered view.

### A2. HIGH - Track ends under a zero-match filter: transport stuck on Pause

Play a track, filter to zero rows, seek to `duration - 1.2`, wait. Twelve
consecutive samples over ~7 s:

```
t=4  ended=true  paused=true  iconPause=true  aria="Pause"
```

Nothing plays, but the button still offers Pause and the icon is the pause glyph.

Cause - `app.js:1156-1162`:

```js
if (cold && VIEW.length) {
  if (cur + 1 < VIEW.length) { select(cur + 1, true); return; }
  if (repeatMode === 'all') { select(0, true); return; }
  stopAtEnd();
  return;
}
onlineNext(0);
```

With `VIEW.length === 0` the guard is false, so `stopAtEnd()` - the only
`icon(false)` on this path (`app.js:272-281`) - is skipped and control falls into
`onlineNext(0)`, which ends at `step(1)` -> `app.js:950` `if (!VIEW.length) return;`.
Nothing resets the icon.

Same class, same handler: `app.js:1136` `if (repeatMode === 'one') { select(cur, true); return; }`
also does nothing when `VIEW` is empty (`select` bails at `app.js:727`), leaving
the icon on Pause.

### A3. MEDIUM - Repeat toggle never repaints the queue strip

Click repeat off -> all -> one -> off. `data-mode` changes every click, the strip
never does:

```
BASE    repeat=off  items=["Quick Step","Long Player","No Artist"]
REP_ALL repeat=all  items=["Quick Step","Long Player","No Artist"]
REP_ONE repeat=one  items=["Quick Step","Long Player","No Artist"]
REP_OFF repeat=off  items=["Quick Step","Long Player","No Artist"]
```

Cause - `setShuffle()` calls `renderQueueStrip()` (`app.js:259`), `cycleRepeat()`
does not (`app.js:262-267`). With repeat one the strip still promises the next
three tracks while the engine replays the current one; with repeat all at the
queue end it hides instead of wrapping.

### A4. MEDIUM - Zero-match filter leaves the queue strip showing unplayable tracks

Filter to zero rows: `rows=0` but `strip.hidden=false` with three items. Clicking
one is a silent no-op (`select` bails at `app.js:727` `if (!VIEW[i]) return;`).

Cause - `renderQueueStrip()` is called from `app.js:259` (shuffle), `app.js:552`
and `app.js:783` only; the filter handler at `app.js:1274` never calls it, so the
strip keeps the pre-filter rows.

### A5. LOW - Seek bar paints a position it did not seek to

Cause - `app.js:1189-1192`:

```js
bindDrag($('seek'), (p) => {
  seekTo(p * (audio.duration || 0));
  $('sfill').style.width = (p * 100) + '%'; $('shead').style.left = (p * 100) + '%';
});
```

`seekTo` returns early when the duration is unknown (`app.js:1175` `if (!d) return;`)
but the next line paints the fill and head anyway. Dragging on a track with no
duration shows a position the audio never took, and the next `timeupdate` snaps
it back.

### A6. LOW - `shufflePeek()` mutates the shuffle queue

Cause - `app.js:231-237`:

```js
/* The head of the queue without consuming it: the strip has to show what will
   play, and showing it must not change what plays. */
function shufflePeek(n) {
  if (!shufQueue.length) {
    if (shufDone && repeatMode === 'off') return [];
    shuffleFill();          // replaces shufQueue with a fresh shuffle
  }
  return shufQueue.slice(0, n);
}
```

The comment promises the peek is side-effect free; `shuffleFill()` reshuffles. Any
second repaint before a track ends (filter change, resize, shuffle toggle) can
change the order that will actually play.

### A7. LOW - Shortcut sheet lists `P` twice, with two different meanings

`index.html:304-305`:

```html
<div class="kv"><span>Next / previous</span><b>N P</b></div>
<div class="kv"><span>Restart the track</span><b>P</b></div>
```

`app.js:1295` `else if (e.key === 'p' || e.key === 'P') step(-1);` - and `step(-1)`
only restarts when past 3 s (`app.js:951` `if (d < 0 && (audio.currentTime || 0) > 3) { seekTo(0); return; }`),
otherwise it goes to the previous track. There is no dedicated restart handler
anywhere. The second row is true only past 3 s, and the sheet claims one key does
two jobs.

---

## B. State-machine pass (agent a2, ids A2V2-*)

Same root cause as A4 in every case: the strip is rendered from a `VIEW` that has
since changed, and nothing re-renders it. Listed separately because each has a
distinct user-visible lie.

### B1. A2V2-01 - Stale strip: clicking an item whose index no longer exists is a silent no-op

Filter to `light` so the list drops from 5 rows to 2; the strip keeps its three
pre-filter buttons. Clicking the last one calls `select()` with index 3 against a
2-row view, so it returns at `if (!VIEW[i]) return`. No track loads, no
announcement, no visual change - the button looks live and does nothing.
`#sr-status` still says "2 tracks match", `#time` keeps ticking on the old track.

### B2. A2V2-02 - Stale strip plays a different track than the one it names

Same filter. Click the first strip button, labelled `LIGHT IT UP` (stored index
1). The hero and audio switch to `Charlie Puth - Light Switch` - the second row of
the filtered view, a track the button never named. `audio.duration` goes 159.32 ->
185.76.

### B3. A2V2-03 - Repeat-all: strip stays hidden while the engine now wraps

Repeat off, click the last row (index 4): the strip hides, correctly. Press `r`
once: `data-mode="all"`, `aria-label="Repeat all"`, strip still `hidden=true`.
Press `n`: the engine wraps to row 1 and plays it, proving the strip was wrong.

### B4. A2V2-04 - Repeat-one: strip advertises the following tracks while the engine replays the current one

With `data-mode="one"` the strip renders the sequential branch (`cur+1`, `cur+2`,
`cur+3`) and never accounts for the mode. At the natural end the ended handler
takes the repeat-one branch and re-selects the same track: `audio.src` before and
after are identical, `t` goes 148.86 -> 0.1, `paused=false`, while the strip still
lists `SELFISH`, `Mehabooba...`, `Charlie Puth - Light Switch` as up next.

### B5. A2V2-05 - Shuffle: strip lists the track that is already playing, and it really replays it

Clicking a strip item under shuffle calls `select()` but never consumes the
shuffle queue, so the strip re-renders from the same queue and shows the
now-playing track as upcoming. Pressing `n` walks the queue and reaches that
track again. Observed title sequence over five `n` presses:

```
Charlie Puth - Light Switch
CITIZEN the Artist - The Thought of Me
Charlie Puth - Light Switch      <- played twice in one pass
Mehabooba Video Song ...
SELFISH
```

### B6. A2V2-07 - Now-playing card shows `-0:00` remaining at the end of the queue

`syncNow()` formats remaining as `"-" + fmt(round(d-c))`. At the end of a track
`d-c` rounds to 0, so the card prints a negative zero while the rail is at 100%
and the transport already says Play. Observed: `#np-left="-0:00"`,
`#np-elapsed="3:05"`, `#np-rail aria-valuetext="3:05 of 3:05"`, `#np-fill=100%`,
`#play aria-label="Play"`.

---

## C. Adversarial pass (agent a4, ids ATK-*)

17 attacks. 14 recovered to a consistent state; 3 did not.

### C1. HIGH - Three attacks leave the transport icon disagreeing with the engine

| id | attack | after recovery attempt |
|---|---|---|
| ATK-02 | drag released outside the window (lost `pointerup`) | `icon=false paused=true view=85/85` |
| ATK-04 | rapid play/pause spam (dblclick + sync burst) | `icon=false paused=true view=85/85` |
| ATK-12 | search/filter while playing | `icon=false paused=true view=85/85` |

All three end with `checks.iconAgrees=false`, `after.playAria="Pause"`,
`after.iconPause=true`, `after.audio.paused=true`. The audio is stopped and the
button offers Pause. ATK-04 also leaves `seekDrift=0.35`.

ATK-02 is the cleanest repro: press the seek slider, drag past the window edge,
release outside. The `pointerup` never reaches the element, so the drag never
ends; the transport is left mid-gesture.

ATK-12 is the same defect as A1/A2 seen from the other side: filtering while
playing desynchronises the card and the transport from the audio element.

### C2. MEDIUM - CSP blocks the iTunes preview host

Three violations, identical text:

```
Loading media from 'https://audio-ssl.itunes.apple.com/itunes-assets/...'
violates the following Content Security Policy directive
```

The Apple preview URLs are fetched by the online shelf but `media-src` does not
allow `audio-ssl.itunes.apple.com`. Previews that resolve to that host cannot
play. (The X/Y/Z cards added the Apple allowlist to the *fetch* path; `media-src`
was not extended.)

### C3. Attacks that recovered (no action)

ATK-01 double/triple click every control; ATK-03 seek drag past both ends;
ATK-05 next/prev spam faster than tracks load; ATK-06 hammer
shuffle+repeat+theme+like simultaneously; ATK-07 keyboard mash; ATK-08 resize
during playback; ATK-09 resize mid-drag; ATK-10 open sheet while track ends;
ATK-11 add the same file twice; ATK-13 seek to 99% then 0% at track end; ATK-14
sheet close/reopen race (240 ms hide timer); ATK-15 now-playing close/reopen race
(280 ms hide timer); ATK-16 like hammer + storage consistency; ATK-17
simultaneous everything.

Two of these reported `ATTACK_ERROR: no box for #lib-btn` (ATK-01, ATK-06) - the
harness could not find the element, not an app failure.

---

## D. Visual and layout pass (agent a1, 33 notes / 27 shots)

### D1. HIGH - Horizontal overflow at 1280x800

`docScrollW=1320` against `clientW=1280` (40 px of horizontal scroll), and the
transport is `scrollW=934` against `clientW=860`. Five offenders, all in
`#hint-keys`:

```
div#hint-keys.hint   x=1105.8  r=1332.5
kbd "b"              x=1278.7  r=1291.3
kbd "m"              x=1299.3  r=1311.9
kbd "/"              x=1319.9  r=1332.5
```

The keycap row does not wrap or shrink, so the last three keycaps are clipped to
`vis=0px` (`b` 0.1 px, `m` 0, `/` 0). At 1266x823 the same row runs to 1319.7.
At 900x600 and 1600x1000 the document fits.

### D2. HIGH - `.kicker` "Library" fails contrast in the liquid theme

| viewport | theme | worst ink/bg |
|---|---|---|
| 1600x1000 | liquid | **2.86:1** (`.kicker`, `rgb(97,90,79)`) |
| 1280x800 | liquid | **2.96:1** (`.kicker`, `rgb(97,90,79)`) |
| 900x600 | liquid | **4.15:1** (`.kicker`, `rgb(97,90,79)`) |
| 900x600 | light | 4.23:1 (`#list .row .d`, `rgb(95,89,79)`) |
| 1280x800 | light | 4.58:1 |
| 1600x1000 | light | 4.62:1 |
| 900x600 | dark | 4.68:1 |
| 1280x800 | dark | 4.45:1 |
| 1600x1000 | dark | 4.39:1 |

WCAG AA for normal text is 4.5:1. The liquid kicker is the only one that fails at
every size; the light/dark `#list .row .d` and `.t i` sit just under 4.5 at
900x600 and 1280x800.

### D3. MEDIUM - Queue strip overlaps the transport by 10 px

Strip `y=689.9 h=74.4` -> bottom 764.3; `transportBottom=679.9`. The strip starts
10 px above the transport's bottom edge, so the two boxes overlap.

### D4. MEDIUM - `.d` carries a permanent 22 px dead gutter

`.d padding-right=22px`, so the duration column reserves 22 px it never uses. Row
height is 78.4 px with a `[31.4px 22px]` grid and 11 px row-gap, 5 children in 4
columns.

### D5. LOW - Library tab has no hover state

`lib-tab` hover/active/focus rules found: `[]`. Hovering the tab changes 0/0 px
(`NaN%`). The row hover does work (`bg=rgb(226,222,212)`, `transition=all`), so
the tab is the odd one out.

### D6. LOW - Row width jumps when the scrollbar appears

With a full list the scrollbar is 12 px and the row is 319.2 px wide; without it
the row width is `null` (delta -319.2 px). The list does not reserve the
scrollbar gutter, so every filter that crosses the scroll threshold reflows the
rows.

### D7. LOW - Focus ring is inconsistent between programmatic and keyboard focus

Programmatic focus: `body=""`, `outline=rgb(20,19,16) none 2.4px`. After Tab:
`body="kbd"`, `active=BUTTON.like`, `outline=solid 1.6px rgb(220,63,25)`. Two
different rings depending on how focus arrived.

### D8. LOW - Sheet content overflows its own scroll box

Sheet is 396x800 with `scroll 881/746` (135 px of overflow) in light and dark,
`891/745` in liquid. The three theme segments sit at `y=903.6`, `1019.3`,
`1135.1` - the last one is below the fold on open.

---

## E. Checked and behaving as designed

- `shufflePeek(3)` returning one item: the ranker's repeat window can leave a
  single eligible track, and the strip honestly shows one.
- `P` restarting past 3 s: intentional (`app.js:951`); the shortcut sheet is what
  is wrong (A7).
- `#sr-status` at `x=-1 r=0`: it is `.sr-only`, not an overflow offender.
