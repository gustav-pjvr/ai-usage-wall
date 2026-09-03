/**
 * Raw Win32 bindings via koffi.
 *
 * koffi ships a prebuilt .node binary for win32-x64, so this needs NO C++
 * compiler and NO node-gyp. That is the reason this project can do real
 * desktop-layer window management from Electron on a machine with no MSVC
 * toolchain. See ARCHITECTURE.md "Why not a native addon".
 *
 * Window handles are modelled as `intptr_t` (plain integers) rather than
 * opaque pointers. Electron hands us HWNDs as a raw Buffer from
 * getNativeWindowHandle(), and integers convert both ways trivially.
 */

let koffi: typeof import('koffi') | null = null;
let loadError: Error | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  koffi = require('koffi');
} catch (err) {
  loadError = err as Error;
}

export type Hwnd = number;

export const NULL_HWND: Hwnd = 0;

/** True when the Win32 layer is usable. False on non-Windows or if koffi failed. */
export const isAvailable = (): boolean => koffi !== null && process.platform === 'win32';

export const unavailableReason = (): string | null => {
  if (process.platform !== 'win32') return `not Windows (${process.platform})`;
  if (loadError) return `koffi failed to load: ${loadError.message}`;
  return null;
};

// ── Constants ──────────────────────────────────────────────────────────────

export const GWL_EXSTYLE = -20;
export const GWL_STYLE = -16;

export const WS_EX_TOOLWINDOW = 0x00000080;
export const WS_EX_NOACTIVATE = 0x08000000;
export const WS_EX_TRANSPARENT = 0x00000020;
export const WS_EX_LAYERED = 0x00080000;
export const WS_EX_APPWINDOW = 0x00040000;

export const HWND_TOP = 0;
export const HWND_BOTTOM = 1;
export const HWND_TOPMOST = -1;
export const HWND_NOTOPMOST = -2;

export const SWP_NOSIZE = 0x0001;
export const SWP_NOMOVE = 0x0002;
export const SWP_NOACTIVATE = 0x0010;
export const SWP_NOOWNERZORDER = 0x0200;
export const SWP_SHOWWINDOW = 0x0040;

/** GetAncestor flags. GA_PARENT is the real parent; GA_ROOT walks to the top. */
export const GA_PARENT = 1;
export const GA_ROOT = 2;

/*
 * HKEY_CURRENT_USER is ((HKEY)(ULONG_PTR)((LONG)0x80000001)), i.e. the 32-bit
 * constant SIGN-EXTENDED to pointer width. Writing 0x80000001 directly gives
 * the wrong 64-bit value and every lookup fails with ERROR_INVALID_HANDLE, so
 * it is spelled as the negative number it actually is.
 */
export const HKEY_CURRENT_USER = -2147483647;
/** RRF_RT_REG_DWORD: refuse to coerce anything that is not a DWORD. */
export const RRF_RT_REG_DWORD = 0x00000010;

/** DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 */
export const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;

// ── Bindings ───────────────────────────────────────────────────────────────

interface Win32Api {
  FindWindowW(cls: string | null, win: string | null): Hwnd;
  GetClassNameW(h: Hwnd, buf: Buffer, n: number): number;
  SetParent(child: Hwnd, parent: Hwnd): Hwnd;
  /*
   * There is deliberately NO GetParent binding here. It returns the OWNER of a
   * WS_POPUP window, which every Electron window is, so it answers NULL whether
   * or not the window has been reparented. Believing it is what left the wall
   * sitting inside Progman while the code reported "SetParent refused". Use
   * GetAncestor(h, GA_PARENT) and compare against GetDesktopWindow().
   */
  GetAncestor(h: Hwnd, flags: number): Hwnd;
  GetDesktopWindow(): Hwnd;
  IsWindowVisible(h: Hwnd): boolean;
  GetWindowRect(h: Hwnd, rect: { left: number; top: number; right: number; bottom: number }[]): boolean;
  SetWindowPos(h: Hwnd, after: Hwnd, x: number, y: number, cx: number, cy: number, flags: number): boolean;
  GetWindowLongPtrW(h: Hwnd, index: number): number;
  SetWindowLongPtrW(h: Hwnd, index: number, value: number): number;
  IsWindow(h: Hwnd): boolean;
  WindowFromPoint(point: { x: number; y: number }): Hwnd;
  GetForegroundWindow(): Hwnd;
  SetProcessDpiAwarenessContext(ctx: number): boolean;
  RegGetValueW(
    key: number,
    subKey: string | null,
    value: string | null,
    flags: number,
    type: number[] | null,
    data: Buffer,
    size: number[],
  ): number;
}

