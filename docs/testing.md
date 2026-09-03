# Testing

**Last updated:** 2026-09-03
**Code snapshot:** commit `a696f5d`. Counts below were produced by running the
suites on that date.
**Primary sources:** `test/run.mjs`, `test/projection.test.mjs`,
`test/projection-crypto.test.mjs`, `test/stats-projection.test.mjs`,
`test/projection-e2e.cjs`, `package.json`

## Summary

Five suites, no test framework. Four of them run in isolation and are wired into
`npm test`; the fifth drives the real projection classes against the **deployed
Cloudflare relay** and is run separately. Each suite bundles the TypeScript it
needs with esbuild into a temp directory, requires the result, and asserts with a
six-line `ok()` helper. That is affordable because `src/shared/` deliberately
imports nothing from Electron.

The recurring hazard in this project is not flaky tests. It is **tests that assert
a proxy for the thing rather than the thing**: a property the code just set, one
end of a relationship, a placement that was mistaken for a rendering. It has
happened at least four times, it has never been caught by the check that was
supposed to catch it, and every time it was found by a person looking at a screen.
The last section of this document is about that pattern, because it is the most
useful thing here.

---

## How to run

```
npm test              # the four isolated suites
npm run typecheck     # tsc --noEmit across src/**/*.ts and build.mjs
npm run test:e2e      # electron test/projection-e2e.cjs, hits the DEPLOYED relay
```

**Measured on 2026-09-03**, `npm test`:

| Suite | Checks | Result |
|---|---|---|
| `test/run.mjs` | 45 | 0 failed |
| `test/projection.test.mjs` | 34 | 0 failed |
| `test/projection-crypto.test.mjs` | 37 | 0 failed |
| `test/stats-projection.test.mjs` | 23 | 0 failed |
| **total** | **139** | |

Two practical notes:

- `package.json:15` chains the four with `&&` and every suite ends in
  `process.exit(fail ? 1 : 0)`, so **the first failing suite stops the rest**. A
  red run tells you nothing about the suites after the one that failed.
- `README.md:31` still says "42 checks on layout, colour and schema". That is
  stale in two ways: `run.mjs` alone reports 45, and `npm test` now runs four
  suites. Recorded rather than fixed; this task changed no source.

`npm run typecheck` is worth listing beside the tests, because for most of the
main process (`win32/`, `settings.ts`, `updater.ts`, `capability.ts`, the store)
it is the **only** automated check that exists.

---

## The suites

### `test/run.mjs` (45 checks): the two pure algorithms, plus the schema

Loads `src/shared/color.ts`, `src/shared/layout.ts` and `src/shared/schema.ts`
(`run.mjs:33-35`). These carry the product's two guarantees, and both were
verified by running them rather than by reasoning about them.

- **Brand derivation.** Twelve adversarial inputs including neon yellow, pure
  white, pure black, mid grey, an invalid hex string and no colour at all, each
  asserted to clear WCAG AA at 4.5:1 for **both** body and accent text
  (`run.mjs:39-49`). Plus determinism by JSON equality, and five colourless slugs
  producing five distinct hues.
- **Layout.** Five client counts across three viewports (`run.mjs:66-84`). The
  assertion is a genuine pairwise overlap test on the produced rectangles, per
  page, plus the card count and a legibility floor of 100 px on the shortest card.
  Then determinism, then the stability guarantee: **"editing one client moves no
  other card"** compares every other card's `x,y,width` before and after
  (`run.mjs:89-95`).
- **Emphasis overrides** are asserted on the resulting **tier**, not on the score,
  and the test says so in a comment (`run.mjs:99-101`). That is the good version
  of the lesson in the last section: assert the outcome a person would see, not
  the intermediate the code happens to compute.
- **Schema.** Ten checks that validation degrades rather than drops: a minimal
  record is accepted, a record with no identity is rejected, an id is derived from
  a name, `"R45,000"` parses, out-of-range progress clamps, an unknown status still
  renders, a bad date warns but keeps the client, an invalid colour falls back,
  unknown fields survive a round trip, and `"completed"` aliases to `past`.

### `test/projection.test.mjs` (34): the leak guard

Loads `src/shared/projection-wire.ts` and `src/shared/project-label.ts`. The
header states the stakes plainly: if this file fails, something that identifies
the user is on its way to a network socket.

What makes it a good suite is **what it asserts on**. It builds an index salted
with Windows and POSIX paths, the username, a session UUID and an OS error naming
the transcript folder, calls `toWire`, then asserts against the **serialised JSON
string** (`projection.test.mjs:120-126`):

