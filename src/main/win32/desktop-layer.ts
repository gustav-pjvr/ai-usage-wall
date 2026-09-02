/**
 * Desktop layering for the client wall.
 *
 * TWO layer modes, deliberately. Full reasoning in ARCHITECTURE.md; summary:
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
 * THERE WAS A THIRD, 'wallpaper', which SetParent()ed the window into the
 * WorkerW that Explorer paints the wallpaper into. It was removed on
 * 2026-09-02 after being measured rather than assumed. Two findings:
 *
 *   1. The old verification used GetParent(), which returns the OWNER of a
 *      WS_POPUP window, and every Electron window is WS_POPUP. It therefore
 *      answered NULL no matter what, so the code reported "SetParent refused
 *      by all 15 candidates" while the window was in fact parented into the
 *      last candidate tried. The 'desktop' fallback then skipped its detach,
 *      also gated on GetParent, and z-ordered a child window against its own
 *      parent. The wall vanished and stayed gone across restarts, because the
 *      failing mode had already been written to settings.json.
 *
 *   2. With the parenting done correctly and confirmed via GetAncestor, the
 *      window still painted nothing. Verified by minimising every window and
 *      reading a real screen pixel with GDI: opaque, transparent, and
 *      WS_POPUP converted to WS_CHILD all failed identically against a control.
 *
 * A wall that ignores the mouse is what that mode was actually wanted for, and
 * `clickThrough` already delivers it on top of 'desktop'.
 *
 * `verifyLayer()` checks the conditions that are NECESSARY for the wall to be
 * on screen. It does not claim to prove pixels; see its comment.
 */

import {
  GA_PARENT,
  GA_ROOT,
  GWL_EXSTYLE,
  HWND_BOTTOM,
  HWND_NOTOPMOST,
  HWND_TOPMOST,
  NULL_HWND,
  SWP_NOACTIVATE,
  SWP_NOMOVE,
  SWP_NOSIZE,
  WS_EX_NOACTIVATE,
  WS_EX_TOOLWINDOW,
  getClassName,
  isAvailable,
  unavailableReason,
  win32,
  type Hwnd,
} from './ffi';

export type LayerMode = 'desktop' | 'top';

