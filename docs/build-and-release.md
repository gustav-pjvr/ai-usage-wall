# Build and release

**Summary.** The build is esbuild plus a file copy, driven by `build.mjs`, with
the edition baked in as a compile-time constant. Two electron-builder configs
produce two Windows installers from that one codebase. The full build reaches
its single machine through `npm run deploy`; the stats build reaches everyone
else through the download site, published from the site repo. Nothing is code
signed. The release checklist is at the end.

Last verified: 2026-09-03, against app version 0.8.6 (`package.json:4`).

---

## 1. Every npm script

From `package.json:10-24`. Nothing else exists; there is no script runner, no
task file and no Makefile.

| Script | Command | What it does |
|---|---|---|
| `build` | `node build.mjs` | Full edition. Wipes `dist/` and writes the five bundles plus static files. |
| `dev` | `node build.mjs --watch` | Same, in watch mode: sourcemaps on, minify off (`build.mjs:35-36`). Static files are copied once, not watched (`build.mjs:114-118`). |
| `start` | `npm run build && electron .` | Full edition from source. |
| `typecheck` | `tsc --noEmit` | Type check only, over `src/**/*.ts` and `build.mjs` (`tsconfig.json`). It emits nothing; esbuild does the compiling and does not type check. |
| `test` | four Node scripts in sequence | `test/run.mjs`, `test/projection.test.mjs`, `test/projection-crypto.test.mjs`, `test/stats-projection.test.mjs`. Plain Node, no framework (`test/run.mjs:1-6`). |
| `package` | `npm run build && electron-builder --win` | Full installer, using the `build` block in `package.json:37-89`. Output in `release/`. |
| `package:dir` | `npm run build && electron-builder --win dir` | Unpacked directory only, no installer. For inspecting what would ship. |
| `logo` | `electron scripts/logo.mjs` | Regenerates the SVG sources, the rasterised PNGs and the multi-resolution `.ico` using the Chromium already in the tree (`scripts/logo.mjs:1-6`). |
| `deploy` | `node scripts/deploy.mjs` | The only supported install path for the full build. Section 6. |
| `build:stats` | `node build.mjs --edition=stats` | Stats edition bundles. |
| `start:stats` | `npm run build:stats && electron .` | Stats edition from source. |
| `package:stats` | `npm run build:stats && electron-builder --win --config electron-builder.stats.js` | Stats installer. Output in `release-stats/`. |
| `test:e2e` | `electron test/projection-e2e.cjs` | Projection end to end **through the deployed relay**, driving the real source and screen classes (`test/projection-e2e.cjs:1-14`). Needs network. |

Two traps worth stating:

- **`dist/` holds whichever edition was built last.** `build.mjs:112` removes
  the directory on every run, and both `package` and `package:stats` rebuild
  first, so an installer can never contain the other edition. But running
  `electron .` by hand runs whatever is sitting in `dist/`. Use `start` or
  `start:stats`, which rebuild.
- **`test:e2e` and the relay's own test suite talk to the live relay.** The
  relay's `npm test` deliberately trips the global rate limiter and locks real
  pairing for about a minute (`../claude-stats-relay/README.md:90-91`). See
  [relay-operations.md](relay-operations.md).

## 2. The esbuild setup

`build.mjs` is the whole build: five bundles and a copy step, deliberately
readable top to bottom (`build.mjs:1-7`).

Shared options (`build.mjs:30-39`): `bundle: true`, `platform: 'node'`,
`target: 'node20'`, `format: 'cjs'`, sourcemaps only in watch, minify unless
watching, and one `define` that substitutes the edition.

| Entry | Output | Platform / format | Externals |
|---|---|---|---|
| `src/main/index.ts` | `dist/main/index.js` | node, cjs | `electron`, `koffi`, `chokidar`, `fsevents` (`build.mjs:48`) |
| `src/preload/index.ts` | `dist/preload/index.js` | node, cjs | `electron` (`build.mjs:54`) |
| `src/renderer/main.ts` | `dist/renderer/main.js` | browser, **iife**, chrome120 | none (`build.mjs:66-73`) |
| `src/renderer/pair.ts` | `dist/renderer/pair.js` | browser, **iife**, chrome120 | none (`build.mjs:76-83`) |
| `src/renderer/toast.ts` | `dist/renderer/toast.js` | browser, **iife**, chrome120 | none (`build.mjs:84-91`) |

