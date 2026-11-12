/**
 * A second Claude Code account counts into the same Claude totals (Gustav,
 * 2026-11-12). It runs with CLAUDE_CONFIG_DIR=~/.claude-account2, so its
 * transcripts live in another projects folder; the indexer reads both, and a
 * session present in both homes is counted once.
 *
 *   node test/claude-accounts.test.mjs
 */

import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'csw-accounts-'));
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

const rec = (session, i, tokens) => JSON.stringify({
  type: 'assistant',
  timestamp: new Date(Date.now() - (100 - i) * 1000).toISOString(),
  sessionId: session,
  cwd: path.join(tmp, 'work'),
  version: '2.1.322',
  message: { model: 'claude-opus-5', usage: { input_tokens: tokens, output_tokens: 1 } },
}) + '\n';

const MAIN = path.join(tmp, 'claude');
const SECOND = path.join(tmp, 'claude-account2');
const S1 = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
const S2 = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002';
for (const d of [path.join(MAIN, 'projects', 'proj'), path.join(SECOND, 'projects', 'proj'), path.join(SECOND, 'projects', 'other')]) {
  await fs.mkdir(d, { recursive: true });
}
// Main account: one session, 3 records of 10 input tokens.
await fs.writeFile(path.join(MAIN, 'projects', 'proj', `${S1}.jsonl`), [0, 1, 2].map((i) => rec(S1, i, 10)).join(''));
// Second account: its own session, 2 records of 100 input tokens.
await fs.writeFile(path.join(SECOND, 'projects', 'other', `${S2}.jsonl`), [0, 1].map((i) => rec(S2, i, 100)).join(''));
// And a copy of the main session at the same path: must not count twice.
await fs.writeFile(path.join(SECOND, 'projects', 'proj', `${S1}.jsonl`), [0, 1, 2].map((i) => rec(S1, i, 10)).join(''));

process.env.MBW_CLAUDE_HOME = MAIN;
const out = path.join(tmp, 'usage.cjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/main/data/usage.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: out,
  external: ['electron'], logLevel: 'error',
});
const { refreshIndex, emptyIndex, extraProjectDirs } = require(out);

console.log('\nwithout a second home');
{
  delete process.env.MBW_EXTRA_CLAUDE_HOMES;
  ok('a custom main home adds no other folders by itself', extraProjectDirs().length === 0, JSON.stringify(extraProjectDirs()));
  const { index } = await refreshIndex(emptyIndex());
  ok('only the main account is counted', index.totals.requests === 3, String(index.totals.requests));
}

console.log('\nwith the second account');
{
  process.env.MBW_EXTRA_CLAUDE_HOMES = [SECOND, path.join(tmp, 'missing')].join(path.delimiter);
  ok('the second home is read; a home without projects is ignored',
     JSON.stringify(extraProjectDirs()) === JSON.stringify([path.join(SECOND, 'projects')]), JSON.stringify(extraProjectDirs()));
  const { index } = await refreshIndex(emptyIndex());
  ok('both accounts add up: 3 + 2 requests', index.totals.requests === 5, String(index.totals.requests));
  ok('input tokens add up: 30 + 200', index.totals.input === 230, String(index.totals.input));
  ok('the session copied into both homes is counted once', Object.keys(index.files).filter((f) => f.endsWith(`${S1}.jsonl`)).length === 1,
     Object.keys(index.files).join(', '));
  ok('two sessions in all', Object.keys(index.sessions ?? {}).length === 2 || (index.sessions?.length ?? 2) === 2);
}

console.log('\nthe real home convention');
{
  delete process.env.MBW_EXTRA_CLAUDE_HOMES;
  delete process.env.MBW_CLAUDE_HOME;
  const homes = extraProjectDirs().map((d) => path.basename(path.dirname(d)));
  ok('auto-detect only picks folders named .claude-account<N>', homes.every((h) => /^\.claude-account\d+$/.test(h)), homes.join(', '));
}

await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