let api: Win32Api | null = null;

function build(): Win32Api | null {
  if (!koffi || process.platform !== 'win32') return null;
  const k = koffi;
  const user32 = k.load('user32.dll');
  const advapi32 = k.load('advapi32.dll');
  k.struct('POINT', { x: 'int32_t', y: 'int32_t' });
  k.struct('RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });

  return {
    FindWindowW: user32.func('intptr_t __stdcall FindWindowW(const char16_t *cls, const char16_t *win)') as never,
    GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t h, _Out_ char16_t *buf, int n)') as never,
    SetParent: user32.func('intptr_t __stdcall SetParent(intptr_t child, intptr_t parent)') as never,
    GetAncestor: user32.func('intptr_t __stdcall GetAncestor(intptr_t h, uint32_t flags)') as never,
    GetDesktopWindow: user32.func('intptr_t __stdcall GetDesktopWindow()') as never,
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t h)') as never,
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t h, _Out_ RECT *rect)') as never,
    SetWindowPos: user32.func(
      'bool __stdcall SetWindowPos(intptr_t h, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)',
    ) as never,
    GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t h, int index)') as never,
    SetWindowLongPtrW: user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t h, int index, intptr_t value)') as never,
    IsWindow: user32.func('bool __stdcall IsWindow(intptr_t h)') as never,
    // POINT is passed by value: two 32-bit ints packed into one 64-bit slot.
    WindowFromPoint: user32.func('intptr_t __stdcall WindowFromPoint(POINT p)') as never,
    GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()') as never,
    SetProcessDpiAwarenessContext: user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t ctx)') as never,
    RegGetValueW: advapi32.func(
      'long __stdcall RegGetValueW(intptr_t key, const char16_t *sub, const char16_t *val, uint32_t flags, _Out_ uint32_t *type, _Out_ void *data, _Inout_ uint32_t *size)',
    ) as never,
  };
}

/** Lazily built so importing this module on a non-Windows box never throws. */
export function win32(): Win32Api | null {
  if (api === null && isAvailable()) api = build();
  return api;
}

/** Convert Electron's getNativeWindowHandle() Buffer into an integer HWND. */
export function hwndFromBuffer(buf: Buffer): Hwnd {
  const raw = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`HWND ${raw} exceeds safe integer range`);
  }
  return Number(raw);
}

/**
 * Read a REG_DWORD from HKCU. Returns null when the value is absent or unreadable.
 *
 * This exists so a value that has to be re-read periodically costs microseconds
 * rather than a `reg.exe` process spawn. Shelling out was fine for a one-off at
 * startup and is not fine on a timer.
 */
export function readHkcuDword(subKey: string, value: string): number | null {
  const w = win32();
  if (!w) return null;
  try {
    const data = Buffer.alloc(4);
    const size = [4];
    const rc = w.RegGetValueW(HKEY_CURRENT_USER, subKey, value, RRF_RT_REG_DWORD, null, data, size);
    if (rc !== 0) return null; // ERROR_SUCCESS is 0; anything else means "no answer"
    return data.readUInt32LE(0);
  } catch {
    return null;
  }
}

/** Read a window's class name. Returns '' on failure. */
export function getClassName(h: Hwnd): string {
  const w = win32();
  if (!w || !koffi) return '';
  const buf = Buffer.alloc(512);
  const n = w.GetClassNameW(h, buf, 256);
  if (n <= 0) return '';
  return koffi.decode(buf, 'char16_t', -1) as string;
}
