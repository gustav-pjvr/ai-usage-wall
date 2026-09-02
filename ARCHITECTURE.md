# MuchBetter Client Wall

Long-term memory for this project. Claude: **read this before changing anything.**
Written 2026-09-02. Keep it current, it is the contract between sessions.

---

## Purpose

An ambient Windows desktop application with two views:

1. **Claude Stats** (default) a live command centre for local Claude Code usage.
2. **MuchBetter Clients** a living wall of the work, as individually branded cards.

Neither is a CRM and neither is a spreadsheet. Both are meant to be looked at.

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
│   │   │   └── desktop-layer.ts  <- the two layer modes
│   │   └── data/
│   │       ├── store.ts     <- loading, error isolation, file watching
│   │       ├── obsidian.ts  <- READ-ONLY vault adapter
│   │       └── usage.ts     <- Claude transcript indexer, incremental
│   ├── preload/index.ts     <- the only bridge
│   └── renderer/
│       ├── main.ts          <- client wall + mode switching
│       ├── stats.ts         <- Claude Stats view
│       └── styles/          <- wall.css, stats.css, shell.css
├── scripts/
│   ├── deploy.mjs           <- THE install path. build, upgrade, verify, relaunch
│   └── logo.mjs             <- generates the mark, icons and wordmark
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

Two layer modes in `src/main/win32/desktop-layer.ts`:

| Mode | Mechanism | Input | Status on this machine |
|---|---|---|---|
| `desktop` **(default)** | Inserted directly above `Progman`, plus `WS_EX_NOACTIVATE` and `WS_EX_TOOLWINDOW` | hover and click work when the desktop is visible | **Verified working**, by hit test rather than by z-order: 4 of 4 sampled points return our window. |
| `top` | `HWND_TOPMOST` | full | Used by focus mode. |

A wall that ignores the mouse is `desktop` plus `clickThrough`, not a mode of
its own.

**Wallpaper mode was removed on 2026-09-02, after being measured.** It
`SetParent`ed the window into the WorkerW that Explorer paints the wallpaper
into. Two separate findings killed it, and the first one is the more important:

1. **The verification was reading the wrong property.** It confirmed the parent
   with `GetParent()`, which returns the **owner** of a `WS_POPUP` window, and
   every Electron window is `WS_POPUP`. It therefore answered NULL whatever the
   truth was. The code reported `SetParent refused by all 15 candidate layers`
   while the window was in fact parented into the last candidate it tried. The
   `desktop` fallback then skipped its detach, because that was gated on
   `GetParent` too, and z-ordered a **child** window against its own parent,
   which means nothing. The wall vanished, and because the failing mode had
   already been written to `settings.json`, restarting the app replayed the
   failure. The only escape was the tray.

2. **Corrected, it still painted nothing.** Parented to the real WorkerW and
   confirmed with `GetAncestor(hwnd, GA_PARENT)`, sized to the full display in
   physical pixels, then every window minimised and one screen pixel read with
   GDI `CopyFromScreen`. Opaque, `transparent: true`, and `WS_POPUP` converted
   to `WS_CHILD` all returned the wallpaper's own colour, identical to the
   control taken with the app not running.

   Unverified hypothesis, recorded so the next person does not start from
   scratch: Chromium's native window occlusion tracker may treat a window living
   beneath `SHELLDLL_DefView` as fully occluded and stop painting it. Testing
   that means disabling `CalculateNativeWinOcclusion`, which is one of this
   project's biggest idle-CPU wins, so it was not tested. It is a hypothesis,
   not a cause.

`verifyLayer()` replaces that check for the modes that remain. It tests
conditions that are **necessary** for the wall to be on screen (top-level,
visible, placed inside the display), so any failure proves the wall is not
showing, which is enough to reject a mode. It does not claim to prove pixels,
and the log line says "verified: top-level, visible, placed", never "verified
rendering".

