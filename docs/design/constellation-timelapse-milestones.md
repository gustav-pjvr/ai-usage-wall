# Design: Project Constellation, End-of-day Time-lapse, Milestones

**Status:** design, not built. Written 2026-09-22 for Gustav by a Fable design
pass. The main thread verifies and builds from this.
**Binding inputs:** `ARCHITECTURE.md` "Do not break" (rules 12, 15, 17, 24, 26,
29, 30 matter most here), `docs/privacy-wire.md`, `docs/responsive-layout.md`.

**Measured on this machine while designing (usage-index.json, 2026-09-22):**
115 projects, of which 45 carry 99% of tokens and 58 have over 10M; 158
sessions; 78 hourly buckets in the 14 day window; 70 daily keys; 8 models;
39.1B tokens processed, 103M generated, 110K requests. Index is 301 KB on disk,
`sessions` 48 KB, `hourly` 15 KB. The five longest session spans (end minus
start) are 1107, 928, 792, 526 and 518 hours: a resumed session keeps its id,
so span is not duration. That single fact shapes the milestones design.

---

## 1. Project Constellation

**One line:** a third view beside Stats and Clients, canvas-drawn, repainted
only on data change, with one CSS-animated pulse for the active project.

### Where it lives
- **A third view, `constellation`, in the mode switch.** Not a panel: the grid
  at 1366x768 is already at both shrink floors, a 4-column cell there is about
  430x230 px, and 40 labelled stars with links in that box is a smudge. Not an
  overlay: it is a place to look at, not an interruption.
- **Displaces nothing.** Both existing views are unchanged. In the stats
  edition the mode switch, currently hidden because there is one view, appears
  with two entries. Settings gain `mode: 'constellation'` as a valid value.
- Optional ambient rotation between Stats and Constellation
  (`viewRotateSeconds`, default 0 = off), reusing the client wall's page
  rotation idea. Open question 4.

### Data
- **Reads (all present, no bump):** `projects[key].{input,output,cacheCreate,
  cacheRead,requests,lastSeen,display}`, `sessions[id].{start,end,cwd,total}`,
  `latest.{ts,cwd}`, `indexing`, `unavailable`.
- **Star size:** log of total tokens (same "total" as the hero, so the caveat
  that it is mostly cache reads applies; hover shows generated separately).
  Rank-bucketed into 5 sizes like the layout engine's tiers, so one project
  growing does not resize its neighbours. MEASURED input, DERIVED size.
- **Brightness:** recency of `lastSeen`, 7 day half-life, floor 0.12 so a
  dormant project is dim rather than gone. DERIVED, rule printed in the
  view's caption.
- **Links:** "worked on in the same session" is NOT available: `SessionInfo`
  holds one `cwd` and a session is one working directory. So links are
  **same local day**, derived from `sessions` (each session contributes its
  `cwd` to the local day of `start` and of `end`). Link weight = number of
  shared days, capped at 5 for drawing. DERIVED, caption says "linked when
  worked on the same day".
- **Active star:** `latest.cwd` while `sinceLast < 15 min` (the intensity
  step already in `derive()`), otherwise nobody pulses.
- **Cap:** top 40 projects by total tokens are stars with labels; the rest are
  folded into a single faint "+N more" caption, never drawn as fake stars.
  45 projects carry 99% here, so nothing visible is lost.
- **No INDEX_VERSION bump. Adds 0 bytes to the index.**

