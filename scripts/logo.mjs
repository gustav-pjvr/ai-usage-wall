/**
 * Logo generator and rasteriser.
 *
 * Run with `npm run logo`. It authors the SVG sources, rasterises them, and
 * packs a multi-resolution Windows .ico. No image libraries and no native deps:
 * the Chromium we already ship does the drawing.
 *
 * DESIGN BRIEF (Gustav, 2026-09-02):
 *   standalone identity, "Client Wall", constellation, reads literally,
 *   multi-colour, sharp geometric, gradient depth, icon plus wordmark,
 *   two variants tuned for large and small.
 *
 * How "constellation" was reconciled with "reads instantly" and "must work at
 * 16px": THE STARS ARE THE CLIENT TILES. Different-sized rounded squares in
 * different brand hues on a dark ground, linked by faint lines. That is
 * simultaneously a constellation and a literal picture of the wall, and squares
 * survive 16px where dots would turn to mush.
 *
 * The palette is computed with the SAME oklch maths the cards use, so the logo
 * cannot drift out of sync with the product's colour system.
 *
 * RASTERISATION NOTE, learned the hard way. Three approaches were tried:
 *   1. One BrowserWindow per icon size. Windows clamps small window sizes, so a
 *      16x16 window does not yield a 16x16 surface.
 *   2. One tall sheet captured once and cropped. capturePage() returns only the
 *      visible viewport, which came back 256px tall whatever the window height,
 *      so crops below that were out of bounds.
 *   3. capturePage() with an explicit rect. Still died after the first tile,
 *      natively: exit code 0, no JS exception, nothing logged.
 * What works is drawing the geometry with Canvas 2D in the page and reading
 * back a data URL. No window capture, so no window-size constraints at all.
 * The geometry below feeds both the SVG and the canvas, so they cannot diverge.
 */

import { app, BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'assets', 'logo');

// ── oklch to hex, the same transform src/shared/color.ts uses ───────────────

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function oklchToHex(l, c, h) {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return (
    '#' +
    rgb.map((v) => Math.round(clamp01(linearToSrgb(clamp01(v))) * 255).toString(16).padStart(2, '0')).join('')
  );
}

/**
 * Five client hues held at one lightness and chroma, so they read as a family
 * rather than a clash. The same discipline the cards apply to real client brands.
 */
const HUES = { teal: 185, amber: 70, violet: 300, blue: 255, green: 150 };
const tone = (hue, dl = 0) => oklchToHex(0.7 + dl, 0.155, hue);

const PLATE_TOP = oklchToHex(0.225, 0.022, 255);
const PLATE_BOT = oklchToHex(0.145, 0.018, 255);
const LINE = oklchToHex(0.82, 0.02, 250);

// ── Geometry (shared by the SVG and the canvas renderer) ───────────────────

/*
 * Nodes sit inside the plate's 40..216 safe area on a 24px module with 8px
 * gaps, so every edge lands on the same rhythm. That alignment, not corner
 * sharpness, is where "sharp and geometric, precise" actually comes from.
 */
const NODES = [
  { x: 40, y: 40, w: 88, h: 88, hue: 'teal' },
  { x: 160, y: 40, w: 56, h: 56, hue: 'amber' },
  { x: 160, y: 128, w: 24, h: 24, hue: 'green' },
  { x: 40, y: 160, w: 56, h: 56, hue: 'violet' },
  { x: 128, y: 160, w: 88, h: 56, hue: 'blue' },
  { x: 136, y: 104, w: 24, h: 24, hue: 'green' },
];

// A closed constellation figure with one interior branch, drawn behind the tiles.
const EDGES = [
  [0, 1],
  [0, 5],
  [5, 2],
  [2, 4],
  [4, 3],
  [3, 0],
];

/**
 * Small variant: four tiles, no plate, no constellation lines, larger relative
 * to the canvas. At 16px the lines would be sub-pixel noise and a dark plate
 * would merge into a dark taskbar, so both are dropped rather than scaled down.
 * That is what "design two variants" actually buys.
 */
