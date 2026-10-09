import type { UpdateChannel } from '@extalia/platform';
import { BrowserWindow, app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { autoUpdater } from 'electron-updater';
import { IPC, reply } from './ipc';
import { UpdatePolicy, updateChannel, type UpdateDriver, type UpdaterEvent, type WorkState } from './updatePolicy';

/** Give the window time to settle before the first network request. */
const LAUNCH_CHECK_DELAY_MS = 5_000;

export interface UpdaterOptions {
  smokeTest: boolean;
  work: WorkState;
  trusted(event: IpcMainInvokeEvent): boolean;
}

/** GitHub Releases through electron-updater; only packaged builds have an update feed (app-update.yml). */
function connectAutoUpdater(channel: UpdateChannel, handle: (event: UpdaterEvent) => void): UpdateDriver {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = channel === 'beta';
  autoUpdater.on('checking-for-update', () => handle({ type: 'checking' }));
  autoUpdater.on('update-available', info => handle({ type: 'available', version: info.version }));
  autoUpdater.on('update-not-available', info => handle({ type: 'not-available', version: info.version }));
  autoUpdater.on('download-progress', progress => handle({ type: 'progress', percent: progress.percent }));
  autoUpdater.on('update-downloaded', info => handle({ type: 'downloaded', version: info.version }));
  autoUpdater.on('error', error => handle({ type: 'error', error }));
  return {
    async check() {
      const result = await autoUpdater.checkForUpdates();
      // Download failures also arrive as 'error' events; avoid an unhandled rejection.
      result?.downloadPromise?.catch(() => undefined);
    },
    // Silent install, then start the new version.
    quitAndInstall: () => autoUpdater.quitAndInstall(true, true),
  };
}

export function startUpdater({ smokeTest, work, trusted }: UpdaterOptions): UpdatePolicy {
  const channel = updateChannel(process.env.EXTALIA_UPDATE_CHANNEL);
  const supported = app.isPackaged && !smokeTest;
  const policy: UpdatePolicy = new UpdatePolicy({
    current: app.getVersion(),
    channel,
    work,
    driver: supported ? connectAutoUpdater(channel, event => policy.handle(event)) : undefined,
    unsupportedDetail: smokeTest ? 'Updates are disabled during smoke tests.' : 'Updates are installed by packaged builds.',
    onStatus: status => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(IPC.updateStatus, status);
    },
  });
  ipcMain.handle(IPC.update, (event, action: unknown) => reply(async () => {
    if (!trusted(event)) throw new Error('Untrusted sender.');
    switch (action) {
      case 'status': return policy.status();
      case 'check': return policy.check();
      case 'install': return policy.install();
      case 'postpone': return policy.postpone();
      default: throw new Error('Unknown update action.');
    }
  }));
  app.on('will-quit', () => policy.dispose());
  return policy;
}

/** Check once the first window is on screen. */
export function checkAfterLaunch(policy: UpdatePolicy, window: BrowserWindow): void {
  if (policy.status().state === 'unsupported') return;
  window.once('ready-to-show', () => { setTimeout(() => void policy.check(), LAUNCH_CHECK_DELAY_MS); });
}
