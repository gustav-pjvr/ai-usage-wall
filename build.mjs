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

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: watch,
  minify: !watch,
  logLevel: 'info',
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
  await fs.copyFile(
    path.join(root, 'src/renderer/styles/wall.css'),
    path.join(dist, 'renderer/styles/wall.css'),
  );
}

async function run() {
  await fs.rm(dist, { recursive: true, force: true });

  if (watch) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((c) => c.watch()));
    await copyStatic();
    console.log('[build] watching');
  } else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
    await copyStatic();
    console.log('[build] done');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