const SMALL = [
  { x: 2, y: 2, w: 13, h: 13, hue: 'teal' },
  { x: 19, y: 3, w: 9, h: 9, hue: 'amber' },
  { x: 3, y: 19, w: 9, h: 9, hue: 'violet' },
  { x: 17, y: 17, w: 11, h: 11, hue: 'blue' },
];

const centre = (n) => [n.x + n.w / 2, n.y + n.h / 2];
const nodeRadius = (n) => Math.round(Math.min(n.w, n.h) * 0.22);

// ── SVG sources (the vector deliverable) ───────────────────────────────────

function markSvg() {
  const grads = NODES.map(
    (n, i) => `    <linearGradient id="g${i}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${tone(HUES[n.hue], 0.1)}"/>
      <stop offset="1" stop-color="${tone(HUES[n.hue], -0.06)}"/>
    </linearGradient>`,
  ).join('\n');

  const lines = EDGES.map(([a, b]) => {
    const [x1, y1] = centre(NODES[a]);
    const [x2, y2] = centre(NODES[b]);
    return `    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }).join('\n');

  const tiles = NODES.map(
    (n, i) =>
      `  <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${nodeRadius(n)}" fill="url(#g${i})"/>`,
  ).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="${PLATE_TOP}"/>
      <stop offset="1" stop-color="${PLATE_BOT}"/>
    </linearGradient>
${grads}
  </defs>
  <rect x="0" y="0" width="256" height="256" rx="56" fill="url(#plate)"/>
  <rect x="0.75" y="0.75" width="254.5" height="254.5" rx="55.25" fill="none"
        stroke="#ffffff" stroke-opacity="0.10" stroke-width="1.5"/>
  <g stroke="${LINE}" stroke-opacity="0.32" stroke-width="3" stroke-linecap="round">
${lines}
  </g>
${tiles}
</svg>
`;
}

function markSmallSvg() {
  const tiles = SMALL.map(
    (n) =>
      `  <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${Math.max(
        1.5,
        Math.round(n.w * 0.22),
      )}" fill="${tone(HUES[n.hue], 0.04)}"/>`,
  ).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30" width="30" height="30">
${tiles}
</svg>
`;
}

function lockupSvg() {
  const inner = markSvg()
    .replace(/^<svg[^>]*>\n/, '')
    .replace(/<\/svg>\n?$/, '')
    .replace(/^/gm, '  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 220" width="800" height="220">
  <g transform="translate(26,25) scale(0.66)">
${inner}
  </g>
  <text x="226" y="116" font-family="'Plus Jakarta Sans','Segoe UI Variable Display','Segoe UI',system-ui,sans-serif"
        font-size="62" font-weight="700" letter-spacing="-1.4" fill="#f2f5f7">Client Wall</text>
  <text x="229" y="148" font-family="'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif"
        font-size="20" font-weight="500" letter-spacing="3.1" fill="${tone(HUES.teal)}">MUCHBETTER</text>
</svg>
`;
}

// ── ICO packing ────────────────────────────────────────────────────────────

/**
 * Windows .ico with PNG-compressed entries (supported since Vista). The format
 * is simple enough to emit directly, which keeps the toolchain dependency-free.
 */
function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 encodes 256
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

// ── Canvas rasteriser ──────────────────────────────────────────────────────

/** Runs inside the page. Draws the same geometry the SVG describes. */
const PAGE_DRAW = `
(function (spec) {
  var c = document.createElement('canvas');
  c.width = spec.width; c.height = spec.height;
  var g = c.getContext('2d');
  var s = spec.scale;

  function rr(x, y, w, h, r) {
    g.beginPath();
    g.roundRect(x * s, y * s, w * s, h * s, r * s);
  }

  if (spec.kind === 'mark' || spec.kind === 'lockup') {
    var ox = spec.ox || 0, oy = spec.oy || 0;
    g.save();
    g.translate(ox * s, oy * s);

    // Plate
    var k = spec.plateScale || 1;
    var pg = g.createLinearGradient(0, 0, 256 * k * s * 0.35, 256 * k * s);
    pg.addColorStop(0, spec.plateTop); pg.addColorStop(1, spec.plateBot);
    rr(0, 0, 256 * k, 256 * k, 56 * k); g.fillStyle = pg; g.fill();
    rr(0.75, 0.75, 254.5 * k, 254.5 * k, 55.25 * k);
    g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = 1.5 * s; g.stroke();

    // Constellation lines, behind the tiles
    g.strokeStyle = spec.line; g.lineWidth = 3 * s; g.lineCap = 'round';
    g.globalAlpha = 0.32;
    spec.edges.forEach(function (e) {
      g.beginPath();
      g.moveTo(e[0] * s, e[1] * s);
      g.lineTo(e[2] * s, e[3] * s);
      g.stroke();
    });
    g.globalAlpha = 1;

    // Tiles
    spec.nodes.forEach(function (n) {
      var ng = g.createLinearGradient(n.x * s, n.y * s, (n.x + n.w) * s, (n.y + n.h) * s);
      ng.addColorStop(0, n.c0); ng.addColorStop(1, n.c1);
      rr(n.x, n.y, n.w, n.h, n.r); g.fillStyle = ng; g.fill();
    });
    g.restore();
  } else {
    spec.nodes.forEach(function (n) {
      rr(n.x, n.y, n.w, n.h, n.r); g.fillStyle = n.c0; g.fill();
    });
  }

  if (spec.kind === 'lockup') {
    g.fillStyle = spec.titleColor;
    g.font = '700 ' + (62 * s) + "px 'Plus Jakarta Sans','Segoe UI Variable Display','Segoe UI',system-ui,sans-serif";
    g.fillText(spec.title, spec.textX * s, spec.titleY * s);
    g.fillStyle = spec.accent;
    g.font = '500 ' + (20 * s) + "px 'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif";
    var t = spec.sub, x = (spec.textX + 3) * s;
    for (var i = 0; i < t.length; i++) { g.fillText(t[i], x, spec.subY * s); x += g.measureText(t[i]).width + 3.1 * s; }
  }

  return c.toDataURL('image/png');
})
`;

function markSpec(size) {
  return {
    kind: 'mark',
    width: size,
    height: size,
    scale: size / 256,
    plateTop: PLATE_TOP,
    plateBot: PLATE_BOT,
    line: LINE,
    edges: EDGES.map(([a, b]) => [...centre(NODES[a]), ...centre(NODES[b])]),
    nodes: NODES.map((n) => ({
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      r: nodeRadius(n),
      c0: tone(HUES[n.hue], 0.1),
      c1: tone(HUES[n.hue], -0.06),
    })),
  };
}

function smallSpec(size) {
  return {
    kind: 'small',
    width: size,
    height: size,
    scale: size / 30,
    nodes: SMALL.map((n) => ({
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      r: Math.max(1.5, Math.round(n.w * 0.22)),
      c0: tone(HUES[n.hue], 0.04),
    })),
  };
}

/** Lockup layout, in unscaled units. */
const LOCKUP = { w: 800, h: 220, markScale: 0.66, markX: 26, textX: 226, titleY: 116, subY: 148 };

/**
 * `onDark` selects the text colour. Two variants are emitted rather than one
 * compromise: near-white text vanishes on a light README and dark text vanishes
 * on a dark one, and no middle value looks deliberate on both.
 */
function lockupSpec(scale, onDark) {
  const base = markSpec(256);
  const k = LOCKUP.markScale;
  const markY = Math.round((LOCKUP.h - 256 * k) / 2);
  return {
    ...base,
    kind: 'lockup',
    width: Math.round(LOCKUP.w * scale),
    height: Math.round(LOCKUP.h * scale),
    scale,
    ox: LOCKUP.markX,
    oy: markY,
    // Scaling is folded into the node coordinates so the page code stays a
    // single translate.
    nodes: base.nodes.map((n) => ({ ...n, x: n.x * k, y: n.y * k, w: n.w * k, h: n.h * k, r: n.r * k })),
    edges: base.edges.map((e) => e.map((v) => v * k)),
    plateScale: k,
    textX: LOCKUP.textX,
    titleY: LOCKUP.titleY,
    subY: LOCKUP.subY,
    title: 'Client Wall',
    sub: 'MUCHBETTER',
    titleColor: onDark ? '#f2f5f7' : oklchToHex(0.22, 0.02, 250),
    accent: onDark ? tone(HUES.teal) : oklchToHex(0.52, 0.13, HUES.teal),
  };
}

async function rasterise(win, spec) {
  const dataUrl = await win.webContents.executeJavaScript(
    `(${PAGE_DRAW})(${JSON.stringify(spec)})`,
    true,
  );
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error(`bad data URL for ${spec.kind} ${spec.width}x${spec.height}`);
  }
  return Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
}

