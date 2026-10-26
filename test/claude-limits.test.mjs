/**
 * Claude's plan limits (docs/design/codex-side-by-side.md, section 5): the
 * reader of `~/.claude.json` (src/main/data/claude-limits.ts), the shared
 * validator (src/shared/claude-limits.ts) and the wire block.
 *
 * The file this reads also holds account details and OAuth state. The test
 * that matters most here is the one that PROVES none of it leaves: a fixture
 * full of fake secrets, read, put in a payload, sent over the wire and read
 * back, with every serialised form searched for every secret.
 *
 *   node test/claude-limits.test.mjs
 */

import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'csw-claude-limits-'));
const require = createRequire(import.meta.url);

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

// Never the real ~/.claude.json, even if a test forgets to pass a path.
process.env.MBW_CLAUDE_JSON = path.join(tmp, 'not-here.json');

const bundle = async (entry, name) => {
  const outfile = path.join(tmp, name);
  await esbuild.build({
    entryPoints: [path.join(root, entry)],
    bundle: true, platform: 'node', format: 'cjs', outfile,
    external: ['electron'], logLevel: 'error',
  });
  return require(outfile);
};
const R = await bundle('src/main/data/claude-limits.ts', 'reader.cjs');
const S = await bundle('src/shared/claude-limits.ts', 'shared.cjs');
const W = await bundle('src/shared/projection-wire.ts', 'wire.cjs');

const FETCHED = Date.parse('2026-10-26T12:17:20.150Z');
const SESSION_RESET = '2026-10-26T14:29:59.854566+00:00';
const WEEK_RESET = '2026-11-02T10:59:59.854585+00:00';
const FABLE_RESET = '2026-11-02T11:00:00+00:00';