- no backslash survives, no `/home/` or `/Users/`, no `HP 865`, no `.claude`
- no session UUID, by regex
- no drive letter, by regex

That is the thing itself. It is checking the bytes that would be compressed,
encrypted and sent, not that a redaction helper was called.

It then checks that the numbers still arrive intact (labels, per-project totals,
session re-keying by index, totals equality, wire version), that opting out of
project names empties `projects` without disturbing the totals, and the property
that rule 26 exists for: **a field added to the index later is not forwarded**
(`projection.test.mjs:148-153`). Home directory masking is covered at
`163-184` and the labelling rule at `186-197`.

### `test/projection-crypto.test.mjs` (37): the security argument as failing assertions

Loads `src/shared/pairing-code.ts` and `src/main/projection/crypto.ts`, bundled
with `external: ['electron']`.

Pairing codes: 12 symbols, `I`, `L`, `O` and `U` absent from the alphabet,
formatting in fours, `I` read as `1` and `O` as `0` on input, a short code
rejected rather than padded, junk rejected.

Crypto, with the three the header calls out as load bearing:

- **a different code derives a different key**, which is what makes a guessed code
  useless even to someone already on the socket
- **a substituted key pair does not agree with the source**, which is what stops a
  malicious relay standing in the middle
- **the lookup is not a plain SHA-256 of the code**
  (`projection-crypto.test.mjs:100-110`), a regression for a real version 1
  bypass: the relay stores every lookup, so a cheap lookup would have let it test
  candidate codes at hash speed and pay scrypt only once

Then the AEAD properties, each phrased as something that must fail: the wrong key
cannot open a frame, a flipped ciphertext byte fails the tag, **editing the
sequence number fails the tag because the sequence is in the AAD**, an unknown
version byte is refused rather than guessed at, a version 1 frame is refused, a
truncated frame is rejected rather than misread. Plus compression before
encryption: today, 25,466 B of JSON became a 6,932 B frame.

One assertion is machine dependent: `stretchMs > 10`
(`projection-crypto.test.mjs:111`), measured at 94 ms today. It asserts the
**cost**, which is the actual security property, so a faster future machine could
fail it while nothing is wrong. That is a real weakness and still the right
trade: asserting the scrypt parameter constant instead would be a proxy for the
property, which is precisely the failure mode this document is about.

### `test/stats-projection.test.mjs` (23): the wording of the status pill

Loads `src/renderer/stats.ts` and uses two pure exports, `projectionPill` and
`cleanLabel`. No DOM.

It exists because of rule 28: a screen printing `LIVE` over numbers that stopped
arriving twenty minutes ago is the one failure that makes the whole projection
feature untrustworthy. Phase to wording is therefore a pure function and is kept
that way so it can be checked exhaustively: every source phase, every screen
phase, singular and plural screen counts, and the tone for each.

The sharpest assertion in the suite is at `stats-projection.test.mjs:56-57`: the
same status is rendered with `now` advanced by seven seconds and the countdown is
expected to read `retrying in 5s`. That catches a countdown frozen at whatever the
last payload happened to carry, which is the same class of bug as the velocity
freeze in `docs/derived-metrics.md`. An elapsed countdown is checked to say
`retrying now` rather than a negative number.

`cleanLabel` is covered for bidi overrides, zero-width characters, control
characters, an all-invisible label falling back to a name, and ordinary accented
text surviving. It matters because the label is typed on a different machine and
is rendered inside a sentence.

### `test/projection-e2e.cjs`: against live deployed infrastructure

**This is the one suite that is not isolated.** Run with `npm run test:e2e`
(`electron test/projection-e2e.cjs`). It is deliberately not in `npm test`.

It talks to `https://claude-stats-relay.gustavpjvr.workers.dev`
(`projection-e2e.cjs:80`), a real Cloudflare Worker maintained in a separate repo.
It constructs the real `SourceProjector` and `ScreenReceiver` rather than
reimplementing the protocol (`projection-e2e.cjs:1-14`), opens real WebSockets,
and POSTs a real redemption to `/v1/pair/redeem` (`projection-e2e.cjs:137`).

What that buys, and nothing else can: the socket lifecycle, the pairing handshake
as the app actually performs it, framing, the staleness state machine, and the
replay boundary surviving a screen restart (`projection-e2e.cjs:176-216`). It also
re-runs the leak guard on the real path (`169-174`), which is the right kind of
duplication: the unit test proves `toWire` produces clean bytes, the e2e proves
that what arrived in a second process is clean.

