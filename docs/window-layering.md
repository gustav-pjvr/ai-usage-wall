# Window layering

How the wall gets onto the screen and stays where it belongs: the two layer
modes, the extended window styles it relies on, how it is anchored against
Explorer's desktop windows, what `verifyLayer()` does and does not prove, and the
250 ms watchdog that undoes what Show Desktop does to it.

The short version: the wall is a non-activating tool window inserted **directly
above** the desktop window, never at the bottom of the Z order, and every
placement is applied, checked, and only then persisted. Most of the design here
exists because an earlier version got one of those three steps wrong.

Related: [settings-and-tray.md](settings-and-tray.md) for how a layer mode is
persisted and healed, and `ARCHITECTURE.md` "Desktop behaviour" for the shorter
narrative version.

---

## The two layer modes

`LayerMode` is declared at `src/main/win32/desktop-layer.ts:63` and has exactly
two members.

| Mode | What it does | Where it is used |
|---|---|---|
| `desktop` (default) | `WS_EX_TOOLWINDOW` and `WS_EX_NOACTIVATE` added, forced top-level, made non-topmost, then inserted directly above `Progman`. Sits above the wallpaper and the desktop icon layer, below every ordinary app, and still receives hover and click. | Normal running. `DEFAULT_LAYER_MODE` at `src/main/index.ts:57`. |
| `top` | `HWND_TOPMOST`, nothing else. | Focus mode only. `applyLayer` picks it whenever `focusMode` is true, regardless of the persisted setting (`src/main/index.ts:791`). |

There is no third mode. `applyLayerMode` handles `top` and falls through to the
`desktop` branch for everything else (`src/main/win32/desktop-layer.ts:194-228`),
and `normaliseSettings` accepts only these two strings
(`src/main/settings.ts:89`).

The tray does not offer a "no input" mode either. It offers the two above plus a
disabled line pointing at the Click-through checkbox instead
(`src/main/index.ts:564-574`), because that is the setting that actually answers
the question people ask a wallpaper mode to answer.

---

## The extended window styles, and why each one

Two of the three are asserted by this repo's own code. The third is not, and the
distinction matters if you go looking for it.

### `WS_EX_TOOLWINDOW` and `WS_EX_NOACTIVATE`: asserted every time

`applyLayerMode` adds both on every call, before it does anything else
(`src/main/win32/desktop-layer.ts:189`). Electron's `skipTaskbar: true`,
`focusable: false` and `type: 'toolbar'` at `src/main/index.ts:670-676` already
ask for the same behaviour, so this is redundant in the happy path. The comment
above it gives the reason for the redundancy: the wall *depends* on these bits,
so the code asserts them rather than assuming Electron's options survived
whatever else touched the window.

- `WS_EX_TOOLWINDOW` keeps the wall out of the taskbar and out of Alt+Tab. A wall
  that is a background surface has no business owning a taskbar button.
- `WS_EX_NOACTIVATE` is the load-bearing one for `desktop` mode. Because the
  window is never activated, almost nothing raises it, so any app the user
  focuses naturally rises above it and the wall stays behind everything without
  needing to be pushed back down. That property is what makes the placement
  cheap: without it, the wall would have to fight the Z order continuously
  rather than being disturbed only by the specific events described below.

### `WS_EX_LAYERED`: present in practice, not set here

`WS_EX_LAYERED` is exported as a constant at `src/main/win32/ffi.ts:45` and, at
the time of writing, **no code in this repository applies it**. Grepping the
whole of `src/` finds the constant declaration and nothing else.

The window is nevertheless a layered window in practice, and that is an
inference from two Electron calls rather than something this codebase asserts:

- the wall windows are created with `transparent: true` and
  `backgroundColor: '#00000000'` (`src/main/index.ts:664`, `:677`), and on
  Windows a transparent Chromium window is implemented as a layered window;
- `applyLayer` calls `win.setOpacity()` on every pass
  (`src/main/index.ts:836`), and per-window opacity on Windows is a layered
  window feature.

