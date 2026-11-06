# MuchBetter Client Wall

Long-term memory for this project. Claude: **read this before changing anything.**
Written 2026-09-02. Keep it current, it is the contract between sessions.

---

## Purpose

An ambient Windows desktop stats wall for local Claude Code usage, with Codex
beside it when available. Claude Stats is the only view in the stats edition.
The full build keeps its installed identity for upgrades and adds Work mode, the
monday Tasks board ([docs/work-mode.md](docs/work-mode.md)), whose code never
reaches the stats bundles.

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
├── src/
│   ├── shared/              <- pure, testable, no Electron imports
│   ├── main/                <- Electron main process
│   │   ├── index.ts         <- windows, tray, hotkeys, IPC, orchestration
│   │   ├── capability.ts    <- hardware tiering
│   │   ├── settings.ts      <- settings file, atomic writes
│   │   ├── win32/
│   │   │   ├── ffi.ts       <- koffi bindings to user32
│   │   │   └── desktop-layer.ts  <- the two layer modes
│   │   └── data/
│   │       └── usage.ts     <- Claude transcript indexer, incremental
│   ├── preload/index.ts     <- the only bridge
│   └── renderer/
│       ├── main.ts          <- stats shell + focus controls
│       ├── stats.ts         <- Claude Stats view
│       └── styles/          <- wall.css, stats.css, shell.css
├── scripts/
│   ├── deploy.mjs           <- THE install path. build, upgrade, verify, relaunch
│   └── logo.mjs             <- generates the mark, icons and wordmark
└── dist/                    <- build output
```

`src/shared/` deliberately imports nothing from Electron so it can be unit-tested
with plain node. Shared stats algorithms are verified that way.

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

**Z-order polling, reluctantly.** `WS_EX_NOACTIVATE` means the window is never
activated, so almost nothing raises it, and for a long time bottom was re-asserted
only on display change, show, and mode change. That was not enough. Show Desktop
raises the DESKTOP over the wall and fires no event at all, leaving the wall
correctly placed, visible, non-iconic and completely hidden behind the wallpaper.
`src/main/win32/desktop-watch.ts` now polls the Z order every 250 ms and re-places
the wall directly above whichever window hosts `SHELLDLL_DefView`. See
`docs/window-layering.md`.

**Multi-monitor:** one window per display, not one stretched across the virtual
desktop. A single stretched window breaks on mixed-DPI setups (Windows scales the
whole surface by the primary monitor's factor) and forces a full repaint of every
monitor when one card changes. Process is marked per-monitor DPI aware v2 before
any window exists. WorkerW coordinates are re-based onto the virtual screen origin,
which is negative when a monitor sits left of the primary.

**Startup** writes the HKCU Run key directly with `reg.exe`, per-user, no
elevation, trivially inspectable and removable. It does NOT use
`app.setLoginItemSettings`, which rule 19 below forbids on Windows; this
paragraph used to say it did, which contradicted the rule three hundred lines
later. `openAsHidden` is macOS-only anyway; on Windows the wall is inherently
quiet because it has no taskbar button and never takes focus.

**Hotkeys:** `Ctrl+Alt+W` focus mode, `Ctrl+Alt+Shift+W` show/hide. Tray icon owns
the rest. The wall has no taskbar button, so the tray is the only affordance.

---

## Security

- `contextIsolation: true`, `nodeIntegration: false`. The renderer gets 6 preload
  methods and nothing else.
- Strict CSP: `default-src 'none'` with an explicit **`connect-src 'none'`** in
  both `index.html` and `pair.html`. The renderer cannot open a socket even if
  something in it tried; all networking is main process (rule 27).
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
- Capability tiering (`capability.ts`) reads real GPU feature status, cores, RAM
  and battery state, and the renderer scales its motion budget via `[data-perf]`.

---

## Do not break

6. **`body` must set a `color`.** Without it, anything not explicitly coloured
   inherits the UA default black and vanishes on a dark surface.
8. **Never assume a Win32 call took.** `SetParent` and `SetWindowPos` both
   report success for things that did not happen the way you meant. Read the
   real property back, with the right API for that property. See 20.
9. **`koffi` and `chokidar` must stay `external` in the esbuild config.** koffi
   loads a native binary and cannot be bundled.
11. **Strip the UTF-8 BOM before parsing hand-edited JSON**, including settings. Notepad and PowerShell's `Set-Content -Encoding utf8` both
    write one, `JSON.parse` rejects it, and the failure is invisible: the file
    looks perfect and is silently ignored. This has now bitten twice.
12. **Never invent a usage metric.** If a number cannot be read out of the
    transcripts, or COMPUTED from them by a rule the panel states, it does not
    go on the dashboard. Quota and headroom are unobtainable locally and are
    stated as absent rather than estimated. Cost is different and this line used
    to get it wrong: token counts are in the transcripts and a dated price table
    turns them into a figure, so cost is shown, tagged DERIVED, floored to the
    cent, and captioned as list prices rather than as what a subscription bills.
13. **Never break the usage-index offset invariant.** After a refresh every
    tracked offset must equal its file size, or records get counted twice.
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
23. **Neither edition reads or ships client records or assets.** The store,
    vault bridge, seeding and asset protocol are removed. Keep existing local
    records untouched. Both editions show stats without a view switch.
25. **Projection off must mean no network object is constructed at all**, not a
    socket that happens not to connect. `startProjection()` returns before
    anything exists if `projection.json` is absent, and `RelaySocket` is
    reachable only from `activate()`. An idle-but-constructed socket is how "no
    network" quietly becomes "no traffic we looked for", and the whole public
    claim rests on the difference. If a lazy connect or a keepalive ever appears
    above that gate, the sentence on the website stops being true.
26. **Never put a path, a username or a session id on the wire, and never add a
    second serialiser.** `toWire()` is the only one, and it names every field
    explicitly instead of spreading the index, so a field added upstream cannot
    reach a screen by accident. Spreading it once would leak `cwd` and
    `sessionId` on the very next refresh, silently, to a machine in another
    building. `fromWire()` re-inserting `sessionId: null` and `cwd: null` is the
    proof, and it is worth keeping.
27. **The renderer keeps `connect-src 'none'`.** All networking is main process,
    in `src/main/projection/`. The renderer draws a dashboard, and a renderer
    that can open a socket turns every future rendering bug into a data-exfil
    bug. Relaxing that directive, in either `index.html` or `pair.html`, is not
    a CSP tweak, it is a change of threat model.
28. **A screen claims liveness only from a frame it decrypted.** The relay
    saying the source is online is not evidence that any data arrived, and
    trusting it prints `LIVE` over numbers that stopped moving twenty minutes
    ago, which is the one failure that makes the whole feature untrustworthy.
    Phase wording is a pure function and is tested in
    `test/stats-projection.test.mjs`; keep it that way.
29. **Discard any frame whose sequence is not strictly greater than the last one
    accepted.** Not "not equal", not "close enough". The sequence is inside the
    GCM AAD so it cannot be edited in flight, but a relay can still replay an old
    frame, and a replayed frame is a screen that quietly reverts to yesterday's
    totals and looks perfectly healthy doing it.
30. **Projection must never delay or break the local dashboard.** The wall
    rendered before this feature existed and must render identically without it.
    `flush()` is scheduled, never awaited by the refresh path, and a relay that
    is down, slow or hostile is an amber pill and nothing more. The moment a
    network round trip can stall a repaint, an outage on someone else's Worker
    becomes a frozen desktop here.
31. **The source's credentials file is the truth about screens; the relay is
    rebuilt from it.** Revoke deletes the key locally FIRST and tells the relay
    second, queueing the notification if the send fails, so revocation does not
    depend on the relay cooperating or even being reachable. Any design where
    the relay's screen list is authoritative means a compromised relay can
    reinstate a screen the user removed.
32. **Never store key material in `settings.json`.** That file is hand-edited,
    backed up, synced, and pasted into chat windows when something goes wrong.
    Projection keys live in `projection.json` in userData under `safeStorage`,
    and the split exists precisely because the two files have opposite
    handling. Note the plaintext fallback when `safeStorage` is unavailable:
    document it, do not pretend it is not there.
33. **Hostnames and labels never cross the relay in plaintext.** The source's
    label and a screen's `os.hostname()` both travel inside a sealed frame, and
    the cleartext relay protocol carries only `t`, `secret`, `lookup`, `pub`,
    `exp`, `spaceId`, `screenId`, `to`, `from` and `ct`. A machine name is the
    one field that would let the relay operator turn anonymous metadata into
    "this is Gustav's laptop, and here is when he works", so it belongs under
    the encryption and not beside it.

---
34. **Every size in `stats.css` is a multiple of `--u`.** A bare `px` font size
    or margin there is a bug, not a style: the grid is fluid and fixed contents
    inside it are exactly how text got clipped on a smaller screen. `--u` is one
    pixel at the 1920x1080 reference and takes the smaller of the width-derived
    and height-derived unit, so it tracks whichever axis actually ran out.
    `clamp()` against `vw` alone is worse than nothing here and is what was
    removed: two screens of equal width and different height are the common case
    on this kind of surface. See `docs/responsive-layout.md`.
35. **When there is no room left, drop a caption. Never clip a number.** Both
    floors, `--u` at 0.7 and the 8px minimum on the label tier, exist so that
    shrinking stops before text becomes unreadable. Past that point the
    short-screen media queries remove explanatory text and keep every value.
    Verify with `npm run test:render`, which measures real overflow in a real
    window at eight sizes rather than reading a font size and reasoning about it.
36. **The notes bar stays on this machine.** It is not in `toWire()` and must not
    be: it holds whatever Gustav happens to be thinking about, and a paired
    screen is another building. Adding it to projection would make
    `docs/privacy-wire.md` false. It also stays `readonly` until a double click,
    because the wall collects stray clicks all day and a field that quietly
    accepts them corrupts the note long before anyone notices.
37. **A milestone is announced once, ever, and never from an incomplete
    index.** The ledger lives in `milestones.json`, outside the usage cache,
    because the cache is thrown away on every index version bump. The first
    evaluation seeds silently. Evaluation runs only after `refreshIndex` has
    resolved, never while indexing or when the source is unreadable. An
    announcement cannot be taken back, so the gate is the whole feature.
38. **Nothing that talks about "today" or "a day" reads `daily`.** `daily` is keyed
    by the UTC date and Gustav chose to keep it so. Local days come from
    `src/shared/day.ts` (`localDayKey`), as `activeDays` and the time-lapse's
    five-minute `intraday` slots do. Never build a day from a session's start and end:
    a resumed session keeps its id, and its span on this machine reaches 1107
    hours.
39. **The constellation and the replay repaint on change, never on a timer, and
    anything that moves is one DOM element or is capped by performance tier.**
    GPU compositing is unavailable on Gustav's laptop, so a loop is paid for in
    software every frame. The replay is driven by elapsed time and hard-stops,
    so a slow frame shortens it rather than stretching it (rule 17).
40. **A screen never relabels labels.** Projected project names are already
    labels; running `labelProjects` on them again split `Desktop / code` on its
    own slash. `projectLabels(paths, alreadyLabelled)` in `stats.ts` does this for the project list; the constellation does the same with an identity map on a screen.
41. **A number the wall has shown never falls because a transcript was
    deleted, a cache was discarded or the index was rebuilt.** The usage index
    is a cache of transcripts Claude Code deletes after `cleanupPeriodDays`, so
    it cannot be the record. Each file's contribution is kept in the index and
    MOVED to the history store (`src/main/data/history.ts`) when the file is
    confirmed gone (`ENOENT` only, never a lock or a missing listing), history
    saved first. A path is in exactly one of the two. Every consumer reads
    `mergeHistory(live, history)`. Reconstructed history is said, never passed
    off as measured (rule 12). 0.9.13 broke this and halved the wall; see
    [docs/usage-history.md](docs/usage-history.md).

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
4. **Plus Jakarta Sans is not bundled.** Falls back to Segoe UI Variable Display.

---

## Packaging

`npm run package` produces a **per-user NSIS installer** (no admin prompt) in
`release/`. Measured: **106.5 MB installer, 370 MB unpacked**, built in about a
minute. Unlike the Tauri toolchain this costs roughly 0.65 GB of disk, which the
machine can afford.

Packaging requirements:

- **koffi is `asarUnpack`ed.** It loads a native `.node` binary at runtime and
  cannot be read from inside an asar archive. Verified present at
  `resources/app.asar.unpacked/node_modules/@koromix/koffi-win32-x64/`.
- **Client records and assets are excluded in both editions.** Neither build
  ships `data/` or `assets/clients/`. Existing local records are left untouched.
- **The full build keeps its appId and productName.** Installed copies continue
  to upgrade in place.

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

That is the whole source, and it is entirely local: **no API, no authentication
and no network to read it, therefore no rate limits and nothing that can go
down.**

**The sole exception is [projection](#projection)**, which sends a copy of these
numbers, encrypted, to a second machine the user has paired. It is off by
default, it is opt-in behind a consent dialog, and it changes nothing about how
the numbers are produced: the reading side of this pipeline never touches the
network in either direction. Everything else in this section is true of a machine
with projection off, which is every machine until someone turns it on.

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
time. The renderer gets a reduced copy without that map, and the cache is written
at most once a minute plus on quit.

### Focus mode must never trap the user

**Double-clicking the tray icon used to enter focus mode**, which makes the wall
topmost, fullscreen, opaque and interactive. With the backdrop now opaque this
covered the entire desktop with no visible way out, and the only escape was
killing the process. That happened to Gustav.

Three changes, and all three matter:
- Tray double-click now shows/hides, which is what people expect anyway.
- **Escape always leaves focus mode**, from anywhere.
- Focus mode shows a visible "Exit focus" control and lifts that control to full
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

## Projection

Opt-in, off by default, and the only feature in this app that is *meant* to touch
the network. It puts one machine's dashboard on another machine's screen: a
**source** reads its own `~/.claude` as usual and sends an encrypted snapshot to
each **screen** it has paired. A machine acting as a screen does not index its
own transcripts at all.

Both editions have it.

### The claim, stated precisely

"Nothing leaves your machine" was the pitch and it was true. It is still true
with two qualifications, and both are structural rather than promised:

1. **Off means no network object exists.** `startProjection()` loads
   `projection.json` and returns immediately if there is none. `RelaySocket` is
   constructed only inside `SourceProjector` and `ScreenReceiver`, which are
   reachable only from `activate()`. There is no idle socket, no lazy connect and
   no boolean to get wrong: the file's PRESENCE is the switch (rule 25).
2. **On but unpaired still sends no data.** `sendTo()` returns early when there
   is no key record for a screen, and `flush()` iterates a list that is empty.
   Without a paired screen there is no key to encrypt for, so there is nothing
   the source could send even if it wanted to.

The connection is a third thing and is not hidden: once projection is on the
source authenticates to the relay, and while a code is outstanding it publishes
an offer. That is connection traffic, not dashboard data, and the difference is
worth keeping straight in anything written for users.

### Transport

| Piece | What it is |
|---|---|
| Relay | `https://claude-stats-relay.gustavpjvr.workers.dev`, a separate Cloudflare Worker in a separate repo |
| `SpaceRelay` | one Durable Object **per space**: holds the sockets, fans frames out |
| `PairingDirectory` | one Durable Object **globally**: maps a code hash to a space and rate limits redemption |
| Storage | SQLite-backed DOs. The key-value backend is paid-only and SQLite is on the free plan, so the migration MUST use `new_sqlite_classes` |
| Sockets | **WebSocket Hibernation** (`ctx.acceptWebSocket`, never `server.accept()`) |