**`HWND_BOTTOM` was wrong, and looked right.** The original implementation sank
the window to the very bottom, which passed every check I ran: correct z-order,
not topmost, visible, 21 windows above it. It was still broken. Explorer's
`SHELLDLL_DefView`, the desktop icon host, spans the whole screen, is
transparent, and sat above us, so Windows hit-tested it first and **every click
and hover went to the desktop.** The wall looked perfect and was completely
inert. Gustav found it by trying to use the mode switcher.

The fix is to insert directly above `Progman` instead. `DefView` is Progman's
child, so being above Progman puts us above the icon layer. We still never
activate, so any focused app rises above us.

**The lesson, now a rule: verifying placement is not verifying input.**
`inputReachesWall()` calls `WindowFromPoint` inside our own bounds and logs
which window actually owns the pixel. Confirmed after the fix: 4 of 4 sampled
points return the wall, where all 4 previously returned `explorer`.

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

**The vault's own conventions file records that at least one client note contains
financial details, deliberately vault-only.** This wall is an ambient display
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
8. **Never assume a Win32 call took.** `SetParent` and `SetWindowPos` both
   report success for things that did not happen the way you meant. Read the
   real property back, with the right API for that property. See 20.
9. **`koffi` and `chokidar` must stay `external` in the esbuild config.** koffi
   loads a native binary and cannot be bundled.
10. **Validation must never throw for a recoverable problem.** One bad client must
    never cost more than one card.
11. **Strip the UTF-8 BOM before every `JSON.parse`**, in the client store and in
    settings alike. Notepad and PowerShell's `Set-Content -Encoding utf8` both
    write one, `JSON.parse` rejects it, and the failure is invisible: the file
    looks perfect and is silently ignored. This has now bitten twice.
12. **Never invent a usage metric.** If a number cannot be read out of the
    transcripts, it does not go on the dashboard. Quota, headroom and cost are
    all unobtainable locally and are stated as such rather than estimated.
13. **Never break the usage-index offset invariant.** After a refresh every
    tracked offset must equal its file size, or records get counted twice.
14. **Hide an inactive view with `visibility: hidden`, not just
    `pointer-events: none`.** The latter is re-enabled by any descendant that
    sets `pointer-events: auto`, which left the hidden client wall intercepting
    input meant for the stats view.
15. **Never present a partially built index as complete.** `refreshIndex`
    mutates in place, so readiness must be stated by the main process, not
    inferred from whether any data is present.
16. **Never place the wall at `HWND_BOTTOM` in desktop mode.** It puts the
    window under Explorer's transparent desktop icon layer, which then eats
    every click and hover while the wall still looks perfect. Anchor above
    `Progman` and confirm with `inputReachesWall()`.
17. **Never put the wall in a state the user cannot escape without Task Manager.**
    Focus mode is topmost, fullscreen and opaque: Escape must always exit it and
    it must always show a way out. Do not bind it to an easily-hit gesture.
18. **`npm run deploy` is the only way the app gets installed or updated.**
    Running `release/win-unpacked` directly is what caused a stale install once.
19. **Never use `app.setLoginItemSettings()` on Windows here.** It neither throws
    nor registers on this machine. Electron's Windows implementation is not safe
    against spaces in the profile path, and this profile has them. Write
    `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` directly via `reg.exe`,
    with the executable path quoted.

20. **Never read a window's parent with `GetParent`.** For a `WS_POPUP`
    top-level window, which every Electron window is, it returns the **owner**,
    which is NULL, so it reports "not parented" whatever the truth is. That is
    how wallpaper mode announced "refused by all 15 candidates" while the wall
    sat inside `Progman`, and how the detach that would have rescued it never
    ran. Use `GetAncestor(hwnd, GA_PARENT)` and compare against
    `GetDesktopWindow()`, never against zero. The `GetParent` binding has been
    deleted from `ffi.ts` so this cannot come back by autocomplete.
21. **Never persist a layer mode the wall has not verified in.**
    `updateSettings` applies, verifies, and only then writes; a rejected mode is
    reverted in memory before the write, and a persisted mode that fails at
    launch is healed to `desktop` and written back. `settings.json` mirrors
    verified state, never requested state. The old order, write first and apply
    second, is precisely what made restarting the app repeat the failure instead
    of escaping it.
