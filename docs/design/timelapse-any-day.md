# Time-lapse of any day: an animated line graph

**Status:** built 2026-09-23 (see docs/work-timelapse.md for what shipped and what was measured). Design written the same day. Requested by Gustav: "I dont really get what its displaying. Could we make so a user can view a timelapse of any day? I think the timelapse should be an animated line graph changing and changing as it goes, showing like token usage and 2 other cared about stats so a user can see spikes etc."
**Replaces:** the star replay in `src/renderer/timelapse.ts` and the `projectHourly` index field, which existed only for it.
**Rules that bind here:** 12 (nothing invented), 15 (readiness stated by main), 17 (always ends, click ends it), 24 (no money), 34 and 35 (`--u` sizes, drop a caption before clipping a number), 38 (local days, never `daily`), 39 (repaint on change, capped by tier), 41 (a shown number never falls).

## 0. The criterion

A viewer with no explanation must read, in two seconds, "this is one day, drawn through time, and that bump is a spike". Every point on the graph must be measured from a transcript record with a timestamp in that five-minute slot. Any day that has transcript data must be playable, cheap enough for a software-painted 24/7 wall, and must survive cache bumps and transcript deletion. Days that only exist as reconstructed totals are said to be that, never drawn.

## 1. Data source: five-minute buckets per transcript, kept forever

**Measured on 2026-09-23** (full scan of 466 transcripts, 829 MB, 8.2 s, 56,525 assistant records over 43 days, 2026-07-11 to 2026-09-23):

| Day | Requests | Tokens | Active 5-min buckets | Peak 5-min bucket | Median bucket | Peak hour | Peak 5-min as share of peak hour |
|---|---|---|---|---|---|---|---|
| 2026-09-22 | 2,685 | 1,203M | 97 | 45.3M | 8.5M | 258.5M | 0.18 |
| 2026-09-10 | 335 | 109M | 16 | 28.4M | 5.6M | 58.2M | 0.49 |

The busiest five minutes of the busy day hold 18% of its busiest hour: an hourly bar hides the burst entirely. Five-minute buckets show a 5x peak over the median. One-minute buckets are dominated by single records (a 1M-token cache read is one line) and read as noise, and 1,440 slots is more than the graph has pixels at 1366 wide. **Resolution: 5 minutes, 288 buckets per local day.** Serialised size: 1.3 KB per active day aggregate, about 2 KB per day split by project; 43 days is about 90 KB; at 250 active days a year, about 0.5 MB a year. One-minute buckets measured at 4.5 KB per day (192 KB for 43 days), kept as the switch condition below.

**Options weighed.**

- **(a) Persistent buckets at ingest, in each file's contribution. CHOSEN.** `FileContribution` gains an optional `intraday` map, filled by `fold` from the same record the totals come from. There is NO index-level aggregate: a day is built on demand by summing `intraday[day]` across `index.files[*].contrib` and `history.entries[*].contrib`. A path is in exactly one of those two (the rule 41 invariant), so the sum is exact, an archived transcript keeps its curve, a restored one is counted once, and the cache holds each bucket once. Cost: `INDEX_VERSION` 5 to 6 for one cold reindex (5.5 s once, stale contributions handed over by `loadIndex` as today), cache growth as measured above, and about 15 added lines in `fold`.
- **(b) On-demand scan of one day's transcripts via IPC.** Rejected. The mtime filter is a superset that grows with age: for a day two months back every file touched since then qualifies, which is the whole 829 MB (8 s on the main process, per view). It cannot see a deleted transcript at all, so a day's curve would fall below its total after a deletion, which rule 41 forbids. It would also need its own cache with its own invalidation. **Switch condition:** if the reindex shows the cache above 4 MB or `saveIndex` above 50 ms, move `intraday` out of the cache into its own file keyed by path, not to (b).
- **(c) Hybrid.** Redundant: the cold reindex already reads every transcript on disk, so (a) covers every day that (b) could.
- **Do nothing.** Keeps the 14-day `projectHourly` window and hourly resolution, which is the complaint.

**Shape**, in `src/main/data/usage.ts`:

```ts
/** [requests, totalTokens, outputTokens] in one five-minute slot of one local day. */
export type IntradayCell = [number, number, number];
/** localDay -> projectKey (lowercased cwd, as `projects`) -> bucket "0".."287" -> cell. */
export type Intraday = Record<string, Record<string, Record<string, IntradayCell>>>;
export interface FileContribution { cv: number; /* unchanged fields */ intraday?: Intraday; }
```

- `cv` STAYS 1. `loadIndex` only hands back stale contributions whose `cv === CONTRIB_VERSION`; bumping it would drop every archived contribution on the upgrade, the exact loss rule 41 exists to prevent. `intraday` is optional; absent means "recorded before minute detail existed" (any entry archived before this version, and the seed; on Gustav's machine today the store holds the seed and no archived entries, checked 2026-09-23).
- Bucket: `bucketOf(tsMs) = Math.floor((d.getHours() * 60 + d.getMinutes()) / 5)` with `d = new Date(tsMs)`; day: `localDayKey(tsMs)`. Same local-day rule as `activeDays`, so for every file `sum of intraday[day][*][*][0] === activeDays[day]`. The test pins that equality.
- Records with no `cwd` fold under the key `""` so their tokens are in the curve and the label is blank. Sidechain (subagent) records are counted, as they are everywhere else in the index.
- `projectHourly` is DELETED: type, ingest, prune, the `usage-append` checks on it, and the render-fit fixture. `hourly` stays: `stats.ts` and the projection wire read it.
- `INDEX_VERSION = 6`, with a comment in the version history: "intraday buckets per file, for the any-day time-lapse; `projectHourly` removed".

## 2. The three series, and how they share one graph

**Chosen: tokens processed, tokens generated, requests, per five minutes.** They are the three words already on the dashboard's hero tiles, so the graph needs no new vocabulary, and they explain each other: a token spike with few requests is one huge context (a long session resumed, a big file read); a request spike with few tokens is a tool loop, many small steps; generated tokens rising is Claude writing (code, a document) rather than reading. All three are in every record, so no new ingest rule (rule 12). Ruled out: cost (rule 24); tool calls (a fourth number, and a new metric to explain); prompts (only about 60 a day, better as a later marker than as a lane); cache hit rate (a ratio, which hides the size of what happened).

**Layout: three stacked lanes, one shared time axis, one playhead through all three.** Lane heights 2:1:1 (processed on top, it is the headline). Each lane has its own vertical scale, fixed from frame 0 at that day's peak for that series, and states it: lane name top-left, `peak 45.3M / 5 min` top-right. Rejected: dual axes (three series do not fit two axes and the reader guesses which line owns which); one overlaid normalised lane (hides that generated is 1% of processed, which is the honest story). **Switch condition:** if render-fit shows the third lane under 48 px tall at 1366x768, drop lane three to a 24 px sparkline with its peak label only (rule 35: drop, never clip). Lane heights and every text size are multiples of `--u`.

Colours from the existing replay palette: processed `oklch(0.8 0.13 75)` (the amber the total already uses), generated `oklch(0.8 0.14 200)`, requests `oklch(0.85 0.02 220)`. Each line is a 2 px polyline through bucket centres with a 12% alpha fill to the baseline. No smoothing: a straight segment between measured points is the shape the data contains.

## 3. The animation

"Changing as it goes" means: **the lines draw themselves left to right behind a moving playhead while a clock and three running totals count up.** Time is uniform: one hour is the same width everywhere, so a spike is a spike and a lull is a lull.

- **Axis.** From `floor(firstActiveMinute / 60)` to `ceil(lastActiveMinute / 60)` hours, minimum span 2 hours; for today, the right edge is `ceil(now / 60)` and the playhead stops at `now`, exactly the 09:05 rule the old replay learned (the current bucket's share is measured against the part of it that has passed, not its full five minutes). Hour ticks are drawn from frame 0.
- **Timing constants** (`src/shared/timelapse.ts`): `LEAD_MS = 700` (axes, lane names and peaks visible, nothing moving, so the frame is read before it changes), `SWEEP_MS = 20_000` (playhead from axis start to `endMinute`, linear in elapsed time), `HOLD_MS = 2_500` on the finished day, `FADE_MS = 450`. **Hard stop at `LEAD_MS + SWEEP_MS + HOLD_MS = 23.2 s`** from `t0`, whatever the frame rate did; a dropped frame skips ahead and never stretches it. Any `pointerdown` ends it at once. Never takes keyboard focus. (Rule 17.)
- **Per frame** the pure `replayFrame(series, elapsedMs)` returns `{ t, minute, revealed, frac, totals, onProject, peakShown, done }`. `revealed` buckets are drawn whole; bucket `revealed` is drawn to the playhead's x by linear interpolation and contributes `value * frac` to the totals, so the totals never go backwards and equal the measured day totals at `t = 1`, to the token.
- **Header** (DOM, static positions, `tabular-nums`, no layout shift): title `Tuesday 22 September` or `Today so far`; under it `replayed 09:00 to 17:40`; centre: the clock at `--u * 54`; under the clock `on muchbetter-client-wall`, the project with the most tokens in the bucket under the playhead, blank in an empty bucket; right: three running totals, `1.20B processed`, `12.4M generated`, `2,685 requests`.
- **The peak.** The bucket with the most processed tokens is marked when the playhead passes it: a dot on lane one and a label `peak 45.3M in 5 min, 14:35, on muchbetter-client-wall`, which stays for the rest of the replay. The lane's fixed scale means the eye already saw how tall a spike could be; the label names it.
- **The first two seconds** (Gustav's complaint): title says which day; the axis with hour ticks, the three lane names and their peaks are on screen during `LEAD_MS`; the caption reads `Each line draws through the day. Height is the amount in each five minutes, as measured. Click anywhere to close.` Then the playhead starts moving with the clock on it. Nothing is a metaphor.
- **Reduced motion** (`prefers-reduced-motion: reduce`, read once at play): no sweep. The complete graph, peak label and day totals are drawn at once, held `REDUCED_HOLD_MS = 10_000`, click ends. The pure function takes `reduced: boolean` and returns the `t = 1` frame for any elapsed.
- **Performance tier.** One `<canvas>` for the graph, frame-capped 12 / 24 / 30 fps by `body[data-perf]` as now; a frame is skipped when the playhead has not moved a whole pixel. Per frame it clears and draws at most 3 x 288 segments plus two labels: measured budget target under 4 ms at 2560x1440 on the software tier (section 7). Nothing runs while the overlay is closed (rule 39). The overlay snapshots its series at play and ignores usage pushes until it ends.

## 4. Choosing a day on a window that cannot take keyboard focus

Two controls where "Today" is now, clicks only:

- **`Today`** plays today at once, unchanged in name and position.
- **`Any day`**, beside it, opens a **month grid** popover (`.dp-pop`, the `.ms-pop` pattern: `position: absolute` under the buttons, closes on `pointerdown` anywhere outside, mutually exclusive with the milestones list). Header: `‹`, `September 2026`, `›` as buttons; months before the first day with data and after this month are not offered. Seven columns, Monday first, one cell per day. Clicking a playable day closes the popover and plays it; there is no confirm step.

Cell states from `wall:timelapseDays`, each with a `title` tooltip (hover needs no focus):

| `data-shape` | Meaning | Look | Click |
|---|---|---|---|
| `full` | every request that day has minute detail | bright, number | plays |
| `partial` | some requests are in archived transcripts without minute detail | bright with a small dot; title `320 of 335 requests have minute detail` | plays, captioned |
| `total` | reconstructed only (the seed's 28 days, or an archived contribution without `intraday`) | dim, `cursor: default`; title `Total only: reconstructed, no minute detail to replay` | nothing |
| `none` | no record that day | very dim | nothing |
| `future` | after today | hidden | nothing |

Today is outlined. A footer line under the grid: `Bright days can be replayed. Dim days have a total only.` Wheel scrolling is not needed: a month is six rows.

**Where the days come from.** `offeredDays(mergedActiveDays, files, entries)` in `src/shared/intraday.ts`: for each local day in the merged `activeDays` (which includes the seed's days), `requests = activeDays[day]` and `shaped = sum of intraday[day][*][*][0]` over live and archived contributions. `full` when equal, `partial` when `0 < shaped < requests`, `total` when `shaped === 0`. Nothing reads `daily` (rule 38).

## 5. States

| State | Button | Picker | Overlay |
|---|---|---|---|
| Indexing (`usage.indexing`) | disabled, title `Still reading transcripts` | not offered | never opens (rule 15) |
| Source unavailable | disabled, as now | not offered | never opens |
| Today, nothing recorded yet | `Today` disabled, title `Nothing recorded yet today` | offered, today is `none` | |
| Today in progress | enabled | today `full` or `partial` | axis to the next hour, playhead stops at now, title `Today so far`, subtitle `replayed 09:00 to now` |
| Finished day, full | | plays | as section 3 |
| Partial day | | plays | caption prefixed `15 requests from archived transcripts are in this day but not in the curve.` The totals shown are the curve's, never the day total |
| Reconstructed-only day | | not clickable | if reached anyway (a stale list): the overlay shows `15 Jul has a total only, nothing to replay` for 4 s, click ends |
| Day the main process cannot read (IPC rejection) | | | `Could not read that day` for 4 s, click ends. Logged in main |
| Paired screen (`projection.role === 'screen'`) | both hidden (`data-replay="off"`) | hidden | never; `intraday` does not cross the wire, `docs/privacy-wire.md` stays true |

## 6. Where the code goes

**Pure, `src/shared/` (no Electron, node-testable, types declared structurally as `usage-merge.ts` does):**

- `intraday.ts` (new): `BUCKET_MINUTES = 5`, `BUCKETS_PER_DAY = 288`, `bucketOf(tsMs)`, `foldIntraday(intraday, day, projectKey, bucket, cell)`, `collectDay(day, live: Record<path, {contrib}>, archived: Record<path, {contrib}>, requests: number, asOf: number): DayRaw`, `offeredDays(...)`. `collectDay` throws if a path is in both maps: that is a broken invariant, not data.
- `timelapse.ts` (rewritten): `buildDaySeries(raw: DayRaw, labelOf, now): DaySeries`, `replayFrame(series, elapsedMs, reduced): ReplayFrame`, the timing constants, `hh`.

```ts
export interface DayRaw {              // what wall:timelapseDay returns
  day: string; asOf: number; bucketMinutes: 5;
  projects: Record<string, { display: string; cells: Record<string, IntradayCell> }>;
  requests: number;                    // merged activeDays[day]
  shapedRequests: number;              // sum of cells[*][0]
}
export interface DaySeries {
  day: string; today: boolean; asOf: number;
  fromMinute: number; toMinute: number; endMinute: number;   // axis and playhead stop, minutes from local midnight
  tokens: number[]; output: number[]; requests: number[];     // length 288, zero where empty
  onProject: (string | null)[];                                // busiest project label per bucket
  peak: { bucket: number; tokens: number; label: string | null } | null;
  totals: { tokens: number; output: number; requests: number };
  missingRequests: number;                                     // requests - shapedRequests
}
export interface ReplayFrame {
  t: number; minute: number; revealed: number; frac: number;
  totals: DaySeries['totals']; onProject: string | null; peakShown: boolean; done: boolean;
}
export interface TimelapseDays { today: string; days: Record<string, { requests: number; shaped: number }> }
```

**Main, `src/main/index.ts`:** two handlers, both refusing while `usageIndexing` (they resolve `null`, and the renderer never asks while indexing):

- `ipcMain.handle('wall:timelapseDays', () => offeredDays(mergedUsage().activeDays, usage.files, currentHistory().entries))`
- `ipcMain.handle('wall:timelapseDay', (_e, day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) ? collectDay(day, usage.files, currentHistory().entries, mergedUsage().activeDays[day] ?? 0, Date.now()) : null)`

Neither touches a push: `usageForRenderer` does not carry `intraday` (a full year would be 0.5 MB on every push, and 170 KB was already too much). Payload per day is under 20 KB.

**Preload:** `timelapseDays()` and `timelapseDay(day)` on `wall`; the comment "exactly these five calls" is updated to the real count.

**Renderer:** `timelapse.ts` rewritten as the line-graph overlay (`WorkReplay.play(series: DaySeries)`); `day-picker.ts` (new, `DayPicker` class); `actions.ts` wires `Any day`, fetches `timelapseDays` on open, `timelapseDay` on pick and on `Today`, and labels projects exactly as it does now (`labelProjects` on the display paths). `styles/actions.css`: `.replay-graph` (the canvas box, `flex: 1`), `.replay-lane-name` and `.replay-lane-peak` as DOM so render-fit can measure them (absolutely placed over the canvas at lane tops, computed from the same 2:1:1 split in CSS `grid-template-rows: 2fr 1fr 1fr`), `.replay-sub`, `.replay-on`, `.replay-stats`, and the `.dp-*` rules. `window.__cswTimelapse(ms)` stays for the render suite and returns the header, graph, lane label and caption rects.

**Deleted:** `buildWorkDay`, `WorkProject`, `WorkDay`, `replayState`, the `layoutConstellation` and `roundRect` imports in the renderer, `.replay-sky`, `.replay-canvas`, `.replay-trace`, `.replay-col`, `.replay-bar`, `.replay-tick`, `projectHourly` everywhere (section 1), and `docs/work-timelapse.md` is rewritten to describe this (keep its "why it always ends" and "today is the local day" sections, they still hold).

**Tests the implementer must write** (same `ok()` style, each fix revert-checked):

- `test/intraday.test.mjs` (new): `bucketOf` at 00:00 and 23:59 local; a record at 00:30 local on a UTC+2 machine lands in the local day, not the UTC one; `foldIntraday` sums two records in one slot; `collectDay` sums a live and an archived contribution and throws on a path in both; a contribution without `intraday` counts in `requests` but not `shapedRequests`; `offeredDays` yields `full`, `partial`, `total` for three fixtures and never a day absent from `activeDays`. Revert check: with the `localDayKey` swapped for `ts.slice(0, 10)`, the 00:30 check fails.
- `test/timelapse.test.mjs` (rewritten): axis floor and ceiling, 2-hour minimum, today's `endMinute` at now; at `LEAD_MS` nothing revealed; totals monotonic in 250 ms steps to the hard stop; at `t = 1` totals equal `DayRaw` sums to the token; the peak bucket, its time and label; `onProject` is the busiest project in that bucket; `missingRequests`; `reduced` returns the complete frame at 0 ms; the current bucket completes exactly at now (the 09:05 rule). Revert check: counting buckets after `endMinute` fails four checks.
- `test/usage-append.test.mjs` (extended): `intraday` is folded per file, per local day, per project, per bucket; for every file `sum(intraday[day][*][*][0]) === contrib.activeDays[day]`; a v5 cache is discarded and its contributions handed back.
- `test/usage-history.test.mjs` (extended): index three transcripts, `collectDay` for their day, delete one, refresh, `collectDay` again: identical series.
- `test/render-fit.cjs`: `wall:timelapseDays` and `wall:timelapseDay` stubs from a fixture day of 40 buckets across three projects with one clear peak. At **all eight sizes**: `Today` opens the replay; frozen at `LEAD_MS + 10_000` the header, graph, three lane names, three peak labels and caption are inside the window and the smallest text is at least 8 px; frozen at the hard stop the three totals equal the fixture's sums; a click ends it. At 1366x768 and 2560x1440: `Any day` opens the grid inside the window; a `total` cell click opens nothing; a `full` cell click opens a replay whose title carries that date; a click outside closes the grid.

## 7. Risks, and what to measure first

1. **Software canvas cost.** Measure ms per frame at 2560x1440 with `data-perf="low"` before styling anything. Expected under 4 ms (864 short segments). If over 20 ms, the fallback is 8 fps on the low tier, not fewer points.
2. **Cache growth and write time.** After the version 6 reindex, read `usage-index.json` size (859 KB today; expect about 950 KB) and time `saveIndex`. The section 1 switch condition applies at 4 MB or 50 ms.
3. **The bump must lose nothing.** Run `test/usage-history.test.mjs` first: the v5 to v6 handover is the same path that lost 19.6B tokens once. Confirm on Gustav's machine that the hero total is identical before and after the reindex.
4. **`offeredDays` cost** is 466 contributions times their days per open, on demand; measure it, expect under 5 ms. It is never computed on a push.
5. **Tooltips on a `focusable: false` window.** Verify a `title` shows on hover of a dim day before relying on it; if it does not, the footer line already carries the explanation.
6. **Partial days will look shorter than the daily chart's bar** for the same date, by design and by caption, and also because the chart's bar is a UTC day. Say the second reason in the caption only if Gustav asks; it is rule 38's standing decision, not this feature's.
7. **Records without `cwd`** (the `""` project) show a blank `on` line; measure how many there are in the reindex log. If it is more than a few percent, label them `no project` rather than blank.