Hibernation is what makes this affordable: the app is silent for hours at a time,
and a hibernating object leaves memory and accrues no billable duration. The
price is a rule the relay has to keep. **Nothing may live in an instance field
across messages.** Per-connection state goes in the socket's attachment
(`serializeAttachment`), everything else in `ctx.storage`, and sweeps run off
`ctx.storage.setAlarm` because a `setTimeout` does not survive hibernation.

Separate Worker and separate deploy cadence on purpose: a relay bug must never
take the download page down.

### Key schedule

Per screen, derived on the two desktops and never anywhere else:

```
shared    = X25519(ourPriv, theirPub)
stretched = scrypt(code, "csw-pair-v1", 32, N=2^15 r=8 p=1)
key       = HKDF-SHA256(ikm  = shared || stretched,
                        salt = lookup,
                        info = "csw-screen-key-v2", 32)
lookup    = base64url(HKDF-SHA256(ikm = stretched, salt = "",
                        info = "csw-lookup-v2", 32))[0..22]

NOTE: version 1 computed the lookup as base64url(sha256("csw-lookup-v1" || code)),
a plain hash of the CODE rather than of the stretched output. That let a hostile
relay test candidates at hash speed and pay scrypt only once, for the match, which
made every other protection here moot. See docs/projection-crypto.md.
```