### Rendering
- **Canvas 2D, one full-window canvas, repainted only when the index changes
  or the window resizes.** No per-frame loop at idle. Positions are
  deterministic: seeded from the project key hash, then 60 iterations of
  simple repulsion plus a pull toward linked stars, computed once per data
  change in a pure function. Same input, byte-identical layout (the layout
  engine's guarantee, again).
- **Stars are rounded squares, not dots**, echoing the constellation mark in
  commit `2ce572b` (squares survive small sizes where dots turn to mush).
  Hue from the project key by the same FNV-1a plus golden-angle rule
  `color.ts` uses for clients with no brand colour.
- **The pulse is DOM, not canvas:** one absolutely positioned `<div>` over
  the active star animating `opacity` and `transform: scale()` only.
  Software cost is one small layer. Static ring on `[data-perf='low']`
  during battery, no pulse at all under `prefers-reduced-motion`.
- **Budget:** a full repaint is 40 squares, up to 120 lines, no `shadowBlur`
  (very slow in software; glow is a pre-rendered 3-size sprite drawn with
  `drawImage`). Target under 6 ms at 1366x768 in software, measured before
  merge by timing `paint()` in the render-fit run. Labels are canvas text at
  `max(9px, 10 * --u)` for the top 12 by size, hover only for the rest.

### Interaction
- **Hover:** a star grows one bucket and shows a caption: label, total,
  generated, requests, last seen. Uses the existing `.tip` element. Hit test
  is a pure function over the layout result, no DOM per star.
- **Click:** nothing. There is no detail surface for a project and inventing
  one is scope. Clicking the canvas is inert, so a stray click costs nothing.
- **Keyboard:** none. The wall is not focusable and needs nothing typed.

### Projection
- **Yes, with one new explicit field.** A screen already receives `projects`
  keyed by label and `latest.project`, enough for stars, size, brightness and
  the active pulse. Links need `sessions[].cwd`, which is deliberately absent
  from the wire. Add `projectLinks: [labelA, labelB, sharedDays][]`, computed
  on the source from local days, labels already masked by `maskHome`, empty
  when `projectsShared` is off. Named in `toWire()` and `fromWire()`, listed
  in `privacy-wire.md`, covered by the leak test (no path, no UUID).
- Nothing else crosses. The renderer computes layout from the frame.

### Honesty
- The view carries a tag like every panel: **MEASURED** for size and activity,
  with the caption stating the two derived rules (brightness half-life, link
  definition). Sizes are on a log scale and the caption says so.
- While `indexing` is true the view shows the same loading state the stats
  grid does; it never draws a partial sky. On `is-stale-data` it desaturates
  and takes the NOT LIVE marker like the hero.
- `+N more` is the honest cap. No star is invented, none is hidden silently.
- No money anywhere in this view.

### Edge cases to decide now
- **Two projects with the same leaf name:** use the shared `labelProjects`
  from `src/shared/project-label.ts` and delete the renderer's inline copy
  (a known drift risk recorded in `usage-indexing.md`).
- **Day boundary:** links use local days via the shared helper in section 5.
  Does not depend on the UTC keying fix; `sessions` carry ISO timestamps.
- **A session that spans midnight** contributes to both days. Stated in the
  caption rule, not hidden.
- **One project only:** one star, centred, no links, no "+N more".

### Verification
- `render-fit.cjs`: switch to the constellation view at all eight sizes and
  assert, via a `window.__cswConstellation()` debug accessor returning the
  layout, that every star and every label rect is inside the viewport, no two
  labels overlap, the smallest label is at least 8 px, and the view's caption
  and tag clear the mode switch and the notes bar (same checks as the strip).
  Also record `paint()` time per size in the output.
- `test/constellation.test.mjs` (pure, `src/shared/constellation.ts`):
  determinism (same input, identical output), stability (adding one project
  moves no existing star by more than one bucket radius), links derived
  correctly from a synthetic `sessions` map including a midnight-spanning
  session, the 40-star cap with "+N" count, active star chosen only inside 15
  minutes, hit test.
- `test/projection.test.mjs`: `projectLinks` present when shared, `[]` when
  not, no path or UUID in the serialised frame.

**Size: M.**

---

## 2. End-of-day Time-lapse

**One line:** a 20 second canvas overlay on whatever view is showing, driven
by wall-clock time so it always ends, replaying today's per-project hourly
activity as stars lighting up with a 24 hour trace beneath.

### Where it lives
- **An overlay, not a view or mode.** It plays over the current view, on both
  editions, and fades back. It never changes `mode`, never touches the
  window, never takes focus. On 1366x768 it covers the whole window for 20
  seconds and displaces nothing afterwards.
- **Trigger:** a scheduled local time (`timelapse.at`, default `"18:00"`,
  `null` = off) plus tray "Replay today" for manual runs. The schedule lives
  in the main process with the other timers (a `setTimeout` to the next
  occurrence, re-armed after it fires, `unref`ed).
- **Visibility gate:** if the wall is occluded at trigger time (renderer
  `document.visibilityState !== 'visible'`, which reflects native occlusion
  since `CalculateNativeWinOcclusion` stays on), the replay is deferred until
  the next visibility change, with a deadline of `timelapse.at` plus 4 hours;
  past that it is dropped, not queued into tomorrow.

### Data
- **What the index has:** `hourly` (global, UTC keys, 14 days), `sessions`,
  `projects.lastSeen`. **What it does not:** per-project activity by hour.
  Distributing a session's tokens evenly across its span would be inventing
  a shape, so the replay needs new measured data.
- **New index field:** `projectHourly: Record<hourKey, Record<projectKey,
  [requests, total, output]>>`, same 14 day prune as `hourly`, folded in the
  same place as the hourly bucket (`ingestFile`). Triples, not full
  `TokenTotals`. Estimated size: 78 hourly keys x ~2 projects x ~30 bytes,
  about 5 to 10 KB. Dropped from the renderer payload except today's and
  yesterday's keys.
- **INDEX_VERSION 3 to 4, one cold reindex** (about 5.5 s per 961 MB, so 6 s
  or so for today's tree). The loading state already covers it.
- **Order of lighting up** is the first hour a project appears today, ties by
  tokens. The trace is `hourly` today, converted to local hours.

### Rendering
- **Canvas 2D on its own full-window layer above the views**, plus a DOM
  strip along the bottom: 24 hour ticks, a moving "now" marker, a one-line
  caption. It reuses the constellation's layout and sprite code, so a project
  lights in the same place it holds in the constellation view.
- **Time-driven, not frame-driven.** `replayState(day, elapsedMs)` is a pure
  function; each frame asks for the state at `performance.now() - t0`. If
  Chromium throttles the frame rate the replay skips frames and still ends
  at 20 s, which is what makes rule 17 hold without a watchdog.
- **Frame budget:** same draw as the constellation plus one 24-column trace,
  capped at the tier's fps (12 on `low`, 24, 30). 240 frames of about 6 ms on
  `low`. Under `prefers-reduced-motion` the replay is a 4-step slideshow
  (06:00, 12:00, 18:00, now) with cross-fades disabled, or skipped entirely
  if `timelapse.reducedMotion` is `'skip'` (default `'steps'`).

### Interaction
- **Any click on the overlay ends it early** (works when the desktop is
  visible and click-through is off, which is the normal case).
- **Escape ends it in focus mode**, where the wall is focusable. Outside
  focus mode Escape cannot arrive, and the design does not pretend it does.
- **Tray "Stop replay"** while one is playing.
- **Hard stop at 20 s regardless.** Never a state the user cannot escape: at
  worst you wait twenty seconds. Hover does nothing during a replay.

### Projection
- **v1: local only.** The replay needs `projectHourly`, which would be a new
  wire field keyed by label. Defer until a screen owner asks; when added it
  is `projectHourly` (label-keyed, today and yesterday only, empty when
  `projectsShared` is off), named in both serialisers. A screen never
  schedules a replay of its own in v1.

### Honesty
- **Never plays while `indexing` or `unavailable`.** A replay of a half
  built day is a lie in motion. The scheduler checks the flags at trigger
  time and again when a deferred replay becomes visible.
- **The caption names the day and the source rule:** "Today, 06:00 to 17:58
  local · tokens per project per hour". Tokens only; **no cost, no money**,
  so the same overlay is safe over the client wall (rule 24).
- **A day with no activity plays nothing.** The scheduler skips it and logs
  one line. No empty theatre.
- `projectHourly` is MEASURED (folded at ingest). The lighting order is a
  sort of measured hours, so it is MEASURED too. Only the pacing is design.

### Edge cases, including day boundaries
- **"Today" is the local calendar day, from 00:00 local up to now**, built
  by converting UTC `hourly` and `projectHourly` keys with the shared day
  helper. Hour buckets convert exactly, so this **does not depend on fixing
  the UTC `daily` keys first**. It does depend on the helper existing.
- **Triggered after midnight** (manual, 01:30): replays the current local day
  so far, which may be 90 minutes. Not yesterday. The caption makes it
  obvious, and the tray entry can offer "Replay yesterday" later if wanted.
- **DST:** not a concern in South Africa, but the helper uses `getHours()`
  on real Date objects rather than adding 2 hours, so it is correct anywhere.
- **Two windows (multi-monitor):** the replay runs on the primary window
  only; a second window would double the software paint for no benefit.
- **The 4 second refresh floor** means the last few records may land during
  the replay. The replay snapshots the data at t0 and ignores pushes until it
  ends.

### Verification
- `test/timelapse.test.mjs` (pure, `src/shared/timelapse.ts`): at elapsed 0
  nothing is lit; at 20 000 ms every project's replayed total equals its
  measured total for the day; totals are monotonic in elapsed; hours map to
  local correctly across a UTC midnight (a 23:30Z bucket is 01:30 local); a
  day with no buckets yields `null`; snapshot ignores later pushes.
- `test/usage-append.test.mjs`: `projectHourly` accumulates per project per
  hour, is pruned with `hourly`, and a version 3 cache is discarded by
  `loadIndex`.
- `render-fit.cjs`: a `window.__cswTimelapse(elapsedMs)` accessor to freeze
  the overlay at 10 s at all eight sizes; assert the bottom strip, its 24
  ticks and the caption are inside the viewport, the caption is at least 8 px,
  and the overlay is gone from the DOM after a forced end.
- Manual, once: trigger at a real scheduled time with the wall occluded,
  confirm it defers and then plays on reveal.

**Size: L** (index bump, scheduler, overlay, settings, tray, tests).

---

## 3. Milestones

**One line:** a persisted ledger outside the cache, evaluated only after a
complete pass, announcing a crossing once through the existing notice
window and a quiet line on the wall.

### Where it lives
- **Two surfaces, both existing:** (a) the toast window's `wall:notice`
  channel, generalised from `{from, count}` to `{kind, title, sub, count?,
  ms?}`, shown 4 s for a milestone, click-through and unfocusable as today;
  (b) a one-line `.milestone-line` in the stats status strip that lingers 24
  hours ("50B tokens processed · today 14:02"), then clears. Displaces
  nothing: the strip already has room for a short item; render-fit checks it.
- **Ledger:** `<userData>/milestones.json`, the `peak.ts` pattern, because
  the usage cache is designed to be thrown away and "already announced" must
  outlive a version bump.

### Data
- **Reads:** `totals.{input,output,cacheCreate,cacheRead,requests}`, `daily`
  keys (streak), `models` keys (new model), `sessions[id].{requests,output,
  models,start}`, plus `indexing`, `unavailable` and the `rebuilt` flag from
  `refreshIndex`.
- **Ladders (fixed, not adaptive):**
  - processed: 1B, 5B, 10B, 25B, 50B, 100B, 250B, 500B, 1T (next here: 50B)
  - generated: 10M, 25M, 50M, 100M, 250M, 500M, 1B (next here: 250M)
  - requests: 10K, 25K, 50K, 100K, 250K, 500K, 1M (next here: 250K)
  - streak of active local days: 7, 14, 30, 60, 100, 365
  - first use of a model: any new key in `models`
  - biggest session: most requests in one session, and most generated tokens
    in one session, each announced when the record moves
- **Not a milestone, on purpose:** longest session by duration. Span here
  reads 1107 hours because a resumed session keeps its id, and per-record
  gaps are not in the index. Cost thresholds are excluded too: money on a
  toast that floats over every application breaks the spirit of rule 24.
- **No INDEX_VERSION bump.** First-seen per model is not stored; a new key
  in `models` compared against the ledger's `modelsSeen` is enough. Ledger
  is under 2 KB.

### Rendering
- DOM only. The strip line is text; the toast is the existing panel with a
  new `data-phase='milestone'`. No animation beyond the toast's existing
  fade, which is already disabled under `prefers-reduced-motion`.

### Interaction
- None. The toast takes no clicks (its preload exposes no actions). The
  strip line has a hover title showing the rule ("consecutive local days
  with at least one request").
- Tray checkbox `Milestone notices` toggling the toast half only; the strip
  line always shows. Open question 3 for the default.

### Projection
- **Not on the wire.** A screen lacks the ledger and would re-fire on every
  reconnect. If wanted later, an explicit `milestone: {key, at, title}`
  field carrying only those three values; nothing about who or where.

### Honesty
- **Never evaluated while `indexing` or `unavailable`, and never on the
  in-place index mid-pass.** Evaluation runs in `refreshUsage` after
  `refreshIndex` resolves, on the completed index, and only when the pass was
  not cold. A rebuild (`rebuilt: true`) evaluates once after it completes.
- **First launch seeds silently.** With no ledger, every threshold already
  crossed is written as `seededAt` with no notice. Otherwise a new install
  would announce ten years of history in one burst. Same rule after a
  deleted ledger.
- **One announcement per key, ever.** Ladder keys are `processed:50B`;
  record keys store the value, and re-announce only when the value grows.
- **Tokens are counted as the hero counts them.** A toast that says "50B
  tokens processed" agrees with the hero to the token, and the strip line's
  hover says "mostly cache reads", the hero's own caveat.
- **Bounded read:** `ingestFile` is now bounded at the stat'd size, so the
  double-count that could fire a threshold a few records early is closed.
  If that ever regresses, a milestone fires early by at most one scan's
  worth of appended records; the ledger cannot un-fire, and the design
  accepts that rather than adding a hysteresis nobody can explain.

### Edge cases, including day boundaries
- **Streaks depend on the day keying.** `daily` is UTC (`usage.ts:322`), so
  a 01:00 local session lands on yesterday's key and a streak can break or
  continue wrongly by one day at the edge. **Streak evaluation must use
  local days.** Two ways: rekey `daily` locally (needs the bump time-lapse
  already pays for) or derive active days from `sessions` start and end
  dates with the shared helper. Recommendation: do the rekey in the same
  bump, and until then the streak reads `sessions`. Either way it never
  reads UTC keys.
- **A model renamed by Anthropic** looks like a new model. That is true from
  the transcript's point of view, and the toast says "first use of
  claude-x", which is what happened.
- **Peak velocity** already has its own record and UI; milestones do not
  duplicate it.
- **Two milestones in one pass** (a burst after a long absence): one toast
  with a count ("2 milestones"), both lines in the ledger, the strip shows
  the largest. Mirrors how message notices already coalesce.

### Verification
- `test/milestones.test.mjs` (pure, `src/shared/milestones.ts`, evaluator
  takes `(index, ledger, now)` and returns `{ledger, notices}`): empty ledger
  seeds and returns no notices; crossing one threshold returns exactly one
  notice and a second call returns none; `indexing: true` returns the input
  ledger untouched; a rebuilt index with lower totals returns nothing; the
  streak counts local days across a UTC midnight; a new model key fires once;
  a session record fires only when it grows; ladder next-up is correct for
  the measured totals above.
- `render-fit.cjs`: inject the longest possible strip line ("first use of
  claude-mythos-5-1-20260901 · yesterday 23:59") at all eight sizes and keep
  the existing `stripOver <= 1` assertion green.
- `test/settings.test.mjs`: the new keys heal to defaults.

**Size: M.**

---

## 4. Shared foundations (build once)

1. **`src/shared/day.ts`:** `localDayKey(tsOrMs)`, `localHourOf(hourKeyUtc)`,
   `localDayBounds(dayKey)`. Used by the hours panel (replacing the inline
   `new Date(k + ':00:00Z').getHours()`), constellation links, time-lapse,
   milestones, and `derive()`'s currently UTC `todayKey`.
2. **One INDEX_VERSION bump (3 to 4)** carrying both `projectHourly` and the
   rekeying of `daily` and `prompts.daily` to local days. One reindex, one
   cache discard, one wire review. The wire's `daily` then means
   "source-local days", stated in `privacy-wire.md` and on the daily panel's
   hover. Not bumping twice is the whole point of doing it together.
3. **`src/shared/project-timeline.ts`:** from an index, build
   `{key, label, total, output, requests, lastSeen, days: Set<localDay>}` per
   project plus today's per-project hour series. Constellation and time-lapse
   both read this and nothing else, so they cannot disagree on which
   projects exist or what they are called.
4. **Notice generalisation:** `wall:notice` payload `{kind, title, sub,
   count?, ms?}`, one queue in `main/index.ts` replacing the message-only
   timer, toast rendering by `kind`. Message notices keep their exact
   wording and 2 s.
5. **Motion budget helper** in the renderer: reads `[data-perf]` and
   `prefers-reduced-motion` once and returns `{fps, pulse, replay}`. The
   `ActivityCanvas` tier-to-fps map moves into it so three canvases share
   one policy.
6. **Use the shared `labelProjects`** in `stats.ts` and delete the inline
   copy. DONE in `b75c6b8` (2026-09-22), before this design was read: stats.ts
   now calls `projectLabels`, which also stops a paired screen relabelling
   labels it received. Nothing left to do here beyond keying new features on
   the same function.

## 5. Build order

1. **Foundations** (day helper, index bump with `projectHourly` and local
   keys, notice generalisation, motion budget, shared labels). Everything
   else stands on these and the reindex is paid once.
2. **Milestones and Constellation in parallel.** They share nothing beyond
   the foundations and touch different files (`main/data/milestones.ts` plus
   the strip; `shared/constellation.ts` plus a new view). Milestones is the
   cheapest visible win and proves the notice queue; the constellation
   proves the software canvas budget before the time-lapse leans on it.
3. **Time-lapse last.** It reuses the constellation layout and sprites, the
   `projectHourly` field, and the day helper, and it is the only one with a
   scheduler and an overlay lifecycle, so it benefits from everything else
   already being measured.

## 6. Open questions for Gustav (recommended default in bold)

1. Constellation placement: third view, or replace "Top projects" in the
   grid? **Third view.** The grid cell is too small at 1366x768 and the
   projects list is the numbers, which the constellation would lose.
2. Time-lapse default time and behaviour when the wall is covered: **18:00
   local, defer up to 4 hours for the wall to become visible, then drop.**
3. Milestone toast default: on (floats over other apps for 4 s, no click) or
   strip-line only? **On**, since the wall is covered most of the day and a
   milestone unseen is a milestone that did not happen; tray checkbox to
   turn it off.
4. Ambient rotation between Stats and Constellation when idle: **off by
   default**, `viewRotateSeconds` available.
5. Rekey `daily` to local days in this bump, accepting that every daily bar
   shifts by up to two hours of records once? **Yes, now**, in the same
   reindex; the alternative is a permanent "today rolls at 02:00" on every
   feature that says "today".
6. Constellation links on the projection wire (`projectLinks`, labels only,
   off with project sharing)? **Yes**, one explicit field; time-lapse and
   milestones stay local in v1.
7. Threshold ladders as listed, or a shorter set? **As listed.** Fixed,
   round, and printed in the toast, so a number is never surprising.