Consequences of being live, all of which a reader should know before running it:

- It **creates a real space and a real pairing** on shared infrastructure and
  revokes the screen at the end. It consumes redemption rate-limit budget; the
  relay allows 5 failed redemptions per IP and 20 globally per minute in a 10
  minute window.
- It can fail for reasons that are not this code's: relay down, deploy in flight,
  no network. **Read a red e2e as "unknown" until the relay is confirmed up.**
- It points `userData` at a fresh temp directory before anything loads
  (`projection-e2e.cjs:21-23`), so it cannot touch a real install's
  `projection.json`.
- It reaches into `screen2.lastSeq` and `screen2.handle`, which are `private` in
  TypeScript and ordinary properties in the bundle. That is deliberate and is
  explained in the file: it is what lets the test inject a frame only a malicious
  relay would send. The cost is that a rename breaks the test in a way `tsc` will
  not catch.
- Timing is handled by an `until()` poller with a 20 s ceiling rather than fixed
  sleeps (`projection-e2e.cjs:39-47`), with three short fixed waits remaining.

**It was not run while writing this document**, so the counts in the table above
carry no e2e figure.

---

## What is not guarded

Worth stating explicitly, because the suites above read as more coverage than they
are. Nothing in `test/` touches:

- **`src/main/data/usage.ts`.** The indexer: offsets, the shrink rebuild, pruning,
  the cache round trip, BOM stripping. The double-count behaviour reported in
  `docs/usage-indexing.md` was found with an ad hoc harness written for that
  document, precisely because there was no suite to add it to.
- **`derive()` and every derived metric.** The decay curve in
  `docs/derived-metrics.md` was verified the same way, by an ad hoc harness, both
  when the bug was fixed (commit `666bbd7`) and when this document reproduced it.
  There is no regression test, so the fix is protected by a comment.
- **`ActivityCanvas`**, and the renderer DOM generally.
- **`src/main/data/store.ts`** and **`obsidian.ts`**. The schema is tested; the
  loader that isolates a broken file, strips BOMs and merges the vault is not.
- **`src/main/win32/`**, `updater.ts`, `settings.ts`, `capability.ts`. These are
  verified by running the app and reading real Win32 state, which is documented in
  `ARCHITECTURE.md` rather than automated.
- **The project labelling rule as the renderer applies it.** `project-label.ts` is
  tested; `stats.ts:1016-1033` contains a second hand-written copy of the same
  rule and is not. See `docs/usage-indexing.md`.

---

## The pattern this project keeps hitting

Four times now, a check has passed while the thing a person could see was broken.
Every one was a check reading back something the code had already assumed.

### 1. Z-order was verified, and rendering was assumed

`HWND_BOTTOM` in desktop mode passed everything: correct z-order, not topmost,
visible, 21 windows above it. The wall was **completely inert**. Explorer's
`SHELLDLL_DefView`, the desktop icon host, spans the whole screen, is transparent,
and sat above us, so Windows hit-tested it first and every click and hover went to
the desktop. Gustav found it by trying to use the mode switcher.

The same family, worse: wallpaper mode confirmed its parent with `GetParent()`,
which for a `WS_POPUP` window returns the **owner**, and every Electron window is
`WS_POPUP`. It therefore answered NULL whatever the truth was. The code reported
`SetParent refused by all 15 candidate layers` while the window was in fact
parented into the last candidate it tried. Corrected with
`GetAncestor(hwnd, GA_PARENT)`, the mode still painted nothing, and it was removed.

**What replaced the assertion:**

- `inputReachesWall()` (`desktop-layer.ts:318-335`) calls `WindowFromPoint` at a
  point inside the wall's own bounds, walks up with `GA_ROOT` to the top-level
  owner, and reports **which window actually owns that pixel**. After the fix, 4
  of 4 sampled points returned the wall, where all 4 had previously returned
  `explorer`.
- `verifyLayer()` (`desktop-layer.ts:248`) was narrowed to conditions that are
  **necessary** for the wall to be on screen, and its own comment forbids the log
  line from ever saying "verified rendering". `index.ts:830` prints "verified:
  top-level, visible, placed".

The general form: **a necessary condition can only reject. It can never confirm.**
A check that cannot fail for the real problem is not evidence about the real
problem.

