/**
 * Ask Gemini: one question, one run of the Antigravity CLI (`agy`).
 *
 * WHY AGY AND NOT THE GEMINI CLI
 *
 * The design (docs/design/gemini-ask.md) chose the Gemini CLI. On 2026-11-06
 * Google refused Gustav's sign-in there: "This client is no longer supported
 * for Gemini Code Assist for individuals. To continue using Gemini, please
 * migrate to the Antigravity suite of products". agy is that suite's CLI, is
 * signed in on his Google AI Plus account, and runs Gemini 3.8 Flash. One
 * backend lives here; nothing outside this file knows which program answers.
 *
 * WHAT THIS FILE OWNS, AND WHY IT IS SECURITY-SENSITIVE
 *
 * agy is a coding agent with shell, file and browser tools, and the question is
 * outside input. So every run is locked down (measured against agy 1.4.11 on
 * 2026-11-06, see docs/ask-gemini.md):
 *
 *   - The question never touches a command line. The prompt goes in on STDIN
 *     as one NDJSON `user` event (`--input-format stream-json`). argv is a
 *     fixed list built here; the only variable parts are the model slug
 *     (validated, cannot start with `-`) and two paths this file created.
 *   - spawn with `shell: false`. agy.exe is a real executable, so no `.cmd`
 *     shim and no cmd.exe is ever involved.
 *   - A session-only settings file (`--settings`, never saved by agy) that
 *     REPLACES the user's permission rules for this run (measured: the log
 *     shows only these rules) and denies every command, every file read and
 *     write, every URL fetch and every MCP tool. `toolPermission: strict` makes
 *     anything else ask, and in print mode an ask is a denial.
 *   - `--mode plan` (read and propose only). Kept instead of
 *     `--disable-slash-commands`, because agy 1.4.11 still ignores plan mode
 *     when slash expansion is off (measured, same as the bridge found on
 *     1.3.2). The prompt always starts with the wall's own preamble and every
 *     line of the question is quoted, so no line of it can be a slash command.
 *   - A fresh empty working folder per run, outside any repository, deleted
 *     afterwards, with agy's log file beside it rather than in it.
 *   - A watchdog on agy's own event stream: the moment it reports any tool
 *     other than web search, the run is killed and its answer discarded. That
 *     is detection, not prevention (the deny rules are the prevention), but it
 *     stops a run that is doing something it should not.
 *   - A time limit, one run at a time, and the whole process tree killed on
 *     cancel or timeout.
 *
 * Nothing agy prints reaches the renderer raw. Answer text is stripped of ANSI
 * and control characters and capped; failures become one of a few fixed
 * messages; stderr is only ever matched against patterns, never forwarded or
 * logged, because it can hold paths and account details.
 *
 * Prior art: gemini-bridge/src/agy-cli.js (Gustav's MCP bridge) solved agy's
 * output format, the deny-rule syntax and the plan/slash-command quirk. This
 * file copies those findings rather than importing across repositories.
 *
 * No electron import, so test/ask.test.mjs runs it under plain node with a fake
 * CLI in place of agy.
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Where agy installs itself for the current user. */
export function defaultAgyExe(): string {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'agy', 'bin', 'agy.exe');
}

/** A model slug as `agy models` prints it. Never starts with `-`, so it can never be read as a flag. */
export const MODEL_SLUG = /^[a-z0-9][a-z0-9.-]{0,63}$/;
/** Only Gemini Flash is offered on the wall (Gustav's plan quota is small; Flash is the cheap one). */
export const OFFERED_MODEL = /^gemini-[a-z0-9.-]*flash[a-z0-9.-]*$/;
export const DEFAULT_MODEL = 'gemini-3.8-flash-medium';
/** Used when `agy models` cannot be read: what agy 1.4.11 listed on 2026-11-06. */
export const FALLBACK_MODELS = ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'];

export const QUESTION_MIN = 1;
export const QUESTION_MAX = 2000;
export const ASK_TIMEOUT_MS = 90_000;
/** Longest answer kept. Several screens of the panel; anything past it is cut with a note. */
export const ANSWER_MAX = 12_000;
/** Stop reading stdout past this. A runaway stream is killed, not buffered. */
const STDOUT_MAX = 2 * 1024 * 1024;
/** Only so much stderr is kept, and only for pattern matching. */
const STDERR_MAX = 16 * 1024;

