# Privacy on the wire: what crosses, what never does, what the relay can see

**Summary.** Three layers, listed separately because they have different
audiences: what the relay sees in the clear (routing and bearer credentials),
what is sealed and reaches the paired screen (the dashboard, with paths,
usernames and session ids removed), and what never leaves the source at all.
`toWire()` is the only serialiser and builds the frame by naming each field, so
a field added to the local index later is absent from the wire until someone
adds it on purpose. Leak-guard tests assert on the output; project folder names
have their own opt-out; the home directory name is masked because the Windows
username once became a project label in real data. The relay can see metadata,
timing and sizes, and Workers Logs are off on the deployed relay so that
metadata is not retained for days.

Paths are relative to the app repo. Paths prefixed `relay/` are in the
`claude-stats-relay` repo.

## Layer 1: plaintext to the relay

Everything the relay receives in a form it can read. This is routing and
authentication, never dashboard content.

| Message | Fields in the clear | Relay handling |
|---|---|---|
| Source auth | `secret` (32 random bytes, base64url) | hashed, hash stored |
| Screen auth | `screenId`, `token` | token hashed and compared |
| Offer | `lookup` (22 chars derived from the stretched code), `pub` (source X25519 public key), `exp`, `spaceId` | stored until redeemed or expired |
| Cancel offer | none | deletes the offer |
| Redeem (HTTP POST) | `lookup`, `pub` (screen public key), plus the client IP | rate limited, then matched |
| Redeem reply | `spaceId`, `screenId`, `token`, `sourcePub` | returned to the screen |
| Frame envelope | `to` (screen id), `ct` (opaque) | `ct` copied into `{t:'frame', ct}` and forwarded, never parsed |
| Up envelope | `ct` (opaque); relay adds `from` | forwarded to the source |
| Revoke | `screenId` | record deleted, socket closed 4003 |
| Leave | none | record deleted, source told |
| Destroy | none | space storage wiped |

Plus what any WebSocket or HTTPS client reveals: the client IP, TLS metadata,
and whatever default headers Node's `fetch` and global `WebSocket` send. Those
headers were not inspected while writing this.

The relay also **emits** presence in the clear: `ready` (with the list of known
screen ids, `online`, and `lastSeen`), `screen-online`, `screen-offline`,
`screen-left`, `source-online`, `source-offline`, `paired` (with the screen's
public key), and `offer-expired`.

## Layer 2: sealed, reaching the paired screen

The sealed envelope is `{sentAt, body}`. `body` is one of
`{t:'hello', label}`, `{t:'beat'}`, or `{t:'frame', usage}`; the screen sends
`{t:'hello-ack', label}` back. `label` in the hello is the source's Windows
computer name; `label` in the ack is the screen's hostname. Both identify a
machine and both travel sealed only.

`usage` is a `ProjectedUsage` (`src/shared/projection-wire.ts`), built by
`toWire()`. Field by field:

| Field | What it is |
|---|---|
| `v` | wire version, currently 1 |
| `sentAt` | source wall clock at build time, display only |
| `sourceLabel` | the source's hostname |
| `builtAt` | when the local index was built |
| `totals` | eight numeric counters: input, output, cacheCreate, cacheRead, thinking, requests, webSearch, webFetch |
| `daily`, `hourly` | the same eight counters keyed by date and by date-hour |
| `models` | the same eight counters keyed by **model name** |
| `projects` | the same counters plus `lastSeen` and `display`, keyed by **label**, empty when sharing is off |
| `projectsShared` | whether the toggle was on |
| `sessions` | keyed by **array index**; start, end, requests, output, total, models |
| `recent` | trailing throughput triples of numbers |
| `prompts` | total count, counts by day, timestamp of the last one |
| `latest` | ts, model, Claude Code version, project **label** or null |
| `peak` | the source's all time peak tokens per minute, and when it was reached |
| `fileCount` | how many transcript files exist, as a number |
| `lastScanMs` | scan duration |
| `indexing` | whether the source is still cold-indexing |
| `unavailable` | boolean |
| `unavailableReason` | the fixed string `the source cannot read its transcripts`, never the OS error |

Sealed does not mean anonymous. Model names, session start and end times, daily
and hourly buckets and `sentAt` all describe when and how the person works, and
a project label is a folder name someone chose. This layer is protected from
the relay and from the network, not from the screen's owner.

## Layer 3: never leaves the source

