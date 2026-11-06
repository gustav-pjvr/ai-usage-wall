/**
 * Build editions.
 *
 * ONE codebase, two products. A git branch was the obvious alternative and it
 * is the wrong shape: the two would diverge, and every fix to the stats
 * dashboard, the desktop layer or the usage indexer would have to be landed
 * twice. A build-time constant costs a handful of guards and keeps a single
 * place to fix anything.
 *
 * Both editions show Claude Stats only. Neither reads or ships client records.
 * The full build keeps its installed identity for upgrades and a future Work view.
 * The stats build remains the shareable edition with its own updater.
 *
 * The value is substituted at build time by esbuild's `define`, so `process` is
 * never evaluated at runtime and this works identically in the main process and
 * in the renderer, where there is no `process` at all.
 */

export type Edition = 'full' | 'stats';

export const EDITION: Edition = process.env.MBW_EDITION === 'stats' ? 'stats' : 'full';

/** True in the shareable dashboard-only build. */
export const isStatsOnly = EDITION === 'stats';

/** Product name, used for the tray header and the window title. */
export const PRODUCT_NAME = isStatsOnly ? 'Claude Stats Wall' : 'MuchBetter Client Wall';