22. **Never offer a layer mode whose only failure signature is "every
    structural check passes and nothing renders."** Wallpaper mode was exactly
    that: parented, visible, correctly sized, and blank. If it ever returns, it
    returns with a pixel-level render probe and a countdown revert like Windows
    display settings, and only after some machine has been **measured** painting
    it.
23. **The stats edition must never ship, seed, read or watch client data.** It
    is not a hidden view, it is an absent one: `data/` is left out of its
    `extraResources`, `seedUserData` returns early, the store and the Obsidian
    bridge are never started, and the clients view is removed from the DOM
    rather than hidden. Verify it the way it was verified the first time, by
    grepping the unpacked build for a client name and expecting nothing.

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
different industries, brand colours, project types and completeness.

`okonkwo-legal` has no brand colour at all, proving the slug-hue fallback.

**A deliberately malformed `zz-broken-example.json` used to ship here** to prove
that one bad file costs one card. It did prove it, and then it turned up as a
permanent red error card on a real desktop after the first install, which is
clutter rather than a demonstration. Removed. The behaviour it demonstrated is
unchanged and still covered by the schema tests: a broken client still renders a
card naming the parse error, it just is not seeded on purpose any more.

**Do not ship intentionally broken data as a default.** Demonstrate error
handling in tests, not on the user's screen.

---

## Known issues

1. **GPU compositing is unavailable on this machine.** Chromium reports
   `disabled_software` for every feature; `--ignore-gpu-blocklist` does not help,
   it is not a remote session, the driver is healthy and no policy blocks it. The
   capability system correctly detects this and drops to the `low` tier. Override
   with `"performance": "high"` in settings if needed.
2. **Wallpaper layer mode was removed on 2026-09-02.** It never rendered on any
   machine this project has measured, and its earlier "refused on this build"
   diagnosis was itself an artefact of the `GetParent` bug. See "Desktop
   behaviour". The claim that it worked on other Windows configurations was
   never measured and should not be repeated.
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


---

## Claude Stats

### Where the numbers come from

Claude Code writes an **append-only JSONL transcript per session** under
`~/.claude/projects/<slugified-cwd>/<sessionId>.jsonl`. Every assistant record
carries a real `message.usage` block: `input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens`,
`output_tokens_details.thinking_tokens`, `server_tool_use` counts, plus model,
timestamp, `sessionId` and `cwd`. `~/.claude/history.jsonl` separately records
every prompt submitted.

That is the whole source, and it is entirely local: **no API, no authentication,
no network, therefore no rate limits and nothing that can go down.**

Measured on this machine: **419 transcripts, 961 MB, 71,962 usage records across
51 days, 61 sessions, 8 models.**

### What was ruled out, and why

| Candidate | Verdict |
|---|---|
| Anthropic Usage / Cost Admin API | Needs an admin API key issued to an organisation. It does not cover Claude subscription usage and no such key exists here. |
| Remaining quota, plan limits, reset times | **Not obtainable.** A limit appears only as free text inside a transcript, indistinguishable from an assistant message *discussing* rate limiting. A first attempt at counting them reported 200, which was simply its own cap: it had matched conversations about building rate limiters. The metric was removed rather than shipped wrong. |
| Money | On a subscription, per-token pricing is not what is billed, so a currency figure would be invented. Tokens are reported instead. |

### Refresh strategy, and why polling is wrong

A full parse is **961 MB in 5.5 s (174 MB/s)**, so a cold index is a one-off cost
cached to disk. The files are append-only, so every refresh afterwards reads
**only the bytes appended since the last read**, tracked as a byte offset per
file. That is ~100 ms.

Because of that, **polling on an interval would be strictly worse on both counts**:
there is no server to ask and no quota to spend, so a timer can only add latency
(up to a full interval) and waste work while idle. The trigger is instead a
**native recursive `fs.watch`** on the transcript tree, debounced 900 ms. Windows
supports recursive watching natively, so one watcher covers all 419 files without
chokidar walking a 960 MB tree.

