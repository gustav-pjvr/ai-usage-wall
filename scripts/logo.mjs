/**
 * Logo generator and rasteriser.
 *
 * Run with `npm run logo`. It authors the SVG sources, rasterises them, and
 * packs a multi-resolution Windows .ico. No image libraries and no native deps:
 * the Chromium we already ship does the drawing.
 *
 * DESIGN BRIEF (Gustav, 2026-09-03):
 *   a wall of clearly defined individual bricks on a WHITE background, with the
 *   top-left corner of the wall exploding outward.
 *
 * How that is built:
 *   - RUNNING BOND, the offset courses a real wall uses. It is what makes a
 *     grid of rectangles read as "brick" rather than as "tiles", and it is the
 *     reason alternate courses end in half bricks.
 *   - WHITE MORTAR. The gaps are the plate showing through, so every brick is
 *     separated by the background itself. That is what "clearly defined
 *     individual" asks for, and it survives downscaling better than an outline.
 *   - THE CORNER IS GENUINELY MISSING. Two bricks are removed from the wall and
 *     the same two, plus smaller chips, fly out of that hole. Drawing shards
 *     over an intact wall would read as debris passing in front of it.
 *   - Shards ROTATE and shrink along a vector radiating from the corner, and
 *     fade as they travel, so the eye reads direction rather than scatter.
 *
 * The five client hues are carried over from the previous mark and are still
 * computed with the same oklch maths the cards use, so the logo cannot drift
 * out of sync with the product's colour system. They are darker here than they
 * were on the old dark plate, because the same lightness that read as vivid on
 * near-black is washed out on white.
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
 * rather than a clash. The same discipline the cards apply to real client
 * brands. L is 0.62 rather than the old 0.7: on a white plate the lighter tone
 * loses its edge, and a brick has to look solid.
 */
const HUES = { teal: 190, amber: 62, violet: 300, blue: 258, green: 148 };
const ORDER = ['teal', 'blue', 'amber', 'violet', 'green'];

/*
 * TWO THEMES, one geometry.
 *
 * The plate flips and the bricks change lightness, but not a single coordinate
 * moves. That is the whole point: they have to be recognisably the same mark,
 * so only the palette is allowed to vary.
 *
 * The brick lightness is NOT the same number in both. 0.62 is solid on white
 * and muddy on near-black; 0.74 is vivid on near-black and washed out on white.
 * Using one value for both would mean picking which theme to disappoint.
 */
const THEMES = {
  light: {
    plate: '#ffffff',
    // Without an edge the plate has no silhouette on a white surface.
    plateEdge: oklchToHex(0.9, 0.004, 250),
    brickL: 0.62,
    brickC: 0.17,
    minAlpha: 0.4,
  },
  dark: {
    // The wall's own backdrop colour, so the icon looks like it belongs to the
    // app rather than to the taskbar it happens to be sitting on.
    plate: oklchToHex(0.17, 0.015, 250),
    plateEdge: oklchToHex(0.34, 0.012, 250),
    brickL: 0.74,
    brickC: 0.16,
    /*
     * A fading shard fades TOWARDS THE PLATE, so the same alpha does not cost
     * the same visibility in both themes. At 0.42 the furthest chips were still
     * readable against white and had all but vanished against near-black, so
     * the dark theme lifts the floor. The trajectory still reads: the shards
     * shrink and spin as well as fade, and those two do the work here.
     */
    minAlpha: 0.58,
  },
};

let THEME = THEMES.light;
const brick = (hue, dl = 0) => oklchToHex(THEME.brickL + dl, THEME.brickC, hue);

// ── Geometry (shared by the SVG and the canvas renderer) ───────────────────

/*
 * Wall metrics on the 256 plate.
 *
 * Course pitch and brick pitch are both derived from one mortar width, so the
 * white gaps are identical vertically and horizontally. A wall whose horizontal
 * mortar is thicker than its vertical mortar looks wrong before anyone can say
 * why.
 */
const MORTAR = 5;
const BRICK_W = 34;
const BRICK_H = 22;
const COLS = 5;
/*
 * The wall sits LOW and RIGHT on purpose. Everything above and left of it is
 * the blast area, and a composition where the wall is centred leaves the
 * shards nowhere to go, which reads as debris rather than as an explosion.
 *
 * It also has to have MASS. An earlier pass used three bricks across and four
 * courses, and taking a corner out of that left a staircase rather than a wall
 * with a bite in it. Twenty-two bricks read as a wall even with four missing.
 */