**The pairing code enters the key material twice**, once through scrypt into the
IKM and once as the HKDF salt by way of `lookup`. A relay that substituted its
own public key would still not arrive at the same key, because it never sees the
code. scrypt at N=2^15 is what makes a 60-bit code expensive to grind offline;
the relay's own rate limits (5 failed redemptions per IP, 20 globally per minute,
in a 10 minute window) are the online half of the same job.

The code is 12 characters of Crockford base32 with I, L, O and U removed so it
can be read aloud, shown as `XXXX-XXXX-XXXX`, valid for **ten minutes**, and the
relay independently caps the offer TTL at ten minutes rather than trusting the
number the source sends. Maximum 8 screens per source.

Frame layout, where the first 9 bytes are also the GCM AAD, so the sequence
number is authenticated rather than merely present:

```
version(1) | seq(8, big endian) | nonce(12) | ciphertext | tag(16)
```

`seq = max(seq + 1, Date.now())`, so it is monotonic and survives a restart
without persisting a counter. A screen discards any frame whose seq is not
strictly greater than the last it accepted (rule 29). Ten consecutive frames it
cannot decrypt is terminal: it says `CANNOT DECRYPT, pair again` rather than
retrying into a wall. Payloads are `deflateRaw`ed before encryption. The relay
bounds a frame at 512 KB, a sanity limit rather than a design target; the two
code comments disagree on the real size (20 KB in `relay-socket.ts`, 78 KB in
`space.js`) and neither has been re-measured.

