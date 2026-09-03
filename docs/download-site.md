# Download site

**Summary.** `claude-stats-wall.gustavpjvr.workers.dev` is a Cloudflare Worker
in front of an R2 bucket, not a Pages site, because Pages refuses any single
file over 25 MB and the installer is about 107 MB. The Worker owns three routes,
`/download`, `/api/release` and `/updates/*`, and hands everything else to the
static assets binding. Publishing is one command in the site repo, which uploads
the installer, then the update feed, then the manifest, and verifies both feeds
afterwards. The page corrects its own version number at runtime.

Repo: `../claude-stats-wall-site` (`github.com/gustav-pjvr/claude-stats-wall-site`).

Last verified: 2026-09-03, against app version 0.8.6.

---

## 1. Why a Worker and not Pages

Stated at the top of both the Worker and its config
(`../claude-stats-wall-site/src/index.js:1-7`,
`../claude-stats-wall-site/wrangler.jsonc:1-6`): Cloudflare Pages rejects any
single file over 25 MB, and the installer is far past that. The 0.8.6 installer
is **112,369,910 bytes**, about 107 MiB, as recorded in the app repo's
`release-stats/latest.yml`.

So the binary lives in R2 and is streamed through the Worker, while the page
itself is served from the static assets binding. That split is the whole
architectural decision; everything below follows from it.

## 2. Architecture

```
  browser ──────────────► Worker (src/index.js)
                            │
                            ├── /api/release   ──► R2: release.json + HEAD of the exe
                            ├── /updates/*     ──► R2: updates/<name>   (the update feed)
                            ├── /download      ──► R2: ClaudeStatsWall-Setup.exe
                            └── anything else  ──► ASSETS binding (./public)

  installed app ────────► /updates/latest.yml, then the .exe and .blockmap it names
```

Bindings (`../claude-stats-wall-site/wrangler.jsonc:13-27`):

| Binding | Kind | Value |
|---|---|---|
| `ASSETS` | static assets | `./public` |
| `RELEASES` | R2 bucket | `claude-stats-wall-releases` |

`observability` is **on** for this Worker
(`../claude-stats-wall-site/wrangler.jsonc:11`). That is the opposite of the
relay, which turns it off deliberately; see
[relay-operations.md](relay-operations.md) for why the two differ.

## 3. `run_worker_first`

```jsonc
"run_worker_first": ["/download", "/api/release", "/updates/*"]
```

`../claude-stats-wall-site/wrangler.jsonc:16-19`. Without it the assets binding
answers first and the Worker never sees those paths, so the download would 404
against `./public` rather than stream from R2. Any new dynamic route has to be
added here as well as to `src/index.js`, or it will silently fall through to the
static assets.

## 4. The routes

### `/api/release`

`../claude-stats-wall-site/src/index.js:65-69`, backed by `readRelease()` at
`:40-59`.

It reads `release.json` and a `HEAD` of the installer in parallel, and returns:

| Field | Source |
|---|---|
| `version` | `release.json`, or the string `unknown` if the manifest is missing or unreadable (`:53`) |
| `filename` | `release.json`, defaulting to the storage key (`:54`) |
| `size` | R2's own reported size, never the recorded one (`:55-56`) |
| `uploaded` | R2 object metadata (`:57`) |

Two deliberate behaviours: a corrupt manifest must not take the download down,
so the JSON parse failure is swallowed (`:44-51`), and a missing installer
returns `503 {"error":"no release published"}` with a 10 second cache rather
than a stale success (`:67`).

The endpoint exists so the page cannot advertise a version that is not there
(`:11-16`).

### `/updates/*`

`../claude-stats-wall-site/src/index.js:84-116`. This is the auto-update feed.
electron-updater asks for `/updates/latest.yml`, then for the installer and its
`.blockmap` by the exact names that file gives.

- **Name validation first.** `/^[A-Za-z0-9._-]{1,120}$/` plus an explicit `..`
  check (`:87`). These are flat artefact names; there is no nesting and no
  traversal. Note that a percent sign is not in that set, which is why an
  installer filename containing spaces could not be served here at all. See the
  artifactName section of [build-and-release.md](build-and-release.md).
- **Range and conditional headers are passed through to R2** (`:91-94`), so
  differential downloads work and a 304 is possible (`:106-108`).
- **206 only when the client asked** (`:109-113`).
- **Caching splits by extension** (`:103`): `latest.yml` gets
  `max-age=60`, everything else `max-age=86400`, because the binaries are
  immutable per version and the YAML is the thing that must go stale quickly.

It is kept separate from `/download` on purpose (`:80-83`): `/download` always
serves the current release under a friendly filename, `/updates/` serves
whatever electron-updater asks for by exact name. Different jobs.

### `/download`

`../claude-stats-wall-site/src/index.js:118-170`. Streams the single object
`ClaudeStatsWall-Setup.exe` (`KEY`, `:25`).

- Range headers are passed through, because 107 MB over a poor connection gets
  resumed and R2 does that work as long as the headers reach it (`:119-121`).
- Missing object gives a plain-text 503 rather than an error page (`:122-127`).
- `content-disposition` is filled from `release.json`, so the user's browser
  saves `ClaudeStatsWall-Setup-0.8.6.exe` rather than the storage key
  (`:136-146`).
- `cache-control: public, max-age=3600` (`:134`).

**The 206 bug that is worth remembering** (`:153-167`): R2 populates
`object.range` whether or not a `Range` header was sent, resolving to the whole
object when there was none. Branching on `object.range` alone therefore returned
`206 Partial Content, bytes 0-111973202/111973203` to every ordinary browser
GET. Most clients tolerate it, it is still a lie about what happened, and some
download managers behave oddly on it. The fix is to branch on
`request.headers.has('range')` first.

