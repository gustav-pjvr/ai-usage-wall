# Projection: roles, pairing, liveness, revocation

**Summary.** Projection puts one machine's Claude Code dashboard on another
machine's screen through a relay that forwards ciphertext it cannot read. This
file covers the two roles, the consent dialog and what it claims, the pairing
flow end to end, the socket lifecycle and reconnection, the liveness state
machine and which clock decides it, the send cadence (a 10 second floor and a
30 second beat), revocation, and what the tray shows in each state. The key
schedule is in `projection-crypto.md`; exactly what crosses the network is in
`privacy-wire.md`. Every claim carries a file and line. Where something was
inferred from reading rather than observed running, it says so.

Paths are relative to the app repo. Paths prefixed `relay/` are in the
`claude-stats-relay` repo.

## Roles

| Role | Class | What it does | Where |
|---|---|---|---|
| Source | `SourceProjector` | Reads its own `~/.claude` as usual, encrypts a snapshot per paired screen, sends it via the relay | `src/main/projection/source.ts` |
| Screen | `ScreenReceiver` | Shows a paired source's dashboard. Does not index its own transcripts while paired | `src/main/projection/screen.ts`, `src/main/index.ts` |

A machine is one or the other or off, decided by the presence and contents of
`projection.json` in `userData` (`src/main/projection/store.ts`,
`src/main/projection/index.ts`). Both editions of the app have the feature.

### Off means no network object is constructed

`startProjection()` returns before anything is built when there is no
`projection.json`. `RelaySocket` is constructed only inside `SourceProjector`
and `ScreenReceiver`, which are constructed only from `activate()`.
`relay-socket.ts` states that nothing else in the app opens a network
connection, and this can be checked by grepping for `RelaySocket` and
`new WebSocket`. The tray's first line in the off state is `Off (no network)`.

## The consent gate

`consent()` in `index.ts` shows a synchronous dialog once, before a role is
written to disk. It is bypassed by the e2e test on purpose
(`test/projection-e2e.cjs`), which drives the classes underneath it.

**Source consent**, with `host` being the relay host computed by `relayHost()`:

> `<PRODUCT_NAME>` will connect to `<host>` and send this machine's dashboard,
> encrypted, to screens you pair with a code.
>
> Sent: token totals, daily and hourly activity, model names, session times,
> project folder names, Claude Code version.
>
> Never sent: file paths, your Windows username, prompts, or any transcript text.
>
> `<host>` forwards ciphertext it cannot read, keeps no message content, and
> has request logging turned off. Nothing is sent until you pair a screen, and
> you can stop from the tray at any time.

**Screen consent**:

> `<PRODUCT_NAME>` will connect to `<host>` and display a paired machine's dashboard.
>
> While this machine is a screen it does not read its own Claude Code transcripts.
>
> You can unpair from the tray at any time.

How each sentence measures against the code:

- "connect to `<host>`": true. `ARCHITECTURE.md` still lists "the consent
  dialog does not name the relay host" as a known gap; that gap is closed and
  the architecture note is stale.
- "Sent: ...": matches `toWire()` (`src/shared/projection-wire.ts`) but is not
  the complete list. Also sent, sealed: prompt counts by day, a transcript file
  count, the trailing throughput series, the all time peak token rate, and the
  source label, which is the Windows computer name.
- "Never sent: ...": true for `toWire()` output, with the qualification that
  the username guard is a mask on label segments equal to the home directory
  name, not a general scrub (see `privacy-wire.md`).
- "forwards ciphertext it cannot read, keeps no message content": true of the
  relay code (`relay/src/space.js`, no `JSON.parse` of `ct`; nothing stores a
  frame). "has request logging turned off": true of the config
  (`relay/wrangler.jsonc`). Whether the deployed Worker matches that config was
  not verified while writing this; the relay README asserts it.
