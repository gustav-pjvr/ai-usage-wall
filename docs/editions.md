# Editions

One codebase, two products. `MBW_EDITION` is baked in by esbuild at build time
and decides which of them a given `dist/` is. This document covers what the two
editions are, how the constant is injected, everything that differs between them,
and the incident where both editions shared a userData directory and a single
instance lock because the packaged asar carried the repo's `productName`.

The short version: the edition is a **build constant**, not a runtime
environment variable and not a branch. Everything downstream of it is a small
number of guards, and the two things that are easiest to get wrong are the
product identity (which controls the userData path) and the packaging config
(which controls what actually ships).

Related: [window-layering.md](window-layering.md),
[settings-and-tray.md](settings-and-tray.md), and `README.md` "The shareable
build" for the hand-over-to-a-human version.

---

## The two editions

`src/shared/edition.ts:25-33` is the whole surface:

```ts
export type Edition = 'full' | 'stats';
export const EDITION: Edition = process.env.MBW_EDITION === 'stats' ? 'stats' : 'full';
export const isStatsOnly = EDITION === 'stats';
export const PRODUCT_NAME = isStatsOnly ? 'Claude Stats Wall' : 'MuchBetter Client Wall';
```

**`full`, MuchBetter Client Wall.** Claude Stats only, with the existing appId
and product name retained so installed copies upgrade in place. A Work view is
planned later. This edition is updated by `npm run deploy`.

**`stats`, Claude Stats Wall.** The same dashboard, with a separate installed
identity and the automatic updater.

Neither edition reads, seeds, watches or ships client records or assets.
The default remains `full` unless the build flag is exactly `stats`.

### Why a build constant and not a git branch

Recorded at `src/shared/edition.ts:3-8`. A branch was the obvious alternative
and it is the wrong shape: the two would diverge, and every fix to the stats
dashboard, the desktop layer or the usage indexer would have to be landed twice.
A build-time constant costs a handful of guards and keeps one place to fix
anything.

---

## How `MBW_EDITION` is injected

Three steps, all in `build.mjs`.

**1. Parse the flag** (`build.mjs:27-28`):

```js
const editionArg = process.argv.find((a) => a.startsWith('--edition='));
const edition = editionArg?.slice('--edition='.length) === 'stats' ? 'stats' : 'full';
```

Exact string match. `--edition=Stats`, `--edition=statistics` and a missing flag
all produce `full`, silently. The build does print which edition it produced
(`build.mjs:118`, `:122`), so read that line rather than trusting the command you
think you ran.

**2. Substitute it into every bundle** (`build.mjs:38`):

```js
define: { 'process.env.MBW_EDITION': JSON.stringify(edition) },
```

This lives in the `common` object, so it applies to all five entry points: the
main process, the preload, and the three browser bundles (`main.ts`, `pair.ts`,
`toast.ts`). esbuild replaces the *expression* with a string literal, so the
compiled output contains `"stats" === 'stats'` and no reference to `process` at
all.

**3. Read it once** at `src/shared/edition.ts:27`.

### The consequence that catches people

**Setting `MBW_EDITION` in the environment at runtime does nothing.** The
expression is gone before the app ever runs. This is not an accident; it is the
reason the mechanism was chosen. The renderer has no `process` object at all, and
a runtime read would throw there. The comment at `src/shared/edition.ts:20-22`
says exactly this, and `build.mjs:22-26` says it from the other side.

So `EDITION` is a property of a `dist/` directory, not of a session. If you are
unsure what is in `dist/`, rebuild.

### `dist/` is shared, and the last build wins

Both editions build to the same `dist/`, and `build.mjs:112` wipes it first. That
makes the npm scripts (`package.json:10-23`) important to read as pairs rather
than as independent commands:

| Script | What it does |
|---|---|
| `npm run build` | full edition into `dist/` |
| `npm run build:stats` | stats edition into `dist/` |
| `npm start` | `build` then `electron .` |
| `npm run start:stats` | `build:stats` then `electron .` |
| `npm run package` | `build` then `electron-builder --win`, output to `release/` |
| `npm run package:stats` | `build:stats` then `electron-builder --win --config electron-builder.stats.js`, output to `release-stats/` |

Each packaging script rebuilds first. That chaining is the thing that stops a
stats installer being cut from a full `dist/`, and it is worth preserving if you
ever refactor these scripts. `electron .` always uses `main` from
`package.json`, which is `dist/main/index.js` regardless of edition, so nothing
about the *runtime* distinguishes them beyond what was compiled in.

