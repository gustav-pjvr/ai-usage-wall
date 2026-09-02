/**
 * Desktop layering for the client wall.
 *
 * Three layer modes, deliberately. Full reasoning in ARCHITECTURE.md; summary:
 *
 *  - 'wallpaper'  SetParent()s the window into the WorkerW that Explorer paints
 *                 the wallpaper into. The window becomes structurally part of
 *                 the desktop background, so it can never fight other apps for
 *                 z-order and needs zero polling. Cost: the desktop, not us,
 *                 owns mouse input, so hover and click do not work here.
 *
 *  - 'desktop'    DEFAULT. A layered tool window with WS_EX_NOACTIVATE placed
 *                 DIRECTLY ABOVE Progman, the desktop window. Sits above the
 *                 wallpaper and the desktop icon layer, below every ordinary
 *                 app, and does receive hover and click.
 *
 *                 It used to sit at HWND_BOTTOM, which looked identical and was
 *                 broken: Explorer's SHELLDLL_DefView spans the screen, is
 *                 transparent, and was hit-tested first, so every click and
 *                 hover went to the desktop. Placement is not input.
 *
 *  - 'top'        HWND_TOPMOST. Temporary, for focus mode and the detail view.
 *
 * We do not poll to defend z-order. WS_EX_NOACTIVATE means the window is never
 * activated, so almost nothing raises it. Placement is re-asserted only on the
 * few events that can disturb it: display change, our own show, and mode change.
 *
 * `inputReachesWall()` verifies the result with WindowFromPoint, because being
 * visible at a pixel and owning it for hit-testing are not the same thing.
 */

import {
  GWL_EXSTYLE,
  HWND_BOTTOM,
  HWND_NOTOPMOST,
  HWND_TOPMOST,
  NULL_HWND,
  SMTO_ABORTIFHUNG,
  SM_CXVIRTUALSCREEN,
  SM_CYVIRTUALSCREEN,
  SM_XVIRTUALSCREEN,
  SM_YVIRTUALSCREEN,
  SWP_NOACTIVATE,
  SWP_NOMOVE,
  SWP_NOOWNERZORDER,
  SWP_NOSIZE,
  WM_SPAWN_WORKERW,
  WS_EX_NOACTIVATE,
  WS_EX_TOOLWINDOW,
  getClassName,
  isAvailable,
  unavailableReason,
  win32,
  type Hwnd,
} from './ffi';

export type LayerMode = 'wallpaper' | 'desktop' | 'top';

export interface VirtualScreen {
  x: number;
  y: number;
  width: number;
  height: number;
}

const log = (...args: unknown[]) => console.log('[desktop-layer]', ...args);
const warn = (...args: unknown[]) => console.warn('[desktop-layer]', ...args);

/**
 * Mark the process per-monitor DPI aware (v2) before any window is created.
 * Without this, Windows bitmap-stretches the wall on scaled displays and every
 * coordinate we compute is wrong on a mixed-DPI multi-monitor setup.
 *
 * Electron normally does this itself. Calling it again is harmless and makes
 * the guarantee explicit rather than a dependency on Electron internals.
 */
export function ensureDpiAwareness(): boolean {
  const w = win32();
  if (!w) return false;
  try {
    // -4 = PER_MONITOR_AWARE_V2. Returns false if already set, which is fine.
    w.SetProcessDpiAwarenessContext(-4);
    return true;
  } catch (err) {
    warn('SetProcessDpiAwarenessContext failed:', (err as Error).message);
    return false;
  }
}

/** Physical bounds of the whole virtual desktop, in Win32 pixels. */
export function getVirtualScreen(): VirtualScreen | null {
  const w = win32();
  if (!w) return null;
  return {
    x: w.GetSystemMetrics(SM_XVIRTUALSCREEN),
    y: w.GetSystemMetrics(SM_YVIRTUALSCREEN),
    width: w.GetSystemMetrics(SM_CXVIRTUALSCREEN),
    height: w.GetSystemMetrics(SM_CYVIRTUALSCREEN),
  };
}

