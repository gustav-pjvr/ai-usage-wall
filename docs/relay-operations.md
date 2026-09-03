# Relay operations

**Summary.** The projection relay is a separate Cloudflare Worker with two
SQLite-backed Durable Object classes. It forwards encrypted frames between a
source desktop and its paired screens and can read none of them. Deploying it is
`wrangler deploy` on a free plan. Observability is off on purpose, which costs
real debuggability, so the black-box test suite against the deployed Worker is
the replacement. Redemption attempts are rate limited globally and per IP.

Repo: `../claude-stats-relay` (`github.com/gustav-pjvr/claude-stats-relay`, MIT,
public).

**The protocol lives in that repo's own README and is not repeated here.** For
what the relay can and cannot see, the pairing scheme, and the three rules the
code and tests enforce, read `../claude-stats-relay/README.md`, specifically
"What it cannot do" (`:21-36`), "What it can see" (`:38-62`) and "Pairing"
(`:64-73`). This document covers running it.

Last verified: 2026-09-03.

---

## 1. What it is, and why it is a separate Worker

A source machine reads Claude Code's local transcripts and wants to show that
dashboard on a second machine. Both are behind NAT, so they need somewhere to
meet. The relay is that somewhere and nothing more
(`../claude-stats-relay/README.md:10-19`).

It is deliberately not part of the download site's Worker
(`../claude-stats-relay/wrangler.jsonc:1-5`): different deploy cadence, and a
relay bug must never take the download page down. The two Workers also differ on
observability, see section 4.

Deployed at `https://claude-stats-relay.gustavpjvr.workers.dev`, which is the
default the test suite targets (`../claude-stats-relay/test/relay.test.mjs:13`)
and the constant the app ships with
(`src/main/projection/index.ts:25`).

### Routes

All in `../claude-stats-relay/src/index.js`:

| Route | Method | Purpose | Line |
|---|---|---|---|
| `/v1/health` | GET | returns `{ ok: true, v: 1 }` | `:48-50` |
| `/v1/pair/redeem` | POST | redeem a pairing lookup, returns the space and the source's public key | `:57-82` |
| `/v1/space/<id>/source` | WebSocket upgrade | the source's socket | `:84-92` |
| `/v1/space/<id>/screen` | WebSocket upgrade | a screen's socket | `:84-92` |
| anything else | any | `404 {"error":"not found"}` | `:94` |

Formats are validated in the Worker **before** any Durable Object is addressed
(`:52-56`): a 26-character Crockford base32 space id (`:33`) and a 22-character
base64url lookup (`:35`). A malformed id must not cost a DO request, or the
cheapest possible attack is to spell an id wrong a hundred thousand times a day.

The client IP is forwarded to the directory object as `x-real-ip`, because a
Durable Object cannot see it. Cloudflare sets `cf-connecting-ip` and strips any
client-supplied copy, so it cannot be spoofed from outside (`:74-79`).

## 2. Deploying it

From `../claude-stats-relay/package.json:6-10`:

| Script | Command |
|---|---|
| `dev` | `wrangler dev` |
| `deploy` | `wrangler deploy` |
| `test` | `node test/relay.test.mjs` |

```sh
cd ../claude-stats-relay
npm install
npm run deploy          # or: npx wrangler deploy
curl -s https://<your-worker>.workers.dev/v1/health
```

A Cloudflare account is needed; the free plan is enough
(`../claude-stats-relay/README.md:75-88`). Worker name `claude-stats-relay`,
entry `src/index.js`, compatibility date `2026-09-01`
(`../claude-stats-relay/wrangler.jsonc:11-13`).

**The migration must stay `new_sqlite_classes`**
(`../claude-stats-relay/wrangler.jsonc:40-45`). The key-value Durable Object
backend is paid-only; the SQLite backend is available on the free plan
(`:6-9`). Changing that migration to the key-value form would make the relay
undeployable on a free account.

