# Derived metrics

**Last updated:** 2026-09-03
**Code snapshot:** commit `a696f5d`. Line references are against that commit; the
working tree was being edited while this was written (see [Drift at the time of
writing](#drift-at-the-time-of-writing)).
**Primary sources:** `src/renderer/stats.ts`, `src/renderer/styles/stats.css`,
`src/main/index.ts`, `src/main/projection/source.ts`

## Summary

Every panel in Claude Stats carries a tag, **MEASURED** or **DERIVED**, and the
tag is not decoration. It is the mechanism that keeps a dashboard of real numbers
from quietly acquiring an invented one. Seven panels are measured, two are
derived, and three metrics that a usage dashboard would normally show (quota,
headroom, cost) are absent because they cannot be read locally at all.

This document covers what that distinction buys, how velocity and intensity are
computed, what the live throughput trace is actually plotting, what context
efficiency measures, and the bug where the source machine froze its time-windowed
values because the renderer only repainted when new data arrived. That last one
is the reason a 20 second clock exists, and the reason this document ends with a
verified decay curve rather than an assurance.

---

## Total cost

**DERIVED, and further from measured than anything else on the dashboard.**

No transcript records a cost. Every record type in a session file was scanned
for a key containing "cost" and there is none: Claude Code's own `/cost` and
`/usage` compute it in process from the token counts, which ARE recorded.
`src/shared/pricing.ts` does the same arithmetic over every project on this
machine.

### What the number is not

It is not a bill. On a subscription nothing here was charged per token. It is
what the same work would have cost through the API at list prices, and it covers
only sessions on this machine.

### The rates

Dollars per million tokens, captured 2026-09-04:

| Model | Input | Output |
|---|---|---|
| Fable 5 / 5.1, Mythos 5 / 5.1 | 10 | 50 |
| Opus 5, 4.8, 4.7, 4.6 | 5 | 25 |
| Sonnet 5 | 2 | 10 |
| Sonnet 4.6 | 3 | 15 |
| Haiku 4.5 | 1 | 5 |

Then the multipliers, which are where a naive implementation goes wrong:

- a cache read is **0.1x** the input rate, except on Fable 5.1 where it is
  **0.025x** ($0.25 per million against a $10 input rate)
- a cache write is **1.25x** at the five minute TTL and **2x** at one hour, so
  the split matters and the indexer reads it per record from
  `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`
- a server side web search is **$0.01**

### How the rates were checked

Against a real `/usage` breakdown, by feeding Claude Code's own reported token
counts through `costOf` and comparing dollars:

| Model | Computed | Claude Code |
|---|---|---|
| Sonnet 5 | $1.123 | $1.12 |
| Haiku 4.5 (with one web search) | $0.0464 | $0.0464 |
| Fable 5.1 | $62.24 | $61.63 |

Sonnet matches to the cent. Haiku only matches once the web search is counted,
which is what pins that price. Fable 5.1 is within the rounding of the displayed
token counts, and would be about $18 high if the 0.025x cache read factor were
wrong, so it is the load-bearing case.

**What could not be checked this way:** a whole session. `/usage` reports for a
window that is not the whole transcript file, so comparing its session total
against a sum over the file compares different things. An attempt to do so gave
$802 against $331 and the discrepancy was entirely in which records were
counted, not in the rates.

### Unpriced models

A model the table does not know contributes **null**, not zero, and its tokens
are accumulated separately into `unpricedTokens`. The card then says so. Zero
would have made the total quietly too low with nothing on screen to indicate it,
which is the failure mode this whole document exists to avoid.

### Never rounded up

`formatCost` floors to the cent. `toFixed(2)` rounds half away from zero, so
$22,523.469 would print as $22,523.47 and claim a cent that was not spent. An
estimate people will compare against a bill should err low.

### Prices go stale

The table is a snapshot with a date on it. Nothing checks it against a live
source, and a price change makes the number wrong with no signal. Re-check it
against the `claude-api` skill when a model is added or a rate moves.


## Hours

The small block beside Total cost: how many hours Claude has run, in whole
hours, never turned into days (Gustav, 2026-10-10). Code:
`src/shared/active-time.ts`.

**What counts.** Two responses in the same transcript at most five minutes
apart are joined into one stretch of work. Every transcript's stretches (main
sessions and subagents) are merged, so an hour with three sessions running side
by side counts once. A pause longer than five minutes counts nothing. Each
transcript keeps its own stretches in its contribution (`contrib.active`, index
version 9), so a deleted transcript keeps its hours, exactly as it keeps its
tokens.

**Why not the obvious sources.** Measured on 2026-10-10 over 980 transcripts:

| Source | Problem |
|---|---|
| Session start to end | A resumed session keeps its id; one spans 1107 hours here |
| Claude Code's `turn_duration` records | Only since 31 Aug, in 65 of 972 transcripts; turns overlap (271.8 hours summed, 232.3 distinct) and include hours waiting on background tasks |
| Five-minute slots with any response | 245.2 hours where the turns say 199.9: one response counts a whole five minutes |
| **Responses at most 5 minutes apart, merged** | **197.1 hours over the same period, against 199.9.** Used |

So `turn_duration`, de-duplicated across every session, is the yardstick, and
the chosen method lands within 1.5% of it.

**Since when.** The reconstructed history before 11 Jul (the seed) has totals
but no times, so it cannot add hours. The block says "since 11 Jul" (the first
stretch on record) rather than letting the figure pass for all time. That note
is deliberately not in the short-screen hide list.

**Cost.** Merging about 2,300 stretches takes 1.6 ms per push; they add 83 KB
to the cache. A paired screen receives two numbers (`activeTime.seconds` and
`since`); a source too old to send them hides the block rather than showing 0.

## MEASURED versus DERIVED, and why the label exists

`panel(title, tag, extraClass)` (`stats.ts:235-242`) stamps every panel header
with one of `MEASURED`, `DERIVED` or `N/A`.

| Panel | Tag | Line |
|---|---|---|
| Total tokens processed | MEASURED | `stats.ts:548` |
| Live throughput | MEASURED | `stats.ts:579` |
| Velocity | DERIVED | `stats.ts:592` |
| Totals | MEASURED | `stats.ts:602` |
| Daily activity | MEASURED | `stats.ts:620` |
| Context efficiency | DERIVED | `stats.ts:626` |
| Models | MEASURED | `stats.ts:640` |
| When you work | MEASURED | `stats.ts:645` |
| Top projects | MEASURED | `stats.ts:654` |

The third tag value, `unavailable`, rendering as `N/A`, has **no call site**. What
cannot be known is not given a panel at all; the disclosure lives on the hover
title of the version item in the status strip (`stats.ts:685-687`): "No quota,
plan limit or cost data exists locally, so none is shown."

### Why bother tagging at all

Because a dashboard is a claim about a machine, and the two kinds of claim have
different failure modes. A measured number can be stale. A derived number can be
**wrong while looking healthy**, which is worse, because it carries the same
authority as the ones next to it.

The project has two concrete cases behind the rule:

1. **The rate limit metric that did not exist.** A count of rate limit events was
   built by matching text in transcripts. It reported 200, which turned out to be
   its own internal cap: it had matched conversations about *building* rate
   limiters. The metric was deleted rather than tuned (`usage.ts:167-175`), and
   `Do not break` rule 12 followed: if a number cannot be read out of the
   transcripts, it does not go on the dashboard.
2. **The true number that was not honest.** "Total tokens processed" is correct
   and, on its own, reads as consumption. `ARCHITECTURE.md` records the measured
   composition as 97.24% cache reads, 2.54% cache writes, 0.21% generated and
   0.01% fresh input. Cache reads are the same context re-read on every turn. So
   the hero now carries a proportion strip and a legend directly beneath it
   (`stats.ts:557-574`, filled at `stats.ts:867-891`) and the counter is labelled
   "Generated" rather than "Output tokens" (`stats.ts:609`).

The second case is the one that generalises: a true number is not automatically an
honest one, and the tag plus the method line under each derived panel is how the
UI says which kind you are looking at.

### The method is printed on the panel

Both derived panels state their own arithmetic in the interface, not just in a
comment:

- Recent volume: "tokens, last 10 min" and "everything processed, mostly cache reads" (`stats.ts`)
- Context efficiency: "cache reads / (cache reads + cache writes + fresh input)"
  (`stats.ts:635`)

That is deliberate. A derived number whose method is only in the source is, to the
person looking at the wall, indistinguishable from one that was made up.

---

## Velocity

`derive()` (`stats.ts:170-229`) computes everything time-dependent in one place.
Velocity is the first thing it does (`stats.ts:173-182`):

```
window   = 10 minutes                     (VELOCITY_WINDOW_MS, shared/velocity.ts)
tokens   = sum of recent[i][1] where now - ts <= window
velocity = tokens > 0 ? tokens / 10 : 0
```

**Divided by the window, not by the age of the oldest record in it.** The number
changes only when the facts change: it holds steady while the same records are in
view, and falls as they age out, reaching zero ten minutes after the last one.

### The wall shows a quantity, not a rate

`velocityOf` returns per minute and everything internal uses it that way:
intensity, the persisted peak, and the projection wire. **The card multiplies it
back up and shows the window total**, labelled `tokens, last 10 min`.

That was the third attempt at this panel and the first that answered the actual
objection. Gustav's words about the per-minute version: "its per min but
calculated per 10min, am i right to bring this up?" The arithmetic was fine, and
answering only that talked past him. A number labelled per minute that moves one
tenth for each minute of new work, and still reads 1.8M nine minutes after the
work stopped, does not describe any minute a person is looking at. The complaint
was about the unit, not the division.

The tempting fix, a shorter window, is refused by the data. Claude Code writes one
record per assistant response, so a long thinking turn is a gap with nothing in
it. Measured across thirty minutes of real activity:

| Window | Reads | Behaviour during ACTIVE work |
|---|---|---|
| 1 min | 2.75M/min | hits zero repeatedly |
| 2 min | 4.12M/min | hits zero repeatedly |
| 5 min | 2.56M/min | hits zero repeatedly |
| 10 min | 1.82M/min | range 0.26M to 2.34M |
| 20 min | 1.81M/min | range 0.48M to 1.81M |

A faster rate is a lie in the other direction. This data cannot support a rate at
any resolution finer than about ten minutes, so the wall shows a quantity with
the window as its only time unit: one unit, no conversion, no claim about any
individual minute.

The peak is stored per minute and displayed the same way, multiplied by the
window, so the two numbers on the card are in the same units.

### What it used to do, and why that was wrong

Until 0.9.9 the divisor was `max(1, (now - earliest) / 60000)`, the time since the
oldest record still in the window. The numerator sat still while the divisor grew,
so the reading fell with no new work at all. Measured on the live buffer, the same
three records and the same 2.65M tokens read:

| Minutes since the last record | Old reading |
|---|---|
| 1 | 2,355K |
| 3 | 847K |
| 5 | 517K |
| 7 | 372K |
| 9 | 290K |

A 1/t curve, which is exactly what "drops a little then plateaus" looks like from
the sofa. Gustav found it by noticing the wall said Claude had been quiet for seven
minutes while the rate beside it read half a million a minute. Both were true. Only
one of them was what the card claimed to be showing.

It was also a label mismatch: the note said "trailing 10 minutes", which describes
the new formula, not the one that was running.

**The ratio between them is `10 / spanMin`, floored at 1, so the old reading ran
between 1x and 10x the new one** depending only on how tightly the work was bunched.
Measured across the live buffer: mean 2.16x, worst exactly 10.00x.

The stored peak is versioned for that reason and a record from the old definition is
discarded rather than converted (`main/data/peak.ts`). Not because the old number was
out of reach: that was the first reason written down and it was wrong. The new formula
reached 26.4M/min in the same buffer against a stored record of 9.6M, so it would have
been beaten within the hour. The reason is that a high water mark mixing two
definitions measures nothing, whichever number is larger.

### Bounds worth knowing

`recent` holds at most 600 entries (`RECENT_EVENTS`, `usage.ts`). In a busy ten
minutes the window could in principle be clipped by the ring rather than by time,
which would make the average silently too low. **Measured 2026-09-04 rather than
left as a worry: the busiest ten minute window in a full 600 record buffer held
128 records.** Not close to the cap.

**What "tokens" means here.** The sum is input plus output plus cache writes plus
cache reads, and on this machine cache reads are 97.27% of it. So the reading is
overwhelmingly context being re-read, not text being generated, which is why the
card says so out loud: "everything processed, mostly cache reads". It is the same definition as the headline
TOTAL TOKENS PROCESSED and the same components the cost stat prices, so the three
agree with each other. A velocity counting only generation would contradict the
number sitting next to it.

**How much the averaging dilutes.** During real activity, very little. At the most
recent burst on 2026-09-04 the work spanned 9.0 of the 10 minutes: 1.96M/min
averaged against 2.19M/min over just the working span, an 11% difference. The
average only reads low when work has genuinely stopped, which is the point.

`derive()` also computes `tokensPerRequest`, `activeHours`, `todayTotals` and
`weekTotals` (`stats.ts:187-226`). **No caller reads any of them.** The only
consumers of the returned object are `intensity`, `velocity`, `cacheHitRate` and
`sinceLast` (`stats.ts:849-911`, `stats.ts:1089-1091`). They are computed on every
push and every clock tick for nothing. Recorded as a finding; the arithmetic is
cheap and nothing is wrong with it, it simply has no reader.

---

## Intensity

Intensity is the visual budget, and it follows from velocity plus recency
(`stats.ts:204-207`):

```
vNorm     = min(1, velocity / 400000)
recency   = sinceLast < 1 min   ? 1
          : sinceLast < 15 min  ? 0.55
          : sinceLast < 60 min  ? 0.22
          :                       0.06
intensity = max(0.06, min(1, vNorm * 0.65 + recency * 0.5))
```

It is published two ways (`stats.ts:849-850`, repeated at `stats.ts:1090-1091`):
as the `--intensity` custom property, read by the CSS for glow and pulse strength,
and as a coarse `data-intensity` of `high` above 0.66, `mid` above 0.3, `calm`
otherwise.

Three properties fall out of the formula and all three are visible:

- **The floor of 0.06 means the wall is never completely dead.** An idle machine
  is quiet, not off.
- **Recency is a step function**, so the wall visibly changes character at one
  minute, fifteen minutes and one hour rather than fading continuously. The code
  does not say why steps were chosen over a smooth decay, and this document does
  not guess.
- **Neither input can reach `high` on its own.** Recency contributes at most 0.5
  and velocity at most 0.65, and both are under the 0.66 threshold, so the `high`
  tier always needs the two together. Since a nonzero velocity implies a record
  inside the last ten minutes, recency is then at least 0.55, and the crossing
  point works out at roughly 237K tokens per minute when the last record is 1 to
  15 minutes old, or roughly 98K when it is under a minute old. Derived from the
  arithmetic, not measured.

Intensity is also what makes the motion budget honest: an idle wall is visually
quiet *and* cheap, because the same number that decides brightness decides how
hard the canvas animates (`stats.ts:467`, `stats.ts:472`).

---

## The live throughput trace

`ActivityCanvas` (`stats.ts:398-521`). The panel is tagged MEASURED, and the
reason it can be is that every column is a real time bucket of real token counts.

### What one column is

`update()` (`stats.ts:419-433`) rebuckets the whole ring on each call:

```
WINDOW = 20 minutes
N      = 150 columns
i      = N - 1 - floor((age / WINDOW) * N)     newest on the right
```

20 minutes over 150 columns is **8 seconds per column**, which is exactly what the
caption underneath says: "Tokens per 8sec column over the last 20 minutes"
(`stats.ts:586`). That wording was set in commit `816774b`, which also removed a
duplicate scale label that had been sitting underneath it.

The value summed into each bucket is `recent[i][1]`, the record's total tokens,
which is `input + output + cacheCreate + cacheRead` as computed at ingest
(`usage.ts:256`).

### What the vertical axis is, and is not

```
peak  = max(1, ...buckets)                (stats.ts:431)
v     = raw / peak
barH  = pow(v, 0.55) * h * 0.82           (stats.ts:494-495)
```

The height is **relative to the tallest column currently in the window**, and the
`pow(v, 0.55)` compression lifts small buckets so they stay visible beside a peak.
There is no y axis and no absolute unit, and none is claimed: columns are
comparable to each other within a frame, and not comparable across time. A busy
20 minutes and a quiet 20 minutes can produce identically tall traces.

### An empty bucket draws nothing

This is the strongest statement the panel makes, and it was not always true
(`stats.ts:482-493`). The chart used to add a small animated ripple to empty
buckets so it would not look dead. That was **decoration shaped exactly like
data**: a quiet stretch read as light activity when the truth was none.

The trace gets its life instead from two things that could not be mistaken for
measurements: a slow sweep along the baseline (`stats.ts:506-514`) and a pulsing
leading-edge marker showing where "now" is (`stats.ts:516-519`). Both scale with
intensity, so a busy wall moves and an idle one breathes.

### Cost

The loop is frame-capped by performance tier: 12 fps on `low`, 24 on `balanced`,
30 on `high` (`stats.ts:414-417`), because software rendering repaints the whole
surface and this machine has no GPU compositing. The loop runs only while the
stats view is on screen (`stats.ts:763-779`), and Chromium stops painting the
window entirely when other apps cover it.

### The buckets do not re-bucket on their own

`canvas.update()` is called from exactly one place, `StatsView.update`
(`stats.ts:911`), which runs when a usage payload arrives.
`paintTimeWindowed()`, the 20 second clock handler, does **not** call it
(`stats.ts:1078-1092`).

So on a machine where Claude Code is closed and no pushes arrive, the columns hold
their positions while the velocity readout beside them decays to zero. The sweep
and the pulse keep moving, because they are pure decoration. This is a narrower
survivor of the freeze bug described below: the fix covered velocity and
intensity, and the canvas buckets were not included. Read from the code at
`a696f5d` rather than observed on a running wall.

---

## Context efficiency

```
contextTokens = cacheRead + cacheCreate + input
cacheHitRate  = contextTokens > 0 ? cacheRead / contextTokens : 0
```

(`stats.ts:185-186`, displayed at `stats.ts:862` and `stats.ts:894`.)

It answers one question: of everything that had to be *present* as context, how
much was served from cache rather than re-sent. `output` is excluded because
generated tokens are not context, and the denominator is printed on the panel
(`stats.ts:635`) so nobody has to take the number on trust.

It is DERIVED for a plain reason: both inputs are measured, but the ratio is a
judgement about what counts as context, and that judgement is the app's, not the
transcript's.

**It is an all-time ratio over `totals`, not a windowed one.** On a corpus of tens
of billions of tokens it barely moves from one session to the next, which makes it
a gauge of how this tool is used rather than a trend line. Reading it as "how well
did today go" would be a misreading, and the panel does not invite one.

---

## The freeze: a derived number needs a clock

### What happened

Velocity is "tokens per minute over a trailing ten minutes" and intensity is
derived from it, so **both decay on their own as the window slides past the last
record**. Nothing has to happen for the correct value to change. It changes
because time passed.

The dashboard, however, only repainted when a usage payload arrived, and payloads
only arrive when a transcript is written. With Claude Code closed there are no
writes, no watcher events, no scans and no pushes. So the machine sat showing the
last velocity it ever computed, indefinitely, presented exactly like a current
reading.

### How it was found

Not by inspection. By comparing two machines that should have agreed.

A projected **screen** and its **source** were showing the same dashboard. The
screen decayed to zero correctly. The source froze at 1.07M tokens per minute with
its last record seven minutes old.

The screen was right, and it was right by accident: a source sends an encrypted
beat every 30 seconds to already-connected screens even when nothing has changed
(`BEAT_MS`, `source.ts:45`), so the screen was forced to repaint twice a minute and
its `derive()` was re-run against a current clock. The source had no equivalent
forcing function, and had not had one since long before projection existed.
Projection did not cause the bug. It supplied the second machine that made it
visible.

This is worth keeping as a method: a stale derived value looks identical to a
correct one, so the only cheap way to catch it is to put a second, independently
driven view of the same data beside it.

### The fix

A clock already existed for the relative-time labels in the status strip. It now
also recomputes the time-windowed values (`stats.ts:765-772`):

```
setInterval(() => { this.paintStatus(); this.paintTimeWindowed(); }, 20000)
```

`paintTimeWindowed()` (`stats.ts:1078-1092`) re-runs `derive()` and updates
velocity, `data-intensity` and `--intensity`. Three deliberate limits:

- **Totals are not repainted.** They do not change on their own, and repainting
  them would restart their odometer animations every twenty seconds for nothing
  (`stats.ts:1074-1076`).
- **A screen that is not live keeps its frozen clock** (`stats.ts:1081-1086`). It
  froze on purpose, so that its trace does not scroll real data off the edge as if
  time were passing on data that stopped arriving. Thawing it here would undo a
  correct behaviour with a fix for a different problem.
- **The clock only runs while the stats view is visible** (`stats.ts:763-779`).
  Switching to the client wall clears the interval, which is right because nothing
  is on screen; switching back starts it again but does not repaint immediately, so
  the first correction after returning can be up to 20 seconds late. Read from the
  code, not observed.

20 seconds was already the right cadence for "3m ago" and it is fine for a decay
that plays out over ten minutes. Nothing else in the renderer polls.

### The verified decay curve

Reproduced on 2026-09-03 against `a696f5d` by bundling `stats.ts` with esbuild and
calling `derive()` directly with one synthetic record of 5,000,000 tokens, aged
across the window:

| Age of the single record | Velocity, tokens/min | Intensity |
|---|---|---|
| 30 s | 5,000,000 | 1.000 |
| 1 min | 4,998,750 | 0.925 |
| 2 min | 2,499,688 | 0.925 |
| 5 min | 999,950 | 0.925 |
| 9 min | 555,540 | 0.925 |
| 9.9 min | 505,038 | 0.925 |
| 10.1 min | 0 | 0.275 |
| 15 min | 0 | 0.110 |
| 70 min | 0 | 0.060 |

Which is the curve recorded in commit `666bbd7`: **5.0M at one minute, 1.0M at
five, 555K at nine, and 0 past ten.** The small shortfalls (4,998,750 rather than
5,000,000) are the milliseconds between constructing the record and calling
`derive()`, not a discrepancy in the arithmetic.

The intensity column shows the step function doing its job: 1.000 while the last
record is under a minute old, 0.925 for the rest of the window, then a drop to
0.275 the moment the record ages out of the velocity window, 0.110 past fifteen
minutes and the 0.060 floor past an hour.

---

## Odometers

Numbers tween to their targets rather than snapping (`Odometer`,
`stats.ts:248-286`). Three details matter more than the animation does:

- **The first paint does not animate.** `animate = this.mounted`
  (`stats.ts:853`), and `mounted` is set at the end of the first `update()`
  (`stats.ts:927`). Counting up from zero on launch would be theatre, and for the
  first 900 ms it would also be a wrong number on screen.
- **A new target retargets a running tween instead of restarting it.**
  `this.target` is assigned before the `if (this.raf) return` guard
  (`stats.ts:257-263`), so a burst of pushes glides to the newest value rather
  than jittering.
- **Sub-unit changes snap** (`stats.ts:258`), so a counter that moved by less than
  one does not spend 900 ms doing it.

The curve is quart-out over 900 ms, the same easing the client wall uses for card
reveals (`stats.ts:269-270`), which is the only reason the two views feel like one
application.

---

## Drift at the time of writing

Uncommitted work was in flight in exactly this area:

- `src/shared/velocity.ts` (new, untracked) extracts `velocityOf()` so the
  renderer's live figure and a main-process peak tracker cannot drift apart. The
  arithmetic is identical to `stats.ts:173-182` as documented above, including the
  earliest-record span and the one minute floor.
- `src/main/data/peak.ts` (new, untracked) adds an all-time peak velocity high
  water mark, stored in its own file rather than in the usage cache, because the
  cache is designed to be discarded on a version bump and a record cannot be
  rebuilt from transcripts.
- `stats.ts` gains a peak readout in the velocity panel, hidden until a record
  exists so that "PEAK 0" never reads as a measurement.

If that lands, this document's velocity section describes `velocityOf()` and the
line numbers move.

## Related

- `docs/usage-indexing.md`, for where `recent`, `totals` and the rest come from.
- `docs/testing.md`, for what is guarded. Note that `derive()` has no committed
  test, and that the decay curve above was verified by an ad hoc harness rather
  than by a regression test.
- `ARCHITECTURE.md`, section "Claude Stats".