---

## What differs

| | full | stats |
|---|---|---|
| `PRODUCT_NAME` | MuchBetter Client Wall | Claude Stats Wall |
| `app.getName()` | from `package.json` `productName` | overridden by `app.setName()` at `src/main/index.ts:1464` |
| userData | `%APPDATA%\MuchBetter Client Wall` | `%APPDATA%\Claude Stats Wall` |
| Single instance lock | keyed on that userData | keyed on that userData, so distinct |
| appId | `world.muchbetter.clientwall` (`package.json:38`) | `world.muchbetter.claudestatswall` (`electron-builder.stats.js:19`) |
| Installer output | `release/` | `release-stats/` |
| Artefact name | `MuchBetter Client Wall Setup <version>.exe` (builder default) | `ClaudeStatsWall-Setup-<version>.exe` (`electron-builder.stats.js:31`) |
| Client records in the installer | absent | absent |
| `assets/` in the installer | filtered, `!clients/**` | filtered, `!clients/**` |
| Desktop shortcut | not created | created |
| Views | Claude Stats only | Claude Stats only |
| Updater | none, updated by `npm run deploy` | electron-updater against a generic feed |
| Run registry value | `MuchBetterClientWall` | `ClaudeStatsWall` |
| Ask Gemini ([ask-gemini.md](ask-gemini.md)) | ASK chip, Ctrl+Alt+G, tray items, `ask:*` IPC, `wall.ask` bridge | none of them: guarded by `isStatsOnly` in main, preload and renderer |

### Menus

The stats edition has an update item. The full edition is updated through
`npm run deploy`. Both retain Projection and all other shared controls.
Neither has a View submenu, records count, client reload or client folder item.

### Data sources

Both editions show stats without a mode switch or Tab toggle. Settings always
normalise `mode` to `stats`; old client paths and vault settings are dropped.
The client store, vault bridge, seeding, watcher and asset protocol are removed.
The app leaves existing local records untouched.

### Updater

`src/main/updater.ts` is compiled into both editions and refuses to do anything
in the full one:

- `startUpdater` returns early when `!app.isPackaged`, and again when
  `!isStatsOnly`, logging "the full build updates via npm run deploy"
  (`src/main/updater.ts:96-102`);
- `checkNow` sets an error state rather than checking (`:169-172`).

That is rule 18: `npm run deploy` is the only way the full build gets installed
or updated, and two update mechanisms racing for the same install is a problem
this project already solved once. `scripts/deploy.mjs` reads
`pkg.productName` and looks in `release/`, so it can only ever pick up the full
installer.

The stats feed is a generic HTTPS directory, configured in two places that must
agree: `publish` in `electron-builder.stats.js:79-85`, which is what
electron-builder embeds as `app-update.yml`, and `FEED_URL` in
`src/main/updater.ts:31`. `generic` was chosen specifically because it needs no
credential, so there is no GitHub token inside a binary handed to strangers.

The artefact name has no spaces, and `electron-builder.stats.js:21-30` explains
that this was not cosmetic: `latest.yml` refers to the installer by its exact
filename, so a product name with three spaces made every update URL
percent-encoded, and one missed decode anywhere is a 404 that surfaces on someone
else's machine as "update failed".

### Packaging: the tray art near-miss

`extraResources` for the stats build is
`[{ from: 'assets', to: 'assets', filter: ['**/*', '!clients/**'] }]`
(`electron-builder.stats.js:52`). The filter is what keeps client logos out.

An earlier version shipped only `assets/logo`, which left `assets/tray.png` out
of the package. `new Tray()` therefore got an empty image and there was **no tray
icon at all**: no menu, no way to quit, no way out of focus mode. That is exactly
the trap rule 17 exists to prevent, and it nearly shipped. The note is at
`electron-builder.stats.js:44-51`.

`trayIcon()` degrades to `nativeImage.createEmpty()` and logs a warning
(`src/main/index.ts:370-377`), so this failure is quiet at runtime. If you change
what the stats build ships, check for that warning line in the log of the
**packaged** build, not the dev one.

---

## The shared userData and single instance lock

This is the incident most worth understanding before touching anything in this
document, because the reasoning that let it through is reasonable-sounding.

### What happened

electron-builder writes the repo's `package.json` into the asar of both
editions. `files` lists `package.json` explicitly in both configs
(`package.json:46`, `electron-builder.stats.js:38`). That package.json carries
`"productName": "MuchBetter Client Wall"` (`package.json:3`).