### Trust model

**Trusted:** the two desktops, and the person who read twelve characters off one
screen and typed them into the other. That is the whole trust anchor, which is
why the code authenticates the exchange rather than merely naming it.

**Not trusted:** the relay, the network, and anyone who later gets hold of the
credentials file. The relay is treated as an active attacker that can drop,
reorder, duplicate and observe, and each of those has an answer: it cannot read
(it holds no key), cannot forge (a GCM tag over an AAD it cannot compute), cannot
replay (monotonic seq), and cannot resurrect a revoked screen (the key is deleted
locally first, rule 31).

What that leaves it is **metadata**, and it is listed rather than glossed,
because a privacy claim that quietly omits the metadata is worse than no claim.

| The relay CAN see | The relay CANNOT see |
|---|---|
| that a machine is connected, and whether it is a source or a screen | any number, name or timestamp inside a frame |
| its IP address. A **failed** redemption also stores the IP for ten minutes, to rate limit guessing | the source's hostname or a screen's label: both travel sealed (rule 33) |
| the timing and size of every frame, so **when** somebody is working | what changed, or whether anything did |
| `spaceId`, `screenId`, `pairedAt`, `lastSeen`, the two public keys, the code hash | the pairing code, and therefore the key |

It **stores no frames at all**, not even the most recent one, so there is nothing
to seize and a screen joining an idle source waits for the source instead of
being served something stale. The only persisted keys are `sourceSecretHash`,
`createdAt`, `spaceId`, a short-lived `offer`, and `screens` as
`{tokenHash, pairedAt, lastSeen}`. `ct` is copied byte for byte into an envelope
and forwarded; there is deliberately no `JSON.parse` of it anywhere in
`space.js`.