- "Nothing is sent until you pair a screen": true of **dashboard data**, and
  structurally so: `sendTo()` returns when there is no key record and `flush()`
  iterates an empty list. It is not true of **connection traffic**. The moment a
  machine becomes a source it authenticates to the relay with its space id and
  source secret and, once you ask for a code, publishes an offer carrying a
  lookup digest and an X25519 public key. `ARCHITECTURE.md` draws the same
  distinction.
- Screen: "does not read its own Claude Code transcripts": true.
  `src/main/index.ts` skips `refreshUsage` and the watcher when `isScreen()`.
  The cached `usage-index.json` is still loaded, but `usageForRenderer()`
  returns projected data, not it.

## Pairing, end to end

Numbered as it happens. Cryptographic detail is in `projection-crypto.md`.

1. **Source turns on.** Tray: `Project this machine to another screen...`.
   Consent, then `enableSource(os.hostname())` writes a `SourceState` with a
   fresh 26 character space id, a fresh 32 byte secret, no screens, label =
   hostname truncated to 40 chars, `shareProjectNames: true`. `activate()`
   starts the socket. The pair window opens in source mode.
2. **Source authenticates.** First WebSocket message is `{t:'auth', secret}`.
   The relay hashes the secret; on a fresh space the first secret to arrive
   claims it (trust on first use); a later different secret is closed with
   4001. The relay replies `ready` with its list of known screens and who is
   online; the source replays any revocations queued while offline.
3. **Source shows a code.** `Show a pairing code` in the pair window calls
   `beginPairing()`: generate 12 characters, run scrypt once, make an X25519
   key pair, set expiry at now + 10 minutes, and send
   `{t:'offer', lookup, pub, exp, spaceId}`. The relay stores the offer in the
   space, caps `exp` at 10 minutes regardless of what the source said, and
   registers `lookup -> spaceId` in the global directory. The window shows
   `XXXX-XXXX-XXXX` with a countdown.
4. **Screen turns on.** Tray on the other machine: `Show another machine
   here...`. Consent only; nothing is written yet. The pair window opens in
   screen mode with a text input.
5. **Screen redeems.** `redeemCode()`: normalise what was typed (lowercase,
   spaces, I/L as 1, O as 0), run scrypt once, derive the lookup, make an
   X25519 pair, and POST `{lookup, pub}` to `/v1/pair/redeem`. This is the only
   HTTP request in the feature. The Worker checks the formats before touching
   any Durable Object and forwards to the directory with the client IP. The
   directory applies its rate limits, deletes the pending lookup so it cannot
   be redeemed twice, and asks the space. The space checks the offer matches
   and has not expired, enforces at most 8 screens, deletes the offer, mints a
   16 character screen id and a 32 byte token, stores only the token's hash,
   tells the source `{t:'paired', screenId, screenPub}` and returns
   `{spaceId, screenId, token, sourcePub}` to the screen. Failure messages
   shown verbatim: 404 no pairing waiting, 410 expired, 429 too many attempts.
6. **Screen derives its key and connects.** `deriveScreenKey()` with its own
   private key, `sourcePub`, the stretched code and the lookup. A `ScreenState`
   is written and activated. The window says `Code accepted. Waiting for the
   source to confirm...`, deliberately not "paired", because redemption proves
   the relay accepted the code, not that the key is right.
7. **Source records the screen, unconfirmed.** On `paired`, if a pending offer
   exists and has not expired, the source derives the same key and stores
   `{screenId, key, label: "Screen N", confirmed: false}`. No hello is sent
   yet: the screen's socket does not exist and the relay stores nothing.
8. **Screen authenticates.** `{t:'auth', screenId, token}`. The relay compares
   the token hash in constant time, replaces any older socket for the same
   screen id, replies `ready` with `sourceOnline`, and tells the source
   `screen-online`.
9. **Hello.** On `screen-online` the source sends a sealed
   `{t:'hello', label}` to an unconfirmed screen and nothing else: `pushNow()`
   refuses unconfirmed screens, as do `flush()` and `sendBeat()`. The comment
   in `source.ts` records that before this gate the whole dashboard went out
   regardless.
