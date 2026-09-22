# The constellation

The project sky in the top row's big panel. Each project is a star; the live
throughput trace it replaced is one click away on the panel's toggle.

Built 2026-09-22 from `docs/design/constellation-timelapse-milestones.md`.
Gustav chose the panel over a third view, and asked that the trace stay.

## What each property means

| Property | Rule | Kind |
|---|---|---|
| Size | total tokens on a fixed log scale: under 10M, 10M, 100M, 1B, 10B and up | measured input, derived size |
| Brightness | halves every 7 days since last used, never below 0.12 | derived from `lastSeen` |
| Link | worked on the same local day; weight is the number of shared days, capped at 5 | derived from sessions |
| Pulse | the project of the latest record, only while that record is under 15 minutes old | derived from `latest` |

The panel caption states the same rules, because a chart that needs a legend in
someone's head is not honest.

**Why fixed thresholds, not ranks:** a rank-based size means one project growing
resizes its neighbours. With fixed thresholds a star only changes size when its
own total crosses a power of ten.

**Why "same day", not "same session":** a session is one working directory, so
two projects can never share one. A session contributes the local day it started
and the day it ended, never the days between, because a resumed session keeps
its id and its span on this machine reaches 1107 hours.

**Total means the hero's total**, which is about 97% cache reads. The hover shows
generated tokens separately.

## Nothing is invented

The number of stars scales with the panel's area, 6 to 40. Projects past the cap
are counted in a `+N more` note, never drawn as filler. A project with no tokens
is not drawn. A label that would collide with another label or a star is
skipped; one that would run off an edge is slid inside first.

## Why it is cheap

GPU compositing is unavailable on Gustav's laptop, so every frame is software.
The canvas is repainted only when something visible changes or the panel is
resized, never on a timer. A usage push arrives every few seconds during a
session and almost never moves a star, so each push is reduced to a signature
(labels, size buckets, brightness steps, links, the active star) and a push that
matches the last one paints nothing. The throughput trace's animation loop stops while the sky is showing. The
one moving thing, the pulse on the active project, is a single DOM element
animating opacity and scale, and it is a static ring on the low performance tier
and under reduced motion. Measured paint: 0.7 to 7 ms at the eight test sizes.

## On a paired screen

A screen receives project names already turned into labels, so it must not run
the labelling rule again: doing so split `Desktop / code` on its own slash and
rebuilt it with doubled spaces. On a screen the constellation maps each name to
itself, and the project list does the same through `projectLabels(paths,
alreadyLabelled)` in `stats.ts`.

Links cannot be derived on a screen, because the sessions it receives have their
working directory stripped (rule 26). The source computes them and sends
`projectLinks`: labels only, empty whenever project names are not shared, and
capped at the 300 strongest, since a busy source with years of history could
otherwise put tens of thousands of pairs in every frame. See
[privacy-wire.md](privacy-wire.md).

## Verified by

- `test/constellation.test.mjs`: determinism, fixed buckets, the brightness
  floor, the cap and `+N`, links across a local midnight, hit testing, labels
  that never collide or leave the box.
- `test/projection.test.mjs`: links are labels only, carry no path, username or
  session id, are empty when sharing is off, and malformed links from another
  version are dropped on arrival.
- `test/render-fit.cjs`: at all eight sizes, reads the layout the canvas actually
  drew and checks every star and label is inside the panel, no labels overlap,
  labels are legible, and the pulse ring is on screen centred on the active star.