Treat that paragraph as reasoning about Electron and Chromium behaviour, not as
a documented property of this code. If you need certainty, read
`GetWindowLongPtrW(hwnd, GWL_EXSTYLE)` on a running wall and test the bit; the
binding for it already exists at `src/main/win32/ffi.ts:143`.

The same caveat applies to `WS_EX_TRANSPARENT` (`src/main/win32/ffi.ts:44`),
which is also exported and never applied. Click-through goes through Electron's
`setIgnoreMouseEvents()` instead; see below.

---

## Placement: directly above `Progman`, never at the bottom

The `desktop` branch does two `SetWindowPos` calls
(`src/main/win32/desktop-layer.ts:217-227`):

1. `HWND_NOTOPMOST`, to clear the topmost bit that focus mode may have set.
2. `SetWindowPos(hwnd, progman, ...)`, which inserts the wall **directly below
   the window passed as `hWndInsertAfter`**, that is, directly above `Progman`
   in visual terms.

If `FindWindowW('Progman', null)` returns nothing, it falls back to
`HWND_BOTTOM` and logs that input will not reach the wall. That is a degraded
state chosen deliberately: out of the way and inert beats unpredictable.

### Why `HWND_BOTTOM` was wrong even though it looked right

This is the single most important piece of history in this file, and the comment
at `src/main/win32/desktop-layer.ts:199-216` records it.

The original implementation sank the window to the very bottom of the Z order.
Every structural check passed: correct Z order, not topmost, visible, a stack of
windows above it. The wall was still completely inert. Explorer's
`SHELLDLL_DefView`, the host for the desktop icons, spans the whole screen and is
transparent. At `HWND_BOTTOM` the wall was *underneath* it, so the wall was
plainly visible through it while Windows hit-tested `DefView` first and sent
every click and every hover to the desktop.

`DefView` is a child of `Progman`, so inserting above `Progman` puts the wall
above the icon layer and input arrives. The rule that came out of it is recorded
as rule 16 in `ARCHITECTURE.md` and is worth internalising in the general form:

> Verifying placement is not verifying input. Being visible at a pixel and owning
> that pixel for hit-testing are different questions.

`sinkToBottom()` (`src/main/win32/desktop-layer.ts:294-303`) is named after the
old behaviour and no longer does it. It re-inserts after `Progman`, falling back
to `HWND_BOTTOM` only when `Progman` is missing. Sinking properly would silently
kill input again, which is exactly why the comment above it says so.

---

## `GetAncestor(GA_PARENT)`, and why `GetParent` is not bound

`ffi.ts` binds `GetAncestor` and deliberately does **not** bind `GetParent`. The
prohibition is written into the interface itself as a comment where the binding
would otherwise go, `src/main/win32/ffi.ts:89-95`, so it cannot come back by
autocomplete.

The reason: for a `WS_POPUP` top-level window, `GetParent` returns the window's
**owner**, not its parent. Every Electron window is `WS_POPUP`, and these windows
have no owner, so `GetParent` answers NULL whether or not the window has been
reparented into something. It is a check that cannot fail, which is worse than no
check.

That is not a theoretical concern. It is how the removed wallpaper mode reported
`SetParent refused by all 15 candidate layers` while the window was in fact
parented into the last candidate it tried, and how the `desktop` fallback then
skipped the detach that would have rescued it, because that was gated on
`GetParent` too.

The correct test is `isTopLevel()` at `src/main/win32/desktop-layer.ts:128-136`:

```ts
return w.GetAncestor(hwnd, GA_PARENT) === w.GetDesktopWindow();
```

Note what it compares against. A healthy top-level window's `GA_PARENT` is the
**desktop window**, not NULL, so writing `=== 0` would report every healthy
window as reparented. Both mistakes, the `GetParent` one and the `=== 0` one,
have already cost this project real time; the comment on that function says so.

### `ensureTopLevel` is a precondition, not a cleanup step

`ensureTopLevel()` (`src/main/win32/desktop-layer.ts:150-170`) runs before any Z
ordering happens, because `SetWindowPos` on a child window orders it against its
**siblings inside its parent**, which is meaningless for this purpose and is
precisely the state that made the wall invisible.

