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
const WATCHDOG_MS = 480000;
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
const WS = 'C:\\Users\\Demo User\\Desktop\\Claude WorkSpace\\';
const TL_PROJECTS = ['muchbetter-client-wall', 'Ridgeway Marathon', 'nvrc-website-v2'];

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
  // Keyed like the real index: the lowercased cwd, with the original casing in
  // `display`. Uppercase keys here once meant the active project and the links
  // were never exercised, because nothing could find them by the real key.
  // Sizes spread across the log buckets so every star size is drawn.
  const scales = [1, 0.4, 0.12, 0.05, 0.012, 0.004];
  projects.forEach((name, i) => {
    const cwd = `C:\\Users\\Demo User\\Desktop\\Claude WorkSpace\\${name}`;
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

  // Claude's five-minute slots for today, as main sends them for the simple view's lane.
  idx.todaySlots = claudeSlots();
  idx.codex = codexFixture(now);
  return idx;
}

/*
 * Codex, from the real figures in docs/design/codex-side-by-side.md (measured
 * 2026-10-26): 55,066,228 tokens over 762 responses, three models, 40 sessions
 * of which Claude started 35, Gustav 3 and T3 Code 2, and a plan reading of
 * 99% on the 5-hour window and 16% on the week. Normalised the way the
 * contract says (fresh input = input_tokens - cached_input_tokens).
 */
const CX_TOTAL = 55_066_228;
const cxTotals = (k) => ({
  input: Math.round(3_431_679 * k),
  output: Math.round(638_965 * k),
  cacheCreate: 0,
  cacheRead: Math.round(50_995_584 * k),
  thinking: Math.round(138_275 * k),
  requests: Math.round(762 * k),
  webSearch: 0,
  webFetch: 0,
  costUsd: 65.7846 * k,
  unpricedTokens: 0,
});
/** Codex's projects: two share a working directory with Claude's fixture projects, so two stars get the ring. */
const CX_PROJECTS = [
  ['C:\\Users\\Demo User\\.t3\\scratch\\2026-10-23-these-are-the-components-i-3365f074', 15_521_714],
  [WS + 'muchbetter-client-wall', 10_352_367],
  [WS + 'pixelplay-north-coast', 5_658_907],
  ['C:\\Users\\Demo User\\Desktop\\Claude WorkSpace', 4_086_706],
];
const CX_HOUR = [2957076, 709811, 298733, 0, 0, 0, 0, 697549, 0, 4373411, 14109279, 8423428, 84671, 0, 1636257, 1428774, 0, 621821, 4229754, 0, 7735453, 2556417, 3507796, 1695998];

function claudeSlots() {
  const s = new Array(288).fill(0);
  for (let i = 0; i < 288; i++) {
    const on = (i >= 16 && i <= 46) || (i >= 120 && i <= 170) || i === 77 || i === 78 || (i >= 178 && i <= 180);
    if (on && i % 5 !== 3) s[i] = 600_000 + ((i * 7919) % 40) * 900_000;
  }
  return s;
}

function codexFixture(now, opts = {}) {
  const day = (k) => new Date(now - k * DAY_MS).toISOString().slice(0, 10);
  const dailyTokens = [8_436_681, 11_766_448, 18_441_725, 7_979_693, 8_441_681];
  const daily = {};
  dailyTokens.forEach((v, i) => { daily[day(4 - i)] = cxTotals(v / CX_TOTAL); });
  const hourly = {};
  CX_HOUR.forEach((v, h) => {
    if (!v) return;
    const d = new Date(now - DAY_MS);
    d.setHours(h, 0, 0, 0);
    hourly[d.toISOString().slice(0, 13)] = cxTotals(v / CX_TOTAL);
  });
  const projects = {};
  for (const [p, v] of CX_PROJECTS) {
    projects[p.toLowerCase()] = { ...cxTotals(v / CX_TOTAL), lastSeen: new Date(now - 3_600_000).toISOString(), display: p };
  }
  const slots = new Array(288).fill(0);
  [18253, 1112203, 729462, 845360, 596189, 741624, 877192, 1666193, 1855205].forEach((v, i) => { slots[131 + i] = v; });
  return {
    totals: cxTotals(1),
    daily,
    hourly,
    models: {
      'gpt-6-astra': cxTotals(27_380_867 / CX_TOTAL),
      'gpt-6.1-sol': cxTotals(13_994_665 / CX_TOTAL),
      'gpt-6-luna': cxTotals(13_690_696 / CX_TOTAL),
    },
    projects,
    activeDays: { [dayKey(now)]: 101 },
    sessions: { total: 40, byClaude: 35, byYou: 3, byT3: 2, other: 0 },
    activeTime: { seconds: 19_080, since: Date.parse('2026-10-22T12:36:00Z') },
    todaySlots: slots,
    recent: [],
    limits: {
      at: new Date(now - 2 * 3_600_000).toISOString(),
      plan: 'plus',
      // Future resets by default; `resetPast` puts the 5-hour reset behind us, which must read as reset.
      fiveHour: { usedPercent: 99, windowMinutes: 300, resetsAt: opts.resetPast ? now - 30 * 60_000 : now + 3 * 3_600_000 },
      weekly: { usedPercent: 16, windowMinutes: 10_080, resetsAt: now + 6.5 * DAY_MS },
    },
    firstAt: '2026-10-22T12:36:00.000Z',
    latestAt: new Date(now - 2 * 3_600_000).toISOString(),
    indexing: false,
  };
}

/*
 * The detailed view's panel rectangles BEFORE Codex existed, measured on this
 * machine from the renderer at ca81343 with this file's Claude fixture. With
 * Codex off or absent the dashboard must be exactly this: [panel, left, top,
 * width, height], rounded to 0.1px.
 */
const BEFORE_CODEX = {"2560x1440":[["panel-hero",34.7,106.7,1028.5,478.2],["panel-live",1079.1,106.7,1028.5,478.2],["panel-cost",2123.5,106.7,252.9,159.7],["panel-ran",2392.4,106.7,133,159.7],["panel-vel",2123.5,282.4,401.8,302.5],["panel-counters",34.7,600.9,819.6,382.6],["panel-daily",870.2,600.9,1028.5,382.6],["panel-eff",1914.7,600.9,610.7,382.6],["panel-models",34.7,999.4,819.6,382.6],["panel-hours",870.2,999.4,819.6,382.6],["panel-projects",1705.8,999.4,819.6,382.6]],"1920x1200":[["panel-hero",26,80,771.3,404.6],["panel-live",809.3,80,771.4,404.6],["panel-cost",1592.7,80,189.2,119.7],["panel-ran",1793.8,80,100.2,119.7],["panel-vel",1592.7,211.7,301.4,272.9],["panel-counters",26,496.6,614.7,323.7],["panel-daily",652.7,496.6,771.3,323.7],["panel-eff",1436,496.6,458,323.7],["panel-models",26,832.3,614.7,323.7],["panel-hours",652.7,832.3,614.7,323.7],["panel-projects",1279.3,832.3,614.7,323.7]],"1920x1080":[["panel-hero",26,80,771.3,358.5],["panel-live",809.3,80,771.4,358.5],["panel-cost",1592.7,80,189.2,119.7],["panel-ran",1793.8,80,100.2,119.7],["panel-vel",1592.7,211.7,301.4,226.8],["panel-counters",26,450.5,614.7,286.8],["panel-daily",652.7,450.5,771.3,286.8],["panel-eff",1436,450.5,458,286.8],["panel-models",26,749.2,614.7,286.8],["panel-hours",652.7,749.2,614.7,286.8],["panel-projects",1279.3,749.2,614.7,286.8]],"1600x900":[["panel-hero",21.7,66.7,642.8,299],["panel-live",674.4,66.7,642.8,299],["panel-cost",1327.2,66.7,157.3,99.8],["panel-ran",1494.5,66.7,83.8,99.8],["panel-vel",1327.2,176.5,251.1,189.2],["panel-counters",21.7,375.6,512.2,239.2],["panel-daily",543.9,375.6,642.8,239.2],["panel-eff",1196.7,375.6,381.7,239.2],["panel-models",21.7,624.8,512.2,239.2],["panel-hours",543.9,624.8,512.2,239.2],["panel-projects",1066.1,624.8,512.3,239.2]],"1512x982":[["panel-hero",20.5,63,607.4,332.9],["panel-live",637.3,63,607.4,332.9],["panel-cost",1254.2,63,148.5,95.7],["panel-ran",1412.2,63,79.3,95.7],["panel-vel",1254.2,168.1,237.3,227.8],["panel-counters",20.5,405.3,484.1,266.3],["panel-daily",514,405.3,607.4,266.3],["panel-eff",1130.8,405.3,360.7,266.3],["panel-models",20.5,681.1,484.1,266.3],["panel-hours",514,681.1,484.1,266.3],["panel-projects",1007.5,681.1,484.1,266.3]],"1440x900":[["panel-hero",19.5,60,578.5,303.3],["panel-live",607,60,578.5,303.3],["panel-cost",1194.5,60,140.6,91.3],["panel-ran",1344,60,76.5,91.3],["panel-vel",1194.5,160.2,226,203],["panel-counters",19.5,372.3,461,242.6],["panel-daily",489.5,372.3,578.5,242.6],["panel-eff",1077,372.3,343.5,242.6],["panel-models",19.5,623.9,461,242.7],["panel-hours",489.5,623.9,461,242.7],["panel-projects",959.5,623.9,461,242.7]],"1366x768":[["panel-hero",18.5,56.9,548.8,254.9],["panel-live",575.8,56.9,548.8,254.9],["panel-cost",1133.1,56.9,131,88.1],["panel-ran",1272.7,56.9,74.8,88.1],["panel-vel",1133.1,153.5,214.4,158.2],["panel-counters",18.5,320.3,437.3,203.9],["panel-daily",464.3,320.3,548.8,203.9],["panel-eff",1021.6,320.3,325.9,203.9],["panel-models",18.5,532.8,437.3,203.9],["panel-hours",464.3,532.8,437.3,203.9],["panel-projects",910.2,532.8,437.3,203.9]],"1280x800":[["panel-hero",18.2,56,513.3,267.8],["panel-live",539.9,56,513.3,267.8],["panel-cost",1061.5,56,117.6,87.3],["panel-ran",1187.5,56,74.3,87.3],["panel-vel",1061.5,151.6,200.3,172.1],["panel-counters",18.2,332.2,408.9,214.2],["panel-daily",435.5,332.2,513.3,214.2],["panel-eff",957.2,332.2,304.6,214.2],["panel-models",18.2,554.8,408.9,214.2],["panel-hours",435.5,554.8,409,214.2],["panel-projects",852.9,554.8,408.9,214.2]]};

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
  /** When set, the next page load gets this instead of the fixture (a first payload of another shape). */
  let usageOverride = null;

  ipcMain.handle('wall:getState', () => state(SIZES[0].w, SIZES[0].h));
  ipcMain.handle('wall:getUsage', () => usageOverride || idx);
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

  // ── Claude and Codex side by side ──────────────────────────────────────
  //
  // docs/design/codex-side-by-side.md. Four views (detailed and simple, Codex
  // on and off) at every size, reached by REAL clicks on the controls, which
  // must save through updateSettings. Detailed with Codex off must be the old
  // dashboard to the pixel: its panel rectangles are compared with the ones
  // measured before Codex existed.
  console.log('\nClaude and Codex side by side\n');
  const lastSaved = (key) => [...saved].reverse().find((x) => x && key in x);
  const statsState = () => win.webContents.executeJavaScript(`(() => {
    const s = document.querySelector('#view-stats .stats');
    return { view: s.dataset.view, codex: s.dataset.codex };
  })()`);

  const CONTROLS = `(() => {
    const a = document.querySelector('#wall-actions');
    const seg = a.querySelector('.wall-seg');
    const chip = a.querySelector('.wall-codex');
    const today = a.querySelector('.wall-action-today');
    const vis = (e) => !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
    const sr = seg.getBoundingClientRect(), tr = today.getBoundingClientRect();
    const cr = chip ? chip.getBoundingClientRect() : null;
    const sw = document.querySelector('#mode-switch').getBoundingClientRect();
    return {
      seg: vis(seg), chip: vis(chip), chipInDom: !!chip,
      order: !!cr && sr.right <= cr.left + 0.5 && cr.right <= tr.left + 0.5,
      inside: sr.left >= 0 && (!cr || cr.right <= innerWidth + 0.5),
      clearOfSwitch: sr.left >= sw.right + 4,
      on: [...seg.querySelectorAll('.wall-seg-btn.is-on')].map((b) => b.dataset.view),
      chipOn: chip ? chip.dataset.on : null,
      px: Math.min(...[...a.querySelectorAll('.wall-seg-btn, .wall-codex-label')].map((e) => parseFloat(getComputedStyle(e).fontSize))),
    };
  })()`;

  /* Everything the four views must show, read off the page in one go. */
  const VIEW = `(() => {
    const q = (s) => document.querySelector(s);
    const shown = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
    const text = (s) => { const e = q(s); return e && shown(e) ? e.textContent.trim() : null; };
    const oneLine = (e) => !!e && e.getBoundingClientRect().height <= parseFloat(getComputedStyle(e).fontSize) * 1.4;
    const insideOf = (e) => {
      const p = e && e.closest('.panel');
      if (!e || !p) return false;
      const r = e.getBoundingClientRect(), b = p.getBoundingClientRect();
      return r.width > 0 && r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5;
    };
    const nums = (sels) => sels.map((s) => q(s)).filter(shown);
    const panels = [...document.querySelectorAll('#view-stats .stats-grid .panel')].filter((p) => p.getBoundingClientRect().width > 0)
      .map((p) => { const r = p.getBoundingClientRect(); return [p.className.split(' ').find((c) => c.startsWith('panel-')), Math.round(r.left * 10) / 10, Math.round(r.top * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; });
    const cxShown = [...document.querySelectorAll('#view-stats .stats-grid .cx')].filter(shown).length;
    const plan = q('.panel-plan');
    const g = window.__cswConstellation && window.__cswConstellation();
    const engines = q('.engines'), ecl = q('.engine-cl'), ecx = q('.engine-cx');
    const detailNums = nums(['.hero-value', '.hero-cx-value', '.cost-value', '.cost-value-cx', '.ran-value', '.ran-value-cx', '.eff-value', '.eff-value-cx']);
    const simpleNums = nums(['.engine-cl .eng-big', '.engine-cx .eng-big', ...[...document.querySelectorAll('.eng-num')].map((_, i) => '.eng-stat:nth-child(' + (i % 3 + 1) + ') .eng-num')]);
    const allNums = [...document.querySelectorAll('.engine .eng-big, .engine .eng-num')].filter(shown);
    return {
      panels, cxShown,
      heroCx: text('.hero-cx-value'), share: text('.hero-cx-share'),
      costCx: text('.cost-value-cx'), hoursCx: text('.ran-value-cx'),
      table: shown(q('.counter-table')) ? [...document.querySelectorAll('.counter-table tr[data-key]')].map((tr) => [tr.dataset.key, tr.querySelector('.ct-cl').textContent, tr.querySelector('.ct-cx').textContent]) : null,
      effCx: text('.eff-value-cx'),
      plan: shown(plan) ? plan.querySelector('.plan-body').textContent : null,
      planRows: shown(plan) ? [...plan.querySelectorAll('.lim-row')].map((r) => r.dataset.tone + ':' + r.textContent) : [],
      dailyCx: [...document.querySelectorAll('.chart-daily-cx .col-bar')].filter(shown).length,
      hoursCxBars: [...document.querySelectorAll('.chart-hours-cx .col-bar')].filter(shown).length,
      modelsCx: [...document.querySelectorAll('.panel-models .bd-cx .bd-row')].filter(shown).length,
      projectsCx: [...document.querySelectorAll('.panel-projects .bd-cx .bd-row')].filter(shown).length,
      groups: [...document.querySelectorAll('.bd-group')].filter(shown).map((e) => e.textContent),
      ringed: g ? g.ringed : null,
      mirrorKeys: [...document.querySelectorAll('.mirror-key')].filter(shown).length,
      detailOneLine: detailNums.every(oneLine), detailInside: detailNums.every(insideOf), detailCount: detailNums.length,
      simpleOneLine: allNums.every(oneLine), simpleInside: allNums.every(insideOf), simpleCount: allNums.length,
      engines: [ecl, ecx].map(shown),
      clFull: shown(ecl) && Math.abs(ecl.getBoundingClientRect().width - engines.getBoundingClientRect().width) < 1,
      sideBySide: shown(ecl) && shown(ecx) && Math.abs(ecl.getBoundingClientRect().top - ecx.getBoundingClientRect().top) < 1 && ecx.getBoundingClientRect().left > ecl.getBoundingClientRect().right,
      bigCl: text('.engine-cl .eng-big'), bigCx: text('.engine-cx .eng-big'),
      todayCl: text('.engine-cl .eng-today .eng-num'), todayCx: text('.engine-cx .eng-today .eng-num'),
      costSimpleCx: text('.engine-cx .eng-cost .eng-num'),
      limits: shown(q('.eng-limits')) ? q('.eng-limits').textContent : null,
      limitRows: [...document.querySelectorAll('.eng-limits .lim-row')].filter(shown).map((r) => r.dataset.tone + ':' + r.textContent),
      nolimits: text('.eng-nolimits'),
      lanes: [...document.querySelectorAll('.lanes .lane')].filter(shown).length,
      laneMarks: [...document.querySelectorAll('.lane-cx .lane-mark')].length,
      handoff: text('.today-handoff'),
      sparkCx: [...document.querySelectorAll('.engine-cx .eng-spark rect')].length,
    };
  })()`;

  const sameRects = (got, want) => {
    if (!want || got.length !== want.length) return `${got.length} panels, expected ${want ? want.length : 'none'}`;
    const bad = [];
    for (const w of want) {
      const g = got.find((x) => x[0] === w[0]);
      if (!g) { bad.push(`${w[0]} missing`); continue; }
      for (let i = 1; i < 5; i++) if (Math.abs(g[i] - w[i]) > 1) { bad.push(`${w[0]} ${JSON.stringify(g.slice(1))} vs ${JSON.stringify(w.slice(1))}`); break; }
    }
    return bad.join('; ');
  };

  // The controls, at the reference size, before anything is clicked.
  await measure(win, { w: 1920, h: 1080 });
  const c0 = await win.webContents.executeJavaScript(CONTROLS);
  ok(`the Simple | Detailed switch and the Codex chip sit before Today (${c0.on.join(',')} on, Codex ${c0.chipOn})`,
     c0.seg && c0.chip && c0.order && c0.inside && c0.clearOfSwitch, JSON.stringify(c0));
  ok('the defaults are the detailed view with Codex shown', c0.on.join() === 'detailed' && c0.chipOn === 'on' &&
     JSON.stringify(await statsState()) === JSON.stringify({ view: 'detailed', codex: 'on' }));
  ok(`the controls' text is legible (${c0.px}px)`, c0.px >= 8);

  const CONFIGS = [
    { name: 'detailed', view: 'detailed', codex: true },
    { name: 'detailed-off', view: 'detailed', codex: false },
    { name: 'simple-off', view: 'simple', codex: false },
    { name: 'simple', view: 'simple', codex: true },
  ];
  const savesBefore = saved.length;
  for (const cfg of CONFIGS) {
    // Get there with real clicks on the controls, from whatever is on screen now.
    await measure(win, { w: 1920, h: 1080 });
    const now = await statsState();
    if ((now.view === 'simple') !== (cfg.view === 'simple')) {
      await clickEl(`#wall-actions .wall-seg-btn[data-view="${cfg.view}"]`);
      ok(`a real click on ${cfg.view} switches the view and saves it`,
         (await statsState()).view === cfg.view && lastSaved('statsView')?.statsView === cfg.view, JSON.stringify(lastSaved('statsView')));
    }
    if ((now.codex === 'on') !== cfg.codex) {
      await clickEl('#wall-actions .wall-codex');
      ok(`a real click on the Codex chip turns Codex ${cfg.codex ? 'on' : 'off'} and saves it`,
         (await statsState()).codex === (cfg.codex ? 'on' : 'off') && lastSaved('showCodex')?.showCodex === cfg.codex, JSON.stringify(lastSaved('showCodex')));
    }
    // A view switch replays the panel entrance; measure the settled layout, not the animation.
    await wait(1400);

    for (const size of SIZES) {
      const r = await measure(win, size);
      const tag = `${cfg.name.padEnd(12)} ${size.w}x${size.h}`;
      if (SHOTS) fs.writeFileSync(path.join(SHOTS, `${cfg.name}-${size.w}x${size.h}.png`), (await win.webContents.capturePage()).toPNG());
      if (r.fatal) { ok(tag, false, r.fatal); continue; }
      ok(`${tag}   everything inside its panel, nothing overflowing`, r.findings.length === 0,
         r.findings.slice(0, 6).join('\n        ') + (r.findings.length > 6 ? `\n        (+${r.findings.length - 6} more)` : ''));
      ok(`${tag}   smallest text ${r.smallest}px (>= 8, on .${r.smallestOn})`, r.smallest >= 8);
      ok(`${tag}   status strip inside, mode switch clear (${r.stripOver}px, ${r.switchOver}px)`, r.stripOver <= 1 && r.switchOver <= 0);
      const c = await win.webContents.executeJavaScript(CONTROLS);
      ok(`${tag}   controls inside the window, clear of the switch, legible (${c.px}px)`,
         c.seg && c.chip && c.order && c.inside && c.clearOfSwitch && c.px >= 8, JSON.stringify(c));
      const v = await win.webContents.executeJavaScript(VIEW);

      if (cfg.name === 'detailed') {
        const share = (() => {
          const mine = CX_TOTAL, claude = 48_100_000 + 62_400_000 + 690_000_000 + 25_300_000_000;
          const pct = (mine / (mine + claude)) * 100;
          return `${pct >= 0.1 ? pct.toFixed(1) : pct.toFixed(2)}% of the two together`;
        })();
        ok(`${tag}   hero: Codex ${v.heroCx}, "${v.share}"`, v.heroCx === '55.07M' && v.share === share, `${v.heroCx} / ${v.share}`);
        ok(`${tag}   cost ${v.costCx} and hours ${v.hoursCx} split Claude / Codex, every number one line and inside its panel`,
           v.costCx === '$65.78' && v.hoursCx === '5' && v.detailOneLine && v.detailInside && v.detailCount === 8, JSON.stringify({ n: v.detailCount, one: v.detailOneLine, inside: v.detailInside }));
        ok(`${tag}   Codex plan: 99% (red) and 16%, with its reading's age`,
           v.planRows.length === 2 && /^bad:5 h99%$/.test(v.planRows[0]) && /^ok:week16%$/.test(v.planRows[1]) && /Read 2h ago/.test(v.plan), JSON.stringify([v.planRows, v.plan]));
        ok(`${tag}   Totals has a Codex column (prompts left empty, never 0)`,
           JSON.stringify(v.table) === JSON.stringify([['requests', '72K', '762'], ['sessions', '58', '40'], ['prompts', '4,812', ''], ['days', '14', '5'], ['output', '62.4M', '639K'], ['thinking', '0', '138K']]), JSON.stringify(v.table));
        ok(`${tag}   context efficiency for both (Codex ${v.effCx})`, v.effCx === '93.7%');
        ok(`${tag}   mirrored daily (${v.dailyCx} Codex days) and hours (${v.hoursCxBars} Codex hours), labelled`,
           v.dailyCx === 5 && v.hoursCxBars === CX_HOUR.filter(Boolean).length && v.mirrorKeys === 6);
        ok(`${tag}   models and projects list Codex under "Codex, its own scale" (${v.modelsCx} and ${v.projectsCx})`,
           v.modelsCx === 3 && v.projectsCx === 2 && v.groups.length === 2 && v.groups.every((t) => t === 'Codex, its own scale'));
        ok(`${tag}   constellation rings the stars Codex worked on (${(v.ringed || []).join(', ')})`,
           Array.isArray(v.ringed) && v.ringed.length === 2 && v.ringed.includes('muchbetter-client-wall') && v.ringed.includes('pixelplay-north-coast'));
      }
      if (cfg.name === 'detailed-off') {
        const diff = sameRects(v.panels, BEFORE_CODEX[`${size.w}x${size.h}`]);
        ok(`${tag}   exactly the dashboard before Codex: same ${v.panels.length} panel rectangles`, diff === '', diff);
        ok(`${tag}   no Codex furniture on screen, no ring`, v.cxShown === 0 && Array.isArray(v.ringed) && v.ringed.length === 0, `${v.cxShown} shown, ringed ${JSON.stringify(v.ringed)}`);
      }
      if (cfg.name === 'simple') {
        ok(`${tag}   two engine cards side by side (${v.bigCl} and ${v.bigCx})`, v.sideBySide && v.bigCl === '26.10B' && v.bigCx === '55.07M');
        ok(`${tag}   every number one line and inside its card (${v.simpleCount})`, v.simpleOneLine && v.simpleInside && v.simpleCount === 8);
        ok(`${tag}   requests today ${v.todayCl} and ${v.todayCx}, Codex cost ${v.costSimpleCx}`, v.todayCl === '2,685' && v.todayCx === '101' && v.costSimpleCx === '$65.78');
        ok(`${tag}   Codex plan limits 99% and 16% with reset times; Claude says it has none on disk`,
           v.limitRows.length === 2 && /^bad:5-hour window99%resets /.test(v.limitRows[0]) && /^ok:This week16%resets /.test(v.limitRows[1]) &&
           /Plus plan\. Read at .+ \(2h ago\), when Codex last ran\./.test(v.limits) && /no plan limits on disk/.test(v.nolimits || ''), JSON.stringify([v.limitRows, v.limits, v.nolimits]));
        ok(`${tag}   two lanes on one axis, and "${v.handoff}"`, v.lanes === 2 && v.laneMarks === 9 && v.handoff === 'Claude started 35 of 40 Codex sessions' && v.sparkCx === 5);
      }
      if (cfg.name === 'simple-off') {
        ok(`${tag}   one Claude card across the full width (${v.bigCl}), one lane, no hand-off line`,
           v.clFull && v.engines.join() === 'true,false' && v.lanes === 1 && v.handoff === null && v.bigCl === '26.10B');
        ok(`${tag}   its numbers one line and inside (${v.simpleCount})`, v.simpleOneLine && v.simpleInside && v.simpleCount === 4);
      }
    }
  }
  ok(`every click saved through updateSettings (${saved.length - savesBefore} saves)`,
     saved.slice(savesBefore).filter((x) => 'statsView' in x || 'showCodex' in x).length === 3);

  // The saved choice is applied from a state push, as on load and on the other monitor.
  await measure(win, { w: 1920, h: 1080 });
  const pushedView = state(1920, 1080);
  pushedView.settings.statsView = 'detailed';
  pushedView.settings.showCodex = false;
  win.webContents.send('wall:state', pushedView);
  await wait(300);
  const afterPush = await statsState();
  const cPush = await win.webContents.executeJavaScript(CONTROLS);
  ok('a state push applies the saved view and Codex choice, controls included',
     afterPush.view === 'detailed' && afterPush.codex === 'off' && cPush.on.join() === 'detailed' && cPush.chipOn === 'off', JSON.stringify([afterPush, cPush]));
  pushedView.settings.showCodex = true;
  win.webContents.send('wall:state', pushedView);
  await wait(300);
  ok('and back on', (await statsState()).codex === 'on');

  // A window whose reset time has passed shows as reset, never its stale percent.
  const resetIdx = { ...idx, codex: codexFixture(Date.now(), { resetPast: true }) };
  win.webContents.send('wall:usage', resetIdx);
  await wait(400);
  const rd = await win.webContents.executeJavaScript(VIEW);
  ok(`detailed: a 5-hour window that has reset reads "${(rd.planRows[0] || '').split(':').slice(1).join(':')}", not 99%`,
     rd.planRows.length === 2 && /^reset:5 hreset at /.test(rd.planRows[0]) && !/99/.test(rd.plan) && /^ok:week16%$/.test(rd.planRows[1]), JSON.stringify(rd.planRows));
  await clickEl('#wall-actions .wall-seg-btn[data-view="simple"]');
  await wait(1400);
  const rs = await win.webContents.executeJavaScript(VIEW);
  if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'simple-reset-1920x1080.png'), (await win.webContents.capturePage()).toPNG());
  ok('simple: the same window reads as reset, not 99%',
     rs.limitRows.length === 2 && /^reset:5-hour windowreset at .+, not read since$/.test(rs.limitRows[0]) && !/99%/.test(rs.limits), JSON.stringify(rs.limitRows));

  // A plan window resets while the stats are on screen: shown as reset at that moment, not up to 20 s later.
  const firstRow = async () => (await win.webContents.executeJavaScript(VIEW)).limitRows[0] || '';
  const resetsSoon = (ms) => {
    const cx = codexFixture(Date.now());
    cx.limits.fiveHour.resetsAt = Date.now() + ms;
    return { ...idx, codex: cx };
  };
  win.webContents.send('wall:usage', resetsSoon(1500));
  await wait(500);
  ok('simple: a 5-hour window still reads as its percent before it resets', /^bad:5-hour window99%/.test(await firstRow()), await firstRow());
  await wait(1500);
  ok('simple: and as reset 2 s later, long before the 20 s clock would have said so', /^reset:5-hour window/.test(await firstRow()), await firstRow());

  // Hidden when it resets, then shown again: repainted on becoming visible, not on the next 20 s tick.
  win.webContents.send('wall:usage', resetsSoon(2000));
  await wait(300);
  await clickEl('#mode-switch .mode-btn[data-mode="clients"]');
  await wait(2600);
  await clickEl('#mode-switch .mode-btn[data-mode="stats"]');
  await wait(250);
  ok('a window that reset while the stats were hidden reads as reset the moment they are shown', /^reset:5-hour window/.test(await firstRow()), await firstRow());
  const planNowhere = await win.webContents.executeJavaScript(`(() => document.querySelector('.stats').dataset.view)()`);
  ok('and the view is still the simple one', planNowhere === 'simple', planNowhere);

  // The unpriced caveat and the all-unpriced cost, in the simple view, for both engines.
  const gaps = () => win.webContents.executeJavaScript(`(() => {
    const shown = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
    const one = (sel) => {
      const e = document.querySelector(sel);
      if (!shown(e)) return null;
      const p = e.closest('.panel'), r = e.getBoundingClientRect(), b = p.getBoundingClientRect();
      return { text: e.textContent, oneLine: r.height <= parseFloat(getComputedStyle(e).fontSize) * 1.6, inside: r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.bottom <= b.bottom + 0.5 };
    };
    return { gapCl: one('.engine-cl .eng-gap'), gapCx: one('.engine-cx .eng-gap'), costCl: one('.engine-cl .eng-cost .eng-num'), costCx: one('.engine-cx .eng-cost .eng-num') };
  })()`);
  const base = await gaps();
  ok('simple: with every token priced there is no caveat and both costs show', base.gapCl === null && base.gapCx === null && !!base.costCl && !!base.costCx, JSON.stringify(base));
  const part = { ...idx, totals: { ...idx.totals, unpricedTokens: 1_500_000 }, codex: { ...codexFixture(Date.now()), totals: { ...cxTotals(1), unpricedTokens: 2_000_000 } } };
  win.webContents.send('wall:usage', part);
  await wait(500);
  const g1 = await gaps();
  ok('simple: Claude\'s card says how many tokens from an unpriced model are not counted, and keeps its cost',
     g1.gapCl && /^1\.50M tokens from an unpriced model are not counted$/.test(g1.gapCl.text) && g1.gapCl.oneLine && g1.gapCl.inside && !!g1.costCl, JSON.stringify(g1.gapCl));
  ok('simple: so does Codex\'s, in the detailed view\'s words, and keeps its cost',
     g1.gapCx && /^Codex: 2\.00M tokens from an unpriced model are not counted$/.test(g1.gapCx.text) && g1.gapCx.oneLine && g1.gapCx.inside && !!g1.costCx, JSON.stringify(g1.gapCx));
  const allClaude = idx.totals.input + idx.totals.output + idx.totals.cacheCreate + idx.totals.cacheRead;
  const every = { ...idx, totals: { ...idx.totals, unpricedTokens: allClaude }, codex: { ...codexFixture(Date.now()), totals: { ...cxTotals(1), unpricedTokens: CX_TOTAL } } };
  win.webContents.send('wall:usage', every);
  await wait(500);
  const g2 = await gaps();
  ok('simple: with every token unpriced the cost is hidden, never $0.00, and the caveat stays',
     g2.costCl === null && g2.costCx === null && !!g2.gapCl && !!g2.gapCx, JSON.stringify(g2));
  win.webContents.send('wall:usage', idx);
  await wait(400);

  // No Codex data at all: no chip, and every view as it was.
  win.webContents.send('wall:usage', { ...idx, codex: undefined });
  await wait(400);
  const none = await win.webContents.executeJavaScript(CONTROLS);
  const noneView = await win.webContents.executeJavaScript(VIEW);
  ok('with no Codex data the chip is not in the DOM at all', none.chipInDom === false && none.seg);
  ok('and the simple view is one Claude card and one lane', (await statsState()).codex === 'off' && noneView.clFull && noneView.lanes === 1);
  await clickEl('#wall-actions .wall-seg-btn[data-view="detailed"]');
  await wait(1400);
  for (const size of [{ w: 1920, h: 1080 }, { w: 1366, h: 768 }]) {
    await measure(win, size);
    const nv = await win.webContents.executeJavaScript(VIEW);
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, `detailed-absent-${size.w}x${size.h}.png`), (await win.webContents.capturePage()).toPNG());
    const diff = sameRects(nv.panels, BEFORE_CODEX[`${size.w}x${size.h}`]);
    ok(`${size.w}x${size.h}   detailed with no Codex data is the dashboard before Codex`, diff === '' && nv.cxShown === 0, diff || `${nv.cxShown} Codex elements shown`);
  }
  win.webContents.send('wall:usage', idx);
  await wait(400);
  ok('the chip comes back when Codex data arrives', (await win.webContents.executeJavaScript(CONTROLS)).chip === true);

  // A payload with no lane at all, from the very first paint: no empty "Today, side by side" panel.
  usageOverride = { ...idx, todaySlots: undefined, codex: { ...codexFixture(Date.now()), todaySlots: undefined } };
  await win.loadFile(RENDERER);
  await wait(2600);
  await clickEl('#wall-actions .wall-seg-btn[data-view="simple"]');
  await wait(1400);
  const noLanes = await win.webContents.executeJavaScript(`(() => {
    const shown = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
    const p = document.querySelector('.today-panel');
    return { panel: shown(p), on: p && p.dataset.on, lanes: [...document.querySelectorAll('.lanes .lane')].filter(shown).length, cards: [...document.querySelectorAll('.engine')].filter(shown).length, view: document.querySelector('.stats').dataset.view };
  })()`);
  ok('a first payload with no todaySlots shows no empty Today panel', noLanes.view === 'simple' && noLanes.panel === false && noLanes.on === 'off' && noLanes.lanes === 0 && noLanes.cards === 2, JSON.stringify(noLanes));
  usageOverride = null;


  win.destroy();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  app.exit(fail ? 1 : 0);
});
