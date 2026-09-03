/**
 * Preload bridge. The renderer gets exactly these five calls and nothing else:
 * no Node, no filesystem, no require. Context isolation is on.
 */

import { contextBridge, ipcRenderer } from 'electron';

const api = {
  getState: () => ipcRenderer.invoke('wall:getState'),
  updateSettings: (patch: unknown) => ipcRenderer.invoke('wall:updateSettings', patch),
  reload: () => ipcRenderer.invoke('wall:reload'),
  getUsage: () => ipcRenderer.invoke('wall:getUsage'),
  setMode: (mode: string) => ipcRenderer.invoke('wall:setMode', mode),
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
  onDebugOpenDetail: (cb: (id: string) => void) => {
    ipcRenderer.on('wall:debugOpenDetail', (_e, id: string) => cb(id));
  },
  /** Update state, pushed whenever it changes, for the Install pill. */
  onUpdate: (cb: (s: unknown) => void) => {
    const listener = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on('wall:update', listener);
    return () => ipcRenderer.removeListener('wall:update', listener);
  },
  installUpdate: () => ipcRenderer.invoke('wall:installUpdate'),
  onState: (cb: (state: unknown) => void) => {
    const listener = (_e: unknown, state: unknown) => cb(state);
    ipcRenderer.on('wall:state', listener);
    return () => ipcRenderer.removeListener('wall:state', listener);
  },
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
});