`koffi` must stay external because it loads a native `.node` binary
(`build.mjs:46-48`), and it is unpacked from the asar at package time
(`package.json:62-65`, `electron-builder.stats.js:53`).

### Why the renderer bundles must be IIFE and not CJS

Recorded at `build.mjs:56-65`. The browser bundles are loaded by a plain
`<script>` tag, and a plain script has no `module` object. If an entry has any
top-level export, esbuild emits its CommonJS wrapper, and the bundle dies on
`ReferenceError: module is not defined` before a single line of application code
runs.

That is not hypothetical. `src/renderer/pair.ts` needs `export {}` for its
`declare global` block, hit exactly this, and rendered an empty window.
`src/renderer/main.ts` escaped only by happening to have no exports, which is
luck rather than design. `src/renderer/toast.ts:50` also ends in `export {}`, so
it would hit the same wall the moment its format changed.

The rule: **anything under `src/renderer/` is `format: 'iife'`,
`platform: 'browser'`.** A new renderer entry that copies the main-process
config will appear to build cleanly and produce a blank window.

### The static copy step

`copyStatic()` (`build.mjs:101-109`) copies three HTML files and an explicit
list of five stylesheets: `wall.css`, `stats.css`, `shell.css`, `pair.css`,
`toast.css`. **A new stylesheet or HTML file must be added to that list**, or it
will be missing from `dist/` and from every installer, with no build error.

Icons are **not** generated by the build any more. `npm run logo` owns them,
because the build used to overwrite `assets/tray.png` on every run and silently
replaced the real logo with a placeholder (`build.mjs:94-99`).

## 3. The two edition builds

One codebase, two products, chosen by a build flag rather than a branch. The
reasoning against a branch, that the two would diverge and every fix would have
to land twice, is at `src/shared/edition.ts:1-23`.

- `--edition=stats` sets the constant to `stats`; anything else yields `full`
  (`build.mjs:27-28`).
- esbuild substitutes `process.env.MBW_EDITION` into **both** bundles, which is
  why it is expressed as a `process.env` read: the renderer has no `process` at
  runtime, but the expression is replaced with a string literal before it gets
  there (`build.mjs:18-26`, `src/shared/edition.ts:20-27`).
- `isStatsOnly` and `PRODUCT_NAME` derive from it (`src/shared/edition.ts:30-33`).

Packaging differences, from `package.json:37-89` and
`electron-builder.stats.js:18-89`:

| | Full (`package.json` `build`) | Stats (`electron-builder.stats.js`) |
|---|---|---|
| `appId` | `world.muchbetter.clientwall` (`:38`) | `world.muchbetter.claudestatswall` (`:19`) |
| `productName` | MuchBetter Client Wall (`:39`) | Claude Stats Wall (`:20`) |
| Output dir | `release` (`:41`) | `release-stats` (`:33`) |
| `artifactName` | not set, so the electron-builder default with spaces | `ClaudeStatsWall-Setup-${version}.${ext}` (`:31`) |
| Client data | `data` shipped in `extraResources` (`:52-61`) | absent entirely (`:52`) |
| Assets | whole `assets` directory (`:52-61`) | `assets` minus `clients/**` (`:52`) |
| Desktop shortcut | false (`:81`) | true (`:63`) |
| `publish` | none | generic feed (`:79-85`) |

Two of those differences are load-bearing:

- **The stats build does not merely hide client records, it does not contain
  them.** Nothing to leak (`electron-builder.stats.js:8-12`, rule 23 at
  `ARCHITECTURE.md:435`).
- **The asset filter must keep the tray art.** Shipping only `assets/logo` once
  left the tray icon file missing, so `new Tray()` got an empty image: no tray
  icon, no menu, no way to quit, no way out of focus mode. That is exactly the
  trap rule 17 exists to prevent, and it nearly shipped
  (`electron-builder.stats.js:44-52`).

