import { DESKTOP_HOST_GLOBAL, type DesktopHostApi } from '@extalia/platform';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, unwrap, type IpcReply } from './ipc';

const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => unwrap(await ipcRenderer.invoke(channel, ...args) as IpcReply<T>);

/** Subscribe to a main-process push channel; the renderer gets the payload only, never the IPC event. */
function listen<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

// Only these functions cross the bridge; no Node or Electron objects reach the renderer.
const api: DesktopHostApi = {
  info: () => ipcRenderer.invoke(IPC.hostInfo),
  selectDirectory: () => ipcRenderer.invoke(IPC.selectDirectory),
  agents: {
    call: (method, args) => invoke(IPC.agents, method, args),
    onEvent: listener => listen(IPC.agentEvent, listener),
  },
  updater: {
    status: () => invoke(IPC.update, 'status'),
    check: () => invoke(IPC.update, 'check'),
    install: () => invoke(IPC.update, 'install'),
    postpone: () => invoke(IPC.update, 'postpone'),
    onStatus: listener => listen(IPC.updateStatus, listener),
  },
};

contextBridge.exposeInMainWorld(DESKTOP_HOST_GLOBAL, api);
