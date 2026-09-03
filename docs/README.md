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

## The numbers

| Document | What it covers |
|---|---|
| [usage-indexing.md](usage-indexing.md) | Reading Claude Code transcripts, the incremental scan, the index shape, project labelling |
| [derived-metrics.md](derived-metrics.md) | Measured against derived, velocity and intensity, the live trace, and why a value that stops changing is a bug |

## Projection

Sending one desktop's dashboard to another, encrypted, through a relay that
cannot read it.

| Document | What it covers |
|---|---|
| [projection.md](projection.md) | Roles, pairing, the socket lifecycle, liveness, revocation |
| [projection-crypto.md](projection-crypto.md) | The key schedule, the replay boundary, the threat model, and the version 1 flaw |
| [privacy-wire.md](privacy-wire.md) | Exactly what crosses the network and what never does |

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

Each of those passed a test. Writing down why the test was satisfied by the
wrong thing is worth more than writing down the fix.
