/**
 * Build. esbuild for the three entry points, plus a static copy step.
 *
 * No bundler config framework, no dev server. Three bundles and a file copy is
 * the whole build, and keeping it that way means the next person (or Claude)
 * can read it top to bottom in a minute.
 */

import * as esbuild from 'esbuild';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const dist = path.join(root, 'dist');

/*
 * Edition, chosen here and baked in. `--edition=stats` produces the shareable
 * dashboard-only build; anything else produces the full client wall. See
 * src/shared/edition.ts for why this is a build constant and not a branch.
 *
 * It is substituted into BOTH bundles, which is the reason for expressing it as
 * process.env: the renderer has no `process` at runtime, but esbuild replaces
 * the expression with a string literal before it ever gets there.
 */
const editionArg = process.argv.find((a) => a.startsWith('--edition='));
const edition = editionArg?.slice('--edition='.length) === 'stats' ? 'stats' : 'full';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: watch,
  minify: !watch,
  logLevel: 'info',
  define: { 'process.env.MBW_EDITION': JSON.stringify(edition) },
};

const configs = [
  {
    ...common,
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(dist, 'main/index.js'),
    // Electron and koffi resolve at runtime from node_modules. koffi in
    // particular loads a native .node binary and must never be bundled.
    external: ['electron', 'koffi', 'chokidar', 'fsevents'],
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(dist, 'preload/index.js'),
    external: ['electron'],
  },
  {
    ...common,
    platform: 'browser',
    target: 'chrome120',
    entryPoints: [path.join(root, 'src/renderer/main.ts')],
    outfile: path.join(dist, 'renderer/main.js'),
  },
];

/*
 * The tray and application icons are NOT generated here any more. They are
 * produced by `npm run logo` from assets/logo/, and this build previously
 * overwrote assets/tray.png on every run, which silently clobbered the real
 * logo with a placeholder.
 */

async function copyStatic() {
  await fs.mkdir(path.join(dist, 'renderer/styles'), { recursive: true });
  await fs.copyFile(path.join(root, 'src/renderer/index.html'), path.join(dist, 'renderer/index.html'));
  for (const css of ['wall.css', 'stats.css', 'shell.css']) {
    await fs.copyFile(path.join(root, 'src/renderer/styles', css), path.join(dist, 'renderer/styles', css));
  }
}

async function run() {
  await fs.rm(dist, { recursive: true, force: true });

  if (watch) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((c) => c.watch()));
    await copyStatic();
    console.log(`[build] watching  (${edition} edition)`);
  } else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
    await copyStatic();
    console.log(`[build] done  (${edition} edition)`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
