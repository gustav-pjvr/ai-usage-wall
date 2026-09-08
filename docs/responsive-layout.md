# Responsive layout

How the stats dashboard adapts to the screen it lands on, and why the first
attempt made things worse rather than better.

## The bug

The grid was always fluid. `.stats-grid` is twelve columns of `1fr` and rows of
`minmax(0, 1fr)`, so a panel has always been a fraction of the window, and it
has always shrunk when the window did.

Its contents did not. Font sizes, padding and vertical rhythm were fixed
pixels. `.panel` sets `overflow: hidden`, so on a smaller screen the box shrank
under text that stayed the same size and the words were cut off. Gustav saw it
on another machine; nothing on this one would ever have shown it, because this
machine is the size everything was tuned against.

## Why the existing clamps were worse than nothing

Five values did try to adapt, with `clamp()` against `vw`:

```css
.hero-value { font-size: clamp(38px, 6.2vw, 92px); }
```

That is the wrong axis. A dashboard that fills the window is constrained by
HEIGHT, not width. 1920x1080 and 1920x1200 have identical `vw` and 120px of
difference in the thing that actually runs out. The clamps let the headline stay
at its maximum on a 1600x900 screen whose rows were 17 percent shorter, which is
exactly where the clipping showed up first.

## One unit

`shell.css` defines a single unit and every size in `stats.css` is a multiple of
it:

```css
:root {
  --u: clamp(0.7px, min(0.0520833vw, 0.0925926vh), 1.35px);
}
```

`0.0520833vw` is 1/19.2, and `0.0925926vh` is 1/10.8, so **`--u` is exactly one
pixel at 1920x1080**. That reference is deliberate: `calc(var(--u) * 11.5)`
still reads as "11.5px on the reference screen", so the stylesheet says what it
used to say and the diff that introduced it is mechanically checkable.

`min()` takes whichever axis is tighter. The ceiling of 1.35 stops a 4K panel
turning the dashboard into a poster. The floor of 0.7 is where shrinking stops
being the answer.

## Two floors, then stop shrinking

Font sizes at or below 11 units carry a second floor:

```css
.tag { font-size: max(8px, calc(var(--u) * 9.5)); }
```

Below about 8px a label stops being a word and becomes a shape. `max()` only
binds on a small screen; at the reference it is inert.

Once both floors are reached there is nothing left to shrink, so the only honest
move is to carry less. Two media queries do that:

| Height | What goes |
|---|---|
| under 940px | `.cost-note`, `.cost-gap`, `.eff-note`, `.vel-note`, `.stat-hint`, `.bd-sub` |
| under 820px | `.comp-legend`, and the peak rule tightens |

What goes is the tier that explains a number to someone reading the dashboard
for the first time. What stays is every number, every unit, and the caption under
the live chart, because that one answers "what am I looking at" rather than "how
was this worked out". The composition BAR stays after its legend goes, so the
proportions are still visible once the words are not.

## Rows are a height decision, not a width decision

The narrow layout used to be:

```css
@media (max-width: 1500px) { /* four rows instead of three */ }
```

Adding a row is the right trade when the window is narrow but tall, and exactly
the wrong one when it is narrow because the whole screen is small. A 1366x768
laptop has 768px to divide; taking it in four rather than three cuts every
panel's usable height by about a quarter and buys nothing in width that `--u`
was not already handling. The query is now gated on `min-height: 1000px`.

Measured before that gate went in: at 1440x900 the four row branch pushed the
hero's composition legend 8.5px through the floor of its own panel, and the cost
panel's content ran 21px taller than its box.

## The cost panel may give height back

`.panel-stack .panel-cost` was `flex: 0 0 auto`. At its natural height it could
take the whole stack on a short screen and leave velocity with nothing, and
because `.panel` clips, "nothing" means an empty box rather than a visibly
squashed one. It is now `flex: 0 1 auto` with `min-height: 0`.

## How it is verified

`npm run test:render` (`test/render-fit.cjs`) loads the real renderer with the
real stylesheet at eight window sizes and asks the layout engine, not the
stylesheet:

1. Does any panel's content overflow its own box? `.panel` clips, so
   `scrollHeight > clientHeight` IS the clipping rather than a sign of it.
2. Does any text element's rectangle escape the content box of the panel it
   lives in?
3. What is the smallest text actually on screen? A dashboard that fits because
   nothing can be read has not been fixed.

Ellipsis truncation is excluded: `.bd-label` asks for it, and a label ending in
"..." is a decision rather than a defect.

The suite was run against the OLD stylesheet before being trusted. It failed at
1600x900, 1512x982, 1440x900, 1366x768 and 1280x800, and passed at the three
larger sizes. A test that has never been shown to fail is not evidence.

Set `CSW_SHOTS` to a directory to also write a PNG per size. The measurements
say nothing overflows; the pictures say it still looks like the dashboard.

## Sizes covered

2560x1440, 1920x1200, 1920x1080, 1600x900, 1512x982, 1440x900, 1366x768,
1280x800. The last is where both floors bind at once and the most captions are
dropped.
