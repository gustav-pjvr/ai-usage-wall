# Projection cryptography: key schedule, replay boundary, rate limits, threat model

**Summary.** Two desktops derive a per-screen AES-256-GCM key from a 60 bit
pairing code stretched with scrypt and an X25519 exchange; the relay sees a
digest of the stretched code, two public keys and ciphertext, and can read none
of it. Frames carry a monotonic sequence in the authenticated header, the
screen persists the last accepted sequence so a replay cannot survive a
restart, and the relay's directory rate limits online guessing. Version 1 of
the schedule had a real flaw: the lookup the relay stored was a plain SHA-256
of the code, so a hostile relay could test candidate codes at hash speed and
pay scrypt only for the match. Version 2 derives the lookup from the scrypt
output. This file documents all of that, states what each protection does not
cover, and marks anything inferred rather than read. All of it is Node's
standard library; no dependency was added.

Paths are relative to the app repo. Paths prefixed `relay/` are in the
`claude-stats-relay` repo. The key schedule is mirrored independently in
`relay/test/relay.test.mjs`, which is how the relay's contract is tested
without sharing the app's code.

## Key schedule

### 1. The pairing code

- Alphabet: Crockford base32, `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, 32 symbols,
  omitting I, L, O and U (`src/shared/pairing-code.ts`).
- Length: 12 symbols. Entropy: 12 x 5 = **60 bits**.
- Generation: one random byte per symbol, `byte & 31`; 256 divides by 32 so the
  mask is uniform. `randomBytes` is Node's CSPRNG, passed in by the caller.
- Displayed as `XXXX-XXXX-XXXX`. Input is forgiving: case, spaces, any
  punctuation, I/L read as 1, O read as 0; anything not exactly 12 valid
  symbols after cleaning is rejected.
- Lifetime: 10 minutes on the source (`CODE_TTL_MS`), independently capped at
  10 minutes by the relay in both the space and the directory.
- One-time: the directory deletes the pending lookup before asking the space,
  and the space deletes the offer whether or not the screen ever connects.

### 2. scrypt

`stretchCode(code) = scrypt(code, "csw-pair-v1", 32 bytes, N=2^15, r=8, p=1)`
(`src/main/projection/crypto.ts`). Memory per evaluation is 128 x N x r bytes =
128 x 32768 x 8 = 32 MiB; `maxmem` is raised to 96 MiB because Node refuses the
default otherwise. The salt is fixed and unchanged from version 1: it does not
need to be secret, because its job is domain separation, not per-user
uniqueness, and the code itself is the secret.

scrypt runs exactly once per pairing on each side, and the result is reused for
both the lookup and the key. It never runs in the per-frame path.

### 3. The lookup

`lookup = base64url(HKDF-SHA256(ikm = stretched, salt = empty, info = "csw-lookup-v2", 32))[0..22)`

22 base64url characters is 132 bits, more than the code carries, so the
truncation loses nothing that matters. This is the only code-derived value the
relay ever receives, and it is what the directory indexes on. The relay
validates only its format.

### 4. X25519

Each side generates a fresh key pair per pairing. Public keys travel as the raw
32 bytes, base64, with the SPKI prefix stripped and re-added. A public key of
the wrong length throws. There is no explicit check for low-order points beyond
whatever Node's `diffieHellman` does; that was not verified while writing this.
It does not matter for confidentiality here, because the code is also in the
key (next step): a relay that supplied a degenerate public key would still have
to guess the code.

### 5. The per-screen key

```
shared = X25519(myPrivate, theirPublic)
key    = HKDF-SHA256(ikm = shared || stretched, salt = lookup, info = "csw-screen-key-v2", 32)
```

Both inputs are required: the X25519 secret, which a passive relay cannot
compute, and the stretched code, which the relay does not have. The same
function runs on both machines with the roles of the keys swapped. The test
asserts the two sides agree, that a different code gives a different key, and
that a substituted key pair does not agree with the source.

Consequence: **X25519 defeats a passive relay completely; against an active
relay the entire strength is the code plus scrypt.** A relay that substitutes
its own public keys in both directions ends up with two keys that differ from
what the desktops derive, and the first sealed message fails to open on the
desktops. To succeed it must find the code, and every candidate costs one
scrypt.

Each screen gets its own key. Revoking a screen is deleting one key. No screen
holds anything that opens another screen's traffic.

### 6. Frames: AES-256-GCM

```
version(1) | seq(8, big endian) | nonce(12, random) | ciphertext | tag(16)
```

The 9 byte header is the GCM additional authenticated data, so neither the
version nor the sequence can be edited without failing the tag. The payload is
JSON, `deflateRaw`ed before encryption; the compression-oracle concern does not
apply because the plaintext is entirely the app's own JSON with no
attacker-chosen content mixed in. `open()` throws on a short buffer, a wrong
version byte, a wrong key, or any tampering. The current version byte is
`CRYPTO_VERSION = 2`; a version 1 frame is refused by the byte before any
decryption.

The nonce is 96 random bits per frame under a long-lived key. At the actual
send rate (at most one frame per 10 seconds plus a beat per 30 seconds) the
number of messages per key stays many orders of magnitude below the point where
random-nonce collision becomes a concern. No counter is kept, so this is a
statistical argument, not a structural one.

### 7. The monotonic sequence

`seq = max(seq + 1, Date.now())` on the source. It is monotonic within a
process, and because it is floored at the wall clock it keeps rising across a
source restart without persisting a counter. One counter serves all screens, so
each screen sees gaps, which is fine because the check is strictly greater, not
consecutive. The screen discards any frame with `seq <= lastSeq`.

The `up` channel (screen to source) is sealed with `seq = Date.now()` and the
source does **not** check the sequence when opening it. A replayed hello-ack
would re-confirm and re-label an already confirmed screen and trigger one extra
frame push; nothing beyond that. Read from the code, not tested.

## The replay boundary, and how it survives a screen restart

The boundary is the screen's `lastSeq`. It is:

- restored from `projection-last.json` **before** the socket opens;
- advanced only after a frame decrypted, authenticated and was strictly newer;
- persisted after **every** accepted message, beats and hellos included, with
  writes chained so two cannot interleave on the temp file.

`screen.ts` records the bug this fixes: `lastSeq` used to start at 0 on every
launch, so a relay that retained yesterday's ciphertexts could replay them in
ascending order after any restart and each would be accepted and shown as live.
It also records that the cache used to be throttled to once a minute, which was
fine for the payload and wrong for the sequence.

The residual window is whatever arrived after the last write that completed:
one message in normal operation. The e2e test restarts a real `ScreenReceiver`,
injects a sealed frame with `seq = 1` and asserts it is rejected and does not
refresh liveness, then injects `restoredSeq + 1` and asserts it is accepted.

What this does not cover: a relay that **withholds** frames rather than
replaying them. The screen then decays to `link-lost` and `offline` on its own
clock, which is the intended answer, but the relay can make a live source look
dead. Also, the sequence is per screen state; a screen whose
`projection-last.json` is deleted by hand starts from 0 again.

## Rate limiting in the relay directory

`relay/src/directory.js` is one Durable Object globally, which is what makes a
global cap trivial. Applied in `redeem()`, in this order:

1. **Global**: at most 20 **failed** redemptions per rolling minute across all
   clients (`GLOBAL_FAILS_PER_MIN`). Returns 429 with `retry-after: 60`.
   Checked first because it is the one that bounds a distributed attack.
2. **Per IP**: at most 5 failures per IP in a 10 minute window. The IP is
   Cloudflare's `cf-connecting-ip`, copied by the Worker into an internal
   header, which the Worker's comment says cannot be spoofed from outside.
3. A failure is counted on: unknown lookup (404), expired (410), and any non-OK
   answer from the space, including "too many screens" (409). Successes are not
   counted.
4. Expired offers and lapsed limiter records are purged by an alarm every
   minute while any exist.

Arithmetic, from the comment in `directory.js`: a code lives 10 minutes, so an
online attacker gets at most about 200 global guesses inside a code's window
against 2^60, roughly 2 in 10^16. The black-box test fires 30 bad redemptions
and asserts a 429 appears and no guess succeeds.

What the rate limit does not cover:

- **A hostile relay operator is not rate limited by their own relay.** The
  limit defends against outsiders guessing online. The relay's own offline
  attack is bounded only by scrypt.
- **Denial of service is cheap.** Twenty bad guesses from anywhere lock pairing
  globally for a minute; the relay README says its own test does exactly this.
  The limiter protects the code, not availability.
- Counting is on failures only, so a legitimate user who mistypes five times
  from one address waits up to ten minutes.

## The version 1 flaw, stated plainly

**What version 1 did.** The lookup sent to the relay was
`base64url(SHA-256("csw-lookup-v1" || code))[0..22)`. `ARCHITECTURE.md` still
shows this formula and is stale; the regression test reconstructs it in
`test/projection-crypto.test.mjs`.

**Why it mattered.** The relay stores every lookup it is given: the space keeps
the offer and the directory keeps `pending`, and the relay operator can also
just log the field. Given a stored lookup, a hostile relay could enumerate the
2^60 codes with a plain SHA-256 each and pay scrypt only once, for the
candidate whose digest matched. SHA-256 on commodity GPUs runs at billions of
evaluations per second; scrypt at these parameters runs at roughly ten per
second per core because it has to touch 32 MiB. The stretch was still in the
key derivation, but it no longer stood between the attacker and the code, so it
was decorative. With the code recovered, the relay could then stand in the
middle of that pairing's exchange, or open every frame for that screen it had
recorded. Every other protection in this document depends on the code being
expensive to test, so this one flaw made the rest moot. The order-of-magnitude
comparison above is an estimate for explanation, not a measurement from this
repo.

**The fix.** `lookupFromStretched()` derives the lookup from the scrypt output
with HKDF; the HKDF info strings moved to `csw-lookup-v2` and
`csw-screen-key-v2`; `CRYPTO_VERSION` was bumped to 2 so a version 1 pairing is
refused by the version byte rather than by a garbled tag. Now every way of
checking a candidate, against the lookup or against the key, costs one scrypt.
The relay needed no code change, because it only stores and compares the
string; its comment in `relay/src/index.js` still says "truncated SHA-256 of a
pairing code" and is stale.

**Regression tests.** `projection-crypto.test.mjs` asserts the lookup is not the
version 1 digest, not a bare SHA-256 of the code, that the stretch costs real
time, and that `CRYPTO_VERSION === 2`.

**Measured cost per guess.** The test times one `stretchCode()` call, prints
`(one scrypt took N ms)` and asserts only that it exceeded 10 ms. On this
machine that figure has been observed at roughly 119 ms per guess. The code's
own estimate is about 100 ms and 32 MB per guess. Run
`node test/projection-crypto.test.mjs` for the number on a given machine. A full
search at 2^60 evaluations of any cost in that range is not feasible, and the
relevant question for a hostile relay is that it cannot do better than that per
candidate.

## Threat model

**Trusted:** the two desktops and the person who read twelve characters off one
screen and typed them into the other.

**Not trusted:** the relay, the network, and anyone who later obtains the
credentials file.

### A hostile relay can

- See everything in `privacy-wire.md` under "plaintext to the relay": space
  ids, screen ids, both bearer credentials as presented, the lookup, both
  public keys, the source's IP and each screen's IP, the timing and size of
  every frame and beat.
- Infer when someone is at the keyboard, from frame timing versus beats.
- Drop, delay or withhold frames, making a live source look dead. The screen
  answers with honest decay, not with a wrong number.
- Refuse pairing, or break a pairing in progress. Read from the code: a
  fabricated `paired` message while an offer is pending makes the source derive
  a key for a relay-chosen public key, store an unconfirmed screen, and clear
  `pending`, so the real screen's later redemption is ignored. The fake screen
  receives only the hello, which the relay cannot open. Confidentiality holds;
  that pairing attempt fails. Not tested.
- Elicit ciphertext: a fabricated `screen-online` makes the source send a hello
  or a frame for that screen id, if and only if the id is in the source's own
  file. It gains ciphertext it cannot read.
- Mount an offline attack on a stored lookup, or an active man-in-the-middle on
  a pairing, at a cost of one scrypt per candidate code, with no rate limit.
  That is the security parameter, and it is 2^60 x scrypt.

### A hostile relay cannot

- Read a frame, a beat, a hello, a hello-ack, the source's hostname or the
  screen's hostname: all are sealed.
- Forge or alter a frame: GCM tag over an AAD it cannot compute.
- Replay a frame, including across a screen restart.
- Resurrect a revoked screen: the key is deleted locally first.
- Learn the pairing code from anything it holds without paying scrypt per
  candidate (version 2).
- Compute the key from the two public keys alone.

### A passive network observer

Sees TLS to the relay host and nothing inside it. Certificate validation is
whatever Node's `fetch` and global `WebSocket` do by default; there is no
pinning in the app.

### Someone who obtains `projection.json`

On Windows the file is DPAPI-encrypted to the logged-in user, so a copy on
another machine yields nothing. If `safeStorage` reports encryption
unavailable, the file is written in plaintext with one warning per process.
Anyone who can read the plaintext file has the keys for every screen on a
source, or the one key on a screen, plus the relay bearer credentials, and can
open any ciphertext for those screens they also managed to capture.

### Limitations that are properties of the design

- **No forward secrecy per frame.** A screen's key is static from pairing to
  revocation. A key obtained later opens every earlier frame for that screen
  that was recorded. Revocation stops new frames; it does not un-record old
  ones.
- **The `up` channel has no replay check.**
- **The source's presence counts trust the relay.** The tray's "X of Y screens"
  is what the relay said, not what was proven.
- **Relay credentials are bearer tokens in the clear inside TLS.** The source
  secret and screen token are presented in the first message and the relay
  stores their hashes. They authorise access to the relay, not to any content.
- **Trust on first use for spaces.** Whoever first presents a secret for a
  fresh 26 character space id owns it. Guessing an id you were never told is
  130 bits of Crockford characters.

## Credentials on disk

`projection.json` and `projection-last.json` live in `userData`, never in
`settings.json`. Written via a temp file and rename so a crash cannot leave
half a key. `clearProjection()` deletes both. `normalise()` coerces any
malformed file to "projection off" rather than throwing.