The stats config is a `.js` file rather than `.json` for one reason: the JSON
schema rejects unknown keys, including a comment key, and those comments are the
record of why each difference exists (`electron-builder.stats.js:5-7`).

## 4. Code signing

**There is none.** No `certificateFile`, `certificateSubjectName`, `signtool`
options, `publisherName` or `forceCodeSigning` key appears in `package.json`,
`electron-builder.stats.js` or any script in this repo. Both installers ship
unsigned.

The consequences are stated to users rather than hidden:

- Windows SmartScreen shows the blue "Windows protected your PC" dialog on first
  run, and the site tells people to choose More info and then Run anyway, with
  the reason: a signing certificate costs a few hundred dollars a year and this
  is a free tool (`../claude-stats-wall-site/public/index.html:109-117`). The
  same warning is in `README.md:281-282`.
- For auto-update, the guarantee that remains is the sha512 recorded in
  `latest.yml` (`release-stats/latest.yml`) fetched over HTTPS. There is no
  publisher identity to compare, so nothing about the update chain proves who
  built the installer, only that it matches what the feed said. That reading of
  electron-updater's Windows behaviour is inferred from its documented
  signature check rather than read out of this repo, so treat it as inference;
  the absence of signing configuration is a direct reading.

If signing is ever added, it belongs in **both** configs, and the stats config
is the one that matters for updates.

## 5. artifactName, and why spaces broke update URLs

The stats config pins `artifactName: 'ClaudeStatsWall-Setup-${version}.${ext}'`
(`electron-builder.stats.js:31`). The reasoning, at `:21-30`:

The product name has three spaces, and `latest.yml` refers to the installer by
its exact filename, so every update URL became percent-encoded. That is legal
and it is a nuisance at every layer: the update route has to accept the encoded
form, logs become unreadable, and one missed decode is a 404 that shows up only
as "update failed" on someone else's machine.

The download site's `/updates/` route makes this concrete. It validates the
requested name against `/^[A-Za-z0-9._-]{1,120}$/`
(`../claude-stats-wall-site/src/index.js:87`). A percent sign is not in that
set, so a request for an encoded space would be rejected as a 404 before it ever
reached the bucket. Removing the spaces once, at the source, is cheaper than
handling them everywhere forever.

The full build keeps the default name **with** spaces, and the deploy script
depends on it: it builds the expected path as
`release/${productName} Setup ${version}.exe` (`scripts/deploy.mjs:37`) and
prunes superseded installers by the same prefix
(`scripts/deploy.mjs:112-124`). Setting an `artifactName` on the full build
without updating those two places would break `npm run deploy`.

## 6. The deploy path: the full build, one machine

`npm run deploy` runs `scripts/deploy.mjs`, whose entire purpose is that there is
never a second place the app can run from. The failure it prevents is a stale
installed copy while a newer build sits in `release/win-unpacked`, which
happened once and cost real confusion (`scripts/deploy.mjs:1-19`). Rule 18:
`npm run deploy` is the only way the app gets installed or updated
(`ARCHITECTURE.md:406-407`).

Sequence (`scripts/deploy.mjs:134-142`):

1. **Build and package.** Runs `npm run package` through `exec` with a command
   string, because npm on Windows is a `.cmd` that Node refuses to `execFile`
   without a shell, and an args array with `shell: true` is deprecated
   (`scripts/deploy.mjs:63-79`). Fails loudly if the expected installer is
   absent, and prints its size.
2. **Stop the running app**, `taskkill /F /IM ... /T`, then wait 1.5 s because
   Windows holds the exe briefly after the process dies
   (`scripts/deploy.mjs:51-61`).
3. **Install in place**, NSIS `/S`: silent, per-user, no admin. The installer
   replaces the existing copy and updates its own Add/Remove Programs entry, so
   no duplicate appears (`scripts/deploy.mjs:81-90`).
4. **Verify against the registry**, not against the installer's own claim. It
   reads `HKCU\...\Uninstall\*` and fails if there is no entry, if there is more
   than one, or if the version does not match `package.json`
   (`scripts/deploy.mjs:92-109`). The "MULTIPLE installations found" check is
   the one that catches the original bug class.