**The no-double-count invariant:** after a refresh every tracked `offset` equals
that file's `size`, so no byte can be read twice. Verified: a second refresh
added exactly the records from the one file that grew, 23 KB of live session.
A file that *shrank* was rewritten and its aggregates cannot be reversed, so that
case triggers a full rebuild rather than serving numbers known to be wrong.

**If the source is unavailable** the index reports `unavailable` with the reason,
the last good cached numbers stay on screen, and the status strip turns amber.

### The headline number is real but needed context

An independent recount (fresh code, not the indexer) confirmed the figures to
within the records this session appended while it ran: **72,057 vs 72,060
requests, 26.10B vs 26.11B tokens.**

That same recount exposed a presentation flaw. The composition of "total tokens
processed" is:

| Part | Share |
|---|---|
| cache reads | 97.24% |
| cache writes | 2.54% |
| **generated** | **0.21%** |
| fresh input | 0.01% |

Cache reads are the same context re-read on every turn. The total is correct and
correctly labelled, but on its own it reads as consumption, when only about 54M
tokens were actually generated. So the hero now carries a proportion strip and a
legend directly beneath it, and the counter is labelled "Generated" rather than
"Output tokens". **A true number is not automatically an honest one.**

### Measured vs derived

Every panel is tagged in the UI, because the distinction is the point.

- **MEASURED**, straight from the transcripts: total tokens, output, cache read
  and write, thinking tokens, requests, sessions, prompts, days active, model
  split, per-project split, daily and hourly activity, Claude Code version.
- **DERIVED**, with the method stated on the panel: velocity (tokens/min over a
  trailing 10 minutes of record timestamps), context efficiency (cache reads over
  all context tokens).
- **Absent on purpose:** quota, headroom and cost. The status strip says so.

### Update rate

The watcher fires on every transcript write, so the raw signal is roughly once a
second during an active session. That is accurate and **restless to look at**, so
refreshes are floored at one per **4 seconds**; nothing is missed, it just lands
together. The status strip's relative times tick on a separate 20 s clock, and
the canvas draws at 12 to 30 fps by tier. There is still no polling anywhere.

Two things were also crossing the boundary far too often and are now fixed:
the full index (170 KB, half of it a per-file offset map the renderer never
reads) was sent over IPC on every refresh, and the disk cache was rewritten each
time. The renderer gets a projection without that map, and the cache is written
at most once a minute plus on quit.

### Focus mode must never trap the user

**Double-clicking the tray icon used to enter focus mode**, which makes the wall
topmost, fullscreen, opaque and interactive. With the backdrop now opaque this
covered the entire desktop with no visible way out, and the only escape was
killing the process. That happened to Gustav.

Three changes, and all three matter:
- Tray double-click now shows/hides, which is what people expect anyway.
- **Escape always leaves focus mode**, from anywhere.
- Focus mode shows a visible "Exit focus" control and lifts the switcher to full
  opacity, so the state announces itself.

Verified after the fix: the wall reports `TOPMOST False`, `NOACTIVATE True`, with
24 windows above it in z-order.

### Startup and the loading state

The app registers at login and opens straight into Claude Stats. The window is
created at full display bounds and shown on `ready-to-show`, so it covers the
desktop from the first painted frame.

On a warm start the cached index is loaded and pushed before the window appears,
so real numbers are on screen immediately. Only a **cold** index shows the
loading state, with real progress (transcripts read, MB of MB) rather than an
indeterminate spinner.

**Readiness is stated by the main process, never inferred from the data.**
`refreshIndex` mutates the index in place, so a half-built one is observable.
Inferring "ready" from `requests > 0` briefly presented 5 of 419 transcripts as
the final totals: 11.5M tokens, 3 days active, 2 sessions, all wrong and all
looking authoritative. The payload now carries an explicit `indexing` flag.

### Hidden views must be truly hidden

`pointer-events: none` on a container **does not lock out its descendants**: a
child that sets `pointer-events: auto` becomes hittable again, and `.card` did.
So the hidden client wall stayed live on top of the stats view, swallowing every
hover and click. Clicking a chart opened a client detail panel, and no tooltip
ever appeared.

