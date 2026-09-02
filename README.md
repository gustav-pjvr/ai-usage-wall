<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo/lockup-on-dark.png">
  <img src="assets/logo/lockup-on-light.png" alt="Client Wall" width="400">
</picture>

An ambient Windows desktop application with two views, sitting below your normal
windows. Go to the desktop and it is there.

**Claude Stats** (the default) is a live command centre for your local Claude Code
usage: tokens, velocity, sessions, models, daily and hourly activity, all read
from the transcripts on this machine. **MuchBetter Clients** is a living wall of
the work, where MuchBetter provides the system and each client provides the
visual identity.

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
npm test           # 42 checks on layout, colour and schema
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

Everything on that view is read from `~/.claude/projects/**/*.jsonl` and
`~/.claude/history.jsonl` on this machine. No API, no account, no network.

Panels are tagged **MEASURED** (straight from the transcripts) or **DERIVED**
(computed, with the method printed on the panel). Three things are deliberately
missing because they cannot be known locally: **remaining quota, plan limits and
cost.** The status strip says so rather than showing a guess.

The first index takes about five seconds and is cached; after that it only reads
the bytes appended since last time, triggered by a filesystem watch rather than a
timer. Full reasoning in [ARCHITECTURE.md](ARCHITECTURE.md#claude-stats).

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