5. **Prune superseded installers** from `release/`, since an old installer is
   the thing most likely to get double-clicked by mistake
   (`scripts/deploy.mjs:111-124`).
6. **Relaunch** detached and wait 3 s (`scripts/deploy.mjs:126-132`).

`npm run deploy` never touches the stats build: it packages with the
`package.json` config and looks only in `release/` (`README.md:294`).

## 7. The release path: the stats build, everyone else

The stats build is not installed by a script; it is published to R2 and picked
up either by a download or by the updater in an already-installed copy.

```
app repo                          site repo                       R2 bucket
--------                          ---------                       ---------
npm run package:stats   ------>   npm run release      ------>    ClaudeStatsWall-Setup.exe
  release-stats/                    reads the app's                release.json
    ClaudeStatsWall-Setup-X.Y.Z.exe package.json version           updates/latest.yml
    ...exe.blockmap                 finds the matching             updates/...exe
    latest.yml                      installer                      updates/...exe.blockmap
```

`publish-release.mjs` reads the version from **the app's** `package.json` and
derives the installer path from it, so the number on the site can never be typed
in by hand and be wrong
(`../claude-stats-wall-site/scripts/publish-release.mjs:33-37`). If the
installer is missing it tells you to run `npm run package:stats`
(`:41-48`). Full detail in [download-site.md](download-site.md).

## 8. The release checklist

Ordered. Steps 1 to 4 happen in the app repo, 5 to 7 in
`../claude-stats-wall-site`.

1. **Bump `version` in `package.json`.** Everything downstream reads it:
   `scripts/deploy.mjs:31-37` and
   `../claude-stats-wall-site/scripts/publish-release.mjs:33-37`. Nothing else
   needs editing for a version change.
2. **`npm run typecheck`.** esbuild does not type check, so this is the only
   thing that will catch a type error before it becomes a runtime failure in a
   packaged build.
3. **`npm test`.** Four suites, all offline. Add `npm run test:e2e` when
   anything under `src/main/projection/` or `src/shared/` changed; it needs
   network and drives the deployed relay.
4. **`npm run package:stats`.** Confirm all three artefacts exist in
   `release-stats/`: `ClaudeStatsWall-Setup-<version>.exe`, the matching
   `.blockmap`, and `latest.yml`. `latest.yml` must name that exact exe, because
   it also carries its sha512 and a mismatch makes every installed copy fail its
   update with a checksum error
   (`../claude-stats-wall-site/scripts/publish-release.mjs:81-90`).
5. **`cd ../claude-stats-wall-site && npm run release`.** Uploads the installer,
   then the update feed, then the manifest, in that order, and verifies both the
   manifest and `latest.yml` afterwards. Order is the safety property: at no
   point does anything advertise a version that is not fully downloadable
   (`../claude-stats-wall-site/scripts/publish-release.mjs:6-13`, `:81-90`).
6. **`npm run deploy` in the site repo only if `public/` changed.** Publishing a
   release does not redeploy the Worker, and it does not need to: the page reads
   the version at runtime from `/api/release`
   (`../claude-stats-wall-site/public/app.js:10-30`). The release script says so
   on its last line (`:175`).
7. **Verify from outside.** `curl` both endpoints and check they agree:

   ```sh
   curl -s https://claude-stats-wall.gustavpjvr.workers.dev/api/release
   curl -s https://claude-stats-wall.gustavpjvr.workers.dev/updates/latest.yml
   ```

   An installed copy picks the new version up within about a minute
   (`src/main/updater.ts:48`).
8. **`npm run deploy` in the app repo**, separately, to move Gustav's own full
   build to the new version. Independent of everything above, and the only way
   that install ever changes.

## Related

- [auto-update.md](auto-update.md) for what an installed copy does with the feed
  produced in step 5.
- [download-site.md](download-site.md) for the Worker, the bucket layout and the
  publish script in detail.
- [editions.md](editions.md) for the runtime differences between the two builds.
- [testing.md](testing.md) for what each suite actually guards.