const WALL_X = 42;
const WALL_Y = 76;
const COURSES = 5;
const COL_PITCH = BRICK_W + MORTAR; // 39
const ROW_PITCH = BRICK_H + MORTAR; // 27
const WALL_W = COLS * BRICK_W + (COLS - 1) * MORTAR; // 190
const HALF_W = (BRICK_W - MORTAR) / 2; // 14.5, so a half brick plus mortar is half a pitch

const R = 4; // brick corner radius: crisp, not soft

/**
 * The bricks that are GONE. The hole is the top-left corner, so the first brick
 * of the first course and the leading half brick of the second.
 */
const MISSING = new Set(['0:0', '0:1', '1:0', '1:1']);

/** Build the wall in running bond. Odd courses start and end with half bricks. */
function buildWall() {
  const out = [];
  let n = 0;
  for (let row = 0; row < COURSES; row++) {
    const y = WALL_Y + row * ROW_PITCH;
    const offset = row % 2 === 1;
    // Even courses: COLS full bricks. Odd courses: a half, COLS-1 fulls, a half.
    // That is running bond, and the half bricks at the ends are what makes the
    // vertical joints stagger instead of lining up into columns.
    const spans = [];
    if (offset) {
      spans.push([WALL_X, HALF_W]);
      for (let i = 0; i < COLS - 1; i++) spans.push([WALL_X + HALF_W + MORTAR + i * COL_PITCH, BRICK_W]);
      spans.push([WALL_X + WALL_W - HALF_W, HALF_W]);
    } else {
      for (let i = 0; i < COLS; i++) spans.push([WALL_X + i * COL_PITCH, BRICK_W]);
    }
    spans.forEach(([x, w], col) => {
      if (MISSING.has(`${row}:${col}`)) return;
      out.push({ x, y, w, h: BRICK_H, hue: ORDER[(row * 2 + col) % ORDER.length], rot: 0, alpha: 1 });
      n++;
    });
    // Keep the hue walk going across removed bricks so the wall's colour rhythm
    // is the same one it would have had before the corner blew out.
    n += spans.filter((_, col) => MISSING.has(`${row}:${col}`)).length;
  }
  return out;
}

const WALL = buildWall();

/**
 * The pieces in flight, ordered near to far.
 *
 * The first two are the bricks taken out of the wall, at full size: the eye
 * should be able to put them back. Everything after is chipped off them, so it
 * gets smaller, spins harder and fades as it travels. All of it radiates from
 * the wall's own top-left corner.
 */
const SHARDS = [
  // The four bricks that were in that hole a moment ago, still full size and
  // barely turned. The eye should be able to put them back.
  { x: 38, y: 40, w: BRICK_W, h: BRICK_H, rot: -22, hue: 'amber', alpha: 1 },
  { x: 6, y: 56, w: BRICK_W, h: BRICK_H, rot: 27, hue: 'teal', alpha: 1 },
  { x: 78, y: 22, w: BRICK_W, h: BRICK_H, rot: 36, hue: 'violet', alpha: 0.95 },
  { x: 22, y: 8, w: BRICK_W - 4, h: BRICK_H - 3, rot: -42, hue: 'blue', alpha: 0.92 },
  // Chips off those four. Smaller, spinning harder, fading as they travel.
  { x: 122, y: 6, w: 24, h: 14, rot: 18, hue: 'green', alpha: 0.78 },
  { x: 60, y: 76, w: 20, h: 12, rot: 56, hue: 'amber', alpha: 0.68 },
  { x: 4, y: 118, w: 17, h: 10, rot: -64, hue: 'violet', alpha: 0.55 },
  { x: 170, y: 22, w: 13, h: 8, rot: 30, hue: 'blue', alpha: 0.42 },
];

/**
 * Small variant, on a 30 unit canvas.
 *
 * Seventeen bricks and seven shards are porridge at 16px, so this is the same
 * IDEA at the resolution that actually exists: three courses of chunky bricks,
 * the corner missing, two chips in flight. Mortar drops to 1.5 units because
 * below about one device pixel a gap stops separating anything.
 */
const SMALL_UNITS = 32;

const SMALL_WALL = [
  // Course 1. The brick at x=4 is the one that is gone: that hole IS the mark
  // at this size, so it comes before everything else.
  { x: 13, y: 11, w: 7, h: 5, hue: 'blue' },
  { x: 22, y: 11, w: 7, h: 5, hue: 'amber' },
  // Course 2, offset. Its leading half brick is missing too, so the hole is a
  // corner rather than a single square notch.
  { x: 8, y: 18, w: 7, h: 5, hue: 'green' },
  { x: 17, y: 18, w: 7, h: 5, hue: 'violet' },
  { x: 26, y: 18, w: 3, h: 5, hue: 'teal' },
  // Course 3, whole.
  { x: 4, y: 25, w: 7, h: 5, hue: 'amber' },
  { x: 13, y: 25, w: 7, h: 5, hue: 'teal' },
  { x: 22, y: 25, w: 7, h: 5, hue: 'blue' },
];