let cachedWorkerW: Hwnd | null = null;

/**
 * Every plausible wallpaper-layer candidate, best first.
 *
 * Explorer's desktop composition differs across Windows builds and shell
 * replacements, and on recent Windows 11 builds SetParent into the WorkerW is
 * often refused outright. Rather than betting on one handle, collect all the
 * candidates and let the caller try each and verify.
 */
export function wallpaperLayerCandidates(): Hwnd[] {
  const w = win32();
  if (!w) return [];
  const out: Hwnd[] = [];
  const push = (h: Hwnd) => {
    if (h && !out.includes(h)) out.push(h);
  };

  const primary = findWallpaperLayer(true);
  if (primary) push(primary);

  // Every WorkerW that does NOT host the desktop icons is a possible layer.
  let cb: unknown = null;
  try {
    cb = w.register((hwnd: Hwnd) => {
      if (getClassName(hwnd) === 'WorkerW') {
        const hostsIcons = w.FindWindowExW(hwnd, NULL_HWND, 'SHELLDLL_DefView', null);
        if (!hostsIcons) push(hwnd);
      }
      return true;
    });
    w.EnumWindows(cb, 0);
  } catch {
    /* best effort */
  } finally {
    if (cb) {
      try {
        w.unregister(cb);
      } catch {
        /* ignore */
      }
    }
  }

  const progman = w.FindWindowW('Progman', null);
  if (progman) push(progman);
  return out;
}

/**
 * Locate the WorkerW that Explorer paints the wallpaper into.
 *
 * Algorithm (the one Wallpaper Engine and Lively use):
 *   1. Poke Progman with the undocumented 0x052C so it splits the desktop into
 *      a WorkerW pair. On many systems this has already happened.
 *   2. Find the window that hosts SHELLDLL_DefView (the desktop icon host).
 *   3. The wallpaper layer is the next WorkerW sibling after that window.
 *
 * Falls back to Progman itself when no split WorkerW exists, which is the case
 * on some single-monitor Windows 10 configurations.
 */
export function findWallpaperLayer(force = false): Hwnd {
  const w = win32();
  if (!w) return NULL_HWND;
  if (!force && cachedWorkerW !== null && w.IsWindow(cachedWorkerW)) return cachedWorkerW;

  const progman = w.FindWindowW('Progman', null);
  if (!progman) {
    warn('Progman not found; wallpaper mode unavailable');
    return NULL_HWND;
  }

  try {
    const res = [0];
    w.SendMessageTimeoutW(progman, WM_SPAWN_WORKERW, 0, 0, SMTO_ABORTIFHUNG, 1000, res);
  } catch (err) {
    warn('0x052C to Progman failed:', (err as Error).message);
  }

  // Find the icon host, then take the WorkerW that follows it.
  let target: Hwnd = NULL_HWND;
  let cb: unknown = null;
  try {
    cb = w.register((hwnd: Hwnd) => {
      const shellView = w.FindWindowExW(hwnd, NULL_HWND, 'SHELLDLL_DefView', null);
      if (shellView) {
        const next = w.FindWindowExW(NULL_HWND, hwnd, 'WorkerW', null);
        if (next) target = next;
      }
      return true; // keep enumerating
    });
    w.EnumWindows(cb, 0);
  } catch (err) {
    warn('EnumWindows failed:', (err as Error).message);
  } finally {
    if (cb) {
      try {
        w.unregister(cb);
      } catch {
        /* ignore */
      }
    }
  }

  if (!target) {
    // No split layer on this machine. Progman itself hosts the wallpaper.
    log('no split WorkerW; falling back to Progman');
    target = progman;
  } else {
    log(`wallpaper layer WorkerW=0x${target.toString(16)}`);
  }

  cachedWorkerW = target;
  return target;
}