### The wire is a whitelist, not a filter

`toWire()` in `src/shared/projection-wire.ts` is the ONLY serialiser (rule 26),
and it names every field explicitly rather than spreading the index. That is the
whole design: the failure mode becomes a field missing on a screen, which is
visible, instead of a field leaking, which is not.

**On the wire:** token totals (input, output, cache write, cache read, thinking,
requests, web search and fetch), daily and hourly activity, model names,
per-session start/end/requests/tokens/models, the trailing throughput series,
prompt COUNTS by day, the Claude Code version, a transcript file COUNT, and a
source label.

**Never on the wire:** filesystem paths, the Windows username, session ids,
prompt text, transcript text. `sessions` are re-keyed by array index so a session
id cannot ride along, `cwd` is replaced by a label, and `unavailableReason` is a
fixed string because the real one is an OS error that can name a path.
`fromWire()` re-inserts `sessionId: null` and `cwd: null`, which is the receiving
end's proof that neither travelled.

**Behind a switch of its own:** project folder names, tray checkbox `Send project
folder names`, on by default, `projects` empty on the wire when it is off. A
folder name is the only thing here that is arguably about the work rather than
about the usage, which is why it gets its own control. The label is the folder
name itself, except that `labelProjects()` prefixes one parent segment when two
projects would otherwise collide on their leaf, so "leaf only" is very slightly
overstated and should not be written as an absolute.

