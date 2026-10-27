import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC, reply } from './ipc';
import { parseRestartRequest, restartBlockReason } from './restart';
import type { WorkState } from './updatePolicy';

export interface RestartOptions {
  smokeTest: boolean;
  work: WorkState;
  trusted(event: IpcMainInvokeEvent): boolean;
}

/**
 * Relaunch on the user's request. The reply is sent first; quitting then runs the
 * agent host's shutdown through the `will-quit` handler in agentsIpc.ts (save, stop,
 * release the lock) before the new process starts. `app.exit()` would skip that step.
 */
export function registerRestart({ smokeTest, work, trusted }: RestartOptions): void {
  ipcMain.handle(IPC.restart, (event, value: unknown) => reply(() => {
    if (!trusted(event)) throw new Error('Untrusted sender.');
    const request = parseRestartRequest(value);
    const blocked = restartBlockReason({ smokeTest, busy: work.isBusy(), acknowledgeActiveWork: request.acknowledgeActiveWork });
    if (blocked) throw new Error(blocked);
    setImmediate(() => {
      app.relaunch();
      app.quit();
    });
  }));
}