/** The only tool a run may use. Anything else seen in the event stream kills the run. */
export const ALLOWED_TOOLS: ReadonlySet<string> = new Set(['search_web']);

/**
 * The session-only settings. Every key here was accepted by agy 1.4.11 and
 * exercised in a live run on 2026-11-06; agy rejects an unknown key outright
 * ("--settings: unknown setting"), so a guess would break every question.
 */
export const LOCKDOWN_SETTINGS = {
  toolPermission: 'strict',
  allowNonWorkspaceAccess: false,
  enableTerminalSandbox: true,
  permissions: {
    allow: [] as string[],
    deny: ['command(*)', 'write_file(*)', 'read_file(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'],
  },
} as const;

/**
 * The argument list for one run. Built here and nowhere else; no caller adds a
 * flag, and `--dangerously-skip-permissions` is never passed. The prompt is NOT
 * an argument: `-p ""` only switches on print mode, and the question arrives on
 * stdin.
 */
export function buildArgs(model: string, settingsFile: string, logFile: string, timeoutMs = ASK_TIMEOUT_MS): string[] {
  if (!MODEL_SLUG.test(model)) throw new Error('invalid model slug');
  if (!path.isAbsolute(settingsFile) || !path.isAbsolute(logFile)) throw new Error('paths must be absolute');
  return [
    '-p', '',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--mode', 'plan',
    '--sandbox',
    '--model', model,
    '--print-timeout', `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`,
    '--settings', settingsFile,
    '--log-file', logFile,
  ];
}

