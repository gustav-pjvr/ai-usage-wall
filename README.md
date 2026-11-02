<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo/lockup-on-dark.png">
  <img src="assets/logo/lockup-on-light.png" alt="AI Usage Wall" width="400">
</picture>

# AI Usage Wall

An ambient Windows desktop dashboard for your AI coding usage, sitting below your
normal windows. Go to the desktop and it is there.

**Claude Stats** (the default) is a live command centre for your local Claude Code
usage, with OpenAI Codex beside it when Codex is on the machine: tokens, cost at
API list prices, hours, sessions, models, projects, plan limits, daily and hourly
activity, all read from files on this machine. It has a Simple view (one card
each for Claude and Codex) and a Detailed view (every panel, the default), and a
switch that hides Codex. **MuchBetter Clients** is a living wall of the work,
where MuchBetter provides the system and each client provides the visual
identity.

Switch with the control at the top, or press `Tab`.

---

## Running it

```bash
npm install
npm start          # build + launch
```

Other scripts:

```bash
npm run build      # bundle to dist/
npm run dev        # rebuild on change
npm test           # 17 suites, about 680 checks: layout, schema, indexing, Codex, plan limits, projection, crypto, chat, pricing
npm run test:render # about 750 layout checks in a real Electron window, every screen size and view
npm run typecheck  # tsc --noEmit
npm run package    # per-user Windows installer into release/
npm run logo       # regenerate the mark, icons and wordmark
npm run deploy     # build, upgrade the installed app in place, relaunch
```

**`npm run deploy` is how the app gets updated.** It packages, silently upgrades
the single installed copy, verifies the installed version matches, prunes old
installers and relaunches. Never run `release/win-unpacked` directly: that is a
build artifact, and running it is how you end up looking at a stale build while
believing it is current.

`npm run package` produces `release/MuchBetter Client Wall Setup <version>.exe`
(about 107 MB, installs per-user with no admin prompt). Prefer `npm run deploy`,
which also installs it.

**In a packaged build your client files live in
`%APPDATA%\MuchBetter Client Wall\data\clients`**, not next to the executable,
because Program Files is not writable. The demonstration clients are copied there
on first run and are never overwritten afterwards. The tray menu's
"Open client data folder" always opens the right one.

The wall has no taskbar button and never steals focus, so **the tray icon is the
control surface**. Right-click it for layer mode, click-through, start-with-Windows,
reload, and the diagnostics overlay.

| Hotkey | Action |
|---|---|
| `Ctrl+Alt+W` | Focus mode: brings the wall above other windows and enables interaction |
| `Ctrl+Alt+Shift+W` | Show / hide the wall |
| `Tab` | Switch between Claude Stats and Clients |

Hover a card to lift it. Click a card for the full client view. `Esc` closes it.

---

## Adding a client

Create one file, `data/clients/<slug>.json`:

```json
{
  "id": "acme-corp",
  "name": "Acme Corp",
  "company": "Industrial supplies",
  "state": "active",
  "project": "Website rebuild",
  "revenue": 50000,
  "progress": 35,
  "startDate": "2026-08-15",
  "lastInteraction": "2026-09-01",
  "branding": { "primary": "#0F766E" }
}
```

The wall picks it up within about a third of a second. No restart.

`id` and `name` are the only required fields; everything else degrades gracefully.
Full field reference is in [ARCHITECTURE.md](ARCHITECTURE.md).

Or just ask Claude: *"Add Acme Corp as a new client, website project worth R50,000,
started 15 August, 35% done."*

**Logos and images** go in `assets/clients/<slug>/` and are referenced relative to
that folder, e.g. `"logo": "acme-corp/logo.png"`.

**Client colours are a starting point, not the final palette.** The brand hue drives
a derived token set that is contrast-solved per card, so every card stays readable
whatever the client's brand does.

---

## Settings

`%APPDATA%\MuchBetter Client Wall\settings.json`. Every key has a working default,
so deleting the file is safe.

| Key | Default | Notes |
|---|---|---|
| `layerMode` | `"desktop"` | `desktop` (below apps, interactive), `top` (always on top). For a wall that ignores the mouse, set `clickThrough` |
| `performance` | `"auto"` | `auto` inspects the machine. Force with `low`/`balanced`/`high` |
| `clickThrough` | `false` | Cards ignore the mouse entirely |
| `opacity` | `1` | Wall opacity in ambient mode |
| `densityScale` | `1` | Lower packs more cards in |
| `pageRotateSeconds` | `45` | Only used when the wall paginates |
| `monitors` | `[]` | Empty means all displays |
| `vaultPath` | `null` | Obsidian vault, read-only |
| `useVault` | `true` | |
| `mode` | `"stats"` | Which view opens on launch: `stats` or `clients` |
| `debug` | `false` | Diagnostics overlay |