### Pointing the app at a different relay

The app has no setting for it. `DEFAULT_RELAY` is a constant
(`src/main/projection/index.ts:25`) used for every new pairing, both as a source
(`:139`) and as a screen (`:199`, `:227`). Using your own relay therefore means
changing that constant and rebuilding, and re-pairing: an existing pairing keeps
whatever relay URL it was created with, because the URL is stored in the
persisted projection record (`src/main/projection/store.ts:75`, `:95`, `:113`).
That stored URL is validated as `https://` only, since a downgrade to `ws://`
would put frames on the wire in the clear (`src/main/projection/store.ts:76-78`).

## 3. The two Durable Object classes

Bindings at `../claude-stats-relay/wrangler.jsonc:33-38`.

### `SpaceRelay`, one per space

`../claude-stats-relay/src/space.js`. Holds the source's socket and its screens'
sockets, and fans frames out between them.

It uses the **WebSocket Hibernation API** throughout, `ctx.acceptWebSocket`
rather than `server.accept()` (`:5-9`, `:89-90`). While every socket is idle the
object leaves memory and accrues no billable duration, which is what makes an
idle projection cost effectively nothing, and the app is silent for hours at a
time. The operational consequence: **nothing may live in an instance field
across messages.** Per connection state goes in the socket's attachment, and
everything else in storage. A change that caches something on `this` will work
in testing and fail in production the first time an object hibernates.

Limits and timers:

| Constant | Value | Line |
|---|---|---|
| `AUTH_GRACE_MS` | 5 seconds before an unauthenticated socket is closed with 4001 | `:14`, `:101-109` |
| `MAX_SCREENS` | 8 per space | `:15`, `:331-334` |
| `MAX_FRAME_BYTES` | 512 KB, a sanity bound; a real frame is about 78 KB today | `:16-17`, `:127-130` |
| `OFFER_TTL_MAX_MS` | 10 minutes, the cap on a pairing offer | `:12`, `:213-217` |

Timers are alarms, not `setTimeout`, because timers do not survive hibernation
(`:93-96`). The alarm sweeps unauthenticated sockets, expires a stale offer and
tells the source, and re-arms itself every 30 seconds only while there is
something left to watch (`:101-123`). Bearer token hashes are compared in
constant time so a token cannot be probed byte by byte (`:26-32`).

### `PairingDirectory`, one globally

`../claude-stats-relay/src/directory.js`, addressed as
`idFromName('global')` (`../claude-stats-relay/src/index.js:68`). Two jobs that
both need a single place to look (`:1-25`):

1. Map a pairing-code digest to the space that offered it. The digest is taken
   **after** the code has been stretched with scrypt, so the table cannot be
   read backwards into codes worth guessing: testing one candidate against a
   stored lookup costs the same scrypt as testing it against the key. An earlier
   version stored a plain SHA-256 of the code, which let a search skip the
   stretch entirely.
2. Rate limit redemption, which is the only endpoint an attacker can attack
   online.

Redemption is one-time and is consumed before the space is even asked, so a race
between two redeemers cannot hand the same code out twice (`:105-108`). Its own
alarm purges expired offers and lapsed limiter records every 60 seconds while
any remain (`:133-159`).

## 4. Observability is off, deliberately

`"observability": { "enabled": false }`
(`../claude-stats-relay/wrangler.jsonc:31`), with the reasoning at `:14-30` and
in `../claude-stats-relay/README.md:51-62`.

The consent dialog in the app tells a user this relay forwards ciphertext it
cannot read and keeps no message content. That was true of the Durable Objects,
which store nothing but a pairing lookup that expires in ten minutes. It was not
the whole truth while Workers Logs were on: those retain the URL, which carries
the space id, plus the client IP and the request timing, for days. Message
content was never in them, because no readable message content reaches the
Worker at all. But who talked to whom and when is exactly the metadata a
projection relay should not be accumulating, and a promise with an asterisk is
not the promise people read.