When it has to repair the window, it reports `repaired: true`, and the caller
must restore bounds: while the window lived inside another window its
coordinates were parent-relative. `applyLayer` does that at
`src/main/index.ts:796-800`.

No `GWL_STYLE` surgery happens on the way out. The usual advice about clearing
`WS_CHILD` after `SetParent(NULL)` applies to windows that were given `WS_CHILD`;
this one never was, so it is still `WS_POPUP` and detaching is sufficient. That
reasoning is recorded at `src/main/win32/desktop-layer.ts:146-148`.

---

## `verifyLayer()`: what it proves, and what it does not

`verifyLayer()` (`src/main/win32/desktop-layer.ts:248-287`) checks three things:

1. the window is top-level (via `isTopLevel`, above);
2. it is visible, when the caller expects it to be (`expectVisible` is
   `!hidden`);
3. `GetWindowRect` returns a non-empty rectangle that **overlaps** the target
   display's bounds.

Each of those is **necessary** for the wall to be on screen, so any failure
proves it is not, which is enough to reject a layer mode. That is the whole
contract, and the docstring is explicit that it stops there.

What it does not do is prove that a single pixel was painted. The log line at
`src/main/index.ts:840-843` says "verified: top-level, visible, placed" and
must never be changed to say "verified rendering". Proving pixels needs a GDI
screen read plus an answer to "is anything covering that point"; wallpaper mode
was rejected partly because that second question could not be answered for it.

Two further limits worth knowing before you trust a pass:

- **It passes while Show Desktop has buried the wall.** Nothing about the wall
  changes in that state; the desktop is what moved. That is stated at the top of
  `src/main/win32/desktop-watch.ts:14-17` and is the reason the watchdog exists
  as a separate mechanism.
- **The display rectangle it is checked against is approximate.** `applyLayer`
  converts Electron's DIP bounds to physical pixels by multiplying `x`, `y`,
  `width` and `height` by that display's own `scaleFactor`
  (`src/main/index.ts:808-816`). On a mixed-DPI multi-monitor layout the origin
  of a secondary display does not scale by its own factor, so the computed
  rectangle can be wrong. It is tolerable because the test is a loose overlap
  rather than an equality, and a wall that is entirely off its display will still
  fail. That reading is mine from the code, not something measured on hardware;
  if you are chasing a spurious verification result on a mixed-DPI rig, start
  here.

### `inputReachesWall()` is advisory and must stay advisory

`inputReachesWall()` (`src/main/win32/desktop-layer.ts:318-335`) is the check
that would have caught the `HWND_BOTTOM` bug on day one. It calls
`WindowFromPoint` at a point well inside the wall's bounds, then walks up with
`GetAncestor(at, GA_ROOT)` because the hit lands on Chromium's
`Chrome_RenderWidgetHostHWND` child, and reports which top-level window actually
owns that pixel.

It is never used to reject a layer mode. In `desktop` mode any application the
user happens to have open over the probe point makes it false for an entirely
legitimate reason. It is logged (`src/main/index.ts:824-829`), surfaced in the
diagnostics overlay, and that is all.

---

## Apply, verify, then persist

There is deliberately no "apply without verifying" path. `applyLayer()`
(`src/main/index.ts:789-848`) always ends in a `verifyLayer()` call and returns
its verdict, and three call sites depend on that:

- **At startup**, `ready-to-show` applies the layer and calls `healLayerMode()`
  if it failed (`src/main/index.ts:707-710`). A persisted mode that cannot
  verify is replaced with `desktop` and written back once, so a bad mode cannot
  survive a restart. `healLayerMode` is idempotent because every display's window
  calls it (`src/main/index.ts:855-867`).
- **On a settings change**, `updateSettings()` applies first and writes last. A
  requested layer mode that fails verification is reverted in memory, the working
  mode is re-applied, a tray balloon explains it, and only then does the file get
  written (`src/main/index.ts:1210-1236`). The comment at
  `src/main/index.ts:1190-1197` records why the order was changed: the write used
  to happen first, so a mode that then failed to apply was already on disk and
  restarting the app replayed the failure instead of escaping it. The only way
  out was the tray.