---

## Claude Stats

Everything on that view is read from files on this machine: Claude Code's
transcripts (`~/.claude/projects/**/*.jsonl`, `~/.claude/history.jsonl`), T3
Code's local database as a fallback for Claude sessions missing from them,
Codex's session rollouts (`~/.codex/sessions`, see
[docs/codex-usage.md](docs/codex-usage.md)), and the one plan-limits reading
Claude Code keeps under `cachedUsageUtilization` in `~/.claude.json` (nothing
else in that file, which also holds account and login details, is read into the
app). No API, no account, and no network to produce any of it. The app reaches the network for exactly two things, neither of
which reads or sends a transcript: [projection](#projection), which is off until
you turn it on, and the update check in the stats build.

Panels are tagged **MEASURED** (straight from the files) or **DERIVED**
(computed, with the method printed on the panel). Cost is derived at API list
prices and is not a bill. Plan limits are the last reading Claude Code and Codex
saved, shown with its age and never fetched live; a window past its reset time
shows as reset rather than its old percent. When a reading is missing the panel
is hidden rather than showing a 0.

The first index takes about five seconds and is cached; after that it only reads
the bytes appended since last time, triggered by a filesystem watch rather than a
timer. Full reasoning in [ARCHITECTURE.md](ARCHITECTURE.md#claude-stats).

## Projection

**Off by default, and off is structural rather than a promise.** With no
credentials file the socket class is never constructed, so there is no connection
to leak, misconfigure or forget about. Turning it on is a deliberate act with a
consent dialog in front of it.

Projection puts one machine's dashboard on another machine's screen. The
**source** reads its own `~/.claude` as usual and sends an encrypted snapshot to
each **screen** it has paired. A machine acting as a screen does not index its
own transcripts at all while it is one.

Both editions have it. The relay is
`https://claude-stats-relay.gustavpjvr.workers.dev`, a separate Cloudflare Worker
that forwards ciphertext it cannot read.

### Turning it on

Tray icon, right-click, **Projection**. The first line of that submenu is a
disabled readout of the current state, not a button: `Off (no network)`,
`Projecting to 1 of 2 screens`, `Showing <label> (live)`.

| Machine | Menu item |
|---|---|
| The one with the numbers (the **source**) | `Project this machine to another screen...` |
| The one you want to watch on (the **screen**) | `Show another machine here...` |

Either one shows a **modal consent dialog first**, titled "Turn on projection?",
which lists what will be sent and what never will and states that nothing goes
anywhere until a screen is paired. Cancel and nothing is written at all: no
credentials file means no projection.

### Pairing

On the source, **Show a pairing code...**. That generates a **12-character** code
over a Crockford base32 alphabet (no I, L, O or U so it can be read aloud),
displayed as `XXXX-XXXX-XXXX` and valid for **ten minutes**. Type it on the
screen. The two machines do an X25519 exchange that the code authenticates, and
each ends up holding its own AES-256-GCM key. Up to 8 screens per source.

**Nothing is sent before a screen is paired**, and again that is structural:
without a paired screen there is no key to encrypt for, so there is nothing the
source could send even if it wanted to.

### What is sent

`toWire()` in `src/shared/projection-wire.ts` is the only serialiser, and it
names every field explicitly rather than spreading an object, so a field added to
the index later cannot reach the wire by accident.

- token totals: input, output, cache writes, cache reads, thinking, requests,
  web search and web fetch counts
- daily and hourly activity
- model names
- per-session start, end, requests, tokens and models
- the last twenty minutes of throughput
- prompt **counts** by day, and when the last one was
- the Claude Code version, and a transcript file **count**
- when Codex is on the source: Codex's own totals, daily and hourly activity,
  models, session counts, active time and plan limits, with projects masked
  exactly like Claude's
- Claude's plan reading: when it was read, and per row a label, the percent
  used and the reset time
- a label for the source machine, which is its Windows computer name: it is set
  from `os.hostname()` and there is no UI to change it

**Sent only while the tray checkbox `Send project folder names` is on** (it is on
by default): project folder names. The folder name itself and nothing above it,
except that one parent segment is prefixed when two projects would otherwise
share a leaf name.

### What is never sent

- filesystem paths
- the Windows username
- session ids
- prompt text
- transcript text

`sessions` are re-keyed by array index precisely so a session id cannot ride
along, and when the index is unavailable the wire carries a fixed string rather
than the real OS error, which could name a path.

### What the relay can see

It is a blind forwarder, and the honest list is:

- that a machine is connected, and whether it is a source or a screen
- its IP address (a failed pairing redemption also stores the IP for ten minutes,
  to rate limit guessing)
- the timing and size of every frame, which reveals **when** you are working

It cannot see what any of the numbers are. It holds no key, never parses a
frame's ciphertext, and **stores no frames at all**, not even the most recent
one, which is why a screen connecting to an idle source waits for the source
instead of being served something stale.

Snapshots go out on change, floored at **one per 10 seconds**, plus one
unthrottled full frame whenever a screen connects, which is what makes a
reconnecting screen fill in immediately. While a screen is connected and nothing
has changed, the source sends a **30 second** encrypted beat carrying no payload.

### Credentials, and turning it off

`projection.json` in the app's userData folder
(`%APPDATA%\MuchBetter Client Wall\` or `%APPDATA%\Claude Stats Wall\`),
encrypted with Electron's `safeStorage`, which on Windows is DPAPI scoped to the
logged-in user, so copying the file to another machine yields nothing.
Deliberately **not** in `settings.json`: that file gets hand-edited, backed up and
pasted into chat windows when something goes wrong, and it is the wrong home for
a key that decrypts a live feed of someone's machine. If `safeStorage` ever
reports encryption unavailable the file is written as plain JSON instead, and the
reader detects that by sniffing for a leading `{`.

**Deleting `projection.json` turns everything off and forgets every pairing.**
Its presence is the on switch, so with it gone no network object is constructed.
`Stop projecting and forget all screens` in the tray does exactly that.

Removing one screen (`Remove this screen`) **deletes that screen's key here
first** and tells the relay second, so a revoked screen stops working immediately
whether or not the relay cooperates. A revocation made while the source is
offline is replayed on the next connect.

## The shareable build

There are two editions from one codebase, chosen at build time.

| | Full | Stats |
|---|---|---|
| Build | `npm run build` | `npm run build:stats` |
| Installer | `npm run package` to `release/` | `npm run package:stats` to `release-stats/` |
| Installed as | MuchBetter Client Wall | Claude Stats Wall |
| Views | Claude Stats and Clients, with a switch | Claude Stats only, no switch |
| Client records | shipped, seeded, watched | **none, and none in the installer** |
| Obsidian vault | read when configured | never read |

**Claude Stats Wall is the one you can hand to someone else.** It reads only the
recipient's own `~/.claude`, needs no account and no API key, and carries no
MuchBetter client data: `data/` is not in its `extraResources`, so there is
nothing to leak even in principle. It installs alongside the full build under its
own appId rather than upgrading over it.

Four things to say when you hand it over:

- **The installer is not code-signed**, so Windows SmartScreen will warn on
  first run. "More info" then "Run anyway".
- **Without Claude Code installed** it says "No Claude Code data on this
  machine" and names the path it looked in, rather than showing zeros.
- **It updates itself.** Unlike the full build, the stats build checks the
  download site for a new version 15 seconds after launch and every 60 seconds
  after that, downloads as soon as it finds one, and shows the progress in a
  small panel above other windows. It installs when the user clicks Install
  update on the wall, or on the next quit if they never do. It sends nothing
  about the recipient's usage to do it, but it is a network request and saying
  "no network" about this build is no longer true.
- **It can project.** [Projection](#projection) ships in both editions. It is off
  by default, and a consent dialog and a pairing code stand between a fresh
  install and a single byte leaving the machine.
- **Paired machines can message each other.** Plain text, over the same sealed
  channel, from the tray under Projection. The relay forwards it without being
  able to read it, and a message that cannot be delivered says so rather than
  pretending it went. See [docs/messaging.md](docs/messaging.md).

`npm run deploy` only ever touches the FULL build, on this machine.

## Obsidian

If `vaultPath` is set, the wall reads `<vault>/02-Clients/*.md` and uses it to fill
gaps in client records. It is **strictly read-only** and **only reads frontmatter,
never note bodies**, because the vault contains information that should not be on a
screen visible to passers-by.

Opt a note in with namespaced frontmatter keys:

```yaml
---
title: Acme Corp
type: client
status: active
client: acme-corp        # must match the wall's client id
wall_revenue: 50000
wall_progress: 35
wall_project: Website rebuild
wall_primary: "#0F766E"
---
```

Local JSON always wins; the vault only fills blanks. The wall works fine with no
vault at all.

---

## If something looks wrong

Turn on the diagnostics overlay from the tray. It reports the display, viewport,
performance tier, layer mode, whether the Win32 layer is available, vault match
count, and any clients that failed to load.

**A client that fails to load still gets a card** showing the parse error, rather
than silently disappearing. So if you mistype something in a client file you will
see exactly which file and which line, instead of that client quietly vanishing.

Known limitations on the current machine are listed in
[ARCHITECTURE.md](ARCHITECTURE.md#known-issues).