Listed in `projection-wire.ts` and enforced by omission in `toWire()`:

- Filesystem paths. `projects` in the local index is keyed by absolute path;
  the wire is keyed by label. `latest.cwd` becomes a label or null.
  `sessions[].cwd` has no reader on the wire.
- The Windows username, which is a path segment of every path above, and is
  additionally masked as a label (below).
- Session ids. `sessions` are re-keyed by index; `latest.sessionId` is dropped.
- The transcript file list (`files`, keyed by path): only its count crosses.
- Prompt file bookkeeping (`offset`, `size`).
- OS error strings, which name the path that failed.
- Prompt text and transcript text: the local index does not contain them, so
  there is nothing for `toWire()` to omit. This is a property of the indexer,
  not of the wire code.

`fromWire()` re-inserts `sessionId: null` and `cwd: null`, which is the
receiving side's proof that neither travelled.

## Why `toWire()` names each field, and why the failure direction matters

`toWire()` never spreads the local index. `totals()` copies eight named
numbers; every other field is read by name and type-checked. The rule is stated
in the file's own header comment: a field added to `UsageIndex` later is absent
from the wire until someone adds it here on purpose.

The reason is which way it fails. A serialiser that spreads and deletes fails
**open**: a new field leaks silently to a machine in another building, and
nobody sees it because everything still renders. A serialiser that names fields
fails **closed**: a new field is missing on the screen, which is visible on the
first side-by-side comparison. The test in `test/projection.test.mjs` adds
`someFutureField` containing a Windows path to the index and asserts it does
not appear.

The rule has already had to be honoured deliberately once. The local index
gained a `peak` velocity record (`src/main/data/peak.ts`,
`src/shared/velocity.ts`), and because `toWire()` names its fields the peak did
NOT cross the wire on its own. It had to be added to `ProjectedUsage` and to
both `toWire()` and `fromWire()` explicitly, with a note saying why it is safe:
two numbers and a timestamp, nothing about who or where. That is the intended
workflow. The alternative design would have shipped it to another machine
without anyone deciding to.

Two rules keep this checkable: `toWire()` is the only serialiser, and it is
pure with no main-process imports so the test can bundle it and assert on the
output directly.

## The leak guard tests

`test/projection.test.mjs` builds an index salted with everything that must not
travel: Windows and POSIX absolute paths, the username `Demo User`, a session
UUID, a folder called `secret-client-work`, and an OS error naming the
`.claude` folder. It then serialises with sharing on and asserts on the JSON:

- no backslash, no `/home/` or `/Users/`, no `HP 865`, no `.claude`
- no UUID by regex, no drive letter by regex
- `secret-client-work` absent, the OS reason replaced, `offset` and `size`
  gone, `latest` has no `sessionId` or `cwd`, `files` gone with `fileCount === 2`

Then with sharing off, the future-field case, the round trip through
`fromWire()` reintroducing no path, and the home-directory masking.

`test/projection-e2e.cjs` feeds the real `SourceProjector` an index with the
same kind of paths and, after a real screen decrypts a real frame from the
deployed relay, asserts no backslash, no drive letter, no `HP 865`, no
`.claude`, and that the project arrived as a label.

**What the tests do not prove.** They look for specific markers: this machine's
username, a few path shapes, a UUID pattern. They do not prove the absence of
all identifying data, and they cannot: a project folder name is itself chosen
by a person and can be a client's name, which is exactly why it has its own
switch. The e2e run also depends on the deployed relay being reachable.

## Project folder names: the opt-out

- Stored as `shareProjectNames` on the source, default **on**. The reason is in
  `store.ts`: the normal case is one person and two of their own machines.
- Tray checkbox `Send project folder names` calls `setShareProjectNames()`,
  which saves and forces the next frame through immediately.
- Effect on the wire when off: `projects` is `{}` and `projectsShared` is
  `false`; `latest.project` is `null`, and a comment records that this last
  field used to go out regardless of the toggle. Totals still arrive.
- Not retroactive beyond the next frame: a screen keeps the last frame it
  decrypted in `projection-last.json` until a newer one replaces it. A screen
  that is offline when the toggle is turned off still holds the old labels
  until it reconnects.

When on, the label is the folder's own name, with one parent segment prefixed
only when two projects share a leaf name (`src/shared/project-label.ts`).
Nothing above the parent segment ever appears. Labels are computed with the
same function the local renderer uses, so the two machines agree.

