# Auto-update

**Summary.** Only the packaged **stats** edition updates itself. It watches a
public, unauthenticated generic feed on the download site's Cloudflare Worker,
first 15 seconds after launch and then once a minute, downloads in the
background, and installs either when the user next quits or when they click
Install. Three surfaces say so: a click-through toast above other windows, an
Install pill on the wall, and the tray. The full build never auto-updates; it is
installed by `npm run deploy`.

Last verified: 2026-09-03, against app version 0.8.6 (`package.json:4`).

---

## 1. Which edition updates, and which deliberately does not

`startUpdater()` returns before doing anything in three cases
(`src/main/updater.ts:90-110`):

| Condition | Behaviour | Line |
|---|---|---|
| `!app.isPackaged` | logs `[update] skipped: development build`, returns | `src/main/updater.ts:94-96` |
| `!isStatsOnly` | logs `[update] skipped: the full build updates via npm run deploy`, returns | `src/main/updater.ts:98-102` |
| `electron-updater` cannot be required | warns, returns | `src/main/updater.ts:104-110` |

`isStatsOnly` is a build constant, not a runtime branch: esbuild substitutes
`process.env.MBW_EDITION` at build time (`src/shared/edition.ts:27-30`,
`build.mjs:27-38`).

The full build is excluded on purpose. It lives on one machine and is installed
by `npm run deploy` (`scripts/deploy.mjs`), which is rule 18 in
`ARCHITECTURE.md:406-407`. The rationale recorded at `src/main/updater.ts:16-24`
is that two update mechanisms racing for the same install recreates the
"multiple installations" problem the deploy script exists to prevent. The tray
does not even show an update entry in the full build: the menu item is absent
rather than present and inert (`src/main/index.ts:609-622`).

## 2. The feed, and why it carries no credential

```
electron-updater  --HTTPS GET-->  https://claude-stats-wall.gustavpjvr.workers.dev/updates/
                                     latest.yml
                                     ClaudeStatsWall-Setup-<version>.exe
                                     ClaudeStatsWall-Setup-<version>.exe.blockmap
```

- Feed URL constant: `src/main/updater.ts:31`.
- Applied at runtime with `provider: 'generic'`: `src/main/updater.ts:112`.
- Baked into the package as `app-update.yml` by the `publish` block:
  `electron-builder.stats.js:79-85`.
- Served by the download site's Worker, `/updates/*` route:
  `../claude-stats-wall-site/src/index.js:84-116`.

The history matters because the decision was reversed. Auto-update was
originally rejected: `electron-updater` needs a feed it can read without a
human, this repo is private, so a GitHub provider would have meant shipping a
GitHub token inside a binary handed to strangers. That reasoning is recorded
twice: at `scripts/deploy.mjs:7-19`, where it is still the operative rule for
the full build, and at `src/main/updater.ts:4-14`, where it is explained as no
longer applying to the stats build. A generic feed on a public R2 bucket needs
no credential at all. The app fetches a YAML file and an installer over plain
HTTPS, exactly as a browser would, and those are the same public artefacts the
download button serves (`../claude-stats-wall-site/src/index.js:71-83`).

What that costs is worth stating plainly: there is no publisher identity check
on an update. Neither electron-builder config sets a signing certificate or a
`publisherName`, and the site tells users the installer is unsigned
(`../claude-stats-wall-site/public/index.html:110-116`, `README.md:281-282`).
The integrity chain is therefore HTTPS to the Worker plus the sha512 that
`latest.yml` records for the installer (`release-stats/latest.yml`). Anyone who
can write to the R2 bucket decides what every installed copy runs next. See
[build-and-release.md](build-and-release.md) on signing and
[download-site.md](download-site.md) on who can write the bucket.

## 3. Check cadence, and what it costs

| Constant | Value | Line |
|---|---|---|
| `FIRST_CHECK_MS` | 15 seconds | `src/main/updater.ts:34` |
| `RECHECK_MS` | 60 seconds | `src/main/updater.ts:48` |

The timer is a `setTimeout` that installs a `setInterval` when it fires, and
both handles are `unref`'d so the check never holds the process open
(`src/main/updater.ts:157-162`). The first check is delayed so it does not
compete with the cold usage index at startup (`src/main/updater.ts:33`).

The cost, as recorded in the comment at `src/main/updater.ts:35-47`: a check is
one conditional GET of a `latest.yml` a few hundred bytes long, so one install
is 60 x 24 = **1,440 requests a day**. That comment states the free-plan
allowances as 100,000 Worker requests a day and 10 million R2 reads a month,
which puts roughly sixty installs inside the Worker allowance before anything
has to change. The installer itself is only fetched when the version moves.

Two honest caveats:

- The allowance figures above are quoted from that comment. They were not
  re-verified against Cloudflare's published limits while writing this document.
  Check them before relying on the sixty-install headroom.
- `latest.yml` is served with `cache-control: public, max-age=60`
  (`../claude-stats-wall-site/src/index.js:103`), so some checks can be answered
  by Cloudflare's edge cache rather than by the origin Worker. Whether a given
  check bills a Worker request depends on cache state, which was not measured
  here. Treat 1,440 as the upper bound per install.

