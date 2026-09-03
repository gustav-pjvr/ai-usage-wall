/**
 * Show Desktop watchdog: keeps the wall above the desktop when the shell
 * raises the desktop over it.
 *
 * Observed on the affected machine (stats build, laptop): after the Show
 * Desktop strip is clicked, the wall's window is still visible, still placed,
 * not iconic, and the tray icon is still there, yet nothing of the wall can be
 * seen until the show-desktop state is cancelled by activating and then
 * minimising some other app. That is the desktop window sitting above the wall
 * in the Z order. Nothing about the wall itself changes, which is why measuring
 * only the wall after ToggleDesktop showed nothing: the wall was never the
 * thing that moved.
 *
 * There is no window message for "another window was raised over you", so
 * index.ts polls this at a short interval. The check is against the desktop's
 * own window, not the wall's properties: verifyLayer() passes in this state and
 * must not be mistaken for a placement check.
 */

import {
  GW_HWNDNEXT,
  GW_HWNDPREV,
  GWL_EXSTYLE,
  HWND_TOP,
  NULL_HWND,
  SWP_NOACTIVATE,
  SWP_NOMOVE,
  SWP_NOSIZE,
  WS_EX_TOPMOST,
  getClassName,
  win32,
  type Hwnd,
} from './ffi';

/** Explorer's desktop-layer windows. Being above these is expected. */
const SHELL_CLASSES: ReadonlySet<string> = new Set(['Progman', 'WorkerW']);

/**
 * Upper bound on a Z-order walk. Top-level windows number in the hundreds on a
 * busy desktop; this guards against a handle cycle, it is not a budget.
 */
const MAX_WALK = 2048;

export interface Placement {
  /** The top-level window that hosts SHELLDLL_DefView, the desktop icon layer. */
  host: Hwnd;
  hostClass: string;
  /** True when the host was not found below the wall, i.e. it is above it. */
  desktopAbove: boolean;
  /**
   * Visible windows met walking down from the wall before the host was reached
   * (or before the bottom, when the host is above). Shell windows and the
   * wall's own sibling windows are left out. Non-empty means the wall is on
   * top of an ordinary app, which desktop mode never wants.
   */
  between: Hwnd[];
  /** Changes only when the situation changes. Used to act once per situation. */
  signature: string;
}

/**
 * The top-level window that currently hosts the desktop icons.
 *
 * Normally Progman. Explorer can move SHELLDLL_DefView into a WorkerW (a
 * wallpaper transition does it; some wallpaper tools do it deliberately), and
 * then that WorkerW is the window the wall must be above. Falls back to
 * Progman when no DefView exists anywhere, e.g. while Explorer restarts.
 */
export function findDesktopHost(): Hwnd {
  const w = win32();
  if (!w) return NULL_HWND;
  const progman = w.FindWindowW('Progman', null);
  if (progman && w.FindWindowExW(progman, NULL_HWND, 'SHELLDLL_DefView', null)) return progman;
  let worker = NULL_HWND;
  for (let i = 0; i < MAX_WALK; i++) {
    worker = w.FindWindowExW(NULL_HWND, worker, 'WorkerW', null);
    if (!worker) break;
    if (w.FindWindowExW(worker, NULL_HWND, 'SHELLDLL_DefView', null)) return worker;
  }
  return progman;
}

/**
 * Where the wall stands relative to the desktop. Walks DOWN from the wall,
 * which in the healthy state reaches the host in a step or two, so the common
 * case costs a handful of calls.
 */
export function assessPlacement(hwnd: Hwnd, own: ReadonlySet<Hwnd>): Placement | null {
  const w = win32();
  if (!w || !w.IsWindow(hwnd)) return null;
  const host = findDesktopHost();
  if (!host) return null;

  const between: Hwnd[] = [];
  let reached = false;
  let cur = w.GetWindow(hwnd, GW_HWNDNEXT);
  for (let i = 0; cur && i < MAX_WALK; i++) {
    if (cur === host) {
      reached = true;
      break;
    }
    if (w.IsWindowVisible(cur) && !own.has(cur) && !SHELL_CLASSES.has(getClassName(cur))) between.push(cur);
    cur = w.GetWindow(cur, GW_HWNDNEXT);
  }
  const desktopAbove = !reached;
  return {
    host,
    hostClass: getClassName(host),
    desktopAbove,
    between,
    signature: `${desktopAbove ? 'above' : 'below'}:${host}:${between.join(',')}`,
  };
}

/**
 * Put the wall directly above the desktop host, wherever the host is right now.
 *
 * SetWindowPos places a window directly BELOW hWndInsertAfter, so "directly
 * above the host" is "directly below the window that is above the host". When
 * nothing is above the host, or only topmost windows are, HWND_TOP does the
 * same job: for a non-topmost window it means the top of the non-topmost band.
 * HWND_NOTOPMOST would not: it is documented to do nothing to a window that is
 * already non-topmost. Inserting after a topmost window is avoided because it
 * would make the wall topmost.
 *
 * The HWND_TOP branch can leave the wall above ordinary apps once the shell
 * drops the desktop back down. That is not left to chance: the next tick sees
 * windows between the wall and the desktop and sinks it again.
 *
 * This is deliberately not sinkToBottom(). That inserts after Progman and is
 * the call the resting state was verified with. Here the host may not be at
 * the bottom, and by the same semantics "after Progman" would then land the
 * wall under it.
 */
export function placeAboveDesktop(hwnd: Hwnd, host: Hwnd): boolean {
  const w = win32();
  if (!w || !w.IsWindow(hwnd) || !w.IsWindow(host)) return false;
  try {
    const above = w.GetWindow(host, GW_HWNDPREV);
    if (above === hwnd) return true;
    const aboveIsTopmost = above ? (w.GetWindowLongPtrW(above, GWL_EXSTYLE) & WS_EX_TOPMOST) !== 0 : true;
    return w.SetWindowPos(
      hwnd,
      aboveIsTopmost ? HWND_TOP : above,
      0,
      0,
      0,
      0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
    );
  } catch {
    return false;
  }
}
