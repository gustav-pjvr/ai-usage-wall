# The time-lapse

"Today" at the top right replays today so far in about twenty seconds. "Any day"
beside it opens a month grid, and clicking a bright day replays that day. Both
play only when clicked. Gustav asked for this on 2026-09-23 after the first
version, a sky of project stars, did not say what it was showing; the design and
its reasoning are in [design/timelapse-any-day.md](design/timelapse-any-day.md).

## What it shows

One day as three stacked lanes on one time axis, drawn left to right behind a
moving playhead while a clock and three running totals count up:

| Lane | Per five minutes | Reads as |
|---|---|---|
| Tokens processed (twice the height) | input, output and both cache counts | the headline number, and where a big context landed |
| Tokens generated | output tokens | Claude writing rather than reading |
| Requests | assistant replies | a spike with few tokens is a tool loop of many small steps |

These are the three words already on the dashboard's hero tiles. Each lane has
its own fixed scale from the first frame, set by that day's highest slot and
stated in its corner (`peak 45.3M / 5 min`), so a spike is visibly a spike before
the playhead reaches it. Time is uniform: an hour is the same width everywhere.
When the playhead passes the busiest slot for tokens processed, it is marked and
named: `peak 45.3M in 5 min, 14:35, on muchbetter-client-wall`. The line under the
clock names the busiest project in the slot under the playhead.

## What is measured and what is pacing

Every point is a five-minute slot measured at ingest (index version 6): each
transcript's contribution holds its own records per local day, per project, per
slot (`FileContribution.intraday`). A day is summed on demand across the live
index and the history store's archived transcripts, so a deleted transcript keeps
its curve (`src/shared/intraday.ts`). Only two things are design: how fast the
playhead crosses the day, and that the slot under the playhead fills in evenly.
At the end the totals equal the day's measured totals, to the token.

Five minutes because on the busiest measured day the busiest five minutes held
18% of the busiest hour, so an hourly bar hid the burst; one-minute slots were
mostly single records and read as noise.

## Which days can be replayed

The picker asks the main process (`wall:timelapseDays`) for every local day with
a request, and compares the requests that day with the ones that have
five-minute detail:

- **Bright:** every request has detail. Plays.
- **Bright with a dot:** some requests are in transcripts archived before this
  detail existed. Plays; the replay says how many are missing from the curve,
  and its totals are the curve's, never the day's.
- **Dim:** only a reconstructed total survives (the 28 seed days from 20 Jun to
  18 Aug, recovered from a snapshot). Not clickable. The day is said to be what
  it is, never drawn (rule 12).

On Gustav's machine on 2026-09-23 the history store held the seed and no
archived transcripts, so every day with a transcript on disk is bright, seed
days that overlap them have a dot, and the seed days before 11 Jul are dim.

## "Today" is the local day

Days and slots come from `localDayKey` and local hours, never from the UTC
`daily` keys, which stay UTC by Gustav's choice. A record at 00:30 on this
machine belongs to today even though its timestamp's date is yesterday's.

Today's axis runs to the next hour, and the playhead stops at NOW, not at the end
of the axis or the current slot. The current slot's share is measured against the
part of it that has actually passed, so it completes exactly when the playhead
reaches now. (The first replay ran to the end of the hour: at 09:05 its clock
read 09:59 and showed tokens arriving across minutes that had not happened.)

## Why it always ends (rule 17)

- It is driven by elapsed time, not frame count. A throttled or dropped frame
  skips ahead; it never makes the replay run long.
- A hard stop 23.2 seconds after it opens: 0.7 s with the frame still, so it is
  read before it moves; a 20 s sweep; a 2.5 s hold on the finished day.
- Any click anywhere on it ends it immediately.
- It never takes keyboard focus, so it never needs a key to escape.
- Under reduced motion there is no sweep: the finished day is shown at once and
  held 10 seconds.

## Cost

One 2D canvas, frame-capped by performance tier (12 frames a second on the
software tier, 24 or 30 elsewhere), and a frame is skipped when the playhead has
not moved a whole device pixel. Nothing runs while it is closed. The detail never
rides on a usage push: one day is fetched when it is picked. Measured on
2026-09-23 against 470 real transcripts: the slots add 0.14 MB to the cache
(1.0 MB in all, saved in 15 ms), listing the days takes 3 ms and reading the
busiest day 0.8 ms, a 6 KB payload.

## When it is not offered

- On a paired screen: five-minute detail does not cross the wire
  ([privacy-wire.md](privacy-wire.md) stays true), so both buttons are hidden.
- While indexing: no day is complete yet. Both buttons are disabled and say so,
  and the main process refuses the two calls (rule 15).
- Before anything has been recorded today: "Today" is disabled, "Nothing
  recorded yet today"; "Any day" still works.
- A day that cannot be read shows "Could not read that day" for four seconds.

## Verified by

- `test/intraday.test.mjs`: slots at 00:00, 09:04, 09:05 and 23:59; a record at
  00:30 on a UTC+2 clock lands in the local day; a live and an archived
  transcript sum into one slot, and a path in both throws; a contribution
  without detail counts in the day's requests but not in its shape; full,
  partial and total days.
- `test/timelapse.test.mjs`: the axis, its two-hour minimum and midnight limit;
  today stops at now; nothing moves during the lead; totals never go backwards
  and end on the measured day; the partial slot, the peak and the "on" project;
  reduced motion. Checked by reverting: counting slots after now fails it.
- `test/usage-append.test.mjs`: slots are folded per file, per local day, per
  project; for every file they add up to its `activeDays`; a version 5 cache
  hands its contributions back. Checked by reverting to the UTC date: two checks
  fail.
- `test/usage-history.test.mjs`: a day's curve is identical before and after one
  of its transcripts is deleted, and after it is restored.
- `test/render-fit.cjs`: at all eight sizes, "Today" opens the replay; its
  header, graph, three lane names and peaks, hour labels and caption are inside
  the window and legible, and the smallest lane is at least 48 px tall; at the
  hard stop the three totals equal the fixture's; a click ends it. At 1366x768
  and 2560x1440, "Any day" opens the grid inside the window, a dim day does
  nothing, a bright one plays with its date as the title, and a click outside
  closes the grid.