Nothing here touches Claude or Anthropic. The check sends no usage data; it is a
GET of a YAML file.

The tray also offers a manual check. `checkNow()` runs whatever the timer is
doing, and in a development or full build it reports a clear error rather than
pretending to check (`src/main/updater.ts:168-179`).

## 4. Differential downloads

`autoDownload = true` (`src/main/updater.ts:113`), so the download starts the
moment a newer version appears, without asking.

The download is partial where it can be. electron-builder writes a `.blockmap`
beside the installer, `publish-release.mjs` uploads it alongside the `.exe` and
`latest.yml` (`../claude-stats-wall-site/scripts/publish-release.mjs:92-121`),
and electron-updater fetches only the blocks that changed. The reasoning is at
`electron-builder.stats.js:68-78`.

That only works because the `/updates/` route passes range headers through to R2
and answers `206 Partial Content` when the client actually asked for a range
(`../claude-stats-wall-site/src/index.js:91-113`), advertising
`accept-ranges: bytes` at `:100`.

Sizes, so the saving has a denominator: the 0.8.6 installer is 112,369,910 bytes
as recorded in `release-stats/latest.yml`, about 107 MiB. The claim that a patch
release comes down as a few MB (`electron-builder.stats.js:74-78`) or under a
megabyte (`../claude-stats-wall-site/public/index.html:126-134`) is the authors'
figure. It was not measured while writing this document.

## 5. Install on quit versus install on click

Two paths, and only one of them ever interrupts anybody.

**On quit.** `autoInstallOnAppQuit = true` (`src/main/updater.ts:119`). A staged
update is applied at the moment the user quits the app anyway. The app never
quits itself to install, which is the point of the comment above that line: the
wall is something you leave running for weeks, so tearing it off the screen
mid-session is the failure being avoided.

**On click.** `installNow()` (`src/main/updater.ts:188-214`):

1. Returns immediately unless the phase is `ready` and no install is already in
   flight (`:189`).
2. Shows a blocking confirm dialog with "Restart and update" and "Later"
   (`:192-203`). Choosing Later keeps the staged update, which then installs on
   next quit.
3. Calls `quitAndInstall(true, true)`, meaning silent and relaunch afterwards
   (`:209`).

The renderer cannot force this. `wall:installUpdate` is guarded on the updater's
own state rather than on who called it, so a stale renderer cannot quit the app
(`src/main/index.ts:1379-1383`). The tray balloon is guarded the same way,
because that balloon channel is shared with the projection warnings and a click
on an unrelated message must not restart the wall
(`src/main/index.ts:376-384`).

On quit, `stopUpdater()` clears the timers and the toast window is destroyed
(`src/main/index.ts:1347-1352`).

## 6. The three notification surfaces

All three are fed by one function, `pushUpdate()`, so they cannot disagree
(`src/main/index.ts:970-977`). It is called from the `startUpdater` change
callback, which also refreshes the tray menu and the tray tooltip
(`src/main/index.ts:1543-1554`). A window that finishes loading later gets the
current state immediately (`src/main/index.ts:723-725`).

State shape: `UpdateState` at `src/main/updater.ts:50-56`, with phases `idle`,
`checking`, `none`, `downloading`, `ready`, `error`.

### 6.1 The toast: "is something happening"

An always-on-top panel, 268 x 88, bottom right of the primary display's work
area with an 18 px margin (`src/main/index.ts:885-896`).

| Property | Value | Line |
|---|---|---|
| `alwaysOnTop` level | `screen-saver` | `src/main/index.ts:921` |
| Mouse input | `setIgnoreMouseEvents(true)` | `src/main/index.ts:922` |
| Focusable | `false` | `src/main/index.ts:905` |
| Shown with | `showInactive()` | `src/main/index.ts:957` |
| Window type | `toolbar`, `skipTaskbar: true` | `src/main/index.ts:904-909` |
| Chrome | frameless, transparent, no shadow | `src/main/index.ts:897-910` |

**Why it is click-through and unfocusable.** It floats above every other
application. A window that takes a click, or takes focus, while you are working
in a different app is the behaviour this project keeps refusing to ship. The
toast therefore only informs, and the thing you act on is the pill on the wall,
a surface you chose to look at. The reasoning is at `src/main/index.ts:868-881`,
`src/renderer/toast.ts:1-9` and `src/renderer/main.ts:979-994`. The bridge
enforces it as well: the toast's preload API exposes `onUpdate` and no actions
at all (`src/preload/index.ts:70-78`).

**Why it withdraws after 9 seconds.** `TOAST_READY_LINGER_MS = 9_000`
(`src/main/index.ts:929-937`). The `ready` phase persists until the user
installs, which may be days, and a panel floating above every window for days is
not a notification, it is a nuisance. So the toast announces once and leaves,
and the pill is the part that persists. A download that starts again cancels a
pending withdrawal (`src/main/index.ts:963-967`).

The toast is shown only for `downloading` and `ready`, and hidden for everything
else (`src/main/index.ts:948-958`). It is created lazily on first need
(`src/main/index.ts:889-890`), which is why a full build, where the updater
never reports a phase, never creates it at all.