- **On focus mode toggle**, `toggleFocusMode()` re-applies for every window
  (`src/main/index.ts:1244-1251`).

`settings.json` therefore mirrors state the wall has verified, never state that
was merely requested. That is rule 21 in `ARCHITECTURE.md`.

---

## The Show Desktop watchdog

Source: `src/main/win32/desktop-watch.ts` (the Win32 half) and
`src/main/index.ts:990-1071` (the timer, the gates and the logging).

### The symptom, and why the obvious measurement found nothing

Click the Show Desktop strip at the far right of the taskbar, or press Win+D, and
the wall disappears. But: the window is still visible, still placed, not iconic,
and the tray icon is still there. Nothing about the wall changed.

The wall is a tool window with no minimise box, so `MinimizeAll` and
`ToggleDesktop` do not touch it. What moves is the **desktop**. The shell raises
the desktop above the windows that did not minimise, the wall included, and the
wall is then behind the wallpaper until the show-desktop state ends.

The diagnostic that pinned it needed no debugger: the wall comes back only when
you open an app and then minimise it, which is exactly the gesture that cancels
the show-desktop state, and the tray icon never goes away. A painting fault would
have been cured by any repaint. Only that one state transition cured this. The
full note is at `src/main/index.ts:992-1005`.

The lesson generalises: measuring the wall across the event showed nothing
because the wall was never the thing that moved. `verifyLayer()` passes happily
in this state, which is why the watchdog checks the desktop's position relative
to the wall rather than the wall's own properties.

### Why polling, and why 250 ms

There is no window message for "another window was raised over you". Windows will
tell a window that its own Z order changed; it will not tell it that the world
moved around it. A `WinEvent` hook on `EVENT_OBJECT_REORDER` was not adopted
here, and the comments give the practical reason rather than a benchmark: there
is no message, so `index.ts` polls.

`DESKTOP_WATCH_MS = 250` (`src/main/index.ts:1022`). The interval is a
responsiveness choice, not a cost one: in the healthy state a tick walks from the
wall to the desktop host in one or two steps, so it is a handful of
`GetWindow` calls, and the timer is `unref`'d
(`src/main/index.ts:1062-1066`) so it cannot hold the process alive. A quarter
of a second is fast enough that the recovery reads as "it flickered" rather than
"it broke".

### Edge triggering

`desktopWatchSeen` maps each wall HWND to the last placement signature it saw
(`src/main/index.ts:1025`). The signature is built in `assessPlacement` as
`above|below : host : between...` (`src/main/win32/desktop-watch.ts:111`), so it
changes only when the situation changes.

A situation is acted on **once**, and the signature is recorded whether or not
the placement succeeded (`src/main/index.ts:1042-1055`). Two consequences, both
intended:

- a placement that did not take is not retried every tick, so a legitimately odd
  shell layout costs one `SetWindowPos` rather than four per second forever;
- after acting, the code re-assesses and stores the *new* signature, so the
  post-fix state is the baseline rather than the broken one.

Entries for windows that no longer exist are pruned at the top of each tick
(`src/main/index.ts:1034`).

### The gates

The tick returns immediately when `focusMode || hidden`, clearing the seen map so
the next resumption starts fresh (`src/main/index.ts:1028-1031`). Per window, it
skips anything with no HWND, anything destroyed, and anything whose
**`effectiveMode`** is not `desktop` (`src/main/index.ts:1037`).

`effectiveMode` and not `settings.layerMode`: what the window is actually in is
what decides whether re-anchoring is the right move. The same distinction is made
on the `show` event at `src/main/index.ts:728-732`. A mode that fell back must
not be treated as the mode that was requested.

The `focusMode` gate is what keeps the watchdog from fighting the
`Control+Alt+W` hotkey. Focus mode puts the wall topmost on purpose; a watchdog
that sank it again 250 ms later would make the hotkey look broken.

