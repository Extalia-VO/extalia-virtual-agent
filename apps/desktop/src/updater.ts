import type { UpdateChannel } from '@extalia/platform';
import { BrowserWindow, app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { autoUpdater } from 'electron-updater';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { IPC, reply } from './ipc';
import { authorizeLinuxInstallerUpdate, isLinuxInstallerAppImage } from './linuxInstallerUpdate';
import { UpdatePolicy, supportsPackagedUpdates, updateChannel, type UpdateDriver, type UpdaterEvent, type WorkState } from './updatePolicy';

/** Give the window time to settle before the first network request. */
const LAUNCH_CHECK_DELAY_MS = 5_000;

export interface UpdaterOptions {
  smokeTest: boolean;
  work: WorkState;
  trusted(event: IpcMainInvokeEvent): boolean;
}

/** GitHub Releases through electron-updater; only packaged builds have an update feed (app-update.yml). */
function connectAutoUpdater(channel: UpdateChannel, handle: (event: UpdaterEvent) => void): UpdateDriver {
  // Checking a release feed is not consent to download or replace the app.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = channel === 'beta';
  let candidateVersion: string | undefined;
  let requestedVersion: string | undefined;
  autoUpdater.on('checking-for-update', () => handle({ type: 'checking' }));
  autoUpdater.on('update-available', info => {
    if (requestedVersion) return;
    candidateVersion = info.version;
    handle({ type: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', info => {
    if (requestedVersion) return;
    candidateVersion = undefined;
    handle({ type: 'not-available', version: info.version });
  });
  autoUpdater.on('download-progress', progress => {
    if (requestedVersion) handle({ type: 'progress', percent: progress.percent });
  });
  autoUpdater.on('update-downloaded', info => {
    if (info.version !== requestedVersion) return;
    if (process.platform === 'linux') {
      try {
        if (isLinuxInstallerAppImage(process.env.APPIMAGE)) {
          // The receipt must exist before the approved update becomes installable.
          authorizeLinuxInstallerUpdate(process.env.APPIMAGE, info);
        }
      } catch (error) {
        requestedVersion = undefined;
        handle({ type: 'error', error });
        return;
      }
    }
    handle({ type: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', error => {
    requestedVersion = undefined;
    handle({ type: 'error', error });
  });
  return {
    async check() {
      const result = await autoUpdater.checkForUpdates();
      // Download failures also arrive as 'error' events; avoid an unhandled rejection.
      result?.downloadPromise?.catch(() => undefined);
    },
    async download(version) {
      if (candidateVersion !== version || requestedVersion) throw new Error('The available update changed. Check for updates again.');
      requestedVersion = version;
      try {
        await autoUpdater.downloadUpdate();
      } catch (error) {
        if (requestedVersion === version) requestedVersion = undefined;
        throw error;
      }
    },
    // Silent install, then start the new version.
    quitAndInstall: () => autoUpdater.quitAndInstall(true, true),
  };
}

export function startUpdater({ smokeTest, work, trusted }: UpdaterOptions): UpdatePolicy {
  const channel = updateChannel(process.env.EXTALIA_UPDATE_CHANNEL);
  let macReleaseMode: unknown;
  if (app.isPackaged && process.platform === 'darwin') {
    try {
      const manifest = JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
      macReleaseMode = manifest.extaliaMacReleaseMode;
    } catch { /* Unknown distribution modes do not start an automatic installer. */ }
  }
  const supported = supportsPackagedUpdates(app.isPackaged, smokeTest, process.platform, macReleaseMode);
  const policy: UpdatePolicy = new UpdatePolicy({
    current: app.getVersion(),
    channel,
    work,
    driver: supported ? connectAutoUpdater(channel, event => policy.handle(event)) : undefined,
    unsupportedDetail: smokeTest ? 'Updates are disabled during smoke tests.' : !app.isPackaged ? 'Updates are installed by packaged builds.' : undefined,
    onStatus: status => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(IPC.updateStatus, status);
    },
  });
  ipcMain.handle(IPC.update, (event, action: unknown, expectedVersion: unknown) => reply(async () => {
    if (!trusted(event)) throw new Error('Untrusted sender.');
    switch (action) {
      case 'status': return policy.status();
      case 'check': return policy.check();
      case 'install':
        if (expectedVersion !== undefined && (typeof expectedVersion !== 'string' || expectedVersion.length === 0 || expectedVersion.length > 100)) throw new Error('Invalid update version.');
        return policy.install(expectedVersion as string | undefined);
      case 'postpone': return policy.postpone();
      default: throw new Error('Unknown update action.');
    }
  }));
  app.on('will-quit', () => policy.dispose());
  return policy;
}

const launchChecks = new WeakSet<UpdatePolicy>();

/** Check once the first window is on screen. */
export function checkAfterLaunch(policy: UpdatePolicy, window: BrowserWindow): void {
  if (policy.status().state === 'unsupported' || launchChecks.has(policy)) return;
  launchChecks.add(policy);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checked = false;
  window.once('ready-to-show', () => {
    if (window.isDestroyed()) return;
    timer = setTimeout(() => {
      if (window.isDestroyed()) return;
      checked = true;
      void policy.check();
    }, LAUNCH_CHECK_DELAY_MS);
  });
  window.once('closed', () => {
    clearTimeout(timer);
    if (!checked) launchChecks.delete(policy);
  });
}