/** Add extended window styles without clobbering the ones Electron set. */
export function addExStyle(hwnd: Hwnd, bits: number): void {
  const w = win32();
  if (!w) return;
  try {
    const current = w.GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    w.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, current | bits);
  } catch (err) {
    warn('addExStyle failed:', (err as Error).message);
  }
}

export function removeExStyle(hwnd: Hwnd, bits: number): void {
  const w = win32();
  if (!w) return;
  try {
    const current = w.GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    w.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, current & ~bits);
  } catch (err) {
    warn('removeExStyle failed:', (err as Error).message);
  }
}

/**
 * Apply a layer mode to a window.
 *
 * `bounds` must be the window's intended position in Win32 virtual-screen
 * pixels. It is only used by 'wallpaper' mode, where SetParent re-bases the
 * child's coordinates onto the WorkerW client area, whose origin is the virtual
 * screen origin, which is negative when a monitor sits left of the primary.
 * Getting this wrong is the classic multi-monitor wallpaper bug.
 */
export function applyLayerMode(
  hwnd: Hwnd,
  mode: LayerMode,
  bounds?: { x: number; y: number; width: number; height: number },
): { ok: boolean; reason?: string } {
  if (!isAvailable()) return { ok: false, reason: unavailableReason() ?? 'unavailable' };
  const w = win32();
  if (!w) return { ok: false, reason: 'win32 unavailable' };
  if (!w.IsWindow(hwnd)) return { ok: false, reason: 'invalid HWND' };

  try {
    // Always keep the wall out of the taskbar and Alt+Tab, and never let it
    // steal focus. Electron's skipTaskbar and focusable:false cover this, but
    // the wall depends on it, so assert rather than assume.
    addExStyle(hwnd, WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);

    const currentParent = w.GetParent(hwnd);

    if (mode === 'wallpaper') {
      const candidates = wallpaperLayerCandidates();
      if (candidates.length === 0) return { ok: false, reason: 'no wallpaper layer found' };

      /*
       * VERIFY, do not assume. SetParent into another process's window can fail
       * with no exception raised here: the handle went stale after an Explorer
       * restart, a shell replacement provides no such layer, UIPI refuses the
       * call, or the Windows 11 desktop composition simply rejects it. A silent
       * failure leaves the wall invisible while the log claims success, which
       * is the worst possible outcome.
       *
       * So try each candidate and read the parent back to confirm.
       */
      let layer: Hwnd = NULL_HWND;
      for (const candidate of candidates) {
        if (currentParent !== candidate) w.SetParent(hwnd, candidate);
        if (w.GetParent(hwnd) === candidate) {
          layer = candidate;
          break;
        }
      }

      if (!layer) {
        const tried = candidates.map((c) => `0x${c.toString(16)}`).join(', ');
        return {
          ok: false,
          reason: `SetParent refused by all ${candidates.length} candidate layer(s): ${tried}`,
        };
      }

      if (bounds) {
        const vs = getVirtualScreen();
        // Re-base into WorkerW client coordinates.
        const x = bounds.x - (vs?.x ?? 0);
        const y = bounds.y - (vs?.y ?? 0);
        w.SetWindowPos(hwnd, HWND_BOTTOM, x, y, bounds.width, bounds.height, SWP_NOACTIVATE | SWP_NOOWNERZORDER);
      }
      log(`wallpaper mode active, parented to WorkerW 0x${layer.toString(16)}`);
      return { ok: true };
    }

    // Leaving wallpaper mode: detach from WorkerW first, else the window keeps
    // WorkerW-relative coordinates and appears in the wrong place.
    if (currentParent) w.SetParent(hwnd, NULL_HWND);

    if (mode === 'top') {
      w.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
      return { ok: true };
    }

    /*
     * 'desktop': sit DIRECTLY ABOVE the desktop, not at the very bottom.
     *
     * HWND_BOTTOM was the obvious choice and it is wrong. It puts the window
     * underneath Explorer's SHELLDLL_DefView, the desktop icon host, which
     * spans the whole screen and is transparent. The wall is therefore visible
     * through it but Windows hit-tests DefView first, so every click and every
     * hover goes to the desktop instead of to us. Verified with
     * WindowFromPoint: at every pixel of the wall the owner came back as
     * "explorer". Visibility and input are not the same thing, and z-order
     * alone does not prove interactivity.
     *
     * Inserting immediately above Progman fixes it. Progman is the desktop's
     * top-level window and DefView is its child, so being above Progman puts us
     * above the icon layer and we receive input. We still never activate
     * (WS_EX_NOACTIVATE), so any app the user focuses rises above us and the
     * wall stays behind everything in normal use.
     */
    w.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);

    const progman = w.FindWindowW('Progman', null);
    if (progman) {
      w.SetWindowPos(hwnd, progman, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    } else {
      // No shell desktop window to anchor to. Bottom is the safe fallback: the
      // wall stays out of the way even though it will not take input.
      warn('Progman not found; falling back to HWND_BOTTOM (input will not reach the wall)');
      w.SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
    return { ok: true };
  } catch (err) {
    const reason = (err as Error).message;
    warn(`applyLayerMode(${mode}) failed:`, reason);
    return { ok: false, reason };
  }
}

/**
 * Cheap re-assert of the desktop placement: just above Progman, not at the
 * bottom. Sinking to HWND_BOTTOM here would undo the fix in applyLayerMode and
 * silently kill input again, since the desktop icon layer would be back on top.
 */
export function sinkToBottom(hwnd: Hwnd): void {
  const w = win32();
  if (!w || !w.IsWindow(hwnd)) return;
  try {
    const progman = w.FindWindowW('Progman', null);
    w.SetWindowPos(hwnd, progman || HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  } catch {
    /* non-fatal */
  }
}

/**
 * Ask Windows which window actually owns a pixel inside our own bounds.
 *
 * This is the check that would have caught the input bug immediately. Being
 * visible at a pixel and OWNING that pixel for hit-testing are different
 * things: with the window at HWND_BOTTOM, Explorer's transparent desktop icon
 * layer sat on top and swallowed every click and hover while the wall still
 * showed through perfectly. Verifying placement is not verifying input.
 */
export function inputReachesWall(
  hwnd: Hwnd,
  bounds: { x: number; y: number; width: number; height: number },
): { reachable: boolean; ownerClass: string } {
  const w = win32();
  if (!w) return { reachable: false, ownerClass: '(win32 unavailable)' };
  try {
    // A point well inside the window, away from any edge.
    const at = w.WindowFromPoint({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + Math.min(120, bounds.height / 4)),
    });
    if (!at) return { reachable: false, ownerClass: '(none)' };
    // The hit may land on a child of ours, so walk up to the top-level owner.
    let root = at;
    for (let i = 0; i < 8; i++) {
      const parent = w.GetParent(root);
      if (!parent) break;
      root = parent;
    }
    return { reachable: root === hwnd || at === hwnd, ownerClass: getClassName(root) || getClassName(at) };
  } catch (err) {
    return { reachable: false, ownerClass: `(error: ${(err as Error).message})` };
  }
}

/** True when the shell (desktop) is the foreground window. */
export function isDesktopForeground(): boolean {
  const w = win32();
  if (!w) return false;
  try {
    const fg = w.GetForegroundWindow();
    if (!fg) return true;
    const cls = getClassName(fg);
    return cls === 'Progman' || cls === 'WorkerW';
  } catch {
    return false;
  }
}

/** Detach from WorkerW so the window can be destroyed cleanly. */
export function detach(hwnd: Hwnd): void {
  const w = win32();
  if (!w || !w.IsWindow(hwnd)) return;
  try {
    if (w.GetParent(hwnd)) w.SetParent(hwnd, NULL_HWND);
  } catch {
    /* ignore */
  }
}