The source label is also on the wire, sealed, and in practice it **is** the OS
hostname: `enableSource(label)` takes a parameter, `main/index.ts` is its only
caller, and it passes `os.hostname()`. There is no UI to change it. The comment
on `WireOptions.sourceLabel` claims it is never defaulted to the hostname, which
is wrong. The behaviour is fine because the label is encrypted, but do not write
user-facing copy from that comment, and if a label field is ever added, say so
rather than leaving people to assume the machine is anonymous.

### Credentials

`projection.json` in `app.getPath('userData')`, encrypted with Electron's
`safeStorage` (DPAPI on Windows, scoped to the logged-in user, so copying the
file to another machine yields nothing), written atomically via `.tmp` and
`rename`. **Never `settings.json`** (rule 32): that file is hand-edited, backed
up, pasted into chat windows when something goes wrong and synced by whatever the
user syncs, which is the exact opposite of where a key that decrypts a live feed
of someone's machine belongs.

Two things worth knowing:

- If `safeStorage.isEncryptionAvailable()` returns false the file is written as
  **plain JSON, silently**, and the reader tells the two apart by sniffing for a
  leading `{`. On Windows DPAPI is effectively always there, but the fallback
  exists, announces nothing, and should be said out loud rather than discovered.
- `projection-last.json` beside it caches the last frame a screen decrypted, so a
  screen shows something on launch instead of an empty wall. Same encryption
  path, same fallback.

Deleting `projection.json` turns projection off and forgets every pairing, which
is exactly what `Stop projecting and forget all screens` does. Revoking a single
screen deletes that screen's key locally FIRST and tells the relay second, so the
screen is dead the moment the key is gone whether or not the relay cooperates,
and a revocation made while the source is offline is replayed on the next
`ready`.

### The local dashboard is not allowed to care

Projection is a passenger (rule 30). The source reads and renders exactly as it
did before it existed; the projector is a listener on the same index refresh,
`flush()` is scheduled rather than awaited, and a relay that is down, slow or
hostile shows as an amber pill and changes nothing else.

Snapshots go out **on change**, floored at one per **10 seconds**, with a content
hash short-circuit so unchanged data sends nothing at all. Two things bypass that
floor and both are deliberate: `pushNow()` sends a full frame when a screen
connects, which is what makes a reconnecting screen fill in immediately instead
of waiting for the next edit, and a 30 second encrypted beat with no payload goes
to already-connected screens when nothing has changed, so a screen can tell
"idle" from "gone". An idle source with no screens connected sends nothing.

The status pill wording is tested as a pure function
(`test/stats-projection.test.mjs`) because every phase must produce wording that
is true of that phase, and `LIVE` printed over numbers that are twenty minutes
old is precisely the failure that test exists to prevent. A screen claims
liveness only from a frame it actually decrypted (rule 28): the relay reporting
the source as online is not evidence that any data arrived.

### Known gaps

Recorded so they are not rediscovered:

- **RESOLVED 2026-09-03: the consent dialog now names the relay host.** It took
  `relayHost()`, which existed and had no callers, and passed it the relay the
  dialog is actually asking about. The comment had claimed this for some time
  before the code did it.
- **RESOLVED 2026-09-03: the relay's source is public**, at
  `github.com/gustav-pjvr/claude-stats-relay`, MIT licensed.
- **Cosmetic:** `directory.js` says the pairing code is 50 bits. It is 60, as
  `pairing-code.ts` says. Twelve characters over a 32-symbol alphabet.

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

electron-updater was considered and rejected **for the full build, and that part
still holds**: the repo is private, so the app would have to carry a GitHub
token, a real secret shipped inside a desktop binary for a tool with one user who
is sitting at the machine that builds it. Two update mechanisms racing for the
same install is also the "multiple installations" problem this project already
solved once (rule 18).