`visibility: hidden` is inherited and cannot be overridden from below, so the
inactive view now uses that, transitioned with a delay so the cross-fade still
plays. `.card` hit-testing is additionally scoped to `.view.is-active`.

### Motion budget

The activity canvas only runs while the stats view is on screen, is frame-capped
by performance tier (12 fps on the low tier, since software rendering repaints
the whole surface), and calms down as Claude goes idle. `--intensity`, derived
from real throughput, drives every glow and pulse, so an idle wall is visually
quiet *and* cheap. Chromium already stops painting entirely when other windows
cover the wall.

### Project keys are lowercased

Claude Code records `cwd` with whatever drive-letter case the shell used, so the
same folder appeared as both `C:\...` and `c:\...` and was counted as two
projects with the same display name. Keys are lowercased for grouping and the
original casing is kept in `display` for reading.

---

## Updating

**`npm run deploy` is the only install path.** It builds, packages, upgrades the
installed app in place (per-user NSIS, silent, no admin), verifies the registry
version matches `package.json`, prunes superseded installers and relaunches.

This exists because a stale installed copy while a newer build sat in
`release/win-unpacked` already happened once and cost real confusion: data
changes reached the running app (they live in `%APPDATA%`) while code changes did
not. The deploy script makes that structurally impossible, and it fails loudly if
it ever finds more than one installation.

electron-updater was considered and rejected for now: the repo is private, so the
app would have to carry a GitHub token, a real secret shipped inside a desktop
binary for a tool with one user who is sitting at the machine that builds it. If
it is ever wanted on a second machine, make releases public and revisit.

---

## Identity

The mark is a **constellation whose stars are the client tiles**: rounded squares
of different sizes in different brand hues on a dark plate, linked by faint
lines. That reconciles the three requirements that otherwise fight each other,
namely "constellation", "reads instantly as its subject", and "must survive
16px". Dots would have failed the third.

`npm run logo` regenerates everything from `scripts/logo.mjs`:

| Output | Use |
|---|---|
| `assets/logo/mark.svg` | vector master, plated variant |
| `assets/logo/mark-small.svg` | vector master, simplified variant |
| `assets/logo/icon.ico` | app and installer icon, 7 entries (16 to 256) |
| `assets/tray.png` + `tray@2x.png` | tray icon, 1x and 2x |
| `assets/logo/lockup-on-{light,dark}.png` | wordmark, 1x and 2x |

Three things about it are deliberate:

- **Two variants, with a switch at 48px.** At and above 48 the plated mark is
  used; below it the simplified four-tile variant takes over. The plate merges
  into a dark taskbar and the constellation lines become sub-pixel noise at
  small sizes, so they are dropped rather than scaled down.
- **The palette is computed with the same oklch maths the cards use**, from the
  same five-hue family at one lightness and chroma. The logo cannot drift out of
  sync with the product's colour system.
- **Two lockups, not one.** Near-white text vanishes on a light README and dark
  text vanishes on a dark one, and no middle value looks deliberate on both.

Rasterisation draws the geometry with **Canvas 2D inside a page**, not
`capturePage()`. Three capture-based approaches were tried and all failed on
Windows: one window per size (Windows clamps small window sizes), one tall sheet
cropped per size (`capturePage()` returns only the visible viewport, which came
back 256px tall regardless of window height), and `capturePage()` with an
explicit rect (died natively after the first tile: exit code 0, no exception,
nothing logged). The geometry constants feed both the SVG and the canvas, so the
vector and raster outputs cannot diverge.

**`build.mjs` must never write `assets/tray.png` again.** It used to generate a
placeholder there on every build, which silently clobbered the real logo.

---

## Future ideas

Architecture already supports these without a rewrite: client timeline and
milestones, revenue analytics, project galleries and screenshots, testimonials,
filtering and search, client groups, per-monitor content assignment (the settings
key `monitors` exists), light-theme wall.