/** The one NDJSON line agy reads on stdin. JSON.stringify escapes every newline, so it is one line. */
export function stdinMessage(prompt: string): string {
  return `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
}

// ── Text hygiene ───────────────────────────────────────────────────────────

/* eslint-disable no-control-regex */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-~]|\x9b[0-?]*[ -/]*[@-~]/g;
/** C0 and C1 controls except tab and newline, plus DEL. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/**
 * Invisible characters that change how text reads without showing: zero-width
 * spaces and joiners, direction marks, bidi overrides and isolates, the
 * Unicode line and paragraph separators, and the BOM.
 */
const INVISIBLE = /[\u200b-\u200f\u061c\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
/* eslint-enable no-control-regex */

/** Model text made safe to put in a text node: no escapes, no controls, normalised newlines. */
export function cleanText(s: string): string {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(ANSI, '')
    .replace(CONTROL, '')
    .replace(INVISIBLE, '');
}

/** Cap by code points, with a visible note, so a capped answer never pretends to be whole. */
export function capAnswer(s: string, max = ANSWER_MAX): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return `${chars.slice(0, max).join('')}\n\n[Answer cut at ${max.toLocaleString('en-US')} characters]`;
}

/**
 * Validate the question. Trimmed, 1 to 2,000 characters (code points), and a
 * string. Null means refused.
 */
export function checkQuestion(q: unknown): string | null {
  if (typeof q !== 'string') return null;
  const t = q.trim();
  const n = Array.from(t).length;
  return n >= QUESTION_MIN && n <= QUESTION_MAX ? t : null;
}

// ── Output parsing ─────────────────────────────────────────────────────────

export type StreamItem =
  | { kind: 'delta'; text: string }
  | { kind: 'tool'; name: string; state: string }
  | { kind: 'result'; ok: boolean; response: string; error: string }
  /** A shape on the allowlist that carries no action: nothing to do. */
  | { kind: 'quiet' }
  /** Anything not on the allowlist. The watchdog kills the run. `what` is a short, safe token. */
  | { kind: 'unknown'; what: string };

/**
 * Step types that carry no tool action, as SEEN in real agy 1.4.11 output on
 * 2026-11-06: the echoed question, the model's text, and the error step agy
 * writes before a failed `result` (the quota run). Everything else, including a
 * step type agy adds later, is treated as an action the wall did not allow.
 */
export const QUIET_STEPS: ReadonlySet<string> = new Set(['user_input', 'agent_response', 'error_message']);

const token = (v: unknown): string => String(v ?? '').replace(/[^a-z0-9_]/gi, '').slice(0, 40) || '?';

/**
 * One line of agy's `--output-format stream-json`, classified against an
 * ALLOWLIST of the shapes measured on agy 1.4.11: `init`; `step_update` with a
 * step type in QUIET_STEPS (agent text arrives as `text_delta` on
 * `agent_response`); `step_update` with `step_type: "tool"` (judged by name in
 * the runner); and the final `result`. A line that is not a JSON object, an
 * unknown event and an unknown step type all come back as `unknown`.
 */
export function parseStreamLine(line: string): StreamItem {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return { kind: 'unknown', what: 'not-json' };
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { kind: 'unknown', what: 'not-object' };
  const ev = o as Record<string, unknown>;
  if (ev.event === 'init') return { kind: 'quiet' };
  if (ev.event === 'step_update' && ev.step_update && typeof ev.step_update === 'object') {
    const s = ev.step_update as Record<string, unknown>;
    if (s.step_type === 'tool') {
      return { kind: 'tool', name: typeof s.tool_name === 'string' ? s.tool_name : '?', state: typeof s.state === 'string' ? s.state : '' };
    }
    if (typeof s.step_type === 'string' && QUIET_STEPS.has(s.step_type)) {
      if (s.step_type === 'agent_response' && typeof s.text_delta === 'string') return { kind: 'delta', text: s.text_delta };
      return { kind: 'quiet' };
    }
    return { kind: 'unknown', what: `step-${token(s.step_type)}` };
  }
  if (ev.event === 'result' && ev.result && typeof ev.result === 'object') {
    const r = ev.result as Record<string, unknown>;
    return {
      kind: 'result',
      ok: r.status === 'SUCCESS',
      response: typeof r.response === 'string' ? r.response : '',
      error: typeof r.error === 'string' ? r.error : '',
    };
  }
  return { kind: 'unknown', what: `event-${token(ev.event)}` };
}

/** `agy models` prints "Fetching available models..." then `slug<TAB>Label` lines. */
export function parseModels(stdout: string): string[] {
  const out: string[] = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const m = /^([a-z0-9][a-z0-9.-]*)\t+.+$/.exec(line.trim());
    if (m && MODEL_SLUG.test(m[1]) && OFFERED_MODEL.test(m[1]) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// ── Failures ───────────────────────────────────────────────────────────────

export type AskErrorCode = 'missing' | 'signin' | 'quota' | 'timeout' | 'cancelled' | 'blocked' | 'busy' | 'invalid' | 'failed';

export interface AskFailure {
  code: AskErrorCode;
  message: string;
}

const MESSAGES: Record<AskErrorCode, string> = {
  missing: 'The Antigravity CLI is not installed. Install it from antigravity.google/download, run `agy` once and sign in with Google.',
  signin: 'The Antigravity CLI is not signed in. Run `agy` in a terminal once and sign in with Google.',
  quota: "Gemini's quota on this Google account is used up for now.",
  timeout: 'Gemini took longer than 90 seconds, so the question was stopped.',
  cancelled: 'Cancelled.',
  blocked: 'Gemini tried to use a tool the wall does not allow, so the answer was stopped and thrown away.',
  busy: 'Gemini is still answering the last question. Wait for it, or press Escape to cancel it.',
  invalid: 'Type a question of 1 to 2,000 characters.',
  failed: 'Gemini could not answer. Try again in a moment.',
};

/** A fixed message for a code. Only these strings ever reach the renderer as an error. */
export function failure(code: AskErrorCode, extra = ''): AskFailure {
  return { code, message: extra ? `${MESSAGES[code]} ${extra}` : MESSAGES[code] };
}

/**
 * Turn a failed run into a fixed message. The raw text is only searched,
 * never returned: the one piece lifted out of it is a reset time, and only in
 * the strict `35m21s` shape, so nothing else in it can ride along.
 */
export function classifyFailure(exitCode: number | null, stderr: string, resultError: string, timedOut: boolean): AskFailure {
  if (timedOut) return failure('timeout');
  const text = `${resultError}\n${stderr}`;
  if (/RESOURCE_EXHAUSTED|\b429\b|quota|credits? (?:are |is )?(?:used|exhausted|exceeded)|out of credits/i.test(text)) {
    const reset = /resets? in ((?:\d{1,3}h)?(?:\d{1,2}m)?(?:\d{1,2}s)?)\b/i.exec(text);
    return failure('quota', reset && reset[1] ? `It resets in ${reset[1]}.` : '');
  }
  if (/UNAUTHENTICATED|\b401\b|not (?:signed|logged) in|sign[ -]?in required|please (?:sign|log) in|no credentials|login required|authenticat(?:e|ion) (?:required|failed)/i.test(text)) {
    return failure('signin');
  }
  void exitCode;
  return failure('failed');
}

/** A short, path-free code for the log. */
export function logCode(f: AskFailure, exitCode: number | null): string {
  return `${f.code}${exitCode === null ? '' : ` (exit ${exitCode})`}`;
}

// ── Process tree ───────────────────────────────────────────────────────────

/** taskkill by its full path, so a `taskkill` earlier on PATH can never be run instead. */
export function taskkillPath(): string {
  return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe');
}

/**
 * Kill a process and everything it started. Windows: taskkill /T /F by full
 * path, no shell. Skipped when the process has already exited, because its pid
 * may by then belong to something else.
 */
export function killChild(child: ChildProcess | null | undefined): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  killTree(child.pid);
}

/** Kill a pid and its tree. Prefer killChild, which checks the process is still ours. */
export function killTree(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  if (process.platform === 'win32') {
    execFile(taskkillPath(), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false }, () => undefined);
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

/** List the Flash models agy offers. Falls back to the known list when agy cannot be read. */
export function listModels(exe = defaultAgyExe()): Promise<{ models: string[]; fromCli: boolean }> {
  return new Promise((resolve) => {
    execFile(exe, ['models'], { windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024, shell: false }, (err, stdout) => {
      const models = err ? [] : parseModels(String(stdout));
      resolve(models.length ? { models, fromCli: true } : { models: [...FALLBACK_MODELS], fromCli: false });
    });
  });
}

// ── The runner ─────────────────────────────────────────────────────────────

export type AskEvent =
  | { type: 'chunk'; id: number; text: string }
  | { type: 'done'; id: number; text: string; model: string }
  | { type: 'error'; id: number; code: AskErrorCode; message: string };

export interface RunnerOptions {
  /** The program to start. agy.exe in the app; process.execPath in the tests. */
  exe: string;
  /** Arguments before agy's own. Empty in the app; the fake CLI's script path in the tests. */
  prefixArgs?: string[];
  /** Parent of each run's temporary folder. */
  tmpRoot?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Short, path-free log lines. */
  log?: (line: string) => void;
  /**
   * TESTS ONLY. Called after the process has exited and before the run's
   * folder is deleted, so a test can prove the folder is still empty.
   */
  beforeCleanup?: (workDir: string) => Promise<void>;
  /** TESTS ONLY. Every tool step agy reports, so a test can see what was attempted. */
  onTool?: (name: string, state: string) => void;
  /**
   * TESTS ONLY. False turns the tool watchdog off, so the live lock-down test
   * proves the deny rules on their own rather than the watchdog. Default true.
   */
  watchdog?: boolean;
}

export interface AskRunner {
  /** Start a run. Refused with a fixed message when one is already running or the question is invalid. */
  start(question: unknown, prompt: (q: string) => string, model: string, emit: (e: AskEvent) => void): { ok: true; id: number } | { ok: false; code: AskErrorCode; message: string };
  /** Cancel the run in progress. True when there was one. */
  cancel(): boolean;
  busy(): boolean;
  /** Resolves when the current run (if any) has finished cleaning up. For tests and quit. */
  idle(): Promise<void>;
}

/**
 * Quote every line of the question, so no line of it can start a slash command
 * or pass for the wall's own instructions.
 */
export function quoteQuestion(q: string): string {
  return q
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

export function createAgyRunner(opts: RunnerOptions): AskRunner {
  const timeoutMs = opts.timeoutMs ?? ASK_TIMEOUT_MS;
  const log = opts.log ?? (() => undefined);
  let current: { id: number; child: ChildProcess | null; cancelled: boolean; done: Promise<void> } | null = null;
  let nextId = 1;

  const start: AskRunner['start'] = (question, prompt, model, emit) => {
    if (current) return { ok: false, ...failure('busy') };
    const q = checkQuestion(question);
    if (q === null) return { ok: false, ...failure('invalid') };
    if (!MODEL_SLUG.test(model)) return { ok: false, ...failure('failed') };

    const id = nextId++;
    const run = { id, child: null as ChildProcess | null, cancelled: false, done: Promise.resolve() };
    current = run;
    run.done = execute(run, prompt(q), model, emit).finally(() => {
      if (current === run) current = null;
    });
    return { ok: true, id };
  };

  async function execute(
    run: { id: number; child: ChildProcess | null; cancelled: boolean },
    prompt: string,
    model: string,
    emit: (e: AskEvent) => void,
  ): Promise<void> {
    const started = Date.now();
    let root: string | null = null;
    let finished = false;
    const finish = (e: AskEvent): void => {
      if (finished) return;
      finished = true;
      emit(e);
    };
    try {
      root = await fs.mkdtemp(path.join(opts.tmpRoot ?? os.tmpdir(), 'mbw-ask-'));
      const work = path.join(root, 'work');
      await fs.mkdir(work);
      const settingsFile = path.join(root, 'settings.json');
      const logFile = path.join(root, 'agy.log');
      await fs.writeFile(settingsFile, JSON.stringify(LOCKDOWN_SETTINGS), 'utf8');
      if (run.cancelled) {
        finish({ type: 'error', id: run.id, ...failure('cancelled') });
        return;
      }

      const args = [...(opts.prefixArgs ?? []), ...buildArgs(model, settingsFile, logFile, timeoutMs)];
      let child: ChildProcess;
      try {
        child = spawn(opts.exe, args, {
          cwd: work,
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: opts.env ?? process.env,
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const f = failure(code === 'ENOENT' ? 'missing' : 'failed');
        log(`[ask] could not start: ${logCode(f, null)}`);
        finish({ type: 'error', id: run.id, ...f });
        return;
      }
      run.child = child;

      let stdoutBytes = 0;
      let pending = '';
      let stderr = '';
      let streamed = '';
      let result: { ok: boolean; response: string; error: string } | null = null;
      let timedOut = false;
      let blocked: string | null = null;
      let spawnError: NodeJS.ErrnoException | null = null;

      const kill = (): void => killChild(child);
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);

      const onLine = (line: string): void => {
        if (!line.trim() || blocked) return;
        const item = parseStreamLine(line);
        if (item.kind === 'unknown') {
          // Not on the allowlist (a new step type, a browser step, a stray
          // line): the wall cannot tell it is harmless, so it ends the run.
          if (opts.watchdog === false) return;
          blocked = item.what;
          log(`[ask] agy reported '${blocked}', which is not allowed, killing the run`);
          kill();
        } else if (item.kind === 'delta') {
          const text = cleanText(item.text);
          if (!text) return;
          const room = ANSWER_MAX - Array.from(streamed).length;
          if (room <= 0) return;
          const piece = Array.from(text).slice(0, room).join('');
          streamed += piece;
          emit({ type: 'chunk', id: run.id, text: piece });
        } else if (item.kind === 'tool') {
          opts.onTool?.(item.name, item.state);
          if (!ALLOWED_TOOLS.has(item.name) && opts.watchdog !== false) {
            // A name agy chose, but still only logged as a short token.
            blocked = item.name.replace(/[^a-z0-9_]/gi, '').slice(0, 40) || '?';
            log(`[ask] tool '${blocked}' is not allowed, killing the run`);
            kill();
          } else if (item.state === 'ACTIVE') {
            log(`[ask] tool ${item.name}`);
          }
        } else if (item.kind === 'result') {
          result = item;
        }
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > STDOUT_MAX) {
          if (!blocked) blocked = 'oversize';
          kill();
          return;
        }
        pending += chunk;
        let nl: number;
        while ((nl = pending.indexOf('\n')) >= 0) {
          onLine(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length < STDERR_MAX) stderr += chunk.slice(0, STDERR_MAX - stderr.length);
      });
      // A child that exits before reading stdin makes the write fail; that is a
      // failed run, reported by the exit below, not a crash of the wall.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(stdinMessage(prompt), 'utf8');

      const exitCode = await new Promise<number | null>((resolve) => {
        child.once('error', (err) => {
          spawnError = err as NodeJS.ErrnoException;
          resolve(null);
        });
        child.once('close', (code) => resolve(code));
      });
      clearTimeout(timer);
      if (pending.trim()) onLine(pending);
      if (opts.beforeCleanup) await opts.beforeCleanup(work).catch(() => undefined);

      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (spawnError) {
        const f = failure((spawnError as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'failed');
        log(`[ask] could not start: ${logCode(f, null)}`);
        finish({ type: 'error', id: run.id, ...f });
        return;
      }
      if (run.cancelled) {
        log(`[ask] cancelled after ${secs}s`);
        finish({ type: 'error', id: run.id, ...failure('cancelled') });
        return;
      }
      if (blocked) {
        finish({ type: 'error', id: run.id, ...failure('blocked') });
        return;
      }
      const res = result as { ok: boolean; response: string; error: string } | null;
      if (!timedOut && exitCode === 0 && res && res.ok) {
        const text = capAnswer(cleanText(res.response || streamed).trim());
        if (!text) {
          log(`[ask] empty answer after ${secs}s`);
          finish({ type: 'error', id: run.id, ...failure('failed') });
          return;
        }
        log(`[ask] answered in ${secs}s`);
        finish({ type: 'done', id: run.id, text, model });
        return;
      }
      const f = classifyFailure(exitCode, stderr, res?.error ?? '', timedOut);
      log(`[ask] failed after ${secs}s: ${logCode(f, exitCode)}`);
      finish({ type: 'error', id: run.id, ...f });
    } catch (err) {
      log(`[ask] run failed: ${(err as NodeJS.ErrnoException).code ?? 'internal'}`);
      finish({ type: 'error', id: run.id, ...failure('failed') });
    } finally {
      if (root) await removeTree(root);
    }
  }

  return {
    start,
    cancel() {
      if (!current) return false;
      current.cancelled = true;
      killChild(current.child);
      return true;
    },
    busy: () => current !== null,
    idle: async () => {
      while (current) await current.done;
    },
  };
}

/** The prefix of every run's folder, and the only thing the startup sweep removes. */
export const RUN_PREFIX = 'mbw-ask-';

/**
 * Remove run folders a previous session left behind (a crash, a forced quit, or
 * a quit that did not wait). They can hold the session settings and agy's log,
 * which may contain the prompt. Only directories, only directly under
 * `tmpRoot`, only names starting with RUN_PREFIX, and never through a link: a
 * symlink or junction with that name is left alone, and `fs.rm` removes a link
 * inside a folder without following it. Returns how many were removed.
 */
/** A run folder younger than this is never swept: no run lasts longer than its 90 s timeout. */
export const STALE_MS = 2 * 60 * 1000;

export async function sweepStaleRuns(tmpRoot = os.tmpdir(), now = Date.now()): Promise<number> {
  let removed = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(tmpRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.name.startsWith(RUN_PREFIX) || !e.isDirectory() || e.isSymbolicLink()) continue;
    const full = path.join(tmpRoot, e.name);
    try {
      // Checked again on the path itself: a junction can read as a directory.
      const st = await fs.lstat(full);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if (path.dirname(full) !== path.resolve(tmpRoot)) continue;
      // Touched recently: it may be a live run of another instance (a dev or
      // test build), and deleting its settings could let agy run without them.
      if (now - st.mtimeMs < STALE_MS) continue;
      await removeTree(full);
      removed++;
    } catch {
      /* gone already, or not ours to touch */
    }
  }
  return removed;
}

/**
 * Remove a run's folder. agy can hold its log open for a moment after exit on
 * Windows, so a few short retries; a folder that still will not go is left for
 * the OS temp cleaner and logged, never retried forever.
 */
async function removeTree(dir: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
}
