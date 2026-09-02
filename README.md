# MuchBetter Client Wall

An ambient Windows desktop application that continuously displays MuchBetter's
clients as individually branded cards. MuchBetter provides the system, each client
provides the visual identity.

It sits below your normal windows. Go to the desktop and the wall is there.

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
```

The wall has no taskbar button and never steals focus, so **the tray icon is the
control surface**. Right-click it for layer mode, click-through, start-with-Windows,
reload, and the diagnostics overlay.

| Hotkey | Action |
|---|---|
| `Ctrl+Alt+W` | Focus mode: brings the wall above other windows and enables interaction |
| `Ctrl+Alt+Shift+W` | Show / hide the wall |

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
| `layerMode` | `"desktop"` | `desktop` (below apps, interactive), `wallpaper` (true wallpaper layer, no input), `top` |
| `performance` | `"auto"` | `auto` inspects the machine. Force with `low`/`balanced`/`high` |
| `clickThrough` | `false` | Cards ignore the mouse entirely |
| `opacity` | `1` | Wall opacity in ambient mode |
| `densityScale` | `1` | Lower packs more cards in |
| `pageRotateSeconds` | `45` | Only used when the wall paginates |
| `monitors` | `[]` | Empty means all displays |
| `vaultPath` | `null` | Obsidian vault, read-only |
| `useVault` | `true` | |
| `debug` | `false` | Diagnostics overlay |

---

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
than silently disappearing. `data/clients/zz-broken-example.json` is intentionally
malformed to demonstrate this; leave it there.

Known limitations on the current machine are listed in
[ARCHITECTURE.md](ARCHITECTURE.md#known-issues).
