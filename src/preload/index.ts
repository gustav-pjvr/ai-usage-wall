/**
 * Preload bridge. The renderer gets exactly the calls in `api` below and
 * nothing else: no Node, no filesystem, no require. Context isolation is on.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { isStatsOnly } from '../shared/edition';

/** Subscribe to one push channel; returns the unsubscribe. */
const on = (channel: string) => (cb: (v: unknown) => void) => {
  const listener = (_e: unknown, v: unknown) => cb(v);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

/*
 * Ask Gemini (docs/ask-gemini.md). Full build only: in the stats build the
 * wall has no `ask` member at all, so nothing in the renderer can reach it.
 */
const ask = isStatsOnly
  ? undefined
  : {
      start: (question: string) => ipcRenderer.invoke('ask:start', question),
      cancel: () => ipcRenderer.invoke('ask:cancel'),
      /** Borrow or return keyboard focus for the ask bar, like `notesEdit`. */
      focus: (active: boolean) => ipcRenderer.invoke('ask:focus', active),
      onOpen: on('ask:open'),
      onChunk: on('ask:chunk'),
      onDone: on('ask:done'),
      onError: on('ask:error'),
    };

/*
 * Work mode (docs/work-mode.md). Full build only, like `ask`: the stats build
 * has no `work` member and none of these channels. Nothing here can carry the
 * monday token: it is typed into the Connect window, which has its own bridge.
 */
const work = isStatsOnly
  ? undefined
  : {
      get: () => ipcRenderer.invoke('work:get'),
      action: (taskId: string, action: unknown) => ipcRenderer.invoke('work:action', taskId, action),
      create: (input: unknown) => ipcRenderer.invoke('work:create', input),
      open: (taskId: string) => ipcRenderer.invoke('work:open', taskId),
      /** Borrow or return keyboard focus for a Work text box, like `notesEdit`. */
      focus: (active: boolean) => ipcRenderer.invoke('work:focus', active),
      /** Open the Connect monday dialog. */
      connect: () => ipcRenderer.invoke('work:connect'),
      onUpdate: on('work:update'),
      onHighlight: on('work:highlight'),
      onCard: on('work:card'),
    };

/*
 * Work mode's inbox (docs/work-mode.md, "Mail"). Full build only, like `work`.
 * Handles are opaque; nothing here can carry a password or a token, which are
 * typed only into the Connect mail window and its own bridge below.
 */
const mail = isStatsOnly
  ? undefined
  : {
      get: () => ipcRenderer.invoke('mail:get'),
      open: (handle: string) => ipcRenderer.invoke('mail:open', handle),
      action: (handle: string, kind: string) => ipcRenderer.invoke('mail:action', handle, kind),
      undo: (token: string) => ipcRenderer.invoke('mail:undo', token),
      task: (handle: string) => ipcRenderer.invoke('mail:task', handle),
      web: (handle: string) => ipcRenderer.invoke('mail:web', handle),
      /** Open the Connect mail dialog. */
      connect: () => ipcRenderer.invoke('mail:connect'),
      onUpdate: on('mail:update'),
      onHighlight: on('mail:highlight'),
    };

const api = {
  getState: () => ipcRenderer.invoke('wall:getState'),
  updateSettings: (patch: unknown) => ipcRenderer.invoke('wall:updateSettings', patch),
  getUsage: () => ipcRenderer.invoke('wall:getUsage'),
  onUsageProgress: (cb: (p: unknown) => void) => {
    const listener = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on('wall:usageProgress', listener);
    return () => ipcRenderer.removeListener('wall:usageProgress', listener);
  },
  onUsage: (cb: (usage: unknown) => void) => {
    const listener = (_e: unknown, u: unknown) => cb(u);
    ipcRenderer.on('wall:usage', listener);
    return () => ipcRenderer.removeListener('wall:usage', listener);
  },
  toggleFocus: () => ipcRenderer.invoke('wall:toggleFocus'),
  exitFocus: () => ipcRenderer.invoke('wall:exitFocus'),
  openExternal: (url: string) => ipcRenderer.invoke('wall:openExternal', url),
  /** Update state, pushed whenever it changes, for the Install pill. */
  onUpdate: (cb: (s: unknown) => void) => {
    const listener = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on('wall:update', listener);
    return () => ipcRenderer.removeListener('wall:update', listener);
  },
  installUpdate: () => ipcRenderer.invoke('wall:installUpdate'),
  /** Clear the milestone badge, after the list has been opened. */
  milestonesSeen: () => ipcRenderer.invoke('wall:milestonesSeen'),
  /** Every local day and how much of it has five-minute detail, for the day picker. */
  timelapseDays: () => ipcRenderer.invoke('wall:timelapseDays'),
  /** One day's five-minute detail, for the time-lapse. */
  timelapseDay: (day: string) => ipcRenderer.invoke('wall:timelapseDay', day),
  /** Borrow keyboard focus while the notes bar has an open edit. */
  notesEdit: (active: boolean) => ipcRenderer.invoke('wall:notesEdit', active),
  onState: (cb: (state: unknown) => void) => {
    const listener = (_e: unknown, state: unknown) => cb(state);
    ipcRenderer.on('wall:state', listener);
    return () => ipcRenderer.removeListener('wall:state', listener);
  },
  ...(ask ? { ask } : {}),
  ...(work ? { work } : {}),
  ...(mail ? { mail } : {}),
};

contextBridge.exposeInMainWorld('wall', api);

/*
 * The pairing window's bridge, deliberately separate from `wall`.
 *
 * `wall` is exposed to the always-on desktop layer and carries usage data; this
 * one carries pairing actions. Neither surface has any business with the
 * other's calls, and one preload serving two windows is not a reason to merge
 * them.
 */
contextBridge.exposeInMainWorld('pair', {
  mode: () => ipcRenderer.invoke('pair:mode'),
  status: () => ipcRenderer.invoke('pair:status'),
  onStatus: (cb: (s: unknown) => void) => {
    ipcRenderer.on('pair:status', (_e, s) => cb(s));
  },
  newCode: () => ipcRenderer.invoke('pair:newCode'),
  cancelCode: () => ipcRenderer.invoke('pair:cancelCode'),
  redeem: (code: string) => ipcRenderer.invoke('pair:redeem', code),
  revoke: (screenId: string) => ipcRenderer.invoke('pair:revoke', screenId),
  copy: (text: string) => ipcRenderer.invoke('pair:copy', text),
  close: () => ipcRenderer.invoke('pair:close'),
});

export type WallApi = typeof api;

/*
 * The toast window's bridge. It receives update state and nothing else: it has
 * no actions, because the thing you click is the pill on the wall.
 */
contextBridge.exposeInMainWorld('updateToast', {
  onUpdate: (cb: (s: unknown) => void) => {
    ipcRenderer.on('wall:update', (_e, s) => cb(s));
  },
  onNotice: (cb: (n: unknown) => void) => {
    ipcRenderer.on('wall:notice', (_e, n) => cb(n));
  },
  /*
   * Work notices, full build only: the one toast with buttons. The toast only
   * ever sends back the notice id and which button; main holds the task.
   */
  ...(isStatsOnly
    ? {}
    : {
        onWork: (cb: (n: unknown) => void) => {
          ipcRenderer.on('toast:work', (_e, n) => cb(n));
        },
        onWorkEnd: (cb: () => void) => {
          ipcRenderer.on('toast:workEnd', () => cb());
        },
        workAction: (id: number, action: 'show' | 'done' | 'later') => ipcRenderer.invoke('toast:workAction', id, action),
      }),
});

/*
 * The Connect monday window's bridge (full build only). The one place the token
 * crosses from a renderer to main, once, on submit; nothing ever sends it back.
 */
if (!isStatsOnly) {
  contextBridge.exposeInMainWorld('mondayConnect', {
    submit: (token: string) => ipcRenderer.invoke('connect:submit', token),
    close: () => ipcRenderer.invoke('connect:close'),
  });
  /*
   * The Connect mail window's bridge: the one place a mail password crosses
   * to main, once, on submit. Microsoft 365 needs no password here at all: its
   * sign-in happens in the system browser.
   */
  contextBridge.exposeInMainWorld('mailConnect', {
    state: () => ipcRenderer.invoke('mailconnect:state'),
    submit: (preset: string, password: string) => ipcRenderer.invoke('mailconnect:submit', preset, password),
    microsoft: () => ipcRenderer.invoke('mailconnect:microsoft'),
    cancel: () => ipcRenderer.invoke('mailconnect:cancel'),
    close: () => ipcRenderer.invoke('mailconnect:close'),
  });
}

/*
 * The messages window's bridge. Separate from `pair` for the same reason `pair`
 * is separate from `wall`: three surfaces, three sets of calls, and no window
 * gets reach it does not need.
 */
contextBridge.exposeInMainWorld('chat', {
  load: () => ipcRenderer.invoke('chat:load'),
  send: (peerId: string, text: string) => ipcRenderer.invoke('chat:send', peerId, text),
  markRead: (peerId: string) => ipcRenderer.invoke('chat:markRead', peerId),
  onChanged: (cb: () => void) => {
    ipcRenderer.on('chat:changed', () => cb());
  },
  close: () => ipcRenderer.invoke('chat:close'),
});
