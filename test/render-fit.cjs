/**
 * Does the dashboard actually FIT, at every screen size it might land on?
 *
 *   npm run test:render
 *
 * WHY THIS TEST EXISTS
 *
 * Gustav ran the app on another machine and the text was cut off. Nothing in
 * the suite could have caught that, because every existing test checks values
 * and none of them checks pixels. The panels were fluid and their contents were
 * fixed pixels, so on a smaller screen the boxes shrank and the words did not.
 *
 * WHAT IT MEASURES, AND WHY IT IS NOT A PROXY
 *
 * This project's expensive mistakes have all been the same shape: checking
 * something adjacent to the thing that mattered. Z-order was verified and
 * rendering assumed. An element's `hidden` property was read back while the
 * element was on screen.
 *
 * So this does not read a font size and reason about it. It loads the real
 * renderer, with the real stylesheet, at a real window size, waits for the
 * numbers to settle, and then asks the layout engine two questions:
 *
 *   1. Does any panel's content overflow its own box? `.panel` clips, so
 *      `scrollHeight > clientHeight` IS the clipping, not a sign of it.
 *   2. Does any text element's rectangle escape the content box of the panel
 *      it lives in? That catches the case where an inner wrapper scrolls
 *      instead of the panel and the clip happens one level down.
 *
 * Ellipsis truncation is excluded deliberately: `.bd-label` asks for it, and a
 * label that ends in "..." is a design decision rather than a defect.
 *
 * Set CSW_SHOTS to a directory to also write a PNG per size. Measurements say
 * nothing overflows; a picture says whether it still looks like the dashboard.
 */

const { app, BrowserWindow, ipcMain } = require('electron');

/*
 * A crash must END the run, never park it behind a dialog.
 *
 * Electron's default for an uncaught exception in the main process is a modal
 * "A JavaScript error occurred" box that waits for a click. On 2026-09-08 a
 * broken test did exactly that and left two whole Electron process trees, GPU
 * and network helpers included, sitting on Gustav's desktop until he noticed.
 *
 * Three layers, because each covers a case the others cannot:
 *   1. these handlers, for anything thrown or rejected once the file is running;
 *   2. a watchdog, for a run that hangs without throwing;
 *   3. `node --check` in the npm script, for a SYNTAX error, which stops the
 *      file before line one and so before any handler here exists.
 */
const die = (what, err) => {
  console.error(`\n  FATAL  ${what}: ${err && err.stack ? err.stack : err}`);
  // app.exit before the app is ready ends in a segfault (exit 139), which reads
  // like a different failure. Before ready, a plain process exit is the clean one.
  if (app.isReady()) app.exit(2);
  else process.exit(2);
};
process.on('uncaughtException', (err) => die('uncaught exception', err));
process.on('unhandledRejection', (err) => die('unhandled rejection', err));
const WATCHDOG_MS = 240000;
setTimeout(() => die('watchdog', new Error(`still running after ${WATCHDOG_MS / 1000}s`)), WATCHDOG_MS).unref();
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'dist', 'renderer', 'index.html');
const PRELOAD = path.join(ROOT, 'dist', 'preload', 'index.js');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'csw-render-')));
// The wall paints a transparent window over the desktop in normal use. Here it
// is an ordinary window, so give it the same backdrop the desktop would.
app.commandLine.appendSwitch('force-color-profile', 'srgb');

