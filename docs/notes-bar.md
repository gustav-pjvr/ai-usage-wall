# The notes bar

One line of text across the top of the wall, locked until you double click it.

## What it is for

Somewhere to keep basic notes and command reminders on a surface that is already
being looked at all day. That is a different thing from a notes app: it has to be
readable without being clicked, impossible to change by accident, and out of the
way the moment it is not in use.

## Why it locks

The wall sits under every other window and takes stray clicks all day. An
always-editable field there would collect keystrokes meant for whatever was
really in focus, and a mangled note is the kind of thing you notice long after
it happened.

So the field is `readonly` until a **double click**, which is a gesture nothing
else on the wall uses, and it locks again the moment focus leaves.

| Action | Result |
|---|---|
| Double click anywhere on the bar | Unlocks, caret to the end of the existing text |
| Click anywhere else | Locks and saves |
| Enter | Locks and saves |
| Escape | Puts the saved text back, locks, saves nothing |

The caret goes to the END rather than selecting everything. A note is usually
being added to, and select-all means one keystroke wipes it.

While unlocked, keydown is stopped from propagating. The wall has a
document-level Escape handler for focus mode, and single letters would otherwise
reach window shortcuts.

## DOM focus is not keyboard focus here

This is the part that nearly shipped broken, and it was caught by review rather
than by the tests.

The wall's windows are created `focusable: false` and carry `WS_EX_NOACTIVATE`.
That is exactly what lets the wall sit behind everything without stealing focus,
and it also means the window can never receive a keystroke. `input.focus()`
alone would have given the field the caret in the DOM, painted the editing
state, and sent every character typed to whatever application was actually in
front, with no caret on screen to suggest otherwise. The pairing window exists
because of this same constraint: `src/main/index.ts` already said in as many
words that a text input in the wall is a trap.

So an edit borrows keyboard focus for its duration:

1. Double click. The renderer calls `wall:notesEdit(true)` and AWAITS it.
2. Main sets `notesEditing` on that window, calls `setFocusable(true)` (which
   is what clears `WS_EX_NOACTIVATE`) and `focus()`, and returns whether the
   window really ended up focused.
3. Only then does the field unlock. If focus was refused, the edit does not open
   at all, because a field that silently posts your keystrokes into another
   application is worse than one that does nothing.
4. On lock, `wall:notesEdit(false)` sets the window back to unfocusable and
   re-runs `applyLayer`, which restores the ex-styles and the z-order anchor.

`applyLayer` returns early while `notesEditing` is set. Without that, saving the
note would end the edit that saved it: `updateSettings` calls `applyLayer` for
every window, which would re-assert `WS_EX_NOACTIVATE` mid-edit.

## Where it lives

In the shell, above the stage, mounted on `document.body`. It spans the whole
window and shows in both views and both editions. It is deliberately NOT part of
the stats view: switching to the client wall must not take the note away.

`--u` sizes it, so it shrinks with everything else rather than eating a fixed
slice of a small screen. `--top-chrome` in `shell.css` reserves room for the bar
plus the mode switch beneath it, and `.stats` reads that one value rather than
knowing the arithmetic.

## The empty state is the discovery mechanism

An empty locked bar with its hint hidden is invisible, and a control nobody can
find is not quiet, it is missing. A placeholder only renders while the field is
empty, which makes it exactly the right thing to leave on: the hint sits there
until there is a note to read, and steps forward on hover.

## Persistence

The text lives in `settings.notes`. Settings was the right home rather than a
file of its own: it is one short string, the settings write is already atomic,
and settings already reaches the renderer on every state push, so a second
monitor's wall window picks up the text without any new plumbing.

Capped at 400 characters in two places. The renderer's `maxLength` is a
courtesy; `normaliseSettings` is the guarantee, because a hand-edited
settings.json is a supported way to change anything else in this app.

Saving goes through `updateSettings`, which triggers a state push that comes
straight back. `setText` ignores incoming values while the field is being
edited, or that round trip, and the second monitor's copy of it, would overwrite
someone mid-word.

## What it deliberately does not do

**It does not travel over projection.** A paired screen is another machine, and
this field holds whatever Gustav happens to be thinking about. The cost stat was
made to project on request; this was not, and `docs/privacy-wire.md` remains an
accurate list of what crosses the network.

**It is one line.** Not a scratchpad, not markdown, no history. At 1920px it
holds roughly two hundred monospace characters, which is several reminders. If
it ever needs to be more than that, it should become a window like the messages
panel rather than a taller bar.

## Verified by

`npm run test:render` drives the real bar in a real window: that it starts
locked, that a double click both unlocks it AND takes the caret, that clicking
away locks it and the text reaches the main process, that Escape restores and
saves nothing, that Enter commits. The lock is checked by its effect, where the
caret actually is and what the main process was actually asked to save, rather
than by reading back the `readOnly` flag the code just set. Reading back the
property you just wrote is how this project once shipped a `hidden` element that
was plainly visible.

It also builds its window with the WALL'S options, `focusable: false` and
`type: 'toolbar'`, not with a convenient default window. That distinction is the
whole reason the focus bug was invisible to the first version of the suite: a
default window proves the state machine and says nothing about whether the
feature works.

Two reverts were used to confirm the tests are real rather than decorative. With
the double click downgraded to a single click, four checks fail. With the focus
handoff removed, six fail, including "the wall really holds keyboard focus while
editing".
