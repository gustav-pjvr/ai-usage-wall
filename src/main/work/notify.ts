/**
 * Work notices: which task changes interrupt Gustav, and when
 * (docs/design/work-mode.md section 3, tasks only; docs/work-mode.md).
 *
 * Pure apart from the callbacks it is given: the clock, focus mode, the saved
 * state and the toast are all injected, so every rule below is tested with a
 * fake clock (test/work.test.mjs).
 *
 *   - Notify: Jaco assigned Gustav a task; Jaco moved or commented on a task
 *     Gustav owns or assigned; a task left Waiting. diffTasks (monday.ts)
 *     finds these and already drops Gustav's own changes; this drops them again.
 *   - Quiet hours, 18:00 to 07:30 and all weekend: only Jaco's assignments
 *     (the VIP case) get through. Everything else is counted and folded into
 *     the next morning summary.
 *   - 08:00 on a weekday: one summary of what is due today and overdue, once a
 *     day, from 08:00 until quiet hours start.
 *   - Never while focus mode is on (those changes are counted into the next
 *     morning summary), never twice for the same event (the keys are
 *     persisted), and a burst in one sync is one notice with a count.
 *
 * A notice carries the sender and the task name and nothing else: never a
 * comment's text, never a token.
 */

import { GUSTAV_ID, JACO_ID, localDay as sharedLocalDay, personName, type TaskCard, type TaskEvent, type TasksView } from '../../shared/work-view';

export interface WorkNotice {
  /** De-duplication key of the newest event in it, or `summary:<day>`. */
  key: string;
  kind: TaskEvent['kind'] | 'summary' | 'burst';
  /** Small caps line, e.g. "monday · new task". */
  label: string;
  /** The sender, shown as the title. */
  from: string;
  /** The task name, or the summary line. */
  title: string;
  /** The task Show and Done act on; null for a summary. */
  taskId: string | null;
  /** How many events this notice stands for. */
  count: number;
  /** Done makes sense only for one named task. */
  canDone: boolean;
}

export interface NotifierState {
  /** Event keys already handled, newest last. */
  seen: string[];
  /** Changes held back by quiet hours, for the next morning summary. */
  held: number;
  /** The local day (YYYY-MM-DD) the morning summary last went out. */
  summaryDay: string | null;
}

export const SEEN_MAX = 2000;
export const emptyNotifierState = (): NotifierState => ({ seen: [], held: 0, summaryDay: null });

/** Coerce a saved state. Never throws: a corrupt file costs at most one repeated notice. */
export function cleanNotifierState(raw: unknown): NotifierState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<NotifierState>;
  return {
    seen: Array.isArray(r.seen) ? r.seen.filter((k): k is string => typeof k === 'string' && k.length <= 200).slice(-SEEN_MAX) : [],
    held: typeof r.held === 'number' && Number.isInteger(r.held) && r.held >= 0 ? Math.min(r.held, 10_000) : 0,
    summaryDay: typeof r.summaryDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.summaryDay) ? r.summaryDay : null,
  };
}

/** The local calendar day: the one helper in src/shared/work-view.ts. */
export const localDay = (ms: number): string => sharedLocalDay(ms);

/** 18:00 to 07:30 on a weekday, and all of Saturday and Sunday, local time. */
export function isQuiet(ms: number): boolean {
  const d = new Date(ms);
  const day = d.getDay();
  if (day === 0 || day === 6) return true;
  const minutes = d.getHours() * 60 + d.getMinutes();
  return minutes < 7 * 60 + 30 || minutes >= 18 * 60;
}

const LABEL: Record<TaskEvent['kind'], string> = {
  assigned: 'monday · new task for you',
  moved: 'monday · task moved',
  commented: 'monday · new comment',
  leftWaiting: 'monday · left Waiting',
};

const isVip = (e: TaskEvent): boolean => e.kind === 'assigned' && e.actorId === JACO_ID;

export function createWorkNotifier(deps: {
  now: () => number;
  focus: () => boolean;
  state: NotifierState;
  save: (state: NotifierState) => void;
  show: (notice: WorkNotice) => void;
  me?: string;
}) {
  const me = deps.me ?? GUSTAV_ID;
  const state = cleanNotifierState(deps.state);
  const seen = new Set(state.seen);

  function persist(): void {
    state.seen = [...seen].slice(-SEEN_MAX);
    if (seen.size > SEEN_MAX) {
      seen.clear();
      for (const k of state.seen) seen.add(k);
    }
    deps.save({ seen: [...state.seen], held: state.held, summaryDay: state.summaryDay });
  }

  return {
    /** The task changes from one sync. */
    events(events: TaskEvent[]): void {
      const fresh = events.filter((e) => e.actorId !== me && !seen.has(e.id));
      if (!fresh.length) return;
      // Marked before anything is shown: a crash mid-notice must not replay it.
      for (const e of fresh) seen.add(e.id);
      if (deps.focus()) {
        // Not shown now and not shown later, but counted into the morning summary.
        state.held += fresh.length;
        persist();
        return;
      }
      const quiet = isQuiet(deps.now());
      const deliver = quiet ? fresh.filter(isVip) : fresh;
      state.held += fresh.length - deliver.length;
      persist();
      if (!deliver.length) return;
      const newest = deliver[deliver.length - 1];
      if (deliver.length === 1) {
        deps.show({
          key: newest.id, kind: newest.kind, label: LABEL[newest.kind], from: personName(newest.actorId),
          title: newest.taskName, taskId: newest.taskId, count: 1, canDone: true,
        });
        return;
      }
      const senders = [...new Set(deliver.map((e) => personName(e.actorId)))];
      deps.show({
        key: newest.id, kind: 'burst', label: `monday · ${deliver.length} task updates`,
        from: senders.length === 1 ? senders[0] : `${senders[0]} and others`,
        title: newest.taskName, taskId: newest.taskId, count: deliver.length, canDone: false,
      });
    },

    /** Called after every sync and once a minute: sends the morning summary when it is due. */
    tick(view: TasksView | null): void {
      const now = deps.now();
      const d = new Date(now);
      if (isQuiet(now) || d.getHours() < 8 || !view) return;
      const today = localDay(now);
      if (state.summaryDay === today || deps.focus()) return;
      const open: TaskCard[] = [...view.columns.inProgress, ...view.columns.waiting, ...view.columns.backlog]
        .filter((c) => c.ownerIds.includes(me) && c.due !== null);
      const dueToday = open.filter((c) => c.due === today).length;
      const overdue = open.filter((c) => (c.due as string) < today).length;
      const held = state.held;
      state.summaryDay = today;
      state.held = 0;
      seen.add(`summary:${today}`);
      persist();
      if (!dueToday && !overdue && !held) return;
      const parts = [`${dueToday} due today`, `${overdue} overdue`];
      if (held) parts.push(`${held} update${held === 1 ? '' : 's'} while you were away`);
      deps.show({
        key: `summary:${today}`, kind: 'summary', label: 'monday · this morning', from: 'Your tasks',
        title: parts.join(', '), taskId: null, count: 1, canDone: false,
      });
    },

    snapshot(): NotifierState {
      return { seen: [...seen].slice(-SEEN_MAX), held: state.held, summaryDay: state.summaryDay };
    },
  };
}

export type WorkNotifier = ReturnType<typeof createWorkNotifier>;