### Why it anchors to the `SHELLDLL_DefView` host, not to `Progman`

`findDesktopHost()` (`src/main/win32/desktop-watch.ts:69-81`) looks for the
top-level window that currently **hosts `SHELLDLL_DefView`**, the desktop icon
layer:

1. if `Progman` has a `SHELLDLL_DefView` child, `Progman` is the host;
2. otherwise it enumerates every `WorkerW` looking for one that does;
3. if no `DefView` exists anywhere, it falls back to `Progman`.

Explorer moves `DefView` into a `WorkerW` under conditions that are entirely
normal: a wallpaper transition does it, and some wallpaper tools do it
deliberately and leave it there. When that has happened, `Progman` is no longer
the window the wall needs to be above, and anchoring to it would put the wall
underneath the icon layer again, reproducing the `HWND_BOTTOM` bug on a machine
that had merely changed its wallpaper.

Step 3 exists because `DefView` genuinely is absent for a moment while Explorer
restarts. Falling back to `Progman` gives a sane answer instead of `NULL_HWND`,
which `assessPlacement` would treat as "cannot assess" and skip.

The walk itself is bounded by `MAX_WALK = 2048`
(`src/main/win32/desktop-watch.ts:42`). That is a guard against a handle cycle,
not a budget: the comment says so explicitly, and top-level windows number in the
hundreds even on a busy desktop.

### What `assessPlacement` reports

`assessPlacement` (`src/main/win32/desktop-watch.ts:88-113`) walks **down** from
the wall with `GW_HWNDNEXT`, which in the healthy state reaches the host in a
step or two. It reports:

- `desktopAbove`: the host was not found below the wall, so it is above it. This
  is the Show Desktop case.
- `between`: visible top-level windows met on the way down, excluding shell
  windows (`Progman`, `WorkerW`) and the wall's own sibling windows. Non-empty
  means the wall is sitting on top of an ordinary app, which `desktop` mode never
  wants.

The `own` set passed in is built from the wall windows only
(`src/main/index.ts:1032-1033`). That is sufficient because the toast and pairing
windows sit above the wall, not below it, so a downward walk never meets them.

Either finding triggers the same response, and the log line names which one it
was (`src/main/index.ts:1047-1053`).

### `placeAboveDesktop`, and why it is not `sinkToBottom`

`placeAboveDesktop` (`src/main/win32/desktop-watch.ts:135-153`) takes the window
directly above the host with `GW_HWNDPREV` and inserts the wall after it, because
`SetWindowPos` places a window directly below its `hWndInsertAfter` argument.

Three details, each with a reason in the comment at
`src/main/win32/desktop-watch.ts:115-134`:

- If nothing is above the host, **or only topmost windows are**, it uses
  `HWND_TOP`. For a non-topmost window that means the top of the non-topmost
  band, which is the right place. Inserting after a topmost window is avoided
  because it would make the wall topmost.
- `HWND_NOTOPMOST` would not work here: it is documented to do nothing to a
  window that is already non-topmost.
- The `HWND_TOP` branch can leave the wall above ordinary apps once the shell
  drops the desktop back down. That is not left to chance. The next tick sees
  windows in `between` and sinks it again, which is the second finding above
  earning its keep.

It is deliberately not `sinkToBottom()`. That function inserts after `Progman`,
which is correct for the resting state it was verified in, but here the host may
not be at the bottom, and by the same "insert directly below" semantics "after
`Progman`" would then land the wall underneath it.

### Note on stale prose elsewhere

`ARCHITECTURE.md:273` still says "**No z-order polling.**" That was true before
the watchdog was added and is not true now. The code is the authority: there is a
250 ms interval, gated as described above. Nothing in this document depends on
that line being fixed, but do not read it as a constraint on new work.

---

## Click-through

Click-through is Electron's `setIgnoreMouseEvents(true, { forward: true })`,
applied in two places:

- at window creation, from the persisted setting
  (`src/main/index.ts:692`);