Electron derives the app name from the packaged `package.json`, and
`app.getPath('userData')` is derived from the app name. So **both editions
reported the same product name and resolved to the same userData folder**, and
the single instance lock, which is keyed on userData, was the same lock.

Two consequences, both bad:

1. The shareable build read the full build's `settings.json` and its client data
   folder. A build whose entire premise is that it carries no client data was
   reading the client data folder of the machine it was installed on.
2. On any machine running both, the second edition to launch exited with
   "another instance is already running". That is precisely the projection setup:
   one machine sourcing, another displaying, frequently the same machine during
   development.

### Why the different appId did not help

The two builds already had different `appId` values, and it is tempting to
conclude from that they are separate products. They are, to NSIS: the appId is
why the stats build installs **alongside** the full build rather than upgrading
over it and inheriting its files, which is called out at
`electron-builder.stats.js:12-14`.

But `appId` does not feed `app.getPath('userData')`. The **app name** does. Two
installers that cannot collide on disk can still collide in `%APPDATA%`, and
that is the gap the bug lived in.

### The fix

`src/main/index.ts:1450-1464`:

```ts
if (isStatsOnly) app.setName(PRODUCT_NAME);
```

Three things about that one line:

- **It is at module scope, not inside a start function.** `setName` must run
  before the app is ready and before anything asks for `getPath('userData')`,
  because the path is resolved from the name at first use. Anywhere later is too
  late, and too late fails silently by pointing at the old folder.
- **It runs before the single instance check** at `src/main/index.ts:1472`,
  which is what makes the two locks distinct.
- **The guard is one-sided.** Only the stats edition renames itself. The full
  build keeps the name from `package.json`, which means its existing userData
  path, settings and seeded client data are untouched by the fix. That last
  consequence is my reading of the code rather than something the comment states,
  but it is the behaviour that follows from the guard.

### The related log line

`src/main/index.ts:1472-1477` logs "another instance is already running, exiting"
rather than exiting silently with code 0. The comment records why: a silent exit
looks exactly like a crash and wasted real debugging time. Note that a packaged
install and a **dev run of the same edition** still collide, because they resolve
to the same userData. That is expected, and the log line is how you tell it apart
from a crash.

### The general lesson

Two products built from one repository share every file that is copied verbatim
into both, including `package.json`. Anything derived from that file is shared
identity unless something overrides it explicitly. Before adding a second
edition-varying property, ask where it is read from, and whether that source is
per-edition or per-repo. The list of per-edition identity so far:

| Property | Where it is made per-edition |
|---|---|
| product name and userData | `app.setName()`, `src/main/index.ts:1464` |
| appId, installer name, output dir | `electron-builder.stats.js` |
| Run registry value | `RUN_VALUE`, `src/main/index.ts:1291` |
| what is shipped | `extraResources` in each config |

Everything else, including `version` (`package.json:4`), is shared by
construction.

### The Run registry value

Same class of bug, caught separately, recorded at `src/main/index.ts:1285-1291`:

```ts
const RUN_VALUE = isStatsOnly ? 'ClaudeStatsWall' : 'MuchBetterClientWall';
```

Both builds used one value name under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Launching the stats build
with its own settings, where `startWithWindows` defaults to off, deleted the full
build's login entry. Two products that install side by side must not share a
single registry value. Details of how the value is written are in
[settings-and-tray.md](settings-and-tray.md).

---

## Verifying an edition build

Both builds exclude client data. Verify that claim by looking for resources
that should not be there.

After `npm run package:stats`, the unpacked application is at
`release-stats/win-unpacked`. Search it for a client name and expect nothing.
Search `release-stats/win-unpacked/resources` for a `data` directory and expect
it to be absent, and for `resources/assets/clients` likewise.

Check the same resource exclusions in `release/win-unpacked` for the full build.

Things worth checking beyond that:

1. Launch it and read the userData path in the first log lines. In the stats
   edition, it must say `Claude Stats Wall`.
2. Open the tray menu. There must be no View submenu, no records-loaded line, no
   client folder items, and there must be an update item.
3. Confirm the tray icon is actually there, per the near-miss above.
4. Run both editions at once. Neither should exit with "another instance is
   already running".

A note on what "verified" means here, in keeping with the rest of this
repository's documentation: check the packaged resources as well as the UI.
Neither edition may ship client data.