### Everything else

`return env.ASSETS.fetch(request)` (`:172`). The page, the stylesheet, the
screenshot, the icons.

## 5. What is in the bucket

Bucket `claude-stats-wall-releases`:

| Key | What it is | Written by |
|---|---|---|
| `ClaudeStatsWall-Setup.exe` | the current installer, under a stable key | `publish-release.mjs:70-78` |
| `release.json` | `{ version, filename, publishedAt }` | `publish-release.mjs:123-139` |
| `updates/latest.yml` | the electron-updater feed | `publish-release.mjs:99-120` |
| `updates/ClaudeStatsWall-Setup-<version>.exe` | the same binary under its versioned name | `publish-release.mjs:99-120` |
| `updates/ClaudeStatsWall-Setup-<version>.exe.blockmap` | block map for differential updates | `publish-release.mjs:99-120` |

The version lives in a small `release.json` object beside the installer rather
than in R2 custom metadata, because `wrangler r2 object put` has no flag for
custom metadata, and a publish step that cannot be run from the CLI is a publish
step that will drift (`../claude-stats-wall-site/src/index.js:18-21`).

The installer is stored twice on purpose: once under the stable key that
`/download` serves, and once under the exact versioned name `latest.yml` refers
to.

## 6. Publishing: `npm run release`

`../claude-stats-wall-site/scripts/publish-release.mjs`, one command so a build
cannot end up half-published (`:1-13`).

**Inputs.** It reads the version from the **app's** `package.json`, two
directories up, and derives the installer path from it, so the number on the
site cannot be typed in by hand and be wrong (`:26-37`). A missing installer
stops the run with the exact command to fix it (`:41-48`).

**Order, which is the safety property** (`:81-90`):

1. `ClaudeStatsWall-Setup.exe` (`:69-79`).
2. `updates/latest.yml`, the versioned `.exe`, and the `.blockmap`, each checked
   for existence before upload (`:91-121`).
3. `release.json` last (`:123-141`).

If any step fails, the site keeps advertising the previous version, which is
still downloadable, rather than a version that is not there. `latest.yml` names
the installer and carries its sha512, so it must go up together with the exact
`.exe` and `.blockmap` it describes; a mismatch makes every installed copy fail
its update with a checksum error (`:81-90`).

**Verification, twice, against storage rather than against the script's own
belief:**

- Reads `release.json` back and fails if the version does not match (`:143-153`).
  Wrangler prints a banner before the piped body, so the JSON is sliced out
  rather than parsed whole (`:144-148`).
- Reads `updates/latest.yml` back and fails unless its `version:` line matches,
  then prints which file it offers (`:161-173`). This is a genuinely different
  question from the first check: the download button and the installed copies
  read different objects.

**Shell quoting.** Wrangler is invoked through `exec` with a single quoted
command string, not `execFile` with an args array (`:56-67`). `npx` on Windows
is a `.cmd`, which Node refuses to `execFile` without a shell, and an args array
with `shell: true` concatenates rather than escapes. That is not theoretical:
the installer path contains `Demo User` and `Claude WorkSpace`, and wrangler
once received nine arguments where it expected one.

**Credentials.** The script shells out to `npx wrangler`, so it uses whatever
Cloudflare account that CLI is logged into. There is no token in the repo
(`.gitignore` excludes `node_modules/` and `.wrangler/`). Whoever can write this
bucket decides what every installed copy runs next, because the app trusts the
feed and nothing is code signed. See
[auto-update.md](auto-update.md) section 2.

## 7. Site commands

From `../claude-stats-wall-site/package.json:6-10`:

| Script | Command | When |
|---|---|---|
| `dev` | `wrangler dev` | local run of the Worker plus assets |
| `deploy` | `wrangler deploy` | only when `src/` or `public/` changed |
| `release` | `node scripts/publish-release.mjs` | every app release |

Publishing a release does **not** require a deploy. The Worker code does not
carry the version; the page reads it at runtime. The release script says so on
its final line (`:175`).

## 8. How the page fills in the version at runtime

`../claude-stats-wall-site/public/app.js:10-30`, loaded as a non-deferred script
at `public/index.html:306`.

The HTML ships with the values that were true when it was written, so the page
is correct with JavaScript off. The script then corrects them against
`/api/release`:

| Placeholder | Where | Baked-in value today |
|---|---|---|
| `[data-version-chip]` | header chip | `v0.7.1 · Windows` (`public/index.html:37`) |
| `[data-download-meta]` | three download buttons | `Latest version · .exe` (`public/index.html:61`, `:140`, `:293`) |
| `[data-version-line]` | footer | `Claude Stats Wall v0.7.1` (`public/index.html:302`) |

The replacement text is `v<version> · <size> MB · .exe`, with the size taken
from what R2 reports (`public/app.js:22-26`). Every failure path leaves the
baked-in values alone: a non-OK response, a missing version field, or a thrown
fetch (`:18-28`). A stale deploy is therefore visibly stale rather than quietly
wrong.

**Known drift, not fixed here.** `public/index.html:282-286` still describes the
update check as "ninety seconds after launch and every six hours after that",
while `:126-134` of the same file correctly says once a minute. The code is 15
seconds then every 60 seconds (`src/main/updater.ts:34`, `:48`). The version
strings baked in at `:37` and `:302` are also older than the current release,
which is harmless because `app.js` overwrites them, but they are what a reader
with JavaScript disabled sees.

## Related

- [auto-update.md](auto-update.md) for what the installed app does with
  `/updates/`.
- [build-and-release.md](build-and-release.md) for how the artefacts get built,
  and the full release checklist.
- [relay-operations.md](relay-operations.md) for the other Cloudflare Worker,
  which is deployed separately on purpose.