/** The key as Claude Code writes it (shape measured 2026-10-26), with Gustav's reading. */
const usageKey = (over = {}) => ({
  fetchedAtMs: FETCHED,
  accountUuid: 'acct-uuid-SECRET-7f3e9a2b-0000-4c1d-9e8f-123456789abc',
  utilization: {
    five_hour: { utilization: 86, resets_at: SESSION_RESET, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
    seven_day: { utilization: 7, resets_at: WEEK_RESET, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
    seven_day_opus: null,
    extra_usage: { is_enabled: false, monthly_limit: null, currency: 'USD', disabled_reason: 'out_of_credits' },
    limits: [
      { kind: 'session', group: 'session', percent: 86, severity: 'critical', resets_at: SESSION_RESET, scope: null, is_active: true },
      { kind: 'weekly_all', group: 'weekly', percent: 7, severity: 'normal', resets_at: WEEK_RESET, scope: null, is_active: false },
      { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resets_at: FABLE_RESET, scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
    ],
  },
  ...over,
});

/** Secrets planted around (and inside) the key. None may survive. */
const SECRETS = [
  'secret.person@example.com',
  'acct-uuid-SECRET-7f3e9a2b-0000-4c1d-9e8f-123456789abc',
  'org-uuid-SECRET-0a0b0c0d',
  'sk-ant-oat01-FAKEFAKEFAKE-TokenLikeString-abcdefghijklmnopqrstuvwxyz0123456789',
  'sk-ant-ort01-FAKEREFRESH-zyxwvutsrqponmlkjihgfedcba9876543210',
  'Secret Person Display',
  'C:\\Users\\secretuser\\private-project',
  'userid-SECRET-f00dfeed',
];
const secretsFile = () => ({
  numStartups: 412,
  userID: 'userid-SECRET-f00dfeed',
  oauthAccount: {
    accountUuid: 'acct-uuid-SECRET-7f3e9a2b-0000-4c1d-9e8f-123456789abc',
    emailAddress: 'secret.person@example.com',
    organizationUuid: 'org-uuid-SECRET-0a0b0c0d',
    displayName: 'Secret Person Display',
  },
  primaryApiKey: 'sk-ant-oat01-FAKEFAKEFAKE-TokenLikeString-abcdefghijklmnopqrstuvwxyz0123456789',
  claudeAiOauth: { accessToken: 'sk-ant-oat01-FAKEFAKEFAKE-TokenLikeString-abcdefghijklmnopqrstuvwxyz0123456789', refreshToken: 'sk-ant-ort01-FAKEREFRESH-zyxwvutsrqponmlkjihgfedcba9876543210' },
  projects: { 'C:\\Users\\secretuser\\private-project': { allowedTools: [], history: [{ display: 'secret.person@example.com said hello' }] } },
  cachedUsageUtilization: {
    ...usageKey(),
    // Extra fields INSIDE the key, and inside a limit and its scope: none may cross either.
    email: 'secret.person@example.com',
    utilization: {
      ...usageKey().utilization,
      owner: 'Secret Person Display',
      limits: [
        { ...usageKey().utilization.limits[0], note: 'sk-ant-oat01-FAKEFAKEFAKE-TokenLikeString-abcdefghijklmnopqrstuvwxyz0123456789' },
        usageKey().utilization.limits[1],
        { ...usageKey().utilization.limits[2], scope: { model: { id: 'org-uuid-SECRET-0a0b0c0d', display_name: 'Fable', owner: 'userid-SECRET-f00dfeed' }, surface: 'C:\\Users\\secretuser\\private-project' } },
      ],
    },
  },
});

const write = async (name, obj) => {
  const f = path.join(tmp, name);
  await fs.writeFile(f, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return f;
};
const keysOf = (o) => Object.keys(o).sort().join(',');

// ── The reader ─────────────────────────────────────────────────────────────

console.log('\nthe reader: the normal file');
{
  const f = await write('normal.json', { numStartups: 3, cachedUsageUtilization: usageKey() });
  const r = await R.readClaudeLimits(f);
  ok('reads a reading', !!r, JSON.stringify(r));
  ok('the reading time is fetchedAtMs, as ISO', r && r.at === new Date(FETCHED).toISOString(), r && r.at);
  ok('rows: 5 h 86%, week 7%, week, Fable 0%, in that order',
     r && JSON.stringify(r.rows.map((x) => [x.label, x.usedPercent])) === JSON.stringify([['5 h', 86], ['week', 7], ['week, Fable', 0]]), JSON.stringify(r && r.rows));
  ok('resets as epoch ms, microseconds and offsets parsed',
     r && r.rows[0].resetsAt === Date.parse('2026-10-26T14:29:59.854Z') && r.rows[2].resetsAt === Date.parse('2026-11-02T11:00:00Z'), JSON.stringify(r && r.rows));
  ok('only `at` and `rows` on the reading, only label, usedPercent, resetsAt on a row',
     r && keysOf(r) === 'at,rows' && r.rows.every((x) => keysOf(x) === 'label,resetsAt,usedPercent'));
  ok('MBW_CLAUDE_JSON points the default path', R.claudeJsonPath() === process.env.MBW_CLAUDE_JSON);
}

console.log('\nthe reader: limits absent, five_hour and seven_day instead');
{
  const k = usageKey();
  delete k.utilization.limits;
  const f = await write('fallback.json', { cachedUsageUtilization: k });
  const r = await R.readClaudeLimits(f);
  ok('two rows from the fallback: 5 h 86%, week 7%',
     r && JSON.stringify(r.rows.map((x) => [x.label, x.usedPercent])) === JSON.stringify([['5 h', 86], ['week', 7]]), JSON.stringify(r));
  const k2 = usageKey();
  k2.utilization.limits = [];
  const r2 = await R.readClaudeLimits(await write('fallback-empty.json', { cachedUsageUtilization: k2 }));
  ok('an empty limits list falls back the same way', r2 && r2.rows.length === 2, JSON.stringify(r2));
  const k3 = usageKey();
  delete k3.utilization.limits;
  k3.utilization.seven_day = null;
  const r3 = await R.readClaudeLimits(await write('fallback-one.json', { cachedUsageUtilization: k3 }));
  ok('a null seven_day leaves the 5 h row alone', r3 && r3.rows.length === 1 && r3.rows[0].label === '5 h', JSON.stringify(r3));
}

console.log('\nthe reader: malformed values drop their row, never become 0');
{
  const k = usageKey();
  k.utilization.limits = [
    { kind: 'session', percent: 'lots', resets_at: SESSION_RESET },
    { kind: 'weekly_all', percent: 150, resets_at: WEEK_RESET },
    { kind: 'weekly_all', percent: -1, resets_at: WEEK_RESET },
    { kind: 'weekly_all', percent: null, resets_at: WEEK_RESET },
    { kind: 'weekly_all', percent: 12, resets_at: 'yesterday' },
    { kind: 'weekly_all', percent: 12, resets_at: 1793617200 },
    { kind: 'weekly_scoped', percent: 1, resets_at: FABLE_RESET, scope: { model: { display_name: '../../etc/passwd' } } },
    { kind: 'weekly_scoped', percent: 1, resets_at: FABLE_RESET, scope: { model: { display_name: '<img src=x onerror=alert(1)>' } } },
    { kind: 'weekly_scoped', percent: 1, resets_at: FABLE_RESET, scope: { model: { display_name: 'A model name far longer than any real one' } } },
    { kind: 'weekly_scoped', percent: 1, resets_at: FABLE_RESET, scope: null },
    { kind: 'monthly', percent: 1, resets_at: FABLE_RESET },
    'junk',
    null,
    { kind: 'weekly_scoped', percent: 42.5, resets_at: FABLE_RESET, scope: { model: { display_name: 'Opus 5.5' } } },
  ];
  const r = await R.readClaudeLimits(await write('malformed.json', { cachedUsageUtilization: k }));
  ok('only the one valid row survives (week, Opus 5.5 at 42.5%)',
     r && r.rows.length === 1 && r.rows[0].label === 'week, Opus 5.5' && r.rows[0].usedPercent === 42.5, JSON.stringify(r));
  const k2 = usageKey();
  k2.utilization.limits = [{ kind: 'session', percent: Infinity, resets_at: SESSION_RESET }];
  delete k2.utilization.five_hour;
  ok('nothing valid: null, so the panel hides', (await R.readClaudeLimits(await write('none-valid.json', { cachedUsageUtilization: k2 }))) === null);
  ok('no fetchedAtMs: null (a reading without an age is not shown)',
     (await R.readClaudeLimits(await write('no-time.json', { cachedUsageUtilization: usageKey({ fetchedAtMs: 'today' }) }))) === null);
  ok('no utilization: null', (await R.readClaudeLimits(await write('no-util.json', { cachedUsageUtilization: usageKey({ utilization: 'x' }) }))) === null);
  ok('no key at all: null', (await R.readClaudeLimits(await write('no-key.json', { numStartups: 1 }))) === null);
  ok('a key of the wrong type: null', (await R.readClaudeLimits(await write('bad-key.json', { cachedUsageUtilization: [1, 2] }))) === null);
  const dup = usageKey();
  dup.utilization.limits = [dup.utilization.limits[0], { ...dup.utilization.limits[0], percent: 1 }, dup.utilization.limits[1]];
  const rd = await R.readClaudeLimits(await write('dup.json', { cachedUsageUtilization: dup }));
  ok('a repeated kind keeps the first row only', rd && rd.rows.length === 2 && rd.rows[0].usedPercent === 86, JSON.stringify(rd));
}

console.log('\nthe reader: a missing or unreadable file is quietly nothing');
{
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.warn = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  const missing = await R.readClaudeLimits(path.join(tmp, 'missing.json'));
  const garbage = await R.readClaudeLimits(await write('garbage.json', '{"cachedUsageUtilization": {"fetchedAtMs": 1, secret.person@example.com'));
  const dir = await R.readClaudeLimits(tmp);
  const empty = await R.readClaudeLimits(await write('empty.json', ''));
  console.warn = orig.warn;
  console.error = orig.error;
  ok('missing file: null', missing === null);
  ok('truncated JSON: null', garbage === null);
  ok('a directory: null', dir === null);
  ok('an empty file: null', empty === null);
  ok('and not one warning or error printed', logs.length === 0, JSON.stringify(logs));
}

console.log('\nthe keeper: one stat per poll, a read only when the file changed');
{
  const f = await write('kept.json', { cachedUsageUtilization: usageKey() });
  // A whole-millisecond mtime, so setting it back later restores it exactly (NTFS keeps 100 ns).
  const T = new Date(1793000000000);
  await fs.utimes(f, T, T);
  const keeper = R.createClaudeLimitsKeeper(() => f);
  ok('nothing before the first poll', keeper.current() === null);
  ok('the first poll reads it and reports a change', (await keeper.refresh()) === true && keeper.current().rows.length === 3);
  ok('a second poll with the file untouched reports no change', (await keeper.refresh()) === false);

  // Same size and the same mtime, different content: a poll must NOT read it, which proves the read is stat-gated.
  const st = await fs.stat(f);
  const sneaky = JSON.stringify({ cachedUsageUtilization: usageKey() }, null, 2).replace('"percent": 86', '"percent": 85');
  ok('(the changed file is the same size)', Buffer.byteLength(sneaky) === st.size);
  await fs.writeFile(f, sneaky);
  await fs.utimes(f, T, T);
  ok('same mtime and size: not re-read, still 86%', (await keeper.refresh()) === false && keeper.current().rows[0].usedPercent === 86);
  await fs.utimes(f, new Date(), new Date(Date.now() + 5000));
  ok('a new mtime: re-read, now 85%', (await keeper.refresh()) === true && keeper.current().rows[0].usedPercent === 85);
  // Claude Code mid-rewrite: half the JSON. Keep the last reading, and retry on the next poll.
  const whole = await fs.readFile(f, 'utf8');
  await fs.writeFile(f, whole.slice(0, 200));
  await fs.utimes(f, new Date(), new Date(Date.now() + 10000));
  ok('a half-written file: no change, the last reading kept (85%)', (await keeper.refresh()) === false && keeper.current()?.rows[0].usedPercent === 85);
  await fs.writeFile(f, whole.replace('"percent": 85', '"percent": 84'));
  await fs.utimes(f, new Date(), new Date(Date.now() + 10000));
  ok('the same mtime once written whole: read again, now 84%', (await keeper.refresh()) === true && keeper.current().rows[0].usedPercent === 84);
  await fs.rm(f);
  ok('the file deleted: the reading goes, change reported', (await keeper.refresh()) === true && keeper.current() === null);
  ok('and stays gone without another change', (await keeper.refresh()) === false && keeper.current() === null);
}

// ── The safety property ────────────────────────────────────────────────────

console.log('\nSECURITY: nothing but the reading leaves the file');
{
  const f = await write('secrets.json', secretsFile());
  const raw = await fs.readFile(f, 'utf8');
  ok('(every planted secret is really in the fixture)', SECRETS.every((x) => raw.includes(JSON.stringify(x).slice(1, -1))));

  const keeper = R.createClaudeLimitsKeeper(() => f);
  await keeper.refresh();
  const reading = keeper.current();
  ok('the reading still comes through (3 rows)', !!reading && reading.rows.length === 3, JSON.stringify(reading));

  // The payload as main builds it (usageForRenderer): `claudeLimits: plan` beside the usage index.
  const payload = { totals: { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 }, daily: {}, claudeLimits: reading };
  const wire = W.toWire(payload, { shareProjectNames: true, sourceLabel: 'PC', indexing: false });
  const frame = JSON.stringify(wire);
  const back = W.fromWire(JSON.parse(frame));
  const forms = {
    reading: JSON.stringify(reading),
    payload: JSON.stringify(payload),
    wire: frame,
    'frame key': W.frameKey(wire),
    'screen side': JSON.stringify(back),
  };
  for (const [name, text] of Object.entries(forms)) {
    const leaked = SECRETS.filter((x) => text.includes(x) || text.includes(JSON.stringify(x).slice(1, -1)));
    ok(`no secret anywhere in the ${name} (${text.length} chars searched)`, leaked.length === 0, leaked.join(' | '));
  }
  // The gate on the source side, proved on its own: hand toWire the raw key and the whole file, planted secrets and all.
  const parsed = JSON.parse(raw);
  for (const [what, v] of [['the raw cachedUsageUtilization', parsed.cachedUsageUtilization], ['the whole parsed file', parsed]]) {
    const text = JSON.stringify(W.toWire({ totals: {}, claudeLimits: v }, { shareProjectNames: true, sourceLabel: 'PC', indexing: false }));
    const leaked = SECRETS.filter((x) => text.includes(x) || text.includes(JSON.stringify(x).slice(1, -1)));
    ok(`toWire given ${what}: no secret on the wire`, leaked.length === 0, leaked.join(' | '));
  }
  const words = ['accountUuid', 'email', 'oauth', 'token', 'organization', 'userID', 'owner', 'note', 'surface', 'severity', 'is_active'];
  const loud = words.filter((w) => forms.reading.toLowerCase().includes(w.toLowerCase()) || JSON.stringify(wire.claudeLimits).toLowerCase().includes(w.toLowerCase()));
  ok('not even the NAMES of other fields cross', loud.length === 0, loud.join(','));
  ok('the wire block is exactly the reading: at, and label, usedPercent, resetsAt per row',
     keysOf(wire.claudeLimits) === 'at,rows' && wire.claudeLimits.rows.every((x) => keysOf(x) === 'label,resetsAt,usedPercent') &&
     JSON.stringify(wire.claudeLimits) === JSON.stringify(reading));
}

// ── The wire ───────────────────────────────────────────────────────────────

console.log('\nthe wire: round trip and hostile input');
{
  const reading = await R.readClaudeLimits(await write('wire.json', { cachedUsageUtilization: usageKey() }));
  const opts = { shareProjectNames: false, sourceLabel: 'PC', indexing: false };
  const w = W.toWire({ claudeLimits: reading }, opts);
  const back = W.fromWire(JSON.parse(JSON.stringify(w)));
  ok('the reading crosses and comes back identical', JSON.stringify(back.claudeLimits) === JSON.stringify(reading), JSON.stringify(back.claudeLimits));
  ok('it crosses whether or not project names are shared', JSON.stringify(W.toWire({ claudeLimits: reading }, { ...opts, shareProjectNames: true }).claudeLimits) === JSON.stringify(reading));
  const none = W.toWire({ totals: {} }, opts);
  ok('a source with no reading sends no field, and the screen gets none', !('claudeLimits' in none) && !('claudeLimits' in W.fromWire(none)));
  ok('a reading change changes the frame key, so a screen is sent it',
     W.frameKey(w) !== W.frameKey(W.toWire({ claudeLimits: { ...reading, rows: [{ ...reading.rows[0], usedPercent: 87 }] } }, opts)));

  // A frame from a source on another version, or anything else: rebuilt on arrival.
  const hostile = JSON.parse(JSON.stringify(w));
  hostile.claudeLimits.accountUuid = 'acct-uuid-SECRET-7f3e9a2b-0000-4c1d-9e8f-123456789abc';
  hostile.claudeLimits.rows = [
    { ...reading.rows[0], email: 'secret.person@example.com' },
    { label: '../../etc/passwd', usedPercent: 5, resetsAt: reading.rows[1].resetsAt },
    { label: 'week, <script>', usedPercent: 5, resetsAt: reading.rows[1].resetsAt },
    { label: 'week', usedPercent: 101, resetsAt: reading.rows[1].resetsAt },
    { label: 'week', usedPercent: '7', resetsAt: reading.rows[1].resetsAt },
    { label: 'week', usedPercent: 7, resetsAt: 'Mon 2 Nov' },
    { label: 'week', usedPercent: 7, resetsAt: 1793617200 },
    { label: 'week', usedPercent: NaN, resetsAt: reading.rows[1].resetsAt },
    { label: 'x'.repeat(5000), usedPercent: 5, resetsAt: reading.rows[1].resetsAt },
    reading.rows[2],
  ];
  const cleaned = W.fromWire(hostile).claudeLimits;
  ok('hostile rows dropped, extra fields stripped, valid rows kept (5 h and week, Fable)',
     cleaned && JSON.stringify(cleaned.rows.map((x) => x.label)) === JSON.stringify(['5 h', 'week, Fable']) &&
     keysOf(cleaned) === 'at,rows' && cleaned.rows.every((x) => keysOf(x) === 'label,resetsAt,usedPercent'), JSON.stringify(cleaned));
  ok('and no secret in what reaches the renderer', !SECRETS.some((x) => JSON.stringify(W.fromWire(hostile)).includes(x)));
  for (const [what, v] of [
    ['a string', 'lots'],
    ['an array', [1, 2]],
    ['rows not a list', { at: reading.at, rows: { a: 1 } }],
    ['no valid row', { at: reading.at, rows: [{ label: 'week', usedPercent: -5, resetsAt: 1 }] }],
    ['a bad time', { at: 'yesterday', rows: reading.rows }],
    ['a time too long to be one', { at: `${reading.at}${' '.repeat(50)}`, rows: reading.rows }],
  ]) {
    const f = W.fromWire({ ...JSON.parse(JSON.stringify(w)), claudeLimits: v });
    ok(`${what}: no field at all, never a 0`, !('claudeLimits' in f), JSON.stringify(f.claudeLimits));
  }
  const many = { at: reading.at, rows: Array.from({ length: 1000 }, (_, i) => ({ label: `week, Model ${i}`, usedPercent: 1, resetsAt: reading.rows[1].resetsAt })) };
  ok(`a thousand rows are capped at ${S.MAX_CLAUDE_ROWS}`, W.fromWire({ ...JSON.parse(JSON.stringify(w)), claudeLimits: many }).claudeLimits.rows.length === S.MAX_CLAUDE_ROWS);
  ok('the source side applies the same gate', JSON.stringify(W.toWire({ claudeLimits: hostile.claudeLimits }, opts).claudeLimits) === JSON.stringify(cleaned));
}

console.log('\nthe shared validator');
{
  ok('scopedLabel accepts a short model name', S.scopedLabel('Opus 5.5') === 'week, Opus 5.5');
  ok('and refuses paths, markup, long or non-string names',
     [ '../x', 'a/b', 'a\\b', '<b>', 'x'.repeat(25), '', ' lead', 5, null ].every((m) => S.scopedLabel(m) === null));
  ok('cleanClaudeLimits returns a fresh object, never the input', (() => {
    const input = { at: '2026-10-26T12:17:20.150Z', rows: [{ label: '5 h', usedPercent: 3, resetsAt: Date.parse(SESSION_RESET) }] };
    const out = S.cleanClaudeLimits(input);
    return out !== input && out.rows !== input.rows && out.rows[0] !== input.rows[0] && JSON.stringify(out) === JSON.stringify(input);
  })());
}

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