Renderer: `src/renderer/toast.ts:30-48` writes the title, the percentage and the
progress bar and sets `data-phase`. Markup at `src/renderer/toast.html:10-17`,
with a locked-down CSP at `:5`. Styling at `src/renderer/styles/toast.css`,
including the green non-pulsing dot and the hidden progress bar in the ready
state (`:48-52`, `:81-88`).

### 6.2 The Install pill: "do I want this now"

Bottom centre of the wall, present only when an update is staged.

- Built and appended once: `src/renderer/main.ts:995-1007`.
- Shown only for phase `ready`: `src/renderer/main.ts:1011-1016`.
- Click disables the button, relabels it "Installing", and invokes
  `wall:installUpdate`: `src/renderer/main.ts:1000-1004`.
- Styling: `src/renderer/styles/wall.css:1087-1139`.

It honours the wall's click-through setting rather than working around it. When
`clickThrough` is on the wall passes clicks through (`src/main/index.ts:681`,
`:824`) and nothing on it is clickable, client card links included. The pill is
still rendered, because knowing an update is ready is useful even when the
action has to come from the tray. Reasoning at `src/renderer/main.ts:989-993`.

### 6.3 The tray: the always-available surface

Three things, all in the stats build only:

1. **Menu entry.** Label from `updateLabel()` (`src/main/updater.ts:225-242`),
   which has honest wording for every phase including "Up to date" and "Update
   check failed". Clicking installs when ready and checks otherwise
   (`src/main/index.ts:613-622`).
2. **Tooltip.** Switched to a "update ready, restart to install" form while an
   update is staged, and back to the plain product name otherwise. It is the one
   update surface visible without opening a menu
   (`src/main/index.ts:1547-1551`).
3. **Balloon.** Raised once when the download completes, with the text "It
   installs when you next quit, or right away from the tray menu."
   (`src/main/updater.ts:136-143`, wired to `tray.displayBalloon` at
   `src/main/index.ts:1553`). Clicking it installs, but only if an update is
   genuinely staged (`src/main/index.ts:382-384`).

## 7. Failure behaviour

An `error` phase is a log line and a tray label, never a dialog
(`src/main/updater.ts:144-149`). Offline, a corporate proxy, or a feed that is
not there yet are all normal, and none of them are worth interrupting anyone
over. `checkForUpdates()` rejections are swallowed because the `error` event has
already reported them (`src/main/updater.ts:151-155`). Startup is never blocked.

All updater logs are prefixed `[update]` (`src/main/updater.ts:120-125`).

## 8. History, and the mistakes worth keeping

**It used to check every six hours, and told nobody.** The updater checked,
downloaded and staged updates entirely correctly and entirely invisibly: the
only sign was a label inside a tray menu nobody had a reason to open. An update
that installs itself is fine; an update the user cannot know about is not,
because "restart when convenient" is their decision to make and they were never
offered it. That is recorded at `src/main/updater.ts:58-66`, and the six hour
cadence at `src/main/updater.ts:35-38`. The fix was both halves at once: the
cadence went to 60 seconds, and the toast and the pill were added so the news
reaches a surface the user actually looks at.

**Stale copy still says six hours.** Two user-facing texts were not updated with
the code and now contradict it:

- `README.md:285-289` says "90 seconds after launch and every six hours after
  that".
- `../claude-stats-wall-site/public/index.html:282-286` says "ninety seconds
  after launch and every six hours after that", while `:126-134` of the same
  file correctly says once a minute.

The code is the authority: 15 seconds, then every 60 seconds
(`src/main/updater.ts:34`, `:48`). Correcting those two files is outside the
scope of this document, which was written under an instruction not to modify
source.

**Both notification surfaces shipped once with a broken `hidden` attribute.**
`.toast` and `.update-pill` each set `display: flex`, and an author rule beats
the user agent's `[hidden] { display: none }` whatever the specificity. Setting
`el.hidden = true` therefore changed the property, the DOM read back as hidden,
and the element stayed on screen. The visible symptom was an Install pill
sitting on the wall of a build that has no updater at all. Both stylesheets now
carry an explicit override: `src/renderer/styles/toast.css:102-112` and
`src/renderer/styles/wall.css:1141-1151`. The general lesson, that a test can
pass by checking something adjacent to the thing that matters, is written up at
`docs/README.md:48-67`.

## 9. Checking it by hand

```sh
# What the installed copies will read
curl -s https://claude-stats-wall.gustavpjvr.workers.dev/updates/latest.yml

# What the download page will advertise
curl -s https://claude-stats-wall.gustavpjvr.workers.dev/api/release
```

The two must agree on the version. `publish-release.mjs` checks both after every
publish (`../claude-stats-wall-site/scripts/publish-release.mjs:143-173`).

## Related

- [build-and-release.md](build-and-release.md) for how the artefacts in that
  feed are produced.
- [download-site.md](download-site.md) for the Worker and bucket that serve them.
- [editions.md](editions.md) for what else differs between the two builds.