### 2. The wall was measured when the desktop was the thing that moved

Report: "It closes when a windows user clicks the bottom right stripe." Through
both `Shell.MinimizeAll()` and `Shell.ToggleDesktop()` the wall measured visible,
non-iconic, same rect, same z-order neighbour. That was read as "cannot
reproduce", and it was wrong. **The wall does not move.** The desktop moves, up
and over it, and in desktop mode the wall sits directly above the desktop host, so
it ends up behind the wallpaper. Nothing fires when that happens.

**What replaced the assertion:** `assessPlacement()`
(`desktop-watch.ts:88-113`) measures the **relationship** rather than either end.
It walks down the z-order from the wall until it reaches the window that hosts
`SHELLDLL_DefView`, and reports `desktopAbove` plus the visible non-shell windows
found in between. Measured once the right thing was being watched:

```
baseline      desktopAbove=False  between=0
show desktop  desktopAbove=True   between=1
restored      desktopAbove=False  between=0
```

and then A/B across versions on one machine: 0.8.2 showed `desktopAbove=True`
250 ms after Show Desktop, 0.8.3 showed `False`, having already healed it.

The host is found dynamically rather than assumed to be `Progman`
(`desktop-watch.ts:69-81`), which is not defensive coding: on this machine a
`WorkerW` hosts the icon layer, so anchoring to `Progman` would have been wrong
here.

The general form: **measure the relationship, not one of its ends.** And when a
report cannot be reproduced, suspect the instrument before the reporter.

### 3. An element's `hidden` property was read back while it was still on screen

Gustav saw an Install pill on the wall of a build that contains no updater at all.
There was no update. The pill was there anyway.

`el.hidden = true` set the property and changed nothing on screen. `.update-pill`
and `.toast` both declare `display: flex`, and **an author rule beats the user
agent's `[hidden] { display: none }` regardless of specificity**, so the attribute
was inert. Neither stylesheet had a `[hidden]` rule of its own.

The test written for the toast read `t.hidden`, the property, and reported `true`
while the element was visible. It asserted the thing its author had already
assumed.

**What replaced the assertion:** read the **computed** `display` and check the
element has a layout box:

```
toast, no update      display:none  boxed:false
toast, downloading    display:flex  boxed:true
toast, idle again     display:none  boxed:false
pill,  no update      display:none  boxed:false
pill,  update ready   display:flex  boxed:true
```

Two things about this one are worth keeping straight.

**Both halves changed.** The assertion moved to computed style, and the CSS gained
the rule it was missing: `toast.css:110` and `wall.css:1149` now declare
`[hidden] { display: none !important }` globally, and two per-selector restatements
exist where a specific author rule was the culprit, `stats.css:965`
(`.status-proj[hidden]`) and `shell.css:105` (`#mode-switch[hidden]`). That last
one is a fourth instance of the same bug, caught separately: an ID selector with
`display: flex` left a 3 px sliver of the mode switcher on screen in the
stats-only build.

**Neither the harness nor its replacement is in `test/`.** `git log --all` over
`test/` lists only the five files documented above, so the evidence for those five
lines lives in commit `06ce4af`'s message, not in anything that runs again. The
standing guard against this regression is a CSS rule and a comment.

The general form: **read what the machine computes, not what your code set.**

---

## What a good assertion looks like here

Drawn from the ones in this repository that are actually load bearing:

| Instead of | Assert |
|---|---|
| a redaction function was called | the serialised bytes contain no path, username or UUID (`projection.test.mjs:120-126`) |
| the layout score changed | the resulting tier changed (`run.mjs:99-118`) |
| `el.hidden === true` | computed `display` plus the presence of a layout box |
| the wall's own properties | the wall's position relative to the desktop host (`desktop-watch.ts:88`) |
| the countdown in the last payload | the countdown recomputed with the clock advanced (`stats-projection.test.mjs:56`) |
| the relay says the source is online | a frame this machine decrypted itself (rule 28) |
| the packer returned successfully | no two rectangles overlap (`run.mjs:71-82`) |

The common thread is that every right-hand entry is something a user could in
principle observe, and every left-hand entry is something the code told itself.

## Related

- `docs/usage-indexing.md`, including a measured double-count in an area with no
  test coverage.
- `docs/derived-metrics.md`, including the freeze that was found by comparing two
  machines rather than by any assertion.
- `ARCHITECTURE.md`, "Desktop behaviour" and "Do not break", which is where the
  rules these tests defend are written down.
