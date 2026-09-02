/**
 * Preload bridge. The renderer gets exactly these five calls and nothing else:
 * no Node, no filesystem, no require. Context isolation is on.
 */

import { contextBridge, ipcRenderer } from 'electron';

const api = {
  getState: () => ipcRenderer.invoke('wall:getState'),
  updateSettings: (patch: unknown) => ipcRenderer.invoke('wall:updateSettings', patch),
  reload: () => ipcRenderer.invoke('wall:reload'),
  toggleFocus: () => ipcRenderer.invoke('wall:toggleFocus'),
  openExternal: (url: string) => ipcRenderer.invoke('wall:openExternal', url),
  onDebugOpenDetail: (cb: (id: string) => void) => {
    ipcRenderer.on('wall:debugOpenDetail', (_e, id: string) => cb(id));
  },
  onState: (cb: (state: unknown) => void) => {
    const listener = (_e: unknown, state: unknown) => cb(state);
    ipcRenderer.on('wall:state', listener);
    return () => ipcRenderer.removeListener('wall:state', listener);
  },
};

contextBridge.exposeInMainWorld('wall', api);

export type WallApi = typeof api;
