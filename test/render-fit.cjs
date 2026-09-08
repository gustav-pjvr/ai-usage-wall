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

  idx.totals = t(48_100_000, 62_400_000, 690_000_000, 25_300_000_000, 72_060, 1284.5678);
  idx.unavailable = false;
  idx.lastScanMs = 118;
  idx.latest = {
    ts: new Date(now - 40_000).toISOString(),
    model: 'claude-opus-5',
    sessionId: 'ad4467e7-438b-4552-b4f1-04373d3d184e',
    version: '2.0.14',
    cwd: 'C:\\Users\\Demo User\\Desktop\\Claude WorkSpace\\muchbetter-client-wall',
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
    'harbourofstreamers',
    'pixelplay-north-coast',
    'supabase-keepalive',
    'b2mx-website-production',
    'keystone-football-migration',
  ];
  projects.forEach((name, i) => {
    idx.projects[`C:\\Users\\Demo User\\Desktop\\Claude WorkSpace\\${name}`] = {
      ...t(9_000_000 - i * 900_000, 11_000_000, 130_000_000, 4_600_000_000, 12_000, 240.5 - i * 30),
      lastSeen: new Date(now - i * 3_600_000).toISOString(),
      display: name,
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
  idx.sessions = {};
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

  const panels = [...document.querySelectorAll('#view-stats .panel')];
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
    const panels = [...document.querySelectorAll('#view-stats .panel')].map((p) => p.getBoundingClientRect());
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

  win.destroy();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  app.exit(fail ? 1 : 0);
});