- on every `applyLayer` pass, as `focusMode ? false : settings.clickThrough`
  (`src/main/index.ts:835`).

`forward: true` means the renderer still receives `mousemove` and can drive hover
effects while clicks pass through to whatever is underneath.

Two things worth knowing:

- **`applyLayer` owns this call.** `toggleFocusMode` deliberately does not make
  its own call, so the two cannot drift out of step
  (`src/main/index.ts:1246-1247`).
- **It used to test the requested layer mode as well**, which meant a mode that
  had fallen back still left the wall click-through. The condition now depends on
  click-through and focus mode only; the comment at
  `src/main/index.ts:831-834` records the bug.

The renderer mirrors the same condition into a body class,
`wall-interactive`, as `!clickThrough || focusMode`
(`src/renderer/main.ts:599`), so CSS hover affordances agree with what the window
will actually accept.

Click-through is the answer to "I want a wall that ignores the mouse". That is
what the disabled tray line at `src/main/index.ts:570-572` is pointing at, and
what the removed wallpaper mode was really being asked for.

---

## Focus mode

Focus mode is a runtime flag (`src/main/index.ts:78`), not a setting, so it never
reaches `settings.json` and cannot be stuck in on a restart.

While it is on:

- `applyLayer` uses `top` instead of the persisted mode
  (`src/main/index.ts:791`), so the wall goes `HWND_TOPMOST`;
- click-through is forced off and opacity is forced to 1
  (`src/main/index.ts:835-836`);
- the desktop watchdog stands down entirely (`src/main/index.ts:1028`).

Because it puts an opaque fullscreen window on top of everything, the way out is
treated as non-negotiable (rule 17 in `ARCHITECTURE.md`):

- `Control+Alt+W` toggles it (`src/main/index.ts:1273`, default at
  `src/main/settings.ts:61`);
- Escape in the renderer calls `wall:exitFocus`, which only ever exits and never
  enters (`src/renderer/main.ts:917-921`, `src/main/index.ts:1407-1409`);
- an "Exit focus" button is added to the mode switcher bar, in both editions. In
  the stats build the bar has nothing else in it and exists solely so that button
  has somewhere to live (`src/renderer/main.ts:843-856`);
- the tray item flips to "Leave focus mode" (`src/main/index.ts:562`).

The wall windows are created `focusable: false` (`src/main/index.ts:671`) and
focus mode does not change that. The Escape handler is a renderer `keydown`
listener, so whether it fires depends on the window receiving keyboard input;
the global hotkey and the tray item do not depend on that and are the guaranteed
routes out.

---

## Removed: wallpaper mode

There was a third mode. It called `SetParent()` to put the wall inside the
`WorkerW` that Explorer paints the wallpaper into. It was removed on 2026-09-02
after being **measured** rather than reasoned about. The full account is at
`src/main/win32/desktop-layer.ts:18-40` and `ARCHITECTURE.md:220-247`.

Two findings killed it, and the first is the more important:

1. **The verification was reading the wrong property.** It confirmed the parent
   with `GetParent()`, which for a `WS_POPUP` window returns the owner, so it
   answered NULL whatever the truth was. The code reported "SetParent refused by
   all 15 candidates" while the window was in fact parented into the last
   candidate tried. The `desktop` fallback then skipped its detach, also gated on
   `GetParent`, and Z ordered a child window against its own parent. The wall
   vanished and stayed gone across restarts, because the failing mode had already
   been written to `settings.json`.
2. **Corrected, it still painted nothing.** Parented to the real `WorkerW`,
   confirmed with `GetAncestor(hwnd, GA_PARENT)`, sized to the full display in
   physical pixels, every other window minimised, and one real screen pixel read
   with GDI. Opaque, transparent, and `WS_POPUP` converted to `WS_CHILD` all
   returned the wallpaper's own colour, identical to a control taken with the app
   not running.

