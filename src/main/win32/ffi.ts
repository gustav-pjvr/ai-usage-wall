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

export const SMTO_ABORTIFHUNG = 0x0002;

/** Undocumented Progman message that spawns the WorkerW wallpaper layer. */
export const WM_SPAWN_WORKERW = 0x052c;

/** DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 */
export const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;

// System metric indices.
export const SM_XVIRTUALSCREEN = 76;
export const SM_YVIRTUALSCREEN = 77;
export const SM_CXVIRTUALSCREEN = 78;
export const SM_CYVIRTUALSCREEN = 79;
export const SM_CMONITORS = 80;

// ── Bindings ───────────────────────────────────────────────────────────────

interface Win32Api {
  FindWindowW(cls: string | null, win: string | null): Hwnd;
  FindWindowExW(parent: Hwnd, after: Hwnd, cls: string | null, win: string | null): Hwnd;
  GetClassNameW(h: Hwnd, buf: Buffer, n: number): number;
  EnumWindows(cb: unknown, lp: number): boolean;
  SetParent(child: Hwnd, parent: Hwnd): Hwnd;
  GetParent(h: Hwnd): Hwnd;
  SetWindowPos(h: Hwnd, after: Hwnd, x: number, y: number, cx: number, cy: number, flags: number): boolean;
  GetWindowLongPtrW(h: Hwnd, index: number): number;
  SetWindowLongPtrW(h: Hwnd, index: number, value: number): number;
  SendMessageTimeoutW(h: Hwnd, msg: number, wp: number, lp: number, flags: number, timeout: number, res: number[]): number;
  GetSystemMetrics(i: number): number;
  IsWindow(h: Hwnd): boolean;
  GetShellWindow(): Hwnd;
  WindowFromPoint(point: { x: number; y: number }): Hwnd;
  GetForegroundWindow(): Hwnd;
  SetProcessDpiAwarenessContext(ctx: number): boolean;
  EnumProcProto: unknown;
  register(fn: (h: Hwnd, lp: number) => boolean): unknown;
  unregister(handle: unknown): void;
}

let api: Win32Api | null = null;

function build(): Win32Api | null {
  if (!koffi || process.platform !== 'win32') return null;
  const k = koffi;
  const user32 = k.load('user32.dll');
  k.struct('POINT', { x: 'int32_t', y: 'int32_t' });

  const EnumProcProto = k.proto('bool __stdcall EnumProc(intptr_t h, intptr_t lp)');

  return {
    FindWindowW: user32.func('intptr_t __stdcall FindWindowW(const char16_t *cls, const char16_t *win)') as never,
    FindWindowExW: user32.func(
      'intptr_t __stdcall FindWindowExW(intptr_t parent, intptr_t after, const char16_t *cls, const char16_t *win)',
    ) as never,
    GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t h, _Out_ char16_t *buf, int n)') as never,
    EnumWindows: user32.func('bool __stdcall EnumWindows(void *cb, intptr_t lp)') as never,
    SetParent: user32.func('intptr_t __stdcall SetParent(intptr_t child, intptr_t parent)') as never,
    GetParent: user32.func('intptr_t __stdcall GetParent(intptr_t h)') as never,
    SetWindowPos: user32.func(
      'bool __stdcall SetWindowPos(intptr_t h, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)',
    ) as never,
    GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t h, int index)') as never,
    SetWindowLongPtrW: user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t h, int index, intptr_t value)') as never,
    SendMessageTimeoutW: user32.func(
      'intptr_t __stdcall SendMessageTimeoutW(intptr_t h, uint32_t msg, uintptr_t wp, intptr_t lp, uint32_t flags, uint32_t timeout, _Out_ uintptr_t *res)',
    ) as never,
    GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int i)') as never,
    IsWindow: user32.func('bool __stdcall IsWindow(intptr_t h)') as never,
    GetShellWindow: user32.func('intptr_t __stdcall GetShellWindow()') as never,
    // POINT is passed by value: two 32-bit ints packed into one 64-bit slot.
    WindowFromPoint: user32.func('intptr_t __stdcall WindowFromPoint(POINT p)') as never,
    GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()') as never,
    SetProcessDpiAwarenessContext: user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t ctx)') as never,
    EnumProcProto,
    register: (fn) => k.register(fn, k.pointer(EnumProcProto)),
    unregister: (handle) => k.unregister(handle as never),
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

/** Read a window's class name. Returns '' on failure. */
export function getClassName(h: Hwnd): string {
  const w = win32();
  if (!w || !koffi) return '';
  const buf = Buffer.alloc(512);
  const n = w.GetClassNameW(h, buf, 256);
  if (n <= 0) return '';
  return koffi.decode(buf, 'char16_t', -1) as string;
}
