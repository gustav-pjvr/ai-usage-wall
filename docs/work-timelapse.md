# The work time-lapse

"Today" at the top right replays today so far in about twenty seconds: projects
light up as their first hour arrives and grow as their tokens accumulate, a trace
of the hours fills in underneath, and a clock and running total count up. It
plays only when the button is pressed. Gustav turned the original scheduled
end-of-day replay into this.

## What is measured and what is pacing

Every hour's tokens per project come from `projectHourly`, measured at ingest
(index version 4). The order projects light up in follows from those hours, so
it is measured too. Only two things are design: how fast the clock runs, and that
tokens inside the hour currently being revealed fill in evenly. At the end every
project's total equals its measured total for the day, to the token.

## "Today" is the local day

Hour keys are UTC. Each is converted to a real moment and then to the local hour,
so on this machine yesterday's 22:00 UTC bucket is 00:00 today. This does not
depend on the daily chart's keys, which stay UTC by Gustav's choice.

The replay spans from the first active hour to the current time, so a day that
started at 09:00 does not spend half the replay on an empty morning, and the
clock stops at NOW, not at the end of the current hour. It first ran to the end
of the hour: at 09:05 the clock read 09:59, and the 09:00 bucket was shown
filling across 54 minutes that had not happened. The current hour's share is
now measured against the part of it that has actually passed. Found by the
Fable review; the timelapse suite pins it and fails with the old span.

## Why it always ends (rule 17)

- It is driven by elapsed time, not frame count. A throttled or dropped frame
  skips ahead; it never makes the replay run long.
- A hard stop at 20 seconds plus a 2.5 second hold on the finished day.
- Any click anywhere on it ends it immediately.
- It never takes keyboard focus, so it never needs a key to escape.

## Cost

A 2D canvas capped by performance tier: 12 frames a second on the software tier,
24 or 30 elsewhere. Stars are laid out once from the day's final totals, so
nothing is recomputed per frame and nothing moves. Under reduced motion the
replay is four steps instead of a continuous run.

## When it is not offered

- On a paired screen: `projectHourly` does not cross the wire, so there is
  nothing of this machine's to replay. The button is hidden.
- While indexing: today is not complete yet. The button is disabled and says so.
- Before anything has been recorded today: disabled, "Nothing recorded yet today".

## Verified by

- `test/timelapse.test.mjs`: yesterday and hours after now are excluded, local
  midnight counts as today, projects light in order, the replay starts empty,
  never goes backwards, and ends on the measured totals; reduced motion steps.
  Checked by reverting: counting hours after now fails five checks.
- `test/usage-append.test.mjs`: `projectHourly` folds requests, total and output
  per project per hour, the ingest cutoff, and pruning an hour that has since
  aged out. The pruning check was added after deleting the prune line failed to
  break the first version of the suite.
- `test/render-fit.cjs`: a real click opens it at 1366x768 and 2560x1440; frozen
  at 10 s its header, trace and caption are inside the window; frozen at 20 s it
  shows exactly the fixture's total for today; a click ends it.
