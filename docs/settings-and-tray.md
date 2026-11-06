# Settings, tray and capability tiers

Everything the user can change and every affordance they can reach: the
`settings.json` schema and where it lives, how a malformed or outdated file is
healed rather than rejected, the tray menu (which is the app's only permanent UI),
the two global hotkeys, launch at sign-in, and the performance tiering that
decides how much motion the wall is allowed.

The short version: every setting has a working default and nothing in the file
can throw, so deleting or corrupting `settings.json` costs nothing. The tray is
the only affordance the app has, because the wall has no taskbar button and never
takes focus. And nothing is written to disk until the wall has verified it works.

Related: [window-layering.md](window-layering.md) for what a layer mode actually
does, [editions.md](editions.md) for why the userData path and the Run registry
value are per-edition.

---

## Where `settings.json` lives

`src/main/settings.ts:79-81`:

```ts
return path.join(app.getPath('userData'), 'settings.json');
```

| Edition | Path |
|---|---|
| full | `%APPDATA%\MuchBetter Client Wall\settings.json` |
| stats | `%APPDATA%\Claude Stats Wall\settings.json` |

The stats path is only distinct because `app.setName()` runs at module scope
before anything asks for a path (`src/main/index.ts:1464`). See
[editions.md](editions.md) for the incident that made that necessary.

**Two things surprise people in development:**

1. `settingsPath()` uses `app.getPath('userData')` unconditionally. A dev run
   reads `settings.json` from `%APPDATA%`, not from the repository.
2. That also means a dev run and a packaged install of the same edition share
   one settings file, and one single instance lock. The lock collision is logged
   explicitly rather than exiting silently (`src/main/index.ts:1472-1477`).

The resolved userData path is printed at startup (`src/main/index.ts:1489-1490`), which
is the fastest way to settle any question about which file is in play.

---

## The schema

Declared as the `Settings` interface at `src/main/settings.ts:16-54`, defaulted at
`:56-75`, and validated at `:84-116`. The renderer receives the whole object in
every state push (`src/main/index.ts:1081`).

| Key | Type | Default | Validation | Consumed by |
|---|---|---|---|---|
| `mode` | `'stats' \| 'work'` | `'stats'` | `'work'` kept in the full build only; anything else, the old `'clients'` included, is `'stats'`. A paired screen shows stats whatever it says (`effectiveMode`) | the view on the wall, [work-mode.md](work-mode.md) |
| `workFilter` | `'mine' \| 'everyone'` | `'mine'` | anything else becomes `'mine'` | Work mode's Mine or Everyone (full build) |
| `layerMode` | `'desktop' \| 'top'` | `'desktop'` | must be one of the two, else default | `applyLayer`, `src/main/index.ts:791` |
| `performance` | `'auto' \| 'low' \| 'balanced' \| 'high'` | `'auto'` | must be in the list, else `'auto'` | `detectCapability`, `src/main/capability.ts:80-83` |
| `clickThrough` | boolean | `false` | strict `=== true` | `setIgnoreMouseEvents`, `src/main/index.ts:835` |
| `hotkeyFocus` | string | `'Control+Alt+W'` | non-empty string, else default | `registerHotkeys`, `src/main/index.ts:1273` |
| `hotkeyToggle` | string | `'Control+Alt+Shift+W'` | non-empty string, else default | `src/main/index.ts:1274` |
| `startWithWindows` | boolean | `false` | strict `=== true` | `applyStartup`, `src/main/index.ts:1310` |
| `opacity` | number | `1` | clamped to 0.2 to 1 | `win.setOpacity`, `src/main/index.ts:836` |
| `background` | `'none' \| 'plain' \| 'gradient'` | `'gradient'` | must be in the list | `document.body.dataset.background`, `src/renderer/main.ts:597` |
| `backgroundOpacity` | number | `1` | clamped to 0 to 1 | `--backdrop-opacity`, `src/renderer/main.ts:598` |
| `monitors` | number[] | `[]` | integers only; empty means all | `targetDisplays`, `src/main/index.ts:648-653` |
| `debug` | boolean | `false` | strict `=== true` | diagnostics overlay, `src/renderer/main.ts:769` |
| `notes` | string | `''` | string, truncated to 400 characters | the notes bar across the top of the wall, [notes-bar.md](notes-bar.md) |
| `askModel` | string | `'gemini-3.8-flash-medium'` | must match `^gemini-[a-z0-9][a-z0-9.-]{0,56}$`, else default | Ask Gemini's model (full build), [ask-gemini.md](ask-gemini.md) |
| `topPanel` | `'constellation'` or `'throughput'` | `'constellation'` | anything else becomes `'constellation'` | what the top row's big panel shows, [constellation.md](constellation.md) |

Legacy client paths, vault settings, density and pagination settings are ignored
and dropped. A settings file with `mode: "clients"` loads as stats.

`opacity`, `backgroundOpacity`, `monitors` and both hotkeys are edit-the-file
settings. The tray exposes `layerMode`, `background`, `clickThrough`,
`startWithWindows` and `debug`.

`monitors` deserves one note: `targetDisplays()` falls back to **all** displays
when the configured ids match nothing (`src/main/index.ts:651-652`). A stale
monitor id after a hardware change therefore gives you every display rather than
no wall at all.

---

## Validation and healing

Three layers, and none of them can throw.

**1. `normaliseSettings()` coerces anything into a valid object**
(`src/main/settings.ts:84-116`). It takes `unknown`, treats a non-object as `{}`,
and produces a fully populated `Settings` with every key present. There is no
"invalid settings" error path because there is no way to express one.

**2. `loadSettings()` distinguishes three failure modes**
(`src/main/settings.ts:118-150`):

- **UTF-8 BOM.** Stripped before `JSON.parse`
  (`src/main/settings.ts:121-125`). Notepad and PowerShell's
  `Set-Content -Encoding utf8` both write one, `JSON.parse` rejects it, and the
  failure is invisible: the file looks perfect and every setting silently reverts
  to its default. This is rule 11 in `ARCHITECTURE.md`. If you add another hand-editable JSON file, strip the
  BOM there too.
- **File missing.** Normal on first run, so `ENOENT` is silent
  (`src/main/settings.ts:142-147`).
- **File present but unparseable.** Logged as an error naming the path, because
  the alternative is a user whose configuration stopped applying with no
  explanation anywhere.

**3. The `wallpaper` migration** (`src/main/settings.ts:128-136`). `'wallpaper'`
was a third layer mode until 2026-09-02. It is not in the accepted list, so it
would already fall back to `'desktop'` for free. `loadSettings` special-cases it
anyway: it logs an explicit notice and rewrites the file, so it stops claiming a
mode that no longer exists. The reason for the extra effort is that a machine
left on that mode was a machine with an invisible wall, and that user is owed a
line saying what happened. Full account in
[window-layering.md](window-layering.md).

**Writes are atomic.** `saveSettings` writes to `<path>.tmp` and renames
(`src/main/settings.ts:153-159`), so a crash mid-write cannot truncate the file.
It also runs the object through `normaliseSettings` on the way out, so an
in-memory value that drifted out of range cannot be persisted out of range.

### The order that matters: apply, verify, then write

`updateSettings()` (`src/main/index.ts:1186-1240`) mutates the in-memory object
first, applies the consequences, and calls `saveSettings` **last**, at
`src/main/index.ts:1236`.

The comment at `src/main/index.ts:1190-1197` records why. The write used to be
the first thing that happened, so a layer mode that then failed to apply was
already on disk, and restarting the app replayed the failure instead of escaping
it. The only way out was the tray.

Now a layer mode that fails verification is reverted in memory, the previous mode
is re-applied, a tray balloon explains it, and the write records the mode that
works (`src/main/index.ts:1222-1232`). At startup, a persisted mode that fails is
healed to `desktop` and written back once by `healLayerMode`
(`src/main/index.ts:855-867`). `settings.json` mirrors verified state, never
requested state. That is rule 21 in `ARCHITECTURE.md`.

Which side effects `updateSettings` runs is keyed on the specific patch keys, not
on a blanket refresh (`src/main/index.ts:1199-1234`):

| Patch key | Side effect |
|---|---|
| `startWithWindows` | `applyStartup()` |
| `performance` | `detectCapability()` re-run |
| `monitors` | `rebuildWindows()` |
| anything else | `applyLayer()` on every window |
| `hotkeyFocus`, `hotkeyToggle` | `registerHotkeys()` |

### Testing status

`test/settings.test.mjs` covers normalisation and loading a legacy client-view
settings file as stats, with retired paths dropped and current settings kept.

---

## The tray menu

The tray is the only permanent affordance. The wall has no taskbar button
(`skipTaskbar: true`, `type: 'toolbar'`), never takes focus
(`focusable: false`, `WS_EX_NOACTIVATE`), and is not in Alt+Tab. If the tray icon
fails to appear there is no way to quit and no way out of focus mode, which is
what rule 17 in `ARCHITECTURE.md` exists to prevent and what nearly shipped once
in the stats build (see [editions.md](editions.md)).

`refreshTrayMenu()` rebuilds the whole menu from current state every time it is
called (`src/main/index.ts:525-644`). It is called after data reloads, settings
changes, focus and hidden toggles, projection status changes and update state
changes. Nothing in the menu is cached, so nothing can be stale.

### Structure

```
<PRODUCT_NAME>  v<version>  [(dev)]        disabled header
---
Show wall / Hide wall                      label follows state
Focus mode / Leave focus mode              label follows state
View                                       full build only
  Claude Stats                             radio, mode 'stats'
  Work                                     radio, mode 'work' (disabled on a paired screen)
Connect monday... / Disconnect monday      full build only; Disconnect deletes the token
Reconnect monday...                        full build, only after monday refused the token
Ask Gemini...  (Ctrl+Alt+G)                full build only
Gemini model                               full build only: radio per agy Flash model
---
Desktop layer
  Behind apps, interactive  (recommended)  radio, layerMode 'desktop'
  Always on top                            radio, layerMode 'top'
  ---
  For a wall that ignores the mouse,       disabled signpost
  use Click-through
Background
  Gradient  (recommended)                  radio
  Solid                                    radio
  None, show the wallpaper through         radio
Click-through                              checkbox
Start with Windows                         checkbox
---
Projection                                 submenu, shape follows role
---
<update label>                             stats edition only
---
Diagnostics overlay                        checkbox
---
Quit
```

Three details worth knowing:

- **The disabled signpost under Desktop layer** (`src/main/index.ts:570-572`) is
  there because a "Wallpaper layer, no input" option used to be. Rather than
  leave people looking for a removed feature, the menu names the setting that
  actually answers the question they were asking.
- **The Projection submenu is built fresh per open** and its *shape* follows the
  role: an off machine gets two choices, a source gets its paired screens, a
  screen gets "Unpair" (`src/main/index.ts:464-523`). The first line always
  states the current state plainly.
- **The update item is absent, not disabled, in the full build**
  (`src/main/index.ts:624-633`). An item that can never do anything is worse than
  no item.

### Quit is the only exit

`quit()` (`src/main/index.ts:1364-1379`) stops the updater and the desktop
watchdog, destroys the toast, stops projection, closes the usage watcher, flushes
the usage index cache to disk, **detaches every wall HWND**, unregisters hotkeys and destroys the tray before `app.quit()`.

The HWND detach matters: it guarantees each window owns itself before it is
destroyed, so nothing is left parented into a shell window
(`src/main/win32/desktop-layer.ts:352-356`).

`window-all-closed` deliberately does nothing (`src/main/index.ts:1587-1589`).
The wall lives in the tray; closing windows must not quit the app.

### Tray icon and taskbar theme

This is a small feature with a precise reason, at `src/main/index.ts:307-356`.

Windows keeps **two independent** settings under
`Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`:
`AppsUseLightTheme` for application chrome and `SystemUsesLightTheme` for the
taskbar and tray. A user can run light apps on a dark taskbar, and many do.
Electron's `nativeTheme.shouldUseDarkColors` reports the **app** one, so using it
to choose a **tray** icon picks by the wrong setting, and it is wrong precisely
for the people who mix the two.

`taskbarIsDark()` therefore reads `SystemUsesLightTheme` directly
(`src/main/index.ts:320-328`), synchronously, so the icon cannot flash the wrong
art while a promise resolves. Absent means light, which is the Windows default
when the value was never written. Unreadable falls back to the app theme, which
is at least a related answer rather than a guess.

Two sets of art exist, `assets/tray.png` and `assets/tray-dark.png`, because a
white plate on a dark taskbar is a glaring rectangle and a dark plate on a light
one disappears (`src/main/index.ts:358-378`). Electron picks up `tray@2x.png`
automatically for HiDPI, so one path covers both densities.

**Change detection uses both an event and a poll** (`src/main/index.ts:330-343`):

- `nativeTheme.on('updated')` covers the common case, where Windows Settings
  changes both values at once. That path is instant.
- A 30 second poll (`THEME_POLL_MS`) covers a taskbar-only change. This was
  tested rather than assumed: flipping `SystemUsesLightTheme`, even with a
  `WM_SETTINGCHANGE` / `ImmersiveColorSet` broadcast, did not raise the Electron
  event.

The poll is affordable **only** because the read is an in-process `RegGetValueW`
rather than a `reg.exe` spawn. That is the entire justification for
`readHkcuDword` existing at `src/main/win32/ffi.ts:178-190`: shelling out is fine
for a one-off at startup and is not fine on a timer. `syncTrayTheme` also returns
early when the value has not changed, so a no-op event costs nothing
(`src/main/index.ts:349-356`), and the timer is `unref`'d.

One Win32 detail preserved in that code: `HKEY_CURRENT_USER` is spelled as the
negative number `-2147483647` (`src/main/win32/ffi.ts:68-74`). The constant is
`0x80000001` sign-extended to pointer width; writing it as a positive literal
gives the wrong 64-bit value and every lookup fails with
`ERROR_INVALID_HANDLE`. The registry path itself uses `String.raw`
(`src/main/index.ts:344-346`), because a registry path is the one string where
every separator is a backslash and a plain quoted literal silently eats all of
them.

### Tray events

| Event | Behaviour | Location |
|---|---|---|
| double-click | toggle hidden | `src/main/index.ts:386` |
| balloon-click | install the update, **only** when `updateState().phase === 'ready'` | `src/main/index.ts:393-395` |
| tooltip | `PRODUCT_NAME`, or `<name> · update ready, restart to install` while one is staged | `src/main/index.ts:384`, `:1568` |

The balloon-click guard exists because the balloon is shared with the layer-mode
warning (`src/main/index.ts:1226-1229`) and with projection notifications
(`src/main/index.ts:1542-1545`). The update state decides, not the click, so
dismissing an unrelated message can never restart the wall out from under
someone.

---

## Hotkeys

Two, both global, both configurable in `settings.json` only.

| Default accelerator | Action | Handler |
|---|---|---|
| `Control+Alt+W` | toggle focus mode | `toggleFocusMode`, `src/main/index.ts:1244` |
| `Control+Alt+Shift+W` | show / hide the wall | `toggleHidden`, `src/main/index.ts:1253` |
| `Control+Alt+G` | open Ask Gemini (full build only, fixed, not a setting) | `openAsk`, [ask-gemini.md](ask-gemini.md) |

`registerHotkeys()` (`src/main/index.ts:1263-1275`) unregisters everything first,
skips empty accelerators, and treats both failure modes as warnings rather than
errors: an accelerator already taken by another app logs "already in use", and an
accelerator Electron cannot parse logs "invalid". Neither stops the app. Setting
a hotkey to `""` disables it, since `bind` returns early on a falsy accelerator.

They are re-registered when either hotkey setting changes
(`src/main/index.ts:1234`) and unregistered both in `quit()` and on `will-quit`
(`src/main/index.ts:1376`, `:1591-1593`). The duplication is harmless and means
an unexpected quit path still releases them.

### Escape, and why it is not a hotkey

Focus mode puts an opaque fullscreen topmost window over everything, so rule 17
requires that it always be escapable. Three independent routes exist:

1. the global hotkey, which works regardless of what has focus;
2. the tray item, which flips to "Leave focus mode";
3. Escape in the renderer, which sends `wall:exitFocus`
   (`src/renderer/main.ts:917-921`). That IPC handler only ever **exits**
   (`src/main/index.ts:1407-1409`), so a stray message cannot enter focus mode.
   An "Exit focus · Esc" button is shown in the focus-control bar as the visible
   affordance, in both editions (`src/renderer/main.ts:843-856`, `:900-906`).

Routes 1 and 2 do not depend on the wall receiving keyboard input, which matters
because the wall windows are created `focusable: false`.

Note also that the hotkeys are deliberately awkward chords. Rule 17 says not to
bind focus mode to an easily-hit gesture.

---

## Start with Windows

Off by default (`src/main/settings.ts:63`). Toggled from the tray
(`src/main/index.ts:595-600`), which calls `applyStartup()` via `updateSettings`.

`applyStartup()` (`src/main/index.ts:1310-1339`) shells out to `reg.exe` to add
or delete one value:

| | Value |
|---|---|
| Key | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` |
| Value name, full edition | `MuchBetterClientWall` |
| Value name, stats edition | `ClaudeStatsWall` |
| Data | `"<path to exe>" --wall-autostart` |

Four details, each with a reason:

- **The value name is per edition** (`src/main/index.ts:1285-1291`). Both builds
  used one name, so launching the stats build with its own settings, where
  `startWithWindows` defaults to off, deleted the full build's login entry. Two
  products that install side by side must not share a single registry value.
- **The executable path is quoted** (`src/main/index.ts:1321`), because the
  install path certainly contains spaces.
- **Development is skipped entirely** (`src/main/index.ts:1313-1318`), logging
  why when the setting is on. Registering the dev Electron binary to launch at
  sign-in would be actively unhelpful.
- **Deleting an entry that is not there is not a failure**
  (`src/main/index.ts:1328-1329`). `reg delete` reports an error for it, and that
  is a normal no-op when turning the setting off on a machine that never had it
  on.

`--wall-autostart` is written into the command but, as of this writing, **nothing
reads it**: grepping `src/`, `test/` and `scripts/` finds the one write site and
no reader. It is a marker that makes the entry recognisable in regedit and Task
Manager's Startup tab. Treat it as available if you ever want autostart-specific
behaviour, but do not assume something already depends on it.

### Why not `app.setLoginItemSettings()`

Recorded at `src/main/index.ts:1293-1309` and as rule 19 in `ARCHITECTURE.md`.

It silently does nothing on this machine. It neither throws nor registers, and
`getLoginItemSettings()` keeps reporting `openAtLogin: false`. The cause is
visible in what it reports for **other** applications' existing entries: an
unquoted Run value under a profile path containing spaces comes back split, for
example path `C:\Users\HP` with args `["865", "G10\AppData\..."]`. Electron's
Windows implementation is not space-safe, and this user profile has spaces in it.

Writing the key directly is also more honest: it is one value a person can see in
regedit or Task Manager's Startup tab and delete by hand, unlike a scheduled
task.

**Documentation warning.** `ARCHITECTURE.md:284` still says startup "uses
`app.setLoginItemSettings` (HKCU Run key)" and mentions `openAsHidden`. That
contradicts both the code and `ARCHITECTURE.md`'s own rule 19, and it is the
stale line, not the code. There is no `setLoginItemSettings` call anywhere in
`src/`.

---

## Performance and capability tiers

`src/main/capability.ts` picks one of three tiers once at startup and hands it to
the renderer, which scales its motion budget to it.

The premise, stated at `src/main/capability.ts:1-11`: the wall runs 24/7, so the
cost of a visual effect is paid continuously. Prioritise smoothness and low idle
cost over effects, because a dropped frame on an ambient wall reads as "broken",
not "busy". Detection is measured, not guessed.

### The signals

| Signal | Source |
|---|---|
| GPU compositing | `app.getGPUFeatureStatus()`, reading `gpu_compositing` and falling back to `compositing`, counted as accelerated only when the string starts with `enabled` (`src/main/capability.ts:32-41`) |
| Cores | `os.cpus()?.length ?? 2` |
| Memory | `os.totalmem()`, rounded to one decimal in GB |
| Battery | `powerMonitor.isOnBatteryPower()`, wrapped in try/catch. The comment notes `app.isOnBatteryPower` does not exist, which is presumably where someone reached first |

### The decision

In order (`src/main/capability.ts:61-83`):

1. No GPU compositing, so software rendering, gives **low**. Blur and mesh
   gradients become CPU-bound and must be dropped.
2. Otherwise 4 cores or fewer, or under 8 GB, gives **low**.
3. Otherwise 12 cores or more **and** 24 GB or more gives **high**.
4. Otherwise **balanced**.
5. On battery, **high** steps down to **balanced**. Windows laptops throttle
   aggressively and the user cares about runtime more than parallax.
6. A `performance` setting other than `'auto'` overrides the result outright,
   and the override is appended to `reasons` so the log still shows what the
   machine would have been given.

`reasons` is a string array carried all the way to the renderer, printed at
startup (`src/main/index.ts:1492`) and shown in the diagnostics overlay. The tier
is never a bare verdict; it always arrives with the numbers behind it.

### What the tier changes

The main process only decides. Everything downstream is presentation:

- `document.body.dataset.perf = state.capability.tier`
  (`src/renderer/main.ts:585`), which CSS gates hang off. Examples: a single
  linear gradient pass instead of a mesh at low
  (`src/renderer/styles/wall.css`) and the stats backdrop dimmed
  (`src/renderer/styles/stats.css`).
- The live trace canvas caps its frame rate: 12 fps at low, 24 at balanced, 30 at
  high (`src/renderer/stats.ts:405-408`). Software rendering repaints the whole
  surface, so it is capped hardest.

### Detection runs twice at most

`detectCapability()` is called at boot (`src/main/index.ts:1491`) and again only
when `settings.performance` changes (`src/main/index.ts:1200`).

It is therefore **not** re-run when the machine is unplugged. A wall that starts
on mains at `high` stays at `high` after the charger comes out, until the app
restarts or the setting is touched. That is a reading of the two call sites, not
a documented decision, and it is the kind of thing to know before concluding the
battery rule is broken. Whether it is worth wiring `powerMonitor`'s `on-battery`
and `on-ac` events to a re-detect is an open question rather than an oversight
the code admits to.

### The diagnostics overlay

`settings.debug` turns on an overlay (`src/renderer/main.ts:767-806`) that prints
the display index, size and scale factor, the viewport, the tier
with its cores, memory and GPU state, the layer mode with a `[FOCUS]` marker and
the click-through state, and whether the Win32 layer loaded at all, colour coded.

For anything in [window-layering.md](window-layering.md) this overlay plus the
`[main] layer ...` log lines are the primary evidence, because none of the
layering code is covered by automated tests.