**The stats build does auto-update, and this paragraph used to deny it.** The
objection above was about a credential, and a public R2-backed download site
removed the credential: the app fetches a YAML feed and an installer over plain
HTTPS, exactly as a browser would. `src/main/updater.ts` is gated on
`app.isPackaged && isStatsOnly`, checks 90 seconds after launch and every six
hours after that, downloads silently and installs on quit. It never touches the
full build. Anything that says the shareable build makes no network requests is
wrong, and was wrong before projection existed.

---

## Identity

The mark is a **brick wall on white with its top-left corner blowing out**
(Gustav's brief, 2026-09-03). Twenty-three bricks in the client hues, laid in
running bond, with four missing from the corner and those same four, plus chips,
in flight above and to the left of them.

Three decisions carry it:

- **Running bond, not a grid.** Offset courses, with half bricks closing the
  alternate ends, are what make rectangles read as "brick" rather than "tiles".
- **White mortar.** The gaps are the plate showing through, so every brick is
  separated by the background itself. That is what "clearly defined individual
  bricks" asks for, and it downscales better than an outline would.
- **The corner is genuinely missing.** Shards drawn over an intact wall read as
  debris passing in front of it. The four bricks in flight are the four that are
  not in the wall, at full size and barely turned, so the eye can put them back;
  everything smaller spins harder and fades as it travels.

`npm run logo` regenerates everything from `scripts/logo.mjs`:

| Output | Use |
|---|---|
| `assets/logo/mark{,-dark}.svg` | vector master, full wall, per theme |
| `assets/logo/mark-small{,-dark}.svg` | vector master, reduced variant, per theme |
| `assets/logo/icon.ico` | app and installer icon, 7 entries (16 to 256) |
| `assets/logo/icon-dark.ico` | dark-theme set, not shipped: Windows bakes one icon |
| `assets/tray{,-dark}.png` + `@2x` | tray icon, both themes, 1x and 2x |
| `assets/logo/lockup-on-{light,dark}.png` | wordmark, 1x and 2x |

Three things about it are deliberate:

- **Two THEMES, one geometry.** A light set on a white plate and a dark set on
  the wall's own backdrop colour. Not one coordinate moves between them: only
  the plate and the brick lightness change, because they have to read as the
  same mark. The brick lightness genuinely differs (0.62 on white, 0.74 on
  near-black); one value for both means choosing which theme to disappoint. The
  dark set also lifts the shard alpha floor to 0.58, because a fading shard
  fades towards the plate and 0.42 was invisible on black while still readable
  on white.

  The TRAY icon follows the taskbar theme at runtime. The app icon (`.ico`)
  cannot: Windows bakes one icon per executable, so the light plate ships there
  and carries its own background on any surface.

- **The tray reads `SystemUsesLightTheme`, not `nativeTheme`.** Windows keeps
  two independent settings: `AppsUseLightTheme` for application chrome and
  `SystemUsesLightTheme` for the taskbar and tray. Electron's
  `nativeTheme.shouldUseDarkColors` reports the app one, so using it to pick a
  tray icon picks by the wrong setting, and wrongly for exactly the people who
  mix the two.

  `nativeTheme.on('updated')` is also not sufficient, and this was TESTED rather
  than assumed: flipping `SystemUsesLightTheme`, even with a WM_SETTINGCHANGE /
  ImmersiveColorSet broadcast, never raised the event. So the event is kept for
  the common case (Settings changes both at once) and a 30 second poll covers a
  taskbar-only change. The poll is affordable only because the read is an
  in-process `RegGetValueW` through koffi rather than a `reg.exe` spawn.

- **Two variants, with a switch at 64px.** At and above 64 the full wall is
  used; below it a reduced variant of eight chunky bricks and two chips takes
  over. 48px was tried with the full wall and measured unreadable: five courses
  of five bricks puts the mortar under one device pixel and the wall turns to
  porridge. The reduced variant keeps the idea (wall, missing corner, something
  in flight) at the resolution that actually exists.
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

Work mode's mail phases (2 to 4 in docs/design/work-mode.md) are planned for the
full edition. Per-monitor content assignment
(the settings key `monitors` exists) and a light-theme wall remain future ideas.