## Home directory masking, and the incident

**The incident.** The record is the comment in `source.ts`: running Claude Code
from the home folder made the home folder a project, its label was the folder's
leaf name, and on Windows the leaf of `C:\Users\<name>` is the username, so the
username went out as a project label while the consent dialog promised the
username is never sent. It was confirmed in real data, appearing at rank 65
with zero tokens.

**The fix.** The source computes `HOME_DIR_NAME = basename(os.homedir())` once
and passes it to `toWire()`. `maskHome()` splits a label on ` / ` and replaces
any segment equal to the home directory name, case-insensitively, with the
literal `home`. It is applied to every project label and to `latest.project`.
The test passes the name in a different case from the path on purpose and
asserts a home-folder project is labelled `home`, a same-named child under home
is `home / notes` while its twin elsewhere is `other / notes`,
`latest.project` is `home`, and the username appears nowhere in the frame.

**What the mask does not cover**, read from the code:

- A folder whose name merely contains the username, such as
  `Demo User backup`: the comparison is whole-segment equality.
- Any other folder name that happens to identify the person. The mask targets
  one specific leak, the home directory, not names in general.
- If `os.homedir()` throws, `HOME_DIR_NAME` is `''` and masking is silently
  disabled.
- The source's hostname, which is sent sealed as `sourceLabel` and shown on the
  screen. A comment in `projection-wire.ts` says the label is "never defaulted
  to the hostname"; that comment is wrong, `src/main/index.ts` passes
  `os.hostname()` and there is no UI to change it.

## What the relay can observe, and what it cannot

Stated from the relay's code, which is the only thing the relay's owner can be
held to.

**Can observe:**

- Which space ids and screen ids connect, when, and from which IPs.
- Whether a connection is a source or a screen (from the URL).
- The timing and size of every frame and beat. Frames go out only when the
  local index changes, floored at 10 seconds, and beats go out every 30 seconds
  when idle, so the relay can tell "Claude Code in use" from "idle" at roughly
  10 second resolution. Frame sizes are not padded, so they correlate with how
  much history the index holds.
- Both public keys and the lookup for each pairing.
- The IP of each failed redemption, for ten minutes.
- What it stores: per space `sourceSecretHash`, `createdAt`, `spaceId`, a
  short-lived `offer {lookup, pub, exp}`, and `screens {tokenHash, pairedAt,
  lastSeen}`; globally `pending {lookup -> spaceId, exp}`, `globalFails`, and
  `fails {ip -> n, until}`.

**Cannot observe:**

- Any number, name or timestamp inside a frame, a hello or an ack. It holds no
  key and never parses `ct`.
- The pairing code, or anything cheaper than scrypt that leads to it.
- Either machine's hostname; both travel sealed.
- Any frame after it has been forwarded: none is stored, not even the most
  recent.

## Observability is off on the deployed relay, and why

`relay/wrangler.jsonc` sets `"observability": { "enabled": false }`. The
comment there and the relay README give the reason: with Workers Logs on,
Cloudflare retains request logs for days, and those logs carry the URL (which
contains the space id), the client IP and the timing. Message content was never
in them, but "who talked to whom and when" is precisely the metadata a relay
describing itself as storing nothing should not be accumulating, and the
consent dialog now says the relay "has request logging turned off". The cost is
accepted: there are no request logs to debug from, and the black-box tests
against the deployed Worker are the replacement.

Two limits on that statement, so it is not overstated:

- It is a statement about the Workers Logs feature controlled by that setting.
  Whatever Cloudflare retains at the platform level (edge analytics, security
  logs, and so on) is outside the relay's code and this document.
- It was read from the config file and the README, and the config was deployed
  with `npx wrangler deploy` in the same session. The deployed Worker's
  settings were not separately queried from Cloudflare.

## Stale comments found while writing this

Recorded so they are fixed rather than repeated:

- `ARCHITECTURE.md`: version 1 lookup formula and `csw-screen-key-v1`. Code is
  version 2.
- `ARCHITECTURE.md`: says the consent dialog does not name the relay host. It
  does.
- `relay/src/index.js`: "truncated SHA-256 of a pairing code". It is an HKDF of
  the scrypt output.
- `projection-wire.ts`: "never defaulted to the hostname". It is the hostname.
- `source.ts`: the content-hash short-circuit is defeated by `sentAt` changing
  on every `toWire()` call, so it never fires. Inferred from reading, not
  executed.
