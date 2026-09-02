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
import * as zlib from 'node:zlib';
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

/**
 * Minimal PNG encoder, so the tray icon is generated rather than checked in as
 * a binary. Keeps the repo text-only and the icon editable in code.
 */
function encodePng(width, height, rgba) {
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Tray mark: a rounded square in MuchBetter's teal accent with a lighter
 * ascending bar, echoing the wall's progress rule.
 */
async function writeTrayIcon() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const put = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4;
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  };

  const radius = 7;
  const inset = 3;
  const inRounded = (x, y) => {
    const lo = inset;
    const hi = size - 1 - inset;
    if (x < lo || x > hi || y < lo || y > hi) return false;
    const cx = Math.min(Math.max(x, lo + radius), hi - radius);
    const cy = Math.min(Math.max(y, lo + radius), hi - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 + 1;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRounded(x, y)) continue;
      // Vertical gradient in the brand teal family.
      const t = (y - inset) / (size - inset * 2);
      put(x, y, Math.round(22 + t * 10), Math.round(96 + t * 34), Math.round(104 + t * 30), 255);
    }
  }

  // Three ascending bars, the wall's progress motif.
  const bars = [
    { x: 10, h: 6 },
    { x: 15, h: 10 },
    { x: 20, h: 14 },
  ];
  for (const bar of bars) {
    for (let y = size - 9 - bar.h; y < size - 9; y++) {
      for (let x = bar.x; x < bar.x + 3; x++) {
        if (inRounded(x, y)) put(x, y, 190, 240, 232, 255);
      }
    }
  }

  const out = path.join(root, 'assets', 'tray.png');
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, encodePng(size, size, buf));
}

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
  await writeTrayIcon();

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
