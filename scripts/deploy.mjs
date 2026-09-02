/**
 * One command, one installation, always current.
 *
 * `npm run deploy` builds, packages, upgrades the INSTALLED app in place and
 * relaunches it. There is deliberately no second place the app can run from.
 *
 * WHY THIS RATHER THAN AUTO-UPDATE
 *
 * electron-updater is the usual answer, and it needs a release feed it can read
 * without a human. This repo is private, so the app would have to carry a
 * GitHub token: a real secret, shipped inside a desktop binary, for a tool with
 * exactly one user who happens to be sitting at the machine that builds it.
 * That trade is not worth it here. If the app is ever wanted on a second
 * machine, make releases public (or host a feed) and electron-updater becomes
 * the right call. Until then this is simpler and cannot silently drift.
 *
 * The failure this prevents: a stale installed copy while a newer build sits in
 * release/win-unpacked. That already happened once and cost real confusion.
 */

import { exec, execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const runShell = promisify(exec);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const PRODUCT = pkg.productName;

const INSTALL_DIR = path.join(os.homedir(), 'AppData', 'Local', 'Programs', PRODUCT);
const INSTALLED_EXE = path.join(INSTALL_DIR, `${PRODUCT}.exe`);
const INSTALLER = path.join(root, 'release', `${PRODUCT} Setup ${VERSION}.exe`);

const step = (msg) => console.log(`\n[deploy] ${msg}`);
const ok = (msg) => console.log(`         ${msg}`);

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function stopApp() {
  step('stopping the running app');
  try {
    await run('taskkill', ['/F', '/IM', `${PRODUCT}.exe`, '/T']);
    ok('stopped');
  } catch {
    ok('was not running');
  }
  // Windows holds the exe briefly after the process dies.
  await new Promise((r) => setTimeout(r, 1500));
}

async function build() {
  step(`building and packaging ${VERSION}`);
  /*
   * exec with a command string, not execFile.
   *
   * npm on Windows is a .cmd, which Node 20+ refuses to execFile without a
   * shell (spawn EINVAL), and passing an args array WITH shell:true is
   * deprecated because the arguments get concatenated rather than escaped.
   * exec takes a single string and uses a shell by design, which is the one
   * form that is neither broken nor deprecated. There is no interpolation
   * here, so there is nothing to escape.
   */
  await runShell('npm run package', { cwd: root, maxBuffer: 1024 * 1024 * 32 });
  if (!(await exists(INSTALLER))) throw new Error(`installer not produced at ${INSTALLER}`);
  const { size } = await fs.stat(INSTALLER);
  ok(`${path.basename(INSTALLER)}  ${(size / 1048576).toFixed(1)} MB`);
}

async function install() {
  step('upgrading the installed app in place (per-user, silent, no admin)');
  // NSIS /S is a silent install. The installer replaces the existing copy and
  // updates its own Add/Remove Programs entry, so no duplicate ever appears.
  await run(INSTALLER, ['/S'], { maxBuffer: 1024 * 1024 * 8 });
  await new Promise((r) => setTimeout(r, 2500));

  if (!(await exists(INSTALLED_EXE))) throw new Error(`installed exe missing at ${INSTALLED_EXE}`);
  ok(`installed at ${INSTALL_DIR}`);
}

/** Ask Windows what it thinks is installed, rather than trusting the installer. */
async function verify() {
  step('verifying the installed version');
  const ps = [
    '-NoProfile',
    '-Command',
    `Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -EA SilentlyContinue |` +
      ` Where-Object { $_.DisplayName -like '*${PRODUCT}*' } |` +
      ` Select-Object -ExpandProperty DisplayVersion`,
  ];
  const { stdout } = await run('powershell', ps, { maxBuffer: 1024 * 1024 });
  const found = stdout.trim().split(/\r?\n/).filter(Boolean);

  if (found.length === 0) throw new Error('no installed entry found in the registry');
  if (found.length > 1) throw new Error(`MULTIPLE installations found: ${found.join(', ')}`);
  if (found[0] !== VERSION) throw new Error(`registry says ${found[0]}, expected ${VERSION}`);
  ok(`registry reports ${found[0]}, matching package.json`);
}

/** Old installers in release/ are the thing most likely to get run by mistake. */
async function pruneOldInstallers() {
  step('pruning superseded installers');
  const dir = path.join(root, 'release');
  let removed = 0;
  for (const f of await fs.readdir(dir).catch(() => [])) {
    const isInstaller = f.startsWith(`${PRODUCT} Setup `) && (f.endsWith('.exe') || f.endsWith('.exe.blockmap'));
    if (isInstaller && !f.includes(` ${VERSION}.`)) {
      await fs.rm(path.join(dir, f), { force: true });
      removed++;
    }
  }
  ok(removed ? `removed ${removed} stale file(s)` : 'nothing stale');
}

async function relaunch() {
  step('relaunching');
  const child = spawn(INSTALLED_EXE, [], { detached: true, stdio: 'ignore' });
  child.unref();
  await new Promise((r) => setTimeout(r, 3000));
  ok('running');
}

try {
  console.log(`\n${PRODUCT} deploy  ->  ${VERSION}`);
  await build();
  await stopApp();
  await install();
  await verify();
  await pruneOldInstallers();
  await relaunch();
  console.log(`\n[deploy] done. One installation, at ${INSTALL_DIR}\n`);
} catch (err) {
  console.error(`\n[deploy] FAILED: ${err.message}\n`);
  process.exit(1);
}