const SHOTS = process.env.CSW_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const saved = [];
let seenCalls = 0;
/** Every day the renderer asked the main process for, in order. */
const dayCalls = [];
let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`);
  }
};

/*
 * The sizes. 1920x1080 is Gustav's desktop and the reference the unit scale is
 * pinned to. 1366x768 is the single most common laptop panel still shipping and
 * the worst case here: narrow AND short. 2560x1440 checks the other end, where
 * the risk is not clipping but a dashboard that has quietly become a poster.
 */
const SIZES = [
  { w: 2560, h: 1440, label: '2560x1440  (QHD)' },
  { w: 1920, h: 1200, label: '1920x1200  (16:10, same width as reference)' },
  { w: 1920, h: 1080, label: '1920x1080  (reference)' },
  { w: 1600, h: 900, label: '1600x900' },
  { w: 1512, h: 982, label: '1512x982   (14 inch laptop)' },
  { w: 1440, h: 900, label: '1440x900' },
  { w: 1366, h: 768, label: '1366x768   (worst case)' },
  { w: 1280, h: 800, label: '1280x800' },
];

/** `YYYY-MM-DD` of the local day `ms` is in, as src/shared/day.ts makes it. */
const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const DAY_MS = 86_400_000;

/*
 * When the fixture's hours start, and the note the Hours block should print for
 * it, formatted here the way the renderer does, in this machine's time zone, so
 * the check holds wherever the suite runs (the review found "11 Jul" alone fails
 * east of UTC+9).
 */
const HOURS_SINCE_MS = Date.parse('2026-07-11T14:58:58Z');
const HOURS_SINCE = (() => {
  const d = new Date(HOURS_SINCE_MS);
  const opts = d.getFullYear() === new Date().getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
  return `since ${d.toLocaleDateString('en-GB', opts)}`;
})();
const WS = 'C:\\Users\\HP 865 G10\\Desktop\\Claude WorkSpace\\';
const TL_PROJECTS = ['muchbetter-client-wall', 'Rwenzori Marathon', 'swrc-website-v2'];

/**
 * One day's five-minute detail, shaped exactly as `wall:timelapseDay` returns
 * it: forty slots across three projects with one clear peak. For today, only
 * slots that have already started, ending at the current one, so the replay
 * stops at now whatever time the suite runs.
 */
function fixtureDay(day, now) {
  const today = day === dayKey(now);
  const d = new Date(now);
  const nowSlot = Math.floor((d.getHours() * 60 + d.getMinutes()) / 5);
  const last = today ? nowSlot : 108 + 79;
  const first = Math.max(0, last - 79);
  const projects = {};
  let i = 0;
  for (let b = first; b <= last; b += 2, i++) {
    const p = TL_PROJECTS[i % 3];
    const key = (WS + p).toLowerCase();
    const peak = i === 23 ? 12 : 1; // one slot far above the rest
    (projects[key] ??= { display: WS + p, cells: {} }).cells[String(b)] = [7 * peak, 3_100_000 * peak + i * 41_000, 21_000 * peak + i * 300];
  }
  const shaped = Object.values(projects).reduce((n, p) => n + Object.values(p.cells).reduce((a, c) => a + c[0], 0), 0);
  return { day, asOf: now, bucketMinutes: 5, projects, requests: shaped, shapedRequests: shaped };
}

/** The picker's days: today and yesterday full, two days ago partial, three days ago a total only. */
function fixtureDays(now) {
  const n = (k) => dayKey(now - k * DAY_MS);
  return {
    today: n(0),
    days: {
      [n(0)]: { requests: 280, shaped: 280 },
      [n(1)]: { requests: 280, shaped: 280 },
      [n(2)]: { requests: 335, shaped: 320 },
      [n(3)]: { requests: 1_200, shaped: 0 },
    },
  };
}

/**
 * A deliberately awkward index. Real magnitudes from this machine, plus the
 * longest plausible project and model names, because a name that fits is not
 * evidence that names fit.
 */
function fixture(emptyIndex) {
  const idx = emptyIndex();
  const now = Date.now();
  const t = (input, output, cacheCreate, cacheRead, requests, costUsd) => ({
    input,
    output,
    cacheCreate,
    cacheRead,
    thinking: 0,
    requests,
    webSearch: 0,
    webFetch: 0,
    costUsd,
    unpricedTokens: 0,
  });

  idx.totals = t(48_100_000, 62_400_000, 690_000_000, 25_300_000_000, 72_060, 48_479.2412);
  idx.unavailable = false;
  idx.lastScanMs = 118;
  idx.sourceHealth = { checkedAt: new Date().toISOString(), t3: 'ready', fallbackSessions: 12, skippedTurns: 3 };
  idx.latest = {
    ts: new Date(now - 40_000).toISOString(),
    model: 'claude-opus-5',
    sessionId: 'ad4467e7-438b-4552-b4f1-04373d3d184e',
    version: '2.0.14',
    cwd: 'C:\\Users\\HP 865 G10\\Desktop\\Claude WorkSpace\\muchbetter-client-wall',
  };

  for (let d = 13; d >= 0; d--) {
    const day = new Date(now - d * 86_400_000).toISOString().slice(0, 10);
    idx.daily[day] = t(3_400_000, 4_300_000, 49_000_000, 1_800_000_000, 5_100, 91.4321);
  }
  // Keyed 'YYYY-MM-DDTHH', which is what usage.ts writes and what the renderer
  // parses with `new Date(k + ':00:00Z')`. A bare '07' produced an Invalid Date,
  // every bucket landed on index NaN, and the hours panel silently rendered
  // empty. An empty panel cannot overflow, so the test was passing on a panel it
  // was not actually exercising.
  for (let d = 0; d < 14; d++) {
    const day = new Date(now - d * 86_400_000).toISOString().slice(0, 10);
    for (let h = 0; h < 24; h++) {
      const lean = h >= 9 && h <= 23 ? 1 : 0.12;
      idx.hourly[`${day}T${String(h).padStart(2, '0')}`] = t(
        Math.round(2_000_000 * lean),
        Math.round(2_600_000 * lean),
        Math.round(28_000_000 * lean),
        Math.round(1_050_000_000 * lean),
        Math.round(3_000 * lean),
        53.21 * lean,
      );
    }
  }

  // Long, similar names on purpose: these are the ones that overflow a label.
  const projects = [
    'muchbetter-client-wall',
    'citadelofstreamers',
    'pickleplay-south-africa',
    'supabase-keepalive',
    'r4tw-website-production',
    'kickstart-football-migration',
  ];
  // Keyed like the real index: the lowercased cwd, with the original casing in
  // `display`. Uppercase keys here once meant the active project and the links
  // were never exercised, because nothing could find them by the real key.
  // Sizes spread across the log buckets so every star size is drawn.
  const scales = [1, 0.4, 0.12, 0.05, 0.012, 0.004];
  projects.forEach((name, i) => {
    const cwd = `C:\\Users\\HP 865 G10\\Desktop\\Claude WorkSpace\\${name}`;
    const k = scales[i];
    idx.projects[cwd.toLowerCase()] = {
      ...t(9_000_000 * k, 11_000_000 * k, 130_000_000 * k, 4_600_000_000 * k, 12_000, 240.5 - i * 30),
      lastSeen: new Date(now - i * 2 * 86_400_000).toISOString(),
      display: cwd,
    };
    // Sessions landing on shared days, so the sky has links to draw.
    const start = now - (i % 3) * 86_400_000;
    idx.sessions[`s${i}`] = {
      id: `s${i}`,
      start: new Date(start).toISOString(),
      end: new Date(start + 3_600_000).toISOString(),
      requests: 100,
      output: 1000,
      total: 1e6,
      cwd,
      models: ['claude-opus-5'],
    };
  });

  for (const m of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001']) {
    idx.models[m] = t(12_000_000, 15_000_000, 170_000_000, 6_300_000_000, 18_000, 321.12);
  }

  // Twenty minutes of live traffic, so the chart and the velocity card are
  // both populated rather than sitting in their empty state.
  for (let i = 150; i >= 0; i--) {
    idx.recent.push([now - i * 8_000, 260_000 + ((i * 7919) % 180_000), 3_400]);
  }

  idx.prompts = { total: 4_812, daily: {}, lastAt: new Date(now - 90_000).toISOString(), offset: 0, size: 0 };
  idx.peak = { velocity: 26_400_000, at: new Date(now - 3 * 86_400_000).toISOString() };
  // Hours as main sends them: 9,999 whole hours, about forty times this machine's
  // figure in October 2026, so the number is as wide as it will be for years.
  idx.activeTime = { seconds: 9_999 * 3600 + 1800, since: HOURS_SINCE_MS };

  // History as the main process merges it in (src/shared/usage-merge.ts), with
  // the longest caption and footer it can produce, so both are measured.
  idx.history = {
    archivedFiles: 12, archivedSessions: 9, reconstructedSessions: 52, reconstructedFiles: 349,
    archived: t(1, 1, 1, 1, 1, 0),
    reconstructed: t(1_000_000, 39_000_000, 530_000_000, 19_000_000_000, 54_000, 16480.82),
    reconstructedFrom: 'a snapshot of 22 Sep 2026',
    unattributedTokens: 8_350_000_000,
  };
  idx.fileCount = 463;

  // Today has requests, so "Today" is enabled. The five-minute detail itself
  // never rides on the usage push; it comes from the two stubs below.
  idx.activeDays[dayKey(now)] = 2_685;

  // A ledger as the main process would hand it over: one unseen, one dated,
  // one seeded, with the longest titles the ladders can produce.
  idx.milestones = {
    achieved: [
      { key: 'processed:25B', title: '25B tokens processed', sub: 'as the headline counts them, mostly cache reads', at: new Date(now).toISOString(), seeded: false },
      { key: 'model:claude-haiku-4-5-20251001', title: 'First use of claude-haiku-4-5-20251001', sub: 'a model this machine had not used before', at: new Date(now - 5 * 86_400_000).toISOString(), seeded: false },
      { key: 'requests:50K', title: '50K requests', sub: 'assistant replies, all projects', at: new Date(now - 40 * 86_400_000).toISOString(), seeded: true },
    ],
    unseen: ['processed:25B'],
    next: [
      { title: '50B tokens processed', progress: 0.04, remaining: '23.9B to go' },
      { title: '100M tokens generated', progress: 0.25, remaining: '37.6M to go' },
      { title: '100K requests', progress: 0.44, remaining: '27.9K to go' },
      { title: '30 day streak', progress: 0.5, remaining: '16 days to go' },
    ],
  };
  return idx;
}

const state = (w, h) => ({
  clients: [],
  problems: [],
  vault: { available: false, scanned: 0, matched: 0 },
  settings: {
    mode: 'stats',
    debug: false,
    layerMode: 'desktop',
    clickThrough: false,
    opacity: 1,
    background: 'gradient',
    backgroundOpacity: 1,
    densityScale: 1,
    pageRotateSeconds: 45,
    notes: '',
  },
  capability: { tier: 'high', cores: 8, memoryGb: 16, gpuAccelerated: true, reasons: [] },
  focusMode: false,
  mode: 'stats',
  appVersion: '0.9.11',
  effectiveLayerMode: 'desktop',
  inputReachable: true,
  display: { id: 1, width: w, height: h, scaleFactor: 1, isPrimary: true, index: 0, total: 1 },
  win32: { available: true, reason: null },
});

/*
 * Runs INSIDE the page. Returns findings rather than assertions, so a failure
 * arrives with the element, the size it wanted and the size it got.
 */
const PROBE = `(() => {
  const findings = [];
  const round = (n) => Math.round(n * 10) / 10;

  // A panel hidden by design (the Hours block with nothing measured) has a zero rect; it is not on screen.
  const panels = [...document.querySelectorAll('#view-stats .panel')].filter((p) => p.getBoundingClientRect().width > 0);
  if (!panels.length) return { fatal: 'no panels rendered' };

  for (const p of panels) {
    const title = (p.querySelector('.panel-title') || {}).textContent || '(untitled)';
    const overH = p.scrollHeight - p.clientHeight;
    const overW = p.scrollWidth - p.clientWidth;
    if (overH > 1) findings.push(title + ': content is ' + overH + 'px taller than the panel');
    if (overW > 1) findings.push(title + ': content is ' + overW + 'px wider than the panel');

    // One level down: an inner wrapper can absorb the overflow and clip there
    // while the panel itself measures clean.
    for (const kid of p.querySelectorAll('*')) {
      const cs = getComputedStyle(kid);
      if (cs.overflow === 'visible') continue;
      if (cs.textOverflow === 'ellipsis') continue;
      const dh = kid.scrollHeight - kid.clientHeight;
      const dw = kid.scrollWidth - kid.clientWidth;
      if (dh > 1) findings.push(title + ' > .' + (kid.className || kid.tagName) + ': clipped ' + dh + 'px vertically');
      if (dw > 1) findings.push(title + ' > .' + (kid.className || kid.tagName) + ': clipped ' + dw + 'px horizontally');
    }

    // Text that has escaped the panel's content box entirely.
    const box = p.getBoundingClientRect();
    const cs = getComputedStyle(p);
    const padT = parseFloat(cs.paddingTop), padB = parseFloat(cs.paddingBottom);
    const padL = parseFloat(cs.paddingLeft), padR = parseFloat(cs.paddingRight);
    for (const kid of p.querySelectorAll('*')) {
      if (!kid.textContent || !kid.textContent.trim()) continue;
      if (kid.children.length) continue;
      if (getComputedStyle(kid).position === 'absolute') continue;
      const r = kid.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.bottom > box.bottom - padB + 1)
        findings.push(title + ' > "' + kid.textContent.trim().slice(0, 24) + '": ' + round(r.bottom - (box.bottom - padB)) + 'px below the panel floor');
      if (r.right > box.right - padR + 1)
        findings.push(title + ' > "' + kid.textContent.trim().slice(0, 24) + '": ' + round(r.right - (box.right - padR)) + 'px past the panel edge');
    }
  }

  // The smallest text actually on screen, so "it fits" cannot be achieved by
  // shrinking the labels into illegibility.
  let smallest = 99;
  let smallestOn = '';
  for (const kid of document.querySelectorAll('#view-stats .panel *, #view-stats .status-strip *')) {
    if (!kid.textContent || !kid.textContent.trim() || kid.children.length) continue;
    const r = kid.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const fs = parseFloat(getComputedStyle(kid).fontSize);
    if (fs < smallest) { smallest = fs; smallestOn = kid.className || kid.tagName; }
  }

  // The floating mode switch against the panels it is supposed to clear. Its
  // offset scales; its height has to scale with it or the clearance is fiction.
  // (No backticks in here: PROBE is a template literal, and a stray pair ends
  // the string early and turns the rest of this file into a syntax error.)
  const sw = document.querySelector('#mode-switch');
  const bar = document.querySelector('#notes-bar');
  const panelTop = Math.min(...panels.map((p) => p.getBoundingClientRect().top));
  const switchOver = sw ? round(sw.getBoundingClientRect().bottom - panelTop) : -99;
  const barOverSwitch = sw && bar ? round(bar.getBoundingClientRect().bottom - sw.getBoundingClientRect().top) : -99;

  const strip = document.querySelector('#view-stats .status-strip');
  const grid = document.querySelector('#view-stats .stats-grid');
  const stats = document.querySelector('#view-stats .stats');
  const stripOver = strip && stats
    ? Math.round(strip.getBoundingClientRect().bottom - stats.getBoundingClientRect().bottom)
    : 0;

  return {
    findings,
    switchOver,
    barOverSwitch,
    smallest: round(smallest),
    smallestOn,
    stripOver,
    unit: (() => {
      // getPropertyValue('--u') returns the literal 'clamp(...)' token, not a
      // length: custom properties resolve at use, not at computed-value time.
      // So USE it, and measure what came out.
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;height:calc(var(--u) * 100)';
      document.body.appendChild(probe);
      const u = probe.getBoundingClientRect().height / 100;
      probe.remove();
      return Math.round(u * 1000) / 1000;
    })(),
    hero: (document.querySelector('.hero-value') || {}).textContent || '',
    gridH: grid ? Math.round(grid.getBoundingClientRect().height) : 0,
  };
})()`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Enough for one IPC round trip to the main process and back. */
const SETTLE = 150;

/*
 * One window for the whole run, resized between sizes.
 *
 * It was one window per size to begin with, and the second load failed with
 * ERR_FAILED every time. Resizing is also closer to the truth: the app does not
 * relaunch when a laptop is docked to a bigger monitor, it reflows, so this
 * exercises the same path a real screen change does.
 */
async function measure(win, size) {
  win.setContentSize(size.w, size.h);
  // Layout, media query re-evaluation and the canvas resize settle inside a
  // couple of frames. The wait is generous because a short one would produce a
  // false PASS, which is the expensive direction to be wrong in.
  await wait(700);
  if (SHOTS) {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(SHOTS, `${size.w}x${size.h}.png`), img.toPNG());
  }
  return win.webContents.executeJavaScript(PROBE);
}

app.whenReady().then(async () => {
  if (!fs.existsSync(RENDERER) || !fs.existsSync(PRELOAD)) {
    console.error('dist/ is missing. Run `npm run build` first.');
    app.exit(1);
    return;
  }

  const bundle = path.join(app.getPath('userData'), 'usage.cjs');
  await require('esbuild').build({
    entryPoints: [path.join(ROOT, 'src', 'main', 'data', 'usage.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['electron'],
    logLevel: 'error',
  });
  const { emptyIndex } = require(bundle);
  const idx = fixture(emptyIndex);

  ipcMain.handle('wall:getState', () => state(SIZES[0].w, SIZES[0].h));
  ipcMain.handle('wall:getUsage', () => idx);
  ipcMain.handle('wall:updateSettings', (_e, patch) => {
    saved.push(patch);
  });
  ipcMain.handle('wall:setMode', () => undefined);
  ipcMain.handle('wall:milestonesSeen', () => {
    seenCalls++;
  });
  ipcMain.handle('wall:timelapseDays', () => fixtureDays(Date.now()));
  ipcMain.handle('wall:timelapseDay', (_e, day) => {
    dayCalls.push(day);
    return fixtureDay(day, Date.now());
  });
  ipcMain.handle('wall:reload', () => undefined);
  ipcMain.handle('wall:toggleFocus', () => undefined);
  ipcMain.handle('wall:exitFocus', () => undefined);
  ipcMain.handle('wall:openExternal', () => undefined);
  ipcMain.handle('wall:installUpdate', () => undefined);

  /*
   * Built with the WALL'S OWN window options, not a convenient test window.
   *
   * `focusable: false` and `type: 'toolbar'` are what let the wall sit behind
   * everything without stealing focus, and they are also why a text input in it
   * cannot receive a keystroke until the main process lends it focus. A default
   * BrowserWindow here would prove the notes bar's state machine and say nothing
   * about whether the feature works, which is the exact shape of mistake this
   * file's header is about.
   */
  const win = new BrowserWindow({
    width: SIZES[0].w,
    height: SIZES[0].h,
    useContentSize: true,
    show: true,
    frame: false,
    focusable: false,
    type: 'toolbar',
    // Visible, because a hidden window does not run requestAnimationFrame and
    // the odometers would never settle on their final string. Almost fully
    // transparent so a run does not take over the screen.
    opacity: 0.02,
    skipTaskbar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });

  /*
   * The focus handoff, mirroring `wall:notesEdit` in src/main/index.ts. The
   * production handler also flips `wall.notesEditing` and re-runs applyLayer,
   * neither of which exists here; what is under test is the part the renderer
   * depends on, which is that focus is really granted and really given back.
   */
  ipcMain.handle('wall:notesEdit', (_e, active) => {
    if (active) {
      win.setFocusable(true);
      win.focus();
      return win.isFocused();
    }
    win.setFocusable(false);
    return false;
  });
  await win.loadFile(RENDERER);
  // Long enough for the panel entrance (0.62s plus stagger) and the odometers,
  // which count up and therefore change the STRING LENGTH of every headline
  // while they run. Measuring early measures a shorter number than ships.
  await wait(2600);

  console.log('\nDoes the dashboard fit?\n');
  for (const size of SIZES) {
    const r = await measure(win, size);
    if (r.fatal) {
      ok(size.label, false, r.fatal);
      continue;
    }
    const detail = r.findings.length ? r.findings.slice(0, 6).join('\n        ') : '';
    ok(
      `${size.label}   u=${r.unit}  smallest text ${r.smallest}px  hero "${r.hero}"`,
      r.findings.length === 0,
      detail + (r.findings.length > 6 ? `\n        (+${r.findings.length - 6} more)` : ''),
    );
    // A dashboard that fits because nothing can be read has not been fixed.
    ok(`${size.label}   smallest text is legible (>= 8px, on .${r.smallestOn})`, r.smallest >= 8);
    ok(`${size.label}   status strip inside the view (${r.stripOver}px past)`, r.stripOver <= 1);
    ok(`${size.label}   mode switch clears the panels (${r.switchOver}px into them)`, r.switchOver <= 0);

    // Reconstructed history is disclosed by the strip's archived count and the
    // projects footnote (rule 12). Gustav removed the hero caption as noise on
    // 2026-09-22; these two are what carry it, so they are measured here.
    const hist = await win.webContents.executeJavaScript(`(() => {
      const shown = (sel, panelSel) => {
        const n = document.querySelector(sel), p = document.querySelector(panelSel);
        if (!n || !p || !n.textContent) return { text: '', inside: false };
        const r = n.getBoundingClientRect(), b = p.getBoundingClientRect();
        return { text: n.textContent, inside: r.width > 0 && r.height > 0 && r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.bottom <= b.bottom + 0.5 };
      };
      return { foot: shown('.proj-foot', '.panel-projects'),
               strip: (document.querySelector('.status-source') || {}).textContent || '' };
    })()`);
    ok(`${size.label}   unattributed history is footnoted on the projects panel`, /no project/.test(hist.foot.text) && hist.foot.inside, hist.foot.text);
    ok(`${size.label}   the strip counts archived transcripts ("${hist.strip}")`, /463 transcripts on disk, 361 archived/.test(hist.strip));

    /*
     * The constellation draws on a canvas, so the DOM checks above cannot see
     * its stars or its labels. It exposes the layout it actually painted, and
     * these check that, not a recomputation of it.
     */
    const c = await win.webContents.executeJavaScript(`(() => {
      const g = window.__cswConstellation && window.__cswConstellation();
      if (!g || !g.layout) return { missing: true };
      const W = g.layout.width, H = g.layout.height;
      const stars = g.layout.stars;
      const outStar = stars.filter((s) => s.x - s.size / 2 < -0.5 || s.y - s.size / 2 < -0.5 || s.x + s.size / 2 > W + 0.5 || s.y + s.size / 2 > H + 0.5).length;
      const outLabel = g.labels.filter((l) => l.x < 0 || l.y < 0 || l.x + l.w > W || l.y + l.h > H).length;
      let overlap = 0;
      for (let i = 0; i < g.labels.length; i++) for (let j = i + 1; j < g.labels.length; j++) {
        const a = g.labels[i], b = g.labels[j];
        if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) overlap++;
      }
      // The pulse is a DOM element over the canvas; a layout flag saying "active"
      // proves nothing about whether the ring is on screen over the right star.
      const pulse = document.querySelector('.const-pulse');
      const act = stars.find((s) => s.active);
      let pulseOk = false;
      if (pulse && act && !pulse.hidden && getComputedStyle(pulse).display !== 'none') {
        const pr = pulse.getBoundingClientRect();
        const cx = g.canvas.x + act.x, cy = g.canvas.y + act.y;
        pulseOk = pr.width > 0 && Math.abs(pr.x + pr.width / 2 - cx) < 1.5 && Math.abs(pr.y + pr.height / 2 - cy) < 1.5;
      }
      return { stars: stars.length, links: g.layout.links.length, labels: g.labels.length, active: stars.filter((s) => s.active).length, pulseOk,
               outStar, outLabel, overlap, paintMs: g.paintMs, minLabelH: Math.min(...g.labels.map((l) => l.h), 99) };
    })()`);
    ok(`${size.label}   constellation drew (${c.stars} stars, ${c.links} links, ${c.labels} labels, paint ${c.paintMs}ms)`,
       !c.missing && c.stars > 0 && c.links > 0 && c.labels > 0);
    ok(`${size.label}   every star and label is inside the panel`, c.outStar === 0 && c.outLabel === 0,
       `${c.outStar} stars and ${c.outLabel} labels outside`);
    ok(`${size.label}   no two constellation labels overlap`, c.overlap === 0, `${c.overlap} overlapping pairs`);
    ok(`${size.label}   constellation labels are legible (line ${c.minLabelH}px)`, c.minLabelH >= 10);
    const act = await win.webContents.executeJavaScript(`(() => {
      const a = document.querySelector('#wall-actions');
      if (!a) return { missing: true };
      const r = a.getBoundingClientRect();
      const bar = document.querySelector('#notes-bar').getBoundingClientRect();
      const sw = document.querySelector('#mode-switch').getBoundingClientRect();
      const top = Math.min(...[...document.querySelectorAll('#view-stats .panel')].map((p) => p.getBoundingClientRect()).filter((r) => r.width > 0).map((r) => r.top));
      const badge = a.querySelector('.wall-badge');
      return {
        inside: r.left >= 0 && r.right <= innerWidth + 0.5 && r.top >= 0,
        belowBar: r.top >= bar.bottom - 0.5,
        abovePanels: r.bottom <= top + 0.5,
        clearOfSwitch: r.left >= sw.right + 4 || r.right <= sw.left - 4,
        buttons: [...a.querySelectorAll('.wall-action')].filter((b) => getComputedStyle(b).display !== 'none').length,
        badge: badge && getComputedStyle(badge).display !== 'none' ? badge.textContent : null,
        fontPx: Math.min(...[...a.querySelectorAll('.wall-action')].map((b) => parseFloat(getComputedStyle(b).fontSize))),
      };
    })()`);
    ok(`${size.label}   Today, Any day and Milestones buttons shown, badge reads ${act.badge}`,
       !act.missing && act.buttons === 3 && act.badge === '1');
    ok(`${size.label}   the buttons sit under the notes bar, above the panels, clear of the switch`,
       act.inside && act.belowBar && act.abovePanels && act.clearOfSwitch, JSON.stringify(act));
    ok(`${size.label}   button text is legible (${act.fontPx}px)`, act.fontPx >= 8);
    const ran = await win.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('#view-stats .cost-row');
      if (!row) return { missing: true };
      const box = (sel) => row.querySelector(sel)?.getBoundingClientRect();
      const cost = box('.panel-cost'), hours = box('.panel-ran');
      const inside = (sel, panel) => { const r = box(sel); return !!r && r.width > 0 && r.left >= panel.left - 0.5 && r.right <= panel.right + 0.5 && r.top >= panel.top - 0.5 && r.bottom <= panel.bottom + 0.5; };
      const oneLine = (sel) => { const e = row.querySelector(sel); const lh = parseFloat(getComputedStyle(e).fontSize); return e.getBoundingClientRect().height <= lh * 1.4; };
      return {
        on: row.dataset.hours === 'on' && getComputedStyle(row.querySelector('.panel-ran')).display !== 'none',
        value: row.querySelector('.ran-value').textContent,
        note: row.querySelector('.ran-note').textContent,
        title: row.querySelector('.panel-ran .panel-title').textContent,
        costWider: cost.width > hours.width * 1.4, // 1.4 with the 9,999 stress figure; about 2x with a real 3 digit one
        sideBySide: Math.abs(cost.top - hours.top) < 1 && hours.left > cost.right,
        allInside: ['.ran-value', '.ran-note', '.panel-ran .panel-title', '.panel-ran .tag'].every((s) => inside(s, hours)) && inside('.cost-value', cost),
        oneLine: oneLine('.ran-value') && oneLine('.cost-value'),
        px: Math.min(...['.ran-value', '.ran-note', '.panel-ran .panel-title'].map((s) => parseFloat(getComputedStyle(row.querySelector(s)).fontSize))),
      };
    })()`);
    ok(`${size.label}   Hours sits beside Total cost, which keeps most of the row`,
       !ran.missing && ran.on && ran.sideBySide && ran.costWider, JSON.stringify(ran));
    ok(`${size.label}   Hours reads ${ran.value} (${ran.note}), whole hours, never days`,
       ran.value === '9,999' && ran.note === HOURS_SINCE && ran.title === 'Hours');
    ok(`${size.label}   both numbers stay on one line, inside their panels, legible (${ran.px}px)`,
       ran.allInside && ran.oneLine && ran.px >= 8, JSON.stringify(ran));
    ok(`${size.label}   exactly one star is marked active, and the pulse ring sits on it`, c.active === 1 && c.pulseOk,
       `${c.active} active, pulse ${c.pulseOk ? 'placed' : 'missing or misplaced'}`);
    ok(`${size.label}   notes bar clears the mode switch (${r.barOverSwitch}px into it)`, r.barOverSwitch <= 0);
  }

  // ── The notes bar ──────────────────────────────────────────────────────
  //
  // Geometry first, then the lock, which is the whole feature. The lock is
  // checked by its EFFECT (where the caret actually is, what the main process
  // was actually asked to save) rather than by reading back the readOnly flag
  // this code just set. Reading back the property you just wrote is how this
  // project shipped a `hidden` element that was plainly visible.
  await measure(win, { w: 1600, h: 900 });

  const geom = await win.webContents.executeJavaScript(`(() => {
    const bar = document.querySelector('#notes-bar');
    if (!bar) return { missing: true };
    const b = bar.getBoundingClientRect();
    const sw = document.querySelector('#mode-switch');
    const s = sw ? sw.getBoundingClientRect() : null;
    const panels = [...document.querySelectorAll('#view-stats .panel')].map((p) => p.getBoundingClientRect()).filter((r) => r.width > 0);
    const topPanel = Math.min(...panels.map((r) => r.top));
    return {
      left: Math.round(b.left),
      right: Math.round(b.right),
      width: Math.round(b.width),
      height: Math.round(b.height),
      viewport: window.innerWidth,
      overlapsSwitch: s ? b.bottom > s.top + 0.5 : false,
      overlapsPanels: b.bottom > topPanel + 0.5,
      visible: getComputedStyle(bar).display !== 'none' && b.height > 0,
    };
  })()`);

  ok('notes bar is present and visible', !geom.missing && geom.visible);
  ok(
    `notes bar spans the full width (${geom.left} to ${geom.right} of ${geom.viewport})`,
    geom.left === 0 && geom.width === geom.viewport,
  );
  ok('notes bar does not overlap the mode switch', geom.overlapsSwitch === false);
  ok('notes bar does not overlap the panels', geom.overlapsPanels === false);

  /*
   * A REAL single click, delivered through Chromium's input pipeline rather
   * than a synthetic MouseEvent.
   *
   * This distinction is the whole point of the check. A `new MouseEvent(...)`
   * dispatched from script does not move focus, so the synthetic tests below
   * cannot see the bug this one is here for: a readonly input still accepts
   * focus from an ordinary click, and the keydown handler then swallowed every
   * keystroke while the bar still said "locked".
   */
  await win.webContents.executeJavaScript(`(() => {
    window.__keysSeen = 0;
    document.addEventListener('keydown', () => { window.__keysSeen++; });
  })()`);

  /*
   * Open an edit and wait for it to actually be open.
   *
   * unlock() asks the main process for keyboard focus and awaits the answer
   * before it changes anything, so dispatching the double click and reading the
   * state in the same call measures the state before the handoff resolved. Four
   * checks failed exactly that way, which is the async version of reading back
   * the property you just set.
   */
  const unlockBar = async () => {
    await win.webContents.executeJavaScript(
      `document.querySelector('#notes-bar').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))`,
    );
    await wait(SETTLE);
  };

  const clickAt = async (x, y, clickCount) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount });
    await wait(60);
  };

  await clickAt(240, 8, 1);
  const stray = await win.webContents.executeJavaScript(`(() => {
    const bar = document.querySelector('#notes-bar');
    const input = bar.querySelector('.notes-input');
    const before = window.__keysSeen;
    // A single letter, the shape of a global shortcut.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true }));
    return {
      state: bar.dataset.state,
      focused: document.activeElement === input,
      keyReachedDocument: window.__keysSeen > before,
    };
  })()`);
  ok('a stray single click does not take the caret', stray.focused === false && stray.state === 'locked');
  ok('and does not swallow a key meant for the wall', stray.keyReachedDocument === true);

  await clickAt(240, 8, 2);
  const realDbl = await win.webContents.executeJavaScript(`(() => {
    const bar = document.querySelector('#notes-bar');
    const input = bar.querySelector('.notes-input');
    return { state: bar.dataset.state, focused: document.activeElement === input, readOnly: input.readOnly };
  })()`);
  ok(
    'a real double click still unlocks and takes the caret',
    realDbl.state === 'editing' && realDbl.focused === true && realDbl.readOnly === false,
  );
  await win.webContents.executeJavaScript(`document.querySelector('#notes-bar .notes-input').blur()`);
  await wait(SETTLE);

  const before = await win.webContents.executeJavaScript(`(() => {
    const bar = document.querySelector('#notes-bar');
    const input = bar.querySelector('.notes-input');
    return { state: bar.dataset.state, readOnly: input.readOnly, focused: document.activeElement === input };
  })()`);
  const notFocusableWhileLocked = win.isFocusable() === false;

  await unlockBar();
  const dbl = await win.webContents.executeJavaScript(`(() => {
    const bar = document.querySelector('#notes-bar');
    const input = bar.querySelector('.notes-input');
    return {
      state: bar.dataset.state,
      readOnly: input.readOnly,
      focused: document.activeElement === input,
    };
  })()`);

  ok('locked before anything touches it', before.state === 'locked' && before.readOnly === true && before.focused === false);
  ok('the wall is not focusable while locked', notFocusableWhileLocked);
  ok('double click unlocks it and takes the caret', dbl.state === 'editing' && dbl.readOnly === false && dbl.focused === true);
  // The one that matters. Without this the field would take DOM focus, paint
  // its editing state, and send every keystroke to whatever app was in front.
  ok('and the wall really holds keyboard focus while editing', win.isFocusable() === true && win.isFocused() === true);

  // Type through real key events where it matters, so the keydown handler that
  // stops single-letter shortcuts reaching the window is on the path.
  const typed = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#notes-bar .notes-input');
    input.value = 'npm run deploy  |  relay: wrangler tail';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  ok('accepts text while unlocked', typed.startsWith('npm run deploy'));

  const clicked = await win.webContents.executeJavaScript(`(() => {
    // A click somewhere else on the wall, which is how it will actually be
    // locked: not by pressing anything, by looking away.
    document.querySelector('#view-stats').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.querySelector('#notes-bar .notes-input').blur();
    const bar = document.querySelector('#notes-bar');
    const input = bar.querySelector('.notes-input');
    return { state: bar.dataset.state, readOnly: input.readOnly, focused: document.activeElement === input, value: input.value };
  })()`);

  ok('clicking away locks it again', clicked.state === 'locked' && clicked.readOnly === true && clicked.focused === false);
  ok('and keyboard focus is handed straight back', win.isFocusable() === false);
  ok('the text survives the lock', clicked.value.startsWith('npm run deploy'));
  const savedNote = saved.filter((x) => x && typeof x.notes === 'string').pop();
  ok(
    `the note reached the main process (${savedNote ? JSON.stringify(savedNote.notes).slice(0, 44) : 'nothing saved'})`,
    !!savedNote && savedNote.notes.startsWith('npm run deploy'),
  );

  await unlockBar();
  const esc = await win.webContents.executeJavaScript(`(() => {
    const bar = document.querySelector('#notes-bar');
    const input = bar.querySelector('.notes-input');
    input.value = 'this should never be kept';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return { state: bar.dataset.state, value: input.value, readOnly: input.readOnly };
  })()`);
  ok('escape puts the saved text back and locks', esc.state === 'locked' && esc.readOnly === true && esc.value.startsWith('npm run deploy'));
  ok('escape saved nothing', saved.filter((x) => x && x.notes === 'this should never be kept').length === 0);

  /*
   * The second monitor.
   *
   * Saving pushes state to EVERY wall window, so a note typed on one screen
   * arrives at the other through the same path as any settings change. If that
   * push is allowed to redefine what Escape restores, cancelling a local edit
   * silently adopts the other screen's text as though it had been typed here.
   */
  const pushed = state(1600, 900);
  pushed.settings.notes = 'written on the other monitor';
  await unlockBar();
  await win.webContents.executeJavaScript(
    `document.querySelector('#notes-bar .notes-input').value = 'half typed and never finished'`,
  );
  win.webContents.send('wall:state', pushed);
  await wait(200);
  const midEdit = await win.webContents.executeJavaScript(
    `document.querySelector('#notes-bar .notes-input').value`,
  );
  ok('a push during an edit does not overwrite what is being typed', midEdit === 'half typed and never finished');

  const afterEsc = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#notes-bar .notes-input');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return { value: input.value, state: document.querySelector('#notes-bar').dataset.state };
  })()`);
  ok(
    `escape after a push shows what is current, not the abandoned edit (${JSON.stringify(afterEsc.value)})`,
    afterEsc.value === 'written on the other monitor' && afterEsc.state === 'locked',
  );
  ok(
    'and cancelling still saved nothing',
    saved.filter((x) => x && typeof x.notes === 'string' && x.notes.startsWith('half typed')).length === 0,
  );

  await unlockBar();
  const enter = await win.webContents.executeJavaScript(`(() => {
    const bar = document.querySelector('#notes-bar');
    const input = bar.querySelector('.notes-input');
    input.value = 'committed with enter';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return { state: bar.dataset.state, value: input.value };
  })()`);
  ok('enter commits and locks', enter.state === 'locked' && enter.value === 'committed with enter');
  ok(
    'enter saved the new text',
    saved.filter((x) => x && x.notes === 'committed with enter').length === 1,
  );

  // ── Milestones and the work time-lapse ─────────────────────────────────
  //
  // Driven with REAL clicks through Chromium's input pipeline, like the notes
  // bar's stray-click check above, because a synthetic click does not exercise
  // the outside-click close that keeps the list from becoming a trap.
  const centre = (sel) => win.webContents.executeJavaScript(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  const clickEl = async (sel) => {
    const p = await centre(sel);
    if (p) await clickAt(p.x, p.y, 1);
    await wait(120);
    return p;
  };

  const seenBefore = seenCalls;
  await clickEl('#wall-actions .wall-action-ms');
  const list = await win.webContents.executeJavaScript(`(() => {
    const pop = document.querySelector('.ms-pop');
    const r = pop.getBoundingClientRect();
    return {
      open: getComputedStyle(pop).display !== 'none',
      inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5,
      rows: pop.querySelectorAll('.ms-row').length,
      next: pop.querySelectorAll('.ms-next').length,
      newRows: pop.querySelectorAll('.ms-row.is-new').length,
      seededWhen: [...pop.querySelectorAll('.ms-row')].map((r) => r.querySelector('.ms-row-when').textContent),
      smallest: Math.min(...[...pop.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.trim()).map((e) => parseFloat(getComputedStyle(e).fontSize))),
    };
  })()`);
  const shot = async (name) => {
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, name), (await win.webContents.capturePage()).toPNG());
  };
  await shot('milestones-open.png');
  ok('clicking Milestones opens the list, inside the window', list.open && list.inside, JSON.stringify(list));
  ok(`it lists what was achieved and what is next (${list.rows} achieved, ${list.next} next)`, list.rows === 3 && list.next === 4);
  ok('the unseen one is marked new, the seeded one says "earlier" rather than a date',
     list.newRows === 1 && list.seededWhen.includes('new') && list.seededWhen.includes('earlier'), JSON.stringify(list.seededWhen));
  ok(`the list's smallest text is legible (${list.smallest}px)`, list.smallest >= 8);
  ok('opening it tells the main process the milestones were seen', seenCalls === seenBefore + 1);

  await clickEl('#view-stats .panel-daily');
  const closed = await win.webContents.executeJavaScript(
    `getComputedStyle(document.querySelector('.ms-pop')).display === 'none'`,
  );
  ok('a click anywhere else closes it', closed);

  // ── The time-lapse ─────────────────────────────────────────────────────
  //
  // Expected numbers are computed here from the fixture the stub hands over,
  // never read back from the replay, and formatted the way the header does.
  const compactTokens = (n) =>
    n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.floor(n));
  const sums = (raw) => {
    const s = { tokens: 0, output: 0, requests: 0 };
    for (const p of Object.values(raw.projects)) for (const c of Object.values(p.cells)) {
      s.requests += c[0];
      s.tokens += c[1];
      s.output += c[2];
    }
    return [compactTokens(s.tokens), compactTokens(s.output), Math.floor(s.requests).toLocaleString('en-GB')];
  };
  const longDay = (day) => {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  };
  const LEAD_MS = 700;
  const HARD_STOP = 23_200;

  for (const size of SIZES) {
    await measure(win, size);
    const tag = `${size.w}x${size.h}`;
    const calls = dayCalls.length;
    await clickEl('#wall-actions .wall-action-today');
    // Let the 450ms fade-in finish first. Measured mid-fade, the first
    // screenshot showed the dashboard through the replay and looked like a bug.
    await wait(600);
    const mid = await win.webContents.executeJavaScript(`window.__cswTimelapse(${LEAD_MS + 10_000})`);
    await wait(80);
    await shot(`replay-${tag}.png`);
    const inWin = (r) => !!r && r.left >= 0 && r.top >= 0 && r.right <= size.w + 0.5 && r.bottom <= size.h + 0.5;
    ok(`${tag}   Today asks for today and opens the replay`, !!mid && dayCalls.length === calls + 1 && dayCalls[calls] === dayKey(Date.now()),
       JSON.stringify(dayCalls.slice(calls)));
    if (!mid) continue;
    ok(`${tag}   it says which day it is ("${mid.title}")`, mid.title === 'Today so far');
    ok(`${tag}   header, graph, axis and caption are inside the window`,
       inWin(mid.head) && inWin(mid.graph) && inWin(mid.axis) && inWin(mid.caption),
       JSON.stringify({ head: mid.head, graph: mid.graph, axis: mid.axis, caption: mid.caption }));
    ok(`${tag}   three lane names and three peaks, all inside the window`,
       mid.laneNames.length === 3 && mid.lanePeaks.length === 3 && [...mid.laneNames, ...mid.lanePeaks].every(inWin));
    ok(`${tag}   no lane name runs into its peak`, mid.laneNames.every((n, i) => n.right <= mid.lanePeaks[i].left + 0.5));
    const lane3 = mid.lanes[2];
    ok(`${tag}   the smallest lane is tall enough to read (${Math.round(lane3.height)}px)`, lane3.height >= 48);
    ok(`${tag}   the smallest text is legible (${mid.smallestPx}px)`, mid.smallestPx >= 8);
    ok(`${tag}   hour labels are inside the window and do not overlap (${mid.ticks.length})`,
       mid.ticks.length >= 2 && mid.ticks.every(inWin) && mid.ticks.every((t, i) => i === 0 || t.left >= mid.ticks[i - 1].right - 0.5));

    const raw = fixtureDay(dayKey(Date.now()), Date.now());
    const end = await win.webContents.executeJavaScript(`window.__cswTimelapse(${HARD_STOP})`);
    await shot(`replay-end-${tag}.png`);
    const want = sums(raw);
    ok(`${tag}   at the end the three totals are the day's, exactly (${end.totals.join(' / ')})`,
       JSON.stringify(end.totals) === JSON.stringify(want), `expected ${want.join(' / ')}`);
    const hasPeak = Object.values(raw.projects).some((p) => Object.values(p.cells).some((c) => c[0] === 84));
    if (hasPeak) ok(`${tag}   the peak is named, inside the window`, inWin(end.peakLabel), JSON.stringify(end.peakLabel));
    await win.webContents.executeJavaScript('window.__cswTimelapse(null)');
    await clickEl('.replay');
    await wait(600);
    ok(`${tag}   a click anywhere ends it`, await win.webContents.executeJavaScript(`!document.querySelector('.replay')`));
  }

  // ── Any day ────────────────────────────────────────────────────────────
  const days = fixtureDays(Date.now());
  const [, yesterday, , totalOnly] = [0, 1, 2, 3].map((k) => dayKey(Date.now() - k * DAY_MS));
  /** Show the month holding `day`: the grid opens on this month, and a day can be in the last one. */
  const showDay = async (day) => {
    const sel = `.dp-day[data-day="${day}"]`;
    for (let i = 0; i < 3; i++) {
      if (await win.webContents.executeJavaScript(`!!document.querySelector('${sel}')`)) return sel;
      await clickEl(day < days.today ? '.dp-head .dp-nav:first-child' : '.dp-head .dp-nav:last-child');
    }
    return sel;
  };
  for (const size of [{ w: 1366, h: 768 }, { w: 2560, h: 1440 }]) {
    await measure(win, size);
    const tag = `${size.w}x${size.h}`;
    await clickEl('#wall-actions .wall-action-days');
    await wait(200);
    const grid = await win.webContents.executeJavaScript(`(() => {
      const pop = document.querySelector('.dp-pop');
      const r = pop.getBoundingClientRect();
      const cells = [...pop.querySelectorAll('.dp-day')];
      return {
        open: getComputedStyle(pop).display !== 'none',
        inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5,
        cells: cells.length,
        playable: cells.filter((c) => c.tagName === 'BUTTON').map((c) => c.dataset.day),
        smallest: Math.min(...[...pop.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.trim() && getComputedStyle(e).visibility !== 'hidden').map((e) => parseFloat(getComputedStyle(e).fontSize))),
        today: pop.querySelector('.dp-day[data-today="true"]')?.dataset.shape ?? null,
      };
    })()`);
    await shot(`picker-${tag}.png`);
    ok(`${tag}   Any day opens a month grid inside the window (${grid.cells} days)`, grid.open && grid.inside && grid.cells >= 28, JSON.stringify(grid));
    ok(`${tag}   today is marked and playable`, grid.today === 'full' && grid.playable.includes(days.today));
    ok(`${tag}   the grid's smallest text is legible (${grid.smallest}px)`, grid.smallest >= 8);

    const before = dayCalls.length;
    await clickEl(await showDay(totalOnly));
    await wait(400);
    const afterTotal = await win.webContents.executeJavaScript(`({
      replay: !!document.querySelector('.replay'),
      open: getComputedStyle(document.querySelector('.dp-pop')).display !== 'none',
      shape: document.querySelector('.dp-day[data-day="${totalOnly}"]')?.dataset.shape ?? null,
    })`);
    ok(`${tag}   a total-only day is dim and a click on it opens nothing`,
       afterTotal.shape === 'total' && !afterTotal.replay && afterTotal.open && dayCalls.length === before, JSON.stringify(afterTotal));

    await clickEl(await showDay(yesterday));
    await wait(700);
    const picked = await win.webContents.executeJavaScript(`({
      title: document.querySelector('.replay .replay-title')?.textContent ?? null,
      closed: getComputedStyle(document.querySelector('.dp-pop')).display === 'none',
    })`);
    ok(`${tag}   a bright day plays at once, titled with its date ("${picked.title}")`,
       picked.title === longDay(yesterday) && picked.closed && dayCalls[dayCalls.length - 1] === yesterday,
       `expected "${longDay(yesterday)}", asked for ${dayCalls[dayCalls.length - 1]}`);
    await clickEl('.replay');
    await wait(600);

    await clickEl('#wall-actions .wall-action-days');
    await wait(200);
    await clickEl('#view-stats .panel-daily');
    ok(`${tag}   a click anywhere else closes the grid`,
       await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.dp-pop')).display === 'none'`));
  }

  // ── Hours with nothing measured ────────────────────────────────────────
  //
  // A paired screen whose source is too old to send hours, or a source with no
  // transcripts: the block must go and the cost take the whole row, never a 0.
  for (const size of [{ w: 1366, h: 768 }, { w: 1920, h: 1080 }]) {
    await measure(win, size);
    win.webContents.send('wall:usage', { ...idx, activeTime: undefined });
    await wait(400);
    const off = await win.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('#view-stats .cost-row');
      const cost = row.querySelector('.panel-cost').getBoundingClientRect();
      return {
        state: row.dataset.hours,
        hidden: getComputedStyle(row.querySelector('.panel-ran')).display === 'none',
        fullWidth: Math.abs(cost.width - row.getBoundingClientRect().width) < 1,
      };
    })()`);
    ok(`${size.w}x${size.h}   with no hours measured the block is hidden, not 0, and cost takes the row`,
       off.state === 'off' && off.hidden && off.fullWidth, JSON.stringify(off));
    win.webContents.send('wall:usage', idx);
    await wait(400);
    ok(`${size.w}x${size.h}   and it comes back when hours arrive`,
       await win.webContents.executeJavaScript(`document.querySelector('#view-stats .cost-row').dataset.hours === 'on'`));
  }

  win.destroy();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  app.exit(fail ? 1 : 0);
});