// ── Main ───────────────────────────────────────────────────────────────────

const log = [];
const say = (line) => {
  log.push(line);
  console.log(line);
};

async function run() {
  await fs.mkdir(outDir, { recursive: true });

  await fs.writeFile(path.join(outDir, 'mark.svg'), markSvg(), 'utf8');
  await fs.writeFile(path.join(outDir, 'mark-small.svg'), markSmallSvg(), 'utf8');
  await fs.writeFile(path.join(outDir, 'lockup.svg'), lockupSvg(), 'utf8');

  const win = new BrowserWindow({ width: 400, height: 300, show: false });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8">'));

  /*
   * 48 and up use the plated mark; below that it turns to porridge and the
   * simplified four-tile variant takes over. That switch point is the entire
   * justification for having two variants.
   */
  const icoSizes = [256, 128, 64, 48, 32, 24, 16];
  const images = [];
  for (const size of icoSizes) {
    const data = await rasterise(win, size >= 48 ? markSpec(size) : smallSpec(size));
    await fs.writeFile(path.join(outDir, `icon-${size}.png`), data);
    images.push({ size, data });
    say(`[logo] icon-${size}.png  ${data.length} bytes  (${size >= 48 ? 'plated' : 'simplified'})`);
  }

  const ico = packIco(images);
  await fs.writeFile(path.join(outDir, 'icon.ico'), ico);
  say(`[logo] icon.ico  ${ico.length} bytes, ${images.length} entries`);

  for (const [name, size] of [
    ['tray', 16],
    ['tray@2x', 32],
  ]) {
    const data = await rasterise(win, smallSpec(size));
    await fs.writeFile(path.join(root, 'assets', `${name}.png`), data);
    say(`[logo] ${name}.png  ${data.length} bytes`);
  }

  for (const [name, scale, onDark] of [
    ['lockup-on-light', 1, false],
    ['lockup-on-light@2x', 2, false],
    ['lockup-on-dark', 1, true],
    ['lockup-on-dark@2x', 2, true],
  ]) {
    const data = await rasterise(win, lockupSpec(scale, onDark));
    await fs.writeFile(path.join(outDir, `${name}.png`), data);
    say(`[logo] ${name}.png  ${data.length} bytes`);
  }

  win.destroy();
  say(`[logo] palette: ${Object.entries(HUES).map(([k, h]) => `${k} ${tone(h)}`).join('  ')}`);
  await fs.writeFile(path.join(outDir, 'render.log'), log.join('\n') + '\n', 'utf8');
  app.quit();
}

app.whenReady()
  .then(run)
  .catch(async (err) => {
    const msg = `[logo] FAILED: ${err && err.stack ? err.stack : String(err)}`;
    console.error(msg);
    try {
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(path.join(outDir, 'render.log'), `${log.join('\n')}\n${msg}\n`, 'utf8');
    } catch {
      /* nothing further we can do */
    }
    app.exit(1);
  });