/*
 * Two chips, and no more. At 16px each of these is about three device pixels
 * across; a third would be a smudge next to the other two rather than a
 * separate object, and the explosion would read as dirt on the icon.
 */
const SMALL_SHARDS = [
  { x: 2, y: 3, w: 7, h: 5, rot: -25, hue: 'teal', alpha: 1 },
  { x: 12, y: 1, w: 5, h: 3.5, rot: 24, hue: 'violet', alpha: 0.9 },
];

// ── SVG sources (the vector deliverable) ───────────────────────────────────

function pieceSvg(p, radius) {
  const rot = p.rot ? ` transform="rotate(${p.rot} ${p.x + p.w / 2} ${p.y + p.h / 2})"` : '';
  const a = p.alpha == null ? 1 : Math.max(p.alpha, THEME.minAlpha);
  const alpha = a < 1 ? ` fill-opacity="${a}"` : '';
  return `  <rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${radius}" fill="${brick(
    HUES[p.hue],
  )}"${alpha}${rot}/>`;
}

function markSvg() {
  const bricks = WALL.map((b) => pieceSvg(b, R)).join('\n');
  const shards = SHARDS.map((s) => pieceSvg(s, R)).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect x="0" y="0" width="256" height="256" rx="56" fill="${THEME.plate}"/>
  <rect x="0.75" y="0.75" width="254.5" height="254.5" rx="55.25" fill="none"
        stroke="${THEME.plateEdge}" stroke-width="1.5"/>
${bricks}
${shards}
</svg>
`;
}

function markSmallSvg() {
  const bricks = SMALL_WALL.map((b) => pieceSvg(b, 1)).join('\n');
  const shards = SMALL_SHARDS.map((s) => pieceSvg(s, 1)).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SMALL_UNITS} ${SMALL_UNITS}" width="${SMALL_UNITS}" height="${SMALL_UNITS}">
  <rect x="0" y="0" width="${SMALL_UNITS}" height="${SMALL_UNITS}" rx="7" fill="${THEME.plate}"/>
${bricks}
${shards}
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
        font-size="20" font-weight="500" letter-spacing="3.1" fill="${brick(HUES.teal, 0.08)}">MUCHBETTER</text>
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

  function piece(p) {
    g.save();
    g.globalAlpha = p.a == null ? 1 : p.a;
    if (p.rot) {
      var cx = (p.x + p.w / 2) * s, cy = (p.y + p.h / 2) * s;
      g.translate(cx, cy);
      g.rotate(p.rot * Math.PI / 180);
      g.translate(-cx, -cy);
    }
    g.beginPath();
    g.roundRect(p.x * s, p.y * s, p.w * s, p.h * s, p.r * s);
    g.fillStyle = p.c;
    g.fill();
    g.restore();
  }

  var ox = spec.ox || 0, oy = spec.oy || 0, k = spec.plateScale || 1;
  g.save();
  g.translate(ox * s, oy * s);

  // Plate. White, with an edge so it still has a silhouette on a white surface.
  g.beginPath();
  g.roundRect(0, 0, spec.plate * k * s, spec.plate * k * s, spec.plateRadius * k * s);
  g.fillStyle = spec.plateFill;
  g.fill();
  if (spec.plateEdge) {
    g.beginPath();
    g.roundRect(0.75 * s, 0.75 * s, (spec.plate * k - 1.5) * s, (spec.plate * k - 1.5) * s, (spec.plateRadius * k - 0.75) * s);
    g.strokeStyle = spec.plateEdge;
    g.lineWidth = 1.5 * s;
    g.stroke();
  }

  spec.pieces.forEach(piece);
  g.restore();

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

const toPiece = (p, radius) => ({
  x: p.x,
  y: p.y,
  w: p.w,
  h: p.h,
  r: radius,
  rot: p.rot || 0,
  a: p.alpha == null ? 1 : Math.max(p.alpha, THEME.minAlpha),
  c: brick(HUES[p.hue]),
});

function markSpec(size) {
  return {
    kind: 'mark',
    width: size,
    height: size,
    scale: size / 256,
    plate: 256,
    plateRadius: 56,
    plateFill: THEME.plate,
    plateEdge: THEME.plateEdge,
    pieces: [...WALL, ...SHARDS].map((p) => toPiece(p, R)),
  };
}

function smallSpec(size) {
  return {
    kind: 'small',
    width: size,
    height: size,
    scale: size / SMALL_UNITS,
    plate: SMALL_UNITS,
    plateRadius: 7,
    plateFill: THEME.plate,
    // No hairline edge at this size: 1.5 units of a 30 unit canvas is most of a
    // device pixel at 16px and reads as a grey halo rather than as an edge.
    plateEdge: null,
    pieces: [...SMALL_WALL, ...SMALL_SHARDS].map((p) => toPiece(p, 1)),
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
    plateScale: k,
    // Scaling is folded into the piece coordinates so the page code stays a
    // single translate.
    pieces: base.pieces.map((p) => ({ ...p, x: p.x * k, y: p.y * k, w: p.w * k, h: p.h * k, r: p.r * k })),
    textX: LOCKUP.textX,
    titleY: LOCKUP.titleY,
    subY: LOCKUP.subY,
    title: 'Client Wall',
    sub: 'MUCHBETTER',
    titleColor: onDark ? '#f2f5f7' : oklchToHex(0.22, 0.02, 250),
    accent: onDark ? brick(HUES.teal, 0.08) : brick(HUES.teal, -0.06),
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

/*
 * Everything is emitted TWICE, once per theme. The light set keeps the plain
 * names because it is what the .ico and the docs use; the dark set is suffixed.
 *
 * 64 and up use the full wall. Below that the mortar falls under one device
 * pixel and the wall turns to porridge: 48px was tried with the full wall and
 * was measurably unreadable, so the switch point is 64, not 48. That decision
 * is the entire justification for having two size variants.
 */
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16];

async function emitTheme(win, theme, suffix) {
  THEME = THEMES[theme];

  await fs.writeFile(path.join(outDir, `mark${suffix}.svg`), markSvg(), 'utf8');
  await fs.writeFile(path.join(outDir, `mark-small${suffix}.svg`), markSmallSvg(), 'utf8');

  const images = [];
  for (const size of ICO_SIZES) {
    const data = await rasterise(win, size >= 64 ? markSpec(size) : smallSpec(size));
    await fs.writeFile(path.join(outDir, `icon-${size}${suffix}.png`), data);
    images.push({ size, data });
  }
  say(`[logo] ${theme}: 7 icon PNGs (full wall at 64+, reduced below)`);

  const ico = packIco(images);
  await fs.writeFile(path.join(outDir, `icon${suffix}.ico`), ico);
  say(`[logo] icon${suffix}.ico  ${ico.length} bytes, ${images.length} entries`);

  for (const [name, size] of [
    ['tray', 16],
    ['tray@2x', 32],
  ]) {
    const data = await rasterise(win, smallSpec(size));
    // The tray art lives beside the app, not in the logo folder, because it is
    // shipped as a runtime asset rather than as a brand deliverable.
    const file = suffix ? `${name.replace('@2x', '')}-dark${name.includes('@2x') ? '@2x' : ''}.png` : `${name}.png`;
    await fs.writeFile(path.join(root, 'assets', file), data);
    say(`[logo] ${file}  ${data.length} bytes`);
  }

  say(`[logo] ${theme} palette: ${Object.entries(HUES).map(([k, h]) => `${k} ${brick(h)}`).join('  ')}`);
}

async function run() {
  await fs.mkdir(outDir, { recursive: true });

  const win = new BrowserWindow({ width: 400, height: 300, show: false });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8">'));

  await emitTheme(win, 'light', '');
  await emitTheme(win, 'dark', '-dark');

  // The lockups pair the LIGHT mark with dark text and the DARK mark with light
  // text, because each is used on a surface of the opposite tone.
  for (const [name, scale, onDark] of [
    ['lockup-on-light', 1, false],
    ['lockup-on-light@2x', 2, false],
    ['lockup-on-dark', 1, true],
    ['lockup-on-dark@2x', 2, true],
  ]) {
    THEME = onDark ? THEMES.dark : THEMES.light;
    const data = await rasterise(win, lockupSpec(scale, onDark));
    await fs.writeFile(path.join(outDir, `${name}.png`), data);
    say(`[logo] ${name}.png  ${data.length} bytes`);
  }

  THEME = THEMES.light;
  await fs.writeFile(path.join(outDir, 'lockup.svg'), lockupSvg(), 'utf8');

  win.destroy();
  say(`[logo] bricks ${WALL.length}, shards ${SHARDS.length}`);
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
