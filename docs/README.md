# Documentation

One document per system. `ARCHITECTURE.md` at the repo root is the map of how
the pieces fit together and the record of decisions that were made and later
reversed; these are the depth behind it.

## The wall itself

| Document | What it covers |
|---|---|
| [window-layering.md](window-layering.md) | Layer modes, why the wall is a tool window, how it is placed against the desktop, and the Show Desktop watchdog |
| [settings-and-tray.md](settings-and-tray.md) | The settings schema and how it heals, the tray menu, hotkeys, start with Windows, performance tiers |
| [editions.md](editions.md) | The full and stats builds, what differs, and how the edition is injected at build time |
| [responsive-layout.md](responsive-layout.md) | How the dashboard adapts to the screen, the one unit everything is a multiple of, and why the original `vw` clamps made it worse |
| [notes-bar.md](notes-bar.md) | The one line note across the top, why it locks, and why it stays on this machine |
| [ask-gemini.md](ask-gemini.md) | Ask Gemini (full build): the question panel, the Antigravity CLI backend, its lock-down, and exactly what is sent to Google |
| [design/gemini-ask.md](design/gemini-ask.md) | The design it was built from, and why the Gemini CLI was dropped for the Antigravity CLI |
| [work-mode.md](work-mode.md) | Work mode (full build): the monday Tasks board, connecting monday, actions, notices, what is stored where |
| [design/work-mode.md](design/work-mode.md) | The design it was built from (phase 1 of 4 built), with Gustav's decisions |
| [constellation.md](constellation.md) | The project sky in the top panel: what size, brightness and a link mean, and how it stays cheap |
| [milestones.md](milestones.md) | The badge and the list: what counts, why the first run is silent, and why there is no duration record |
| [work-timelapse.md](work-timelapse.md) | The time-lapse of today or any day: three lines, what they measure, which days can be replayed, and why it always ends |
| [design/timelapse-any-day.md](design/timelapse-any-day.md) | The design it was built from: five-minute detail per transcript, the three series, the day picker |
| [design/constellation-timelapse-milestones.md](design/constellation-timelapse-milestones.md) | The design those three were built from, with Gustav's decisions on top |

## The numbers

| Document | What it covers |
|---|---|
| [usage-indexing.md](usage-indexing.md) | Reading Claude Code transcripts, the incremental scan, the index shape, project labelling |
| [codex-usage.md](codex-usage.md) | Reading Codex's session files beside Claude: what is read and never read, normalisation, plan limits, prices, the wire block |
| [derived-metrics.md](derived-metrics.md) | Measured against derived, cost, recent volume and intensity, the live trace, and why a value that stops changing is a bug |

## Projection

Sending one desktop's dashboard to another, encrypted, through a relay that
cannot read it.

| Document | What it covers |
|---|---|
| [projection.md](projection.md) | Roles, pairing, the socket lifecycle, liveness, revocation |
| [projection-crypto.md](projection-crypto.md) | The key schedule, the replay boundary, the threat model, and the version 1 flaw |
| [privacy-wire.md](privacy-wire.md) | Exactly what crosses the network and what never does |
| [messaging.md](messaging.md) | Text messages between the two paired machines |

## Shipping

| Document | What it covers |
|---|---|
| [auto-update.md](auto-update.md) | The feed, the check cadence and its cost, and the three ways an update announces itself |
| [build-and-release.md](build-and-release.md) | Every npm script, the two edition builds, and the release checklist |
| [download-site.md](download-site.md) | The Cloudflare Worker and R2 bucket behind the download page |
| [relay-operations.md](relay-operations.md) | Deploying and operating the relay |

## Verifying

| Document | What it covers |
|---|---|
| [testing.md](testing.md) | Every suite, what it guards, and the failure mode this project keeps repeating |

## A note on how these are written

Several documents spend as much space on decisions that were WRONG as on the
current design. That is deliberate. The expensive mistakes in this project were
not typos, they were confident conclusions drawn from checking something
adjacent to the thing that mattered:

- Z-order was verified and rendering was assumed, so a wallpaper layer mode
  shipped that never drew a pixel.
- `GetParent` was read as the parent when for a popup window it returns the
  owner, so a window reported itself detached while it was parented into the
  shell.
- The wall was measured across a Show Desktop click and found unchanged, which
  was true and useless: the desktop was the thing that moved.
- An element's `hidden` property was read back and reported true while the
  element was visible, because an author `display: flex` rule beats the user
  agent's `[hidden]` rule.
- Panel sizes were checked against the grid and the CONTENTS were assumed, so a
  dashboard that had always been fluid shipped text that was clipped on any
  screen smaller than the one it was written on.

Each of those passed a test. Writing down why the test was satisfied by the
wrong thing is worth more than writing down the fix.