10. **Hello-ack.** The screen opens the hello, which is the first proof that
    both sides hold the same key, saves the source label, and replies with a
    sealed `{t:'hello-ack', label: hostname}` over the `up` channel. The
    screen's `lastAuthAt` is set, so it is now LIVE.
11. **Confirmed.** The source opens the ack, marks the screen confirmed, adopts
    the screen's label, raises the `Screen paired` notice and pushes the first
    frame immediately. Anything it cannot open is ignored and logged.

The e2e test walks steps 2 to 11 against the deployed relay and asserts each
one.

## Socket lifecycle and reconnection

One class for both roles, `RelaySocket` (`src/main/projection/relay-socket.ts`).

- URL: `wss://<relay>/v1/space/<spaceId>/source` or `/screen`. `https://` is
  rewritten to `wss://`; `normalise()` refuses any stored relay URL that is not
  `https://`, so a downgrade to plaintext cannot be configured.
- Authentication is the first message, not a header or a URL parameter. The
  relay closes a socket that has not authenticated within 5 seconds, via a
  Durable Object alarm because timers do not survive hibernation.
- Inbound messages over 512 KB, non-string, or not JSON objects are dropped. A
  handler exception is logged and does not close the socket.
- Backoff on close: `base = min(60 s, 2 s x 2^min(attempt-1, 5))`, then jitter
  in [0.75, 1.25), so 2, 4, 8, 16, 32, then 60 seconds, each jittered. A
  successful open resets `attempt` to 0. `retryInSeconds()` reports the
  unjittered base.
- Fatal close codes stop retrying entirely: source 4001 (secret rejected);
  screen 4003 (revoked) and 4004 (space closed). 4005 (replaced by a newer
  socket for the same identity) is not fatal for either role, so two instances
  of the same screen state would keep replacing each other with backoff.
  Inferred from reading, not tested.
- The relay uses WebSocket Hibernation; per-socket state lives in the socket
  attachment and everything else in Durable Object storage.
- On the source's `ready`, `screen-online`, `screen-offline` and `screen-left`
  the source's `online` set is updated. This set is **relay-reported presence**
  and is what the tray's "X of Y screens" counts. It is not cryptographic
  evidence of anything.

## Liveness: which clock decides

`screen.ts` states the rule and `status()` implements it. Read top to bottom,
first match wins:

| Order | Condition | Phase |
|---|---|---|
| 1 | a terminal verdict is set | `revoked`, `space-closed`, or `key-mismatch` |
| 2 | `age < 90 s` | `live` |
| 3 | socket not open, never had a frame | `connecting` |
| 3 | socket not open, had a frame | `relay-unreachable` (with `retryIn`) |
| 4 | socket open, never had a frame | `connecting` |
| 5 | `age < 5 min` | `link-lost` |
| 6 | otherwise | `offline` |

`age` is `Date.now() - lastAuthAt` **on the screen's own clock**. `lastAuthAt`
is set only after a message was decrypted and authenticated, its sequence was
strictly greater than the last accepted, and its body had a string `t`. Beats,
hellos and frames all count. Thresholds: `LIVE_MS = 90_000` and
`OFFLINE_MS = 5 * 60_000`.

What does **not** decide liveness, by construction:

- The relay's `source-online` / `source-offline` / `ready` messages. They only
  trigger a status republish.
- The socket being open.
- `sentAt` inside the sealed envelope or inside the wire payload. Neither is
  read for liveness, so the two machines' clocks never need to agree.
- A replayed or out-of-order frame: it is discarded before `lastAuthAt` is
  touched, and the e2e test asserts that a rejected replay does not refresh
  liveness.

A 15 second timer republishes status so the age text keeps moving without any
network activity. Ten consecutive decryption failures set the terminal
`key-mismatch`; one later success clears it.

