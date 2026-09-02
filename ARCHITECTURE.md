# MuchBetter Client Wall

Long-term memory for this project. Claude: **read this before changing anything.**
Written 2026-09-02. Keep it current, it is the contract between sessions.

---

## Purpose

An ambient Windows desktop application that continuously displays MuchBetter's
clients, past and present, as individually branded cards. It is not a CRM and not
a dashboard. It is a living showcase that happens to be genuinely useful.

MuchBetter provides the system. Each client provides the visual identity.

Maintenance happens through Claude in conversation ("add client X", "mark Y
completed"), not through a CMS. That constraint shaped most of the decisions below.

---

## Technology, and why

**Electron 44 + vanilla TypeScript + esbuild + koffi.** No React, no Tailwind,
no runtime framework.

This was not the obvious choice and the brief explicitly warned against picking
Electron out of familiarity. What actually decided it, measured on this machine:

| Option | Verdict |
|---|---|
| **Tauri** | **Ruled out on hard constraints.** Needs the Rust toolchain plus MSVC Build Tools and the Windows SDK, roughly 10 GB. The machine had **13.3 GB free on C:, no D: or E:, and no compiler installed**. Installing it would have left the OS with under 1 GB. Genuinely the better runtime, physically not installable here. |
| **WinUI 3 / WPF** | Needs the .NET SDK (not installed). Worse: MuchBetter's design language is oklch colour, conic-gradient masks and CSS custom-property theming. Reimplementing that in XAML loses fidelity and makes future Claude maintenance much harder. |
| **Neutralino** | Tiny, but weak Windows window management and a small ecosystem for the desktop-layer work this needs. |
| **Electron** | Ships prebuilt, needs no compiler, gives a current Chromium that renders the website's design language natively, and has first-class multi-monitor and global-shortcut APIs. |

**koffi is the unlock.** Real desktop-layer work needs `user32.dll`, which normally
means a native addon, which means node-gyp, which means MSVC, which we do not have.
koffi ships a **prebuilt `.node` binary for win32-x64 (2.9 MB, zero compilation)**
and calls Win32 directly. Verified before committing to the architecture.

**Cost of the choice, measured, on this machine with GPU acceleration unavailable:**
4 processes, **~293 MB private / ~344 MB working set** (down from 424 MB after
trimming Chromium switches). This is the honest number and it is the main price
paid for the stack. Expect materially less on a machine with working GPU
compositing, since most of it is software-rasterised surface buffers.

---

## Directory structure

```
muchbetter-client-wall/
├── ARCHITECTURE.md          <- you are here
├── README.md                <- how to run it
├── build.mjs                <- esbuild + generated tray icon. The whole build.
├── data/clients/*.json      <- ONE FILE PER CLIENT. The thing you edit.
├── assets/clients/<slug>/   <- logos and images, served over mbw-asset://
├── src/
│   ├── shared/              <- pure, testable, no Electron imports
│   │   ├── schema.ts        <- client shape, validation, normalisation
│   │   ├── layout.ts        <- the wall layout engine
│   │   └── color.ts         <- brand token derivation with contrast solving
│   ├── main/                <- Electron main process
│   │   ├── index.ts         <- windows, tray, hotkeys, IPC, orchestration
│   │   ├── capability.ts    <- hardware tiering
│   │   ├── settings.ts      <- settings file, atomic writes
│   │   ├── win32/
│   │   │   ├── ffi.ts       <- koffi bindings to user32
│   │   │   └── desktop-layer.ts  <- the three layer modes
│   │   └── data/
│   │       ├── store.ts     <- loading, error isolation, file watching
│   │       └── obsidian.ts  <- READ-ONLY vault adapter
│   ├── preload/index.ts     <- the only bridge, 6 methods
│   └── renderer/            <- vanilla TS + CSS
└── dist/                    <- build output
```

`src/shared/` deliberately imports nothing from Electron so it can be unit-tested
with plain node. Both hard algorithms live there and both were verified that way.

---

## Client data model

**One JSON file per client at `data/clients/<slug>.json`.** Not one big array.
That is the error-isolation requirement: a corrupt file costs exactly one card.

```jsonc
{
  "id": "helderberg-run-crew",      // slug, must match filename
  "name": "Helderberg Run Crew",
  "company": "Community running club",
  "state": "active",                 // active | prospect | paused | past | archived
  "industry": "Sport & Community",
  "projectType": "Website",
  "project": "Brand refresh and race-day registration platform",
  "revenue": 68000,
  "currency": "ZAR",
  "hours": 112,
  "deliverables": 14,
  "progress": 72,                    // 0..100
  "startDate": "2026-04-08",
  "endDate": null,
  "currentPhase": "Development",
  "lastInteraction": "2026-09-01",
  "notes": "...",
  "links": [{ "label": "Live site", "url": "https://..." }],
  "tags": ["community", "events"],
  "featured": true,                  // never demoted below the 'large' tile
  "branding": {
    "primary": "#0F766E",            // hex; drives the whole card palette
    "secondary": "#134E4A",
    "logo": "helderberg-run-crew/logo.png",   // relative to assets/clients/
    "images": [],
    "motif": "gradient"              // plain | gradient | mesh | grid
  }
}
```

**Extensibility:** unknown keys are preserved in `extra` and survive a round trip.
Add a field to the JSON by hand and it will not be destroyed, even before the
renderer knows about it.

**Validation never throws for a recoverable problem.** `validateClient()` returns
a normalised record plus a list of issues. A bad date, an unknown status, an
out-of-range progress, an invalid colour: all degrade with a warning. The only
fatal case is a record with no usable id, because it cannot be addressed.

Input is tolerant on purpose: `"R45,000"` parses as revenue, `status`/`type` alias
to `state`, `"completed"`/`"done"`/`"finished"` all map to `past`, `"2026-05"`
parses as a date.

---

## The layout engine (`src/shared/layout.ts`)

**Justified row packing on a discrete column grid.** Cards fill rows edge to edge
at mixed sizes, which reads as a bento composition rather than a grid or a scatter.

Rejected, with reasons in the file header: uniform grid (no hierarchy, the
"spreadsheet on the desktop" failure), masonry (ragged bottoms), skyline packing
(tighter but changes discontinuously when one item resizes), random placement
(not deterministic).

**Importance score** blends status (0.42), revenue (0.24, log-scaled), recency
(0.22, 45-day half-life) and in-flight progress (0.12).

**Tiers are assigned by RANK, not absolute threshold**, so the wall always has
visual variety: 40 uniformly dormant clients still produce heroes and smalls
rather than 40 identical tiles.

Tile ladder in grid units: `hero 6x4`, `large 4x3`, `medium 3x2`, `small 2x2`.

### Two guarantees, both verified by running them

1. **Deterministic.** Same data plus same viewport gives a byte-identical layout
   every launch. Ordering is score-desc with client id as an immutable tie-break.
2. **Stable under edits.** Size comes from a tier bucket, not the raw score, so a
   revenue or progress change moves nothing unless it crosses a bucket boundary.
   Measured: **editing one client's progress moved 0 other cards.**

### Pagination

Squeezing 40 clients onto one 1080p screen produced 41px cards: it fits and is
unreadable. Below a legibility floor (`MIN_ROW_UNIT = 62`) the wall stops shrinking
and becomes a slow ambient rotation between full-size pages, cross-fading every
`pageRotateSeconds`. Verified: 40 clients is 4 pages at 1080p, 1 page at 4K.

---

## Brand token derivation (`src/shared/color.ts`)

**The client's colour is a hue source, not a paint bucket.**

Raw client hex on a card gives neon-yellow text or an invisible near-black logo.
Instead: take the brand hue, clamp lightness and chroma into system-safe bands,
then *solve* numerically for contrast against the surface actually generated.

All maths in OKLab/OKLCh (perceptually uniform, so chroma clamps behave the same
across hues). **Contrast is measured with real WCAG relative luminance on the
resulting sRGB, not OKLab L**, because those are not the same thing.

The ordering matters: **design picks the colour, maths only intervenes if design
would ship something unreadable.** Body text prefers a crisp near-white (L 0.96)
and is only solved down if it fails. Solving first produced text sitting exactly
at the 7:1 threshold, which is legible and looks washed out.

**Verified against adversarial input.** All 12 cases pass AA: neon yellow, pure
white, pure black, mid grey, neon cyan, deep navy, hot pink, invalid hex, and
no colour at all. Clients with no brand colour get a stable hue derived from their
slug (FNV-1a plus golden-angle spread), so they still have an identity.

CSS contract consumed by a card: `--c-surface --c-surface-raised --c-border --c-fg
--c-fg-muted --c-accent --c-accent-fg --c-glow --c-hue`.

---

## Desktop behaviour

Three layer modes in `src/main/win32/desktop-layer.ts`:

| Mode | Mechanism | Input | Status on this machine |
|---|---|---|---|
| `desktop` **(default)** | `HWND_BOTTOM` + `WS_EX_NOACTIVATE` + `WS_EX_TOOLWINDOW` | hover and click work when the desktop is visible | **Verified working.** `ex=0x8080080`, not topmost, 21 visible windows above it in z-order. |
| `wallpaper` | `SetParent` into Explorer's WorkerW | none, the desktop owns input | **Refused on this Windows 11 build.** All 14 candidate layers rejected `SetParent`. Falls back automatically. |
| `top` | `HWND_TOPMOST` | full | Used by focus mode. |

**Wallpaper mode verifies rather than assumes.** `SetParent` into another process's
window can fail with no exception raised: stale handle after an Explorer restart,
a shell replacement, UIPI, or the Windows 11 desktop composition simply refusing.
The code sets the parent, **reads it back**, tries every candidate layer, and on
total failure logs precisely what it tried and degrades to `desktop`. A silent
failure would leave a blank desktop with a log claiming success.

**No z-order polling.** `WS_EX_NOACTIVATE` means the window is never activated, so
almost nothing raises it. Bottom is re-asserted only on display change, show, and
mode change.

**Multi-monitor:** one window per display, not one stretched across the virtual
desktop. A single stretched window breaks on mixed-DPI setups (Windows scales the
whole surface by the primary monitor's factor) and forces a full repaint of every
monitor when one card changes. Process is marked per-monitor DPI aware v2 before
any window exists. WorkerW coordinates are re-based onto the virtual screen origin,
which is negative when a monitor sits left of the primary.

**Startup** uses `app.setLoginItemSettings` (HKCU Run key): per-user, no elevation,
trivially inspectable and removable. Note `openAsHidden` is macOS-only; on Windows
the wall is inherently quiet because it has no taskbar button and never takes focus.

**Hotkeys:** `Ctrl+Alt+W` focus mode, `Ctrl+Alt+Shift+W` show/hide. Tray icon owns
the rest. The wall has no taskbar button, so the tray is the only affordance.

---

## Obsidian integration (READ-ONLY, and security-relevant)

`src/main/data/obsidian.ts` reads `<vault>/02-Clients/*.md`.

**The vault's own conventions file records that `02-Clients/r4tw.md` contains
client banking details, deliberately vault-only.** This wall is an ambient display
that anyone walking past the desk can read. Therefore:

- **Only YAML frontmatter is parsed. Note bodies are never read into memory.**
  Enforced structurally: only the first 16 KB is read and the body is discarded at
  the parse boundary, not filtered later.
- **Frontmatter keys are allowlisted.** A key someone adds to a note does not
  automatically reach the wall. Free-text and contact fields are not on the list.
- The parser is a deliberately minimal YAML subset (scalars, inline arrays, block
  lists). It cannot construct objects, resolve tags or follow anchors, so a
  malformed note produces junk strings at worst.

Wall-specific fields are namespaced `wall_*` (`wall_revenue`, `wall_progress`, ...)
so it is obvious in the vault what the wall consumes.

**Merge policy:** the local JSON file wins wherever it has a value; the vault only
fills gaps. The JSON carries deliberate presentation decisions, so a vault edit
should enrich the wall, never silently overwrite them.

**Nothing here writes, renames, moves or deletes.** If the vault is missing the
wall runs unchanged. Verified: adapter scanned all 7 real client notes cleanly.

---

## Security

- `contextIsolation: true`, `nodeIntegration: false`. The renderer gets 6 preload
  methods and nothing else.
- Strict CSP: `default-src 'none'`, no remote origins, no `connect-src`.
- **Client assets are served over a custom `mbw-asset://` protocol**, never
  `file://`. Every request is resolved against the assets root and rejected if it
  escapes. Client JSON is hand-edited and its paths are not trusted, so a `logo`
  of `../../../../.ssh/id_rsa` reads nothing.
- `openExternal` only accepts `http(s)`.
- All DOM text goes through `textContent`. **There is no `innerHTML` anywhere.**

---

## Performance rules

The wall runs 24/7. Every effect is paid continuously.

- **Only `transform`, `opacity` and CSS custom properties are animated.** Nothing
  animates layout.
- `backgroundThrottling` stays **on**, and `CalculateNativeWinOcclusion` is
  deliberately **not** disabled. Chromium stops painting the wall while other apps
  cover it, which is most of the time. This is the biggest idle-CPU win.
- Cards are created once and mutated in place. A data change diffs against the DOM
  rather than rebuilding, which would restart every entrance animation.
- The cursor edge-glow runs **one** rAF for the whole wall, only while a card is
  hovered, and only writes two custom properties. It never reads layout.
- File watching is chokidar with a 350 ms debounce and `awaitWriteFinish`. **No
  polling.** An idle wall does no filesystem work.
- Capability tiering (`capability.ts`) reads real GPU feature status, cores, RAM
  and battery state, and the renderer scales its motion budget via `[data-perf]`.
  At `low` the edge glow and mesh wash are dropped entirely.

---

## Do not break

1. **One JSON file per client.** Merging them into one file destroys error isolation.
2. **Never read Obsidian note bodies.** Frontmatter allowlist only. See above.
3. **Card position must stay in `--x`/`--y` custom properties.** A bare
   `transform: translate3d()` on `.card` is silently overridden by the entrance
   keyframe's `to` frame and snaps every card to the origin. This bug cost a full
   render cycle to find.
4. **`--card-h` must carry a `px` unit.** `calc(var(--card-h) * 0.088)` on a
   unitless value is an invalid length and voids the entire `font-size` declaration.
5. **Vertical spacing must be driven by `--card-h`, never percentages.** Percentage
   padding and margins resolve against the container's **width** even for
   top/bottom, so a wide 192px-tall card was given 52px of vertical padding.
6. **`body` must set a `color`.** Without it, anything not explicitly coloured
   inherits the UA default black and vanishes on a dark surface.
7. **Never let `.card-body` shrink.** The metrics and progress are the point of the
   card; the prose headline gives up lines first.
8. **Verify `SetParent`, never assume it took.**
9. **`koffi` and `chokidar` must stay `external` in the esbuild config.** koffi
   loads a native binary and cannot be bundled.
10. **Validation must never throw for a recoverable problem.** One bad client must
    never cost more than one card.

---

## How to add a client

1. Create `data/clients/<slug>.json` using the shape above. Filename must match `id`.
2. Optional assets in `assets/clients/<slug>/`, referenced relative to that root.
3. Nothing else. The file watcher picks it up within ~350 ms; no restart needed.

Minimum viable record is `{ "id": "x", "name": "X" }`. Everything else degrades.

## How to update a client

Edit that client's JSON file only. Never touch other clients' files, and never
rewrite the renderer for a data change. Progress, revenue, status and dates are
all data.

Marking a client finished: `"state": "past"`, `"progress": 100`, set `"endDate"`.

## How to restyle one client

In order of preference:
1. `branding.primary` (drives the entire derived palette)
2. `branding.motif` (`plain` | `gradient` | `mesh` | `grid`)
3. `featured: true` to force a larger tile
4. Only if none of those suffice, add a *reusable* variant to the CSS keyed off a
   data attribute. Do not write one-off per-client CSS.

---

## Current clients (demonstration data)

Ten fictional clients spanning active/prospect/paused/past/archived, deliberately
different industries, brand colours, project types and completeness. Plus
`zz-broken-example.json`, which is **intentionally malformed** and must stay:
it is the live proof that one bad file costs one card. Do not "fix" it.

`okonkwo-legal` has no brand colour at all, proving the slug-hue fallback.

---

## Known issues

1. **GPU compositing is unavailable on this machine.** Chromium reports
   `disabled_software` for every feature; `--ignore-gpu-blocklist` does not help,
   it is not a remote session, the driver is healthy and no policy blocks it. The
   capability system correctly detects this and drops to the `low` tier. Override
   with `"performance": "high"` in settings if needed.
2. **Wallpaper layer mode does not work on this Windows 11 build.** All 14
   candidate layers refuse `SetParent`. Falls back to `desktop` automatically.
   Kept because it works on many Windows 10 and earlier Windows 11 configurations.
3. **Memory is ~293 MB private across 4 processes.** Reduced from 424 MB, but this
   is the honest cost of Electron plus a full-screen transparent window being
   software-composited. Expect lower with working GPU acceleration.
4. **Plus Jakarta Sans is not bundled.** Falls back to Segoe UI Variable Display,
   which is a good match. Drop a woff2 at `assets/clients/fonts/PlusJakartaSans.woff2`
   to use the real face.
5. **Packaged builds ship demonstration data on first run.** Replace it with real
   clients via the tray's "Open client data folder".

---

## Packaging

`npm run package` produces a **per-user NSIS installer** (no admin prompt) in
`release/`. Measured: **106.5 MB installer, 370 MB unpacked**, built in about a
minute. Unlike the Tauri toolchain this costs roughly 0.65 GB of disk, which the
machine can afford.

Two things the packaged build has to get right, and does:

- **koffi is `asarUnpack`ed.** It loads a native `.node` binary at runtime and
  cannot be read from inside an asar archive. Verified present at
  `resources/app.asar.unpacked/node_modules/@koromix/koffi-win32-x64/`.
- **Client data lives in userData, not next to the exe.** Program Files is not
  writable and the whole point is that these files get hand-edited. The shipped
  data under `resources/data/` is *seeded* into
  `%APPDATA%\MuchBetter Client Wall\data\clients` on first run and **never
  overwritten**, so an upgrade cannot clobber real client files and a deleted
  client stays deleted.

Verified end to end: packaged exe seeded 11 files, loaded 10 clients with the one
intentional failure, drove the Win32 layer, and rendered identically to the dev
build.

The app has no custom icon yet, so Windows shows the default Electron icon.

---

## Future ideas

Architecture already supports these without a rewrite: client timeline and
milestones, revenue analytics, project galleries and screenshots, testimonials,
filtering and search, client groups, per-monitor content assignment (the settings
key `monitors` exists), light-theme wall.