export interface Rect {
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
 * True when the window is a real top-level window rather than a child of some
 * other window.
 *
 * Note what this compares against. A top-level window's GA_PARENT is the
 * DESKTOP WINDOW, not NULL, so testing `=== 0` would report every healthy
 * window as reparented. Testing with GetParent() reports the opposite error.
 * Both mistakes have already cost this project real time.
 */
export function isTopLevel(hwnd: Hwnd): boolean {
  const w = win32();
  if (!w) return true;
  try {
    return w.GetAncestor(hwnd, GA_PARENT) === w.GetDesktopWindow();
  } catch {
    return true;
  }
}

/**
 * Guarantee the window is top-level, repairing it if something (a previous
 * version of this app, or any other process) parented it into the shell.
 *
 * This is a PRECONDITION of layering, not a cleanup step: SetWindowPos on a
 * child window z-orders it against its siblings inside its parent, which is
 * meaningless here and is exactly the state that made the wall invisible.
 *
 * No GWL_STYLE surgery is needed on the way out. The note about clearing
 * WS_CHILD after SetParent(NULL) applies to windows that were given WS_CHILD;
 * this one never was, so it is still WS_POPUP and detaching is enough.
 */
export function ensureTopLevel(hwnd: Hwnd): { ok: boolean; repaired: boolean; reason?: string } {
  const w = win32();
  if (!w) return { ok: true, repaired: false };
  try {
    const desktop = w.GetDesktopWindow();
    const parent = w.GetAncestor(hwnd, GA_PARENT);
    if (parent === desktop) return { ok: true, repaired: false };

    warn(`window is parented into 0x${parent.toString(16)} (${getClassName(parent) || '?'}); detaching`);
    w.SetParent(hwnd, NULL_HWND);

    const now = w.GetAncestor(hwnd, GA_PARENT);
    if (now !== desktop) {
      return { ok: false, repaired: false, reason: `could not detach from 0x${now.toString(16)}` };
    }
    log('detached; window is top-level again');
    return { ok: true, repaired: true };
  } catch (err) {
    return { ok: false, repaired: false, reason: (err as Error).message };
  }
}

/**
 * Apply a layer mode to a window.
 *
 * `repaired` means the window had to be pulled back out of another window's
 * hierarchy. Its coordinates were parent-relative while it was in there, so the
 * caller must restore its bounds afterwards.
 */
export function applyLayerMode(hwnd: Hwnd, mode: LayerMode): { ok: boolean; repaired: boolean; reason?: string } {
  if (!isAvailable()) return { ok: false, repaired: false, reason: unavailableReason() ?? 'unavailable' };
  const w = win32();
  if (!w) return { ok: false, repaired: false, reason: 'win32 unavailable' };
  if (!w.IsWindow(hwnd)) return { ok: false, repaired: false, reason: 'invalid HWND' };

  try {
    // Always keep the wall out of the taskbar and Alt+Tab, and never let it
    // steal focus. Electron's skipTaskbar and focusable:false cover this, but
    // the wall depends on it, so assert rather than assume.
    addExStyle(hwnd, WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);

    const top = ensureTopLevel(hwnd);
    if (!top.ok) return { ok: false, repaired: false, reason: top.reason };

    if (mode === 'top') {
      w.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
      return { ok: true, repaired: top.repaired };
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
    return { ok: true, repaired: top.repaired };
  } catch (err) {
    const reason = (err as Error).message;
    warn(`applyLayerMode(${mode}) failed:`, reason);
    return { ok: false, repaired: false, reason };
  }
}

/**
 * Check the conditions that MUST hold for the wall to be on screen.
 *
 * Honest about its own limits. Top-level, visible and placed inside the display
 * are each NECESSARY for the wall to be rendering, so any failure proves it is
 * not, which is enough to reject a layer mode. Passing them does not prove a
 * single pixel was painted, and the log line must never say "verified
 * rendering". Proving pixels needs a GDI screen read plus an answer to "is
 * something covering that point", which WindowFromPoint can give in these two
 * modes but could not in the removed wallpaper mode. That asymmetry is half the
 * reason wallpaper mode is gone.
 */
export function verifyLayer(
  hwnd: Hwnd,
  opts: { expectVisible: boolean; display: Rect },
): { ok: boolean; failures: string[]; rect: Rect | null } {
  const w = win32();
  if (!w) return { ok: true, failures: [], rect: null };
  const failures: string[] = [];
  let rect: Rect | null = null;

  try {
    if (!isTopLevel(hwnd)) {
      const parent = w.GetAncestor(hwnd, GA_PARENT);
      failures.push(`not top-level (parent 0x${parent.toString(16)} ${getClassName(parent) || '?'})`);
    }

    if (opts.expectVisible && !w.IsWindowVisible(hwnd)) failures.push('not visible');

    const out = [{ left: 0, top: 0, right: 0, bottom: 0 }];
    if (!w.GetWindowRect(hwnd, out)) {
      failures.push('GetWindowRect failed');
    } else {
      const r = out[0];
      rect = { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
      if (rect.width <= 0 || rect.height <= 0) {
        failures.push(`empty rect ${rect.width}x${rect.height}`);
      } else {
        const d = opts.display;
        const overlaps =
          rect.x < d.x + d.width && rect.x + rect.width > d.x && rect.y < d.y + d.height && rect.y + rect.height > d.y;
        if (!overlaps) {
          failures.push(`off display (at ${rect.x},${rect.y}, display is ${d.x},${d.y} ${d.width}x${d.height})`);
        }
      }
    }
  } catch (err) {
    failures.push(`verification threw: ${(err as Error).message}`);
  }

  return { ok: failures.length === 0, failures, rect };
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
 *
 * ADVISORY ONLY. In desktop mode any app the user has open over the probe point
 * makes this false for an entirely legitimate reason, so it is logged and shown
 * in the diagnostics overlay but never used to reject a layer mode.
 */
export function inputReachesWall(hwnd: Hwnd, bounds: Rect): { reachable: boolean; ownerClass: string } {
  const w = win32();
  if (!w) return { reachable: false, ownerClass: '(win32 unavailable)' };
  try {
    // A point well inside the window, away from any edge.
    const at = w.WindowFromPoint({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + Math.min(120, bounds.height / 4)),
    });
    if (!at) return { reachable: false, ownerClass: '(none)' };
    // The hit lands on Chromium's Chrome_RenderWidgetHostHWND child, so walk up
    // to the top-level owner. GA_ROOT is that walk, done by Windows itself.
    const root = w.GetAncestor(at, GA_ROOT) || at;
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

/** Make sure the window owns itself before it is destroyed or rebuilt. */
export function detach(hwnd: Hwnd): void {
  const w = win32();
  if (!w || !w.IsWindow(hwnd)) return;
  ensureTopLevel(hwnd);
}