**What it costs, stated rather than hidden: there are no request logs to debug
from.** A production failure leaves you with the client's own logs, the health
endpoint, and the test suite. The replacements are
`../claude-stats-relay/test/relay.test.mjs` and the app's end-to-end run, both
in section 5.

If you must chase a specific bug, turn it on, deploy, reproduce, then turn it
off and deploy again **in the same session**. Both the config comment and the
README say so in those terms.

Note the contrast with the download site, where `observability` is on
(`../claude-stats-wall-site/wrangler.jsonc:11`). That Worker serves public files
to anonymous browsers and has no privacy promise to keep, so the tradeoff there
goes the other way. See [download-site.md](download-site.md).

## 5. Rate limits

Constants at `../claude-stats-relay/src/directory.js:27-30`:

| Limit | Value |
|---|---|
| Global redemption failures | 20 per minute (`GLOBAL_FAILS_PER_MIN`) |
| Per-IP redemption failures | 5 per 10 minutes (`IP_FAILS`, `IP_WINDOW_MS`) |
| Pairing offer lifetime | capped at 10 minutes (`OFFER_TTL_MAX_MS`) |

The global limiter is checked **first**, before the per-IP one, because it is
the one that bounds a distributed attack and it must not be reachable around by
rotating addresses (`:65-74`). Both return `429` with a `retry-after` header
(`:73`, `:79`). Only failures count: a successful redemption increments nothing.

What the numbers buy, from the header comment (`:19-24`): a code lives 10
minutes, so an attacker gets at most about 200 global guesses inside its window
against 2^60 possibilities, roughly 2 in 10^16, and it costs them their whole
global budget. Offline, against a stored lookup, a full search is 2^60 scrypts
at about 100 ms each.

**Operational consequence:** the global limiter is global. A burst of failed
redemptions from anyone locks legitimate pairing for up to a minute. That is
also why the test suite must not be run against a relay people are using.

Frame-level limits are separate and live in `SpaceRelay`: 512 KB per message
(`../claude-stats-relay/src/space.js:127-130`), 8 screens per space (`:15`), and
a 5 second authentication grace period (`:14`).

## 6. Running the tests against the deployed Worker

```sh
cd ../claude-stats-relay
npm test                                        # the default deployment
node test/relay.test.mjs https://my-relay.example.workers.dev
```

The optional first argument is the base URL; the suite derives the WebSocket
origin from it by swapping the scheme (`test/relay.test.mjs:8`, `:13-14`).

It is a black-box test that **reimplements the pairing protocol independently of
the desktop app on purpose** (`:1-9`). Sharing the app's code would mean the app
and the relay could agree on something wrong and the test would still pass.

**Two warnings before you run it:**

- It deliberately trips the global rate limiter, so it locks real pairing for
  about a minute. Do not run it against a relay people are using
  (`../claude-stats-relay/README.md:90-91`).
- With observability off, this suite plus the health endpoint is most of what
  you have. Treat a failure here as the primary signal rather than the first
  step towards reading logs.

**From the app side**, `npm run test:e2e` in this repo drives the real
`SourceProjector` and `ScreenReceiver` classes end to end through the deployed
relay, covering the socket lifecycle, the pairing handshake as the app actually
performs it, framing, the staleness state machine, and the replay boundary
across a screen restart (`test/projection-e2e.cjs:1-14`). It bypasses the
consent dialogs, which are UI and would block. Run it after any change to the
relay's message handling, since it is the only check that the two sides still
agree.

## Related

- `../claude-stats-relay/README.md` for the protocol, the threat model and the
  three rules. This document does not duplicate them.
- [projection.md](projection.md) and [projection-crypto.md](projection-crypto.md)
  for the app's half of the same system.
- [download-site.md](download-site.md) for the other Cloudflare Worker.
