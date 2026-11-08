import { BrowserWindow, app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { INSTALLER_CHANNELS, installApplication, isInstallerSender, shouldShowInstaller } from './policy';

/** Supplied by build.mjs from the canonical catalog; missing build metadata fails closed. */
declare const __EXTALIA_INSTALLER_COPY__: {
  readonly macWizardTitle: string;
  readonly macWizardReplaceTitle: string;
  readonly macWizardReplaceDescription: string;
  readonly macWizardCancel: string;
  readonly macWizardReplace: string;
};
const INSTALLER_COPY = __EXTALIA_INSTALLER_COPY__;

export function createInstallerWindow(options: { preview: boolean; onContinue(): void; onClose(): void }): BrowserWindow {
  const file = path.join(__dirname, 'installer', 'index.html');
  const url = pathToFileURL(file).toString() + (options.preview ? '?preview=1' : '');
  const window = new BrowserWindow({
    width: 900, height: 620, minWidth: 650, minHeight: 530,
    show: false, title: INSTALLER_COPY.macWizardTitle, backgroundColor: '#10232d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'installer', 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, spellcheck: false, partition: 'extalia-installer',
    },
  });
  window.removeMenu();
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-redirect', event => event.preventDefault());
  const session = window.webContents.session;
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  const denyDownload = (event: Electron.Event) => event.preventDefault();
  session.on('will-download', denyDownload);
  let continuing = false;
  let installing = false;
  const trusted = (event: IpcMainInvokeEvent) => !window.isDestroyed()
    && isInstallerSender(event, window.webContents, window.webContents.mainFrame, url);
  ipcMain.handle(INSTALLER_CHANNELS.install, event => {
    if (!trusted(event)) throw new Error('Untrusted installer sender.');
    if (installing || continuing) return { state: 'blocked' };
    installing = true;
    try {
      return installApplication({
        preview: options.preview,
        eligible: () => shouldShowInstaller({ preview: false, smokeTest: false, platform: process.platform,
          packaged: app.isPackaged, inApplications: process.platform === 'darwin' && app.isInApplicationsFolder() }),
        move: moveOptions => app.moveToApplicationsFolder(moveOptions),
        confirmReplacement: () => dialog.showMessageBoxSync(window, {
          type: 'question', title: INSTALLER_COPY.macWizardReplaceTitle,
          message: INSTALLER_COPY.macWizardReplaceDescription,
          buttons: [INSTALLER_COPY.macWizardCancel, INSTALLER_COPY.macWizardReplace],
          defaultId: 0, cancelId: 0, noLink: true,
        }) === 1,
      });
    } finally { installing = false; }
  });
  ipcMain.handle(INSTALLER_CHANNELS.continue, event => {
    if (!trusted(event)) throw new Error('Untrusted installer sender.');
    if (installing || continuing) return false;
    continuing = true;
    // Reply before disposing this renderer and booting the regular application.
    setImmediate(() => { window.close(); options.onContinue(); });
    return true;
  });
  window.once('closed', () => {
    ipcMain.removeHandler(INSTALLER_CHANNELS.install);
    ipcMain.removeHandler(INSTALLER_CHANNELS.continue);
    session.removeListener('will-download', denyDownload);
    if (!continuing) options.onClose();
  });
  void window.loadURL(url).catch(() => { if (!window.isDestroyed()) window.close(); });
  return window;
}