On restart the cached last frame is shown immediately but `lastAuthAt` stays 0,
so it is never shown as live, which the e2e test asserts.

Two consequences of "the screen's clock decides", read from the code:

- The sequence number, by contrast, comes from the **source's** clock:
  `seq = max(seq + 1, Date.now())`. If the source's clock is set back further
  than the time elapsed since the last frame the screen accepted, every new
  frame has a lower `seq` and is discarded until the clock catches up, and the
  screen decays to `link-lost` then `offline` while the source is alive. Not
  tested.
- A screen holding the wrong key receives only one hello per connection, so
  `badFrames` reaches 10 only after 10 reconnects in one process lifetime.
  Until then it sits at `connecting` rather than `key-mismatch`. Not tested.

## Send cadence: the 10 second floor and the 30 second beat

- **Floor.** `WIRE_MIN_INTERVAL_MS = 10_000`. `offer()` is called from
  `pushUsage()` on every local index refresh, builds the wire frame, sets a
  dirty flag and schedules a flush for `max(0, 10 s - since last send)`. It
  returns synchronously so a relay problem cannot slow the local dashboard. The
  local dashboard keeps its own 4 second coalescing. This is push on change,
  not a timer: the index only refreshes when a transcript file changes, so a
  machine with Claude Code closed sends no frames.
- **Beat.** `BEAT_MS = 30_000`. Every 30 seconds, if any screen is online and
  nothing has been sent in the last 30 seconds, a sealed `{t:'beat'}` goes to
  each online confirmed screen. The reason is recorded in `source.ts`: without
  it, silence is ambiguous between an idle source and a dead one, and the
  screen would have to either lie or nag. Two missed beats is the 90 second
  liveness threshold.
- **Unthrottled sends.** A full frame goes out the moment a confirmed screen
  connects and the moment a screen becomes confirmed, so a screen joining an
  idle source does not wait for the next edit. Toggling `Send project folder
  names` forces the next frame through.
- **Content hash short-circuit.** `flush()` skips the send when a hash of the
  JSON (length plus first and last 256 characters) equals the last one. Read
  carefully, this cannot work as its comment says: the wire payload's second
  field is `sentAt`, stamped with `Date.now()` on every `toWire()` call, and it
  sits inside the first 256 characters, so the hash differs on every call. The
  practical effect is that every index refresh that reaches `flush()` sends a
  frame, floored at 10 seconds. Inferred from reading, not executed. This is a
  real defect: the optimisation is dead code that reads as if it works.

**Why a screen decays correctly while an idle source used to freeze.** The
history is recorded in `src/renderer/stats.ts`. The recent volume panel sums the
tokens in a trailing ten minute window, so it should fall to zero on its own once
activity stops. The local dashboard only repainted when a usage push arrived,
so a source with Claude Code closed sat showing its last computed velocity
indefinitely as if current. The projected screen did not have this problem:
every 30 second beat is an accepted message, which calls `persist()` and
`publish()`, the status change reaches `onStatus` in `src/main/index.ts`, and
that handler calls `pushUsage()` unconditionally, which repaints the wall.
Gustav caught it by comparing the two machines side by side: the screen was
right and the source was wrong. The source side was fixed by repainting
time-windowed values on a 20 second clock; see `derived-metrics.md`.

A second, related freeze is recorded in `src/main/index.ts`: the post-status
push was once gated on `isScreen()`, which is false by the time an unpaired
screen publishes `off`, so a former screen kept showing `LIVE from <source>` at
full brightness forever.

## Messages

Once a pairing is confirmed, both machines can send each other text on the same
sealed channel, as a `{t:'chat', msg}` body in either direction. It is reached
from the tray under Projection, in a window of its own rather than on the
pairing panel, because the pairing panel is asymmetric and the receiving machine
never opens it. Full detail in [messaging.md](messaging.md).

Two consequences for this document:

- The `up` channel now carries frequent traffic, where it previously carried one
  hello-ack per connection. It gained a persisted per-screen replay boundary as
  a result; see [projection-crypto.md](projection-crypto.md).
- The tray's Projection submenu gains a `Messages...` entry, carrying an unread
  count, whenever there is a peer to message.

## Revocation, unpairing, stopping

**Source removes a screen** (`Remove this screen` in the tray, or `Remove` in
the pair window). `revoke()`:

1. Deletes the screen record, and with it the key, from local state first. This
   is the actual revocation: with no key, nothing further can be encrypted for
   that screen whatever the relay does.
2. Sends `{t:'revoke', screenId}`. If the socket is not open the id is queued
   in `pendingRevocations` and replayed on the next `ready`.
3. Saves and republishes.

The relay deletes its record and closes the screen's socket with 4003; a
revoked screen cannot reconnect. The screen treats 4003 as terminal, deletes
`projection.json` and `projection-last.json`, and raises `Removed by the
source`. Asserted end to end in `projection-e2e.cjs`.

What revocation does **not** do: a screen that is offline when revoked keeps
its key and cached last frame on disk (DPAPI-encrypted where available) until
it next connects and receives 4003. The key is useless for new frames but still
opens any ciphertext for that screen captured earlier; there is no per-frame
forward secrecy (see `projection-crypto.md`).

**Screen unpairs itself** (`Unpair from this source`). `unpairScreen()` sends
`{t:'leave'}`, stops, deletes both files. The relay deletes the record and
tells the source `screen-left`; the source deletes its key for that screen and
raises `Screen unpaired`.

**Source stops and forgets everything** (`Stop projecting and forget all
screens`). `disableProjection(true)` sends `{t:'destroy'}`, stops, and deletes
the local file. The relay closes every screen with 4004 and wipes the space's
storage; screens treat 4004 as terminal and delete their files. Read from the
code: `destroy()` does not check the return of `send()`, so if the socket is
not open at that moment the relay is never told, the local secret is gone, and
the space's records remain at the relay with no source able to reach them.
Screens would then show `<label> is offline`. Not tested.

## What the tray shows

The first line of the Projection submenu is `projectionLabel()`, rebuilt every
time the menu opens.

| State | First line | Items below it |
|---|---|---|
| Off | `Off (no network)` | `Project this machine to another screen...`, `Show another machine here...` |
| Source, socket not open | `Projecting: relay unreachable, retrying in Ns` | as below |
| Source, no screens | `Projecting: no screens paired yet` | `Show a pairing code...`, `No screens paired yet`, `Send project folder names` checkbox, `Stop projecting and forget all screens` |
| Source, screens | `Projecting to X of Y screen(s)` | one item per screen: `<label>  (connected or offline)` plus `(unconfirmed)` while unproven, each with `Remove this screen` |
| Screen, live | `Showing <label> (live)` | `Messages...`, `Unpair from this source` |
| Screen, link lost (90 s to 5 min) | `Showing <label> (link lost)` | same |
| Screen, offline (over 5 min) | `<label> is offline` | same |
| Screen, relay unreachable | `Relay unreachable, retrying` | same |
| Screen, revoked | `Removed by the source` | same |
| Screen, space closed | `The source stopped projecting` | same |
| Screen, key mismatch | `Cannot decrypt: pair again` | same |
| Screen, connecting | `Connecting...` | same |

`<label>` is the source's hostname as received in the sealed hello, or `the
source machine` before one arrives. Balloon notices come from `notify`:
`Screen paired`, `Screen unpaired`, `Removed by the source`, `Projection
stopped`. The pair window in screen mode shows the raw phase string, with
`Live` substituted for `live`.

One label is misleading, read from the code: when the source's secret is
rejected (close 4001) the socket stops for good, but the source's first line
still says `relay unreachable, retrying in 2s` because `projectionLabel()` only
checks `phase !== 'open'` and `retryInSeconds()` returns the base for attempt 0.
Not tested.
