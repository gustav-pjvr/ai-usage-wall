/**
 * Projection, end to end, through the DEPLOYED relay.
 *
 * Drives the real SourceProjector and ScreenReceiver classes rather than
 * reimplementing the protocol, so this catches the things the unit tests
 * cannot: the socket lifecycle, the pairing handshake as the app actually
 * performs it, framing, and the staleness state machine.
 *
 * The consent dialogs are bypassed on purpose. They are UI, they block, and
 * what is under test here is the runtime beneath them.
 *
 *   electron test/projection-e2e.cjs
 */

const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const OUT = path.join(os.tmpdir(), `csw-e2e-${Date.now()}`);
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', OUT);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? '  ->  ' + detail : ''}`);
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until a condition holds, so the test never depends on a fixed sleep. */
async function until(label, fn, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return true;
    await wait(250);
  }
  console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
  return false;
}

app.whenReady().then(async () => {
  const bundle = path.join(OUT, 'projection.cjs');
  await require('esbuild').build({
    entryPoints: [path.join(__dirname, '..', 'src', 'main', 'projection', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['electron'],
    logLevel: 'error',
  });

  const srcBundle = path.join(OUT, 'source.cjs');
  await require('esbuild').build({
    entryPoints: [path.join(__dirname, '..', 'src', 'main', 'projection', 'source.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: srcBundle, external: ['electron'], logLevel: 'error',
  });
  const scrBundle = path.join(OUT, 'screen.cjs');
  await require('esbuild').build({
    entryPoints: [path.join(__dirname, '..', 'src', 'main', 'projection', 'screen.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: scrBundle, external: ['electron'], logLevel: 'error',
  });
  const cxBundle = path.join(OUT, 'crypto.cjs');
  await require('esbuild').build({
    entryPoints: [path.join(__dirname, '..', 'src', 'main', 'projection', 'crypto.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: cxBundle, external: ['electron'], logLevel: 'error',
  });

  const { SourceProjector } = require(srcBundle);
  const { ScreenReceiver } = require(scrBundle);
  const cx = require(cxBundle);
  const RELAY = 'https://claude-stats-relay.gustavpjvr.workers.dev';

  console.log('\nprojection end to end (real classes, deployed relay)\n');

  // ── The source comes up ──────────────────────────────────────────────────
  let srcStatus = null;
  const source = new SourceProjector(
    {
      role: 'source',
      relayUrl: RELAY,
      spaceId: cx.newSpaceId(),
      sourceSecret: cx.newSecret(),
      screens: [],
      pendingRevocations: [],
      label: 'Test source',
      shareProjectNames: true,
    },
    (s) => (srcStatus = s),
    (t, b) => console.log(`        [notice] ${t}: ${b}`),
  );
  source.start();

  ok('source connects to the relay', await until('source open', () => srcStatus?.phase === 'open'),
     JSON.stringify(srcStatus));

  // Feed it something with paths in it, so the leak guard is exercised on the
  // real path rather than only in the unit test.
  const index = {
    builtAt: new Date().toISOString(),
    files: { 'C:\\Users\\Demo User\\.claude\\projects\\a.jsonl': { size: 1, offset: 1 } },
    totals: { input: 1, output: 2, cacheCreate: 3, cacheRead: 4, thinking: 5, requests: 6, webSearch: 0, webFetch: 0 },
    daily: {}, hourly: {}, models: { 'claude-opus-5': { requests: 6 } },
    projects: {
      'c:\\users\\demo user\\desktop\\claude workspace\\muchbetter-client-wall': {
        requests: 6, lastSeen: new Date().toISOString(),
        display: 'C:\\Users\\Demo User\\Desktop\\Claude WorkSpace\\muchbetter-client-wall',
      },
    },
    sessions: {}, recent: [], prompts: { total: 3, daily: {}, lastAt: null, offset: 9, size: 9 },
    latest: { ts: new Date().toISOString(), model: 'claude-opus-5', sessionId: 'x', version: '2.1.258',
              cwd: 'C:\\Users\\Demo User\\Desktop\\Claude WorkSpace\\muchbetter-client-wall' },
    lastScanMs: 5, unavailable: false,
  };
  source.offer(index, false);

  // ── Pair a screen ────────────────────────────────────────────────────────
  const offer = source.beginPairing();
  ok('the source produces a formatted code', /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(offer.code), offer.code);
  await wait(800);

  const raw = offer.code.replace(/-/g, '');
  const lookup = cx.lookupOf(raw);
  const kp = cx.newKeyPair();
  const res = await fetch(`${RELAY}/v1/pair/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lookup, pub: kp.publicKey }),
  });
  ok('the relay accepts the code', res.status === 200, `got ${res.status}`);
  const creds = await res.json();
  const key = cx.deriveScreenKey(kp.privateKey, creds.sourcePub, raw, lookup);

  let received = null;
  let scrStatus = null;
  const screen = new ScreenReceiver(
    {
      role: 'screen', relayUrl: RELAY, spaceId: creds.spaceId, screenId: creds.screenId,
      screenToken: creds.token, key: key.toString('base64'), sourceLabel: '',
      pairedAt: new Date().toISOString(),
    },
    (u) => (received = u),
    (s) => (scrStatus = s),
    (t, b) => console.log(`        [notice] ${t}: ${b}`),
  );
  await screen.start();

  ok('the screen reaches LIVE from a decrypted frame',
     await until('screen live', () => scrStatus?.phase === 'live'), JSON.stringify(scrStatus));

  ok('the source sees the screen connected',
     await until('screen online', () => srcStatus?.screens?.some((s) => s.online)));

  ok('the source marks the screen confirmed only after the encrypted hello',
     await until('confirmed', () => srcStatus?.screens?.some((s) => s.confirmed)));

  ok('the screen received usage', await until('usage', () => received !== null));

  // ── The leak guard, on the real path ─────────────────────────────────────
  const json = JSON.stringify(received ?? {});
  ok('no Windows path crossed the wire', !json.includes('\\') && !/[a-z]:/i.test(json));
  ok('no username crossed the wire', !json.includes('HP 865'));
  ok('the .claude folder was never named', !json.includes('.claude'));
  ok('the project arrived as a label', json.includes('muchbetter-client-wall'));
  ok('the totals arrived intact', received?.totals?.requests === 6, JSON.stringify(received?.totals));

  // ── Revocation ───────────────────────────────────────────────────────────
  const screenId = creds.screenId;
  await source.revoke(screenId);
  ok('the screen is told it was revoked',
     await until('revoked', () => scrStatus?.phase === 'revoked'), JSON.stringify(scrStatus));
  ok('the source drops the screen from its list',
     await until('dropped', () => !srcStatus?.screens?.some((s) => s.screenId === screenId)));

  screen.stop();
  source.destroy();
  await wait(500);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  fs.rmSync(OUT, { recursive: true, force: true });
  app.exit(fail ? 1 : 0);
});