`ARCHITECTURE.md:242-247` records an unverified hypothesis for the second
finding: Chromium's native window occlusion tracker may treat a window living
beneath `SHELLDLL_DefView` as fully occluded and stop painting it. Testing that
means disabling `CalculateNativeWinOcclusion`, which is one of this project's
largest idle-CPU wins (`src/main/index.ts:1441-1443`), so it was not tested. It
is labelled a hypothesis in the source and should stay labelled one here.

### Why this history is in the reference docs

Three durable rules came out of it, and all three are load-bearing for code you
might otherwise be tempted to write:

- A mode whose only failure signature is "every structural check passes and
  nothing renders" must not be offered at all (rule 22). If wallpaper mode ever
  returns, it returns with a pixel-level render probe and a countdown revert,
  and only after some machine has been measured painting it.
- Never persist a layer mode the wall has not verified in (rule 21). The reason
  the failure was unrecoverable was not the failure, it was the write.
- Never read a window's parent with `GetParent` (rule 20). The binding is gone
  from `ffi.ts` so the mistake cannot be made again by accident.

### Migration

Nothing needs to be migrated by hand. `normaliseSettings` accepts only
`desktop` and `top`, so an old `settings.json` carrying `"layerMode":
"wallpaper"` simply loads as `desktop` (`src/main/settings.ts:86-94`).

`loadSettings` additionally special-cases that one value: it logs an explicit
notice and rewrites the file, rather than defaulting silently
(`src/main/settings.ts:128-136`). The reason given is that a machine left on that
mode was a machine with an invisible wall, so the user deserves a line in the log
saying what happened to their setting.

---

## Related mechanics worth knowing

**One window per display.** `targetDisplays()` and `createWindowForDisplay()`
(`src/main/index.ts:648-743`). One window stretched across the virtual desktop
was rejected because Windows scales the whole surface by the primary monitor's
factor on mixed-DPI setups, and because one card changing would force a repaint
of every monitor (`src/main/index.ts:4-8`).

**DPI awareness is set before any window exists.** `ensureDpiAwareness()` runs at
`src/main/index.ts:1480`, before `app.whenReady()`. Electron normally does this
itself; calling `SetProcessDpiAwarenessContext(-4)` again is harmless and makes
the guarantee explicit rather than a dependency on Electron internals
(`src/main/win32/desktop-layer.ts:75-94`).

**Display changes rebuild rather than patch.** `display-added`,
`display-removed` and `display-metrics-changed` all call `rebuildWindows()`
(`src/main/index.ts:1576-1584`), which detaches each HWND before destroying its
window (`src/main/index.ts:869-875`). A display change is one of the few events
that genuinely disturbs both geometry and Z order at once.

**Everything degrades to a no-op off Windows.** `isAvailable()` requires both
`process.platform === 'win32'` and a loaded `koffi`
(`src/main/win32/ffi.ts:29`), every function in `desktop-layer.ts` returns early
when `win32()` is null, and `verifyLayer` returns `{ ok: true }` in that case so
nothing gets healed on a platform that has no layering to heal.

**Handles are integers, not opaque pointers.** `Hwnd` is a `number` and the
bindings use `intptr_t` (`src/main/win32/ffi.ts:9-11`).
`hwndFromBuffer()` converts Electron's `getNativeWindowHandle()` buffer and
throws rather than silently truncating if the value exceeds
`Number.MAX_SAFE_INTEGER` (`src/main/win32/ffi.ts:163-169`).

---

## Testing status, stated plainly

None of this is covered by the automated suite. `test/run.mjs` covers brand token
derivation, the layout engine and schema validation; the other three suites cover
projection. There is no test for `applyLayerMode`, `verifyLayer`,
`assessPlacement` or `placeAboveDesktop`, and there could not easily be one
without a real Windows shell to place windows against.

What that means in practice: changes in this area are verified by running the
wall and reading the `[desktop-layer]`, `[main] layer ...` and
`[desktop-watch]` log lines, plus the diagnostics overlay
(`settings.debug`, `src/renderer/main.ts:793-806`), which prints the layer mode,
the click-through state and whether the Win32 layer loaded at all. Given the
history above, "it looks right on screen" is not an acceptable substitute for
reading those lines.
