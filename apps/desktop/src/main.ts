import type { DirectorySelection, HostInfo } from '@extalia/platform';
import { BrowserWindow, app, dialog, ipcMain, net, protocol, shell, type IpcMainInvokeEvent } from 'electron';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startAgents } from './agentsIpc';
import { IPC } from './ipc';
import { APP_HOST, APP_ORIGIN, APP_SCHEME, CONTENT_SECURITY_POLICY, isAllowedAppUrl, isTrustedSender, parseDevServerUrl, resolveAppFile } from './security';
import { runSmokeTest } from './smoke';
import { checkAfterLaunch, startUpdater } from './updater';

const smokeTest = process.argv.includes('--smoke-test');
let smokeDataDirectory: string | undefined;
if (smokeTest) {
  // Smoke tests use a throwaway profile and agent data directory so they never touch the user's data.
  const profile = mkdtempSync(path.join(tmpdir(), 'extalia-smoke-'));
  app.setPath('userData', profile);
  smokeDataDirectory = path.join(profile, 'extalia-home');
  mkdirSync(smokeDataDirectory);
  process.env.EXTALIA_HOME = smokeDataDirectory;
  process.env.EXTALIA_SECRET_STORE = 'memory';
} else if (app.isPackaged) {
  // Extalia's own data directory defaults to <appData>/Extalia on macOS and Windows; keep Chromium's
  // profile (caches, local storage) beside it instead of mixed into it.
  app.setPath('userData', path.join(app.getPath('appData'), 'Extalia Desktop'));
}
const devServer = parseDevServerUrl(process.env.EXTALIA_WEB_URL);
if (process.env.EXTALIA_WEB_URL && !devServer) console.warn('EXTALIA_WEB_URL ignored: only http:// loopback addresses are allowed.');

protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

/** The web build is shipped beside the app when packaged, and read from the workspace in development. */
function webRoot(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'web') : path.resolve(__dirname, '../../web/dist');
}

function serveWebBuild(): void {
  const root = webRoot();
  protocol.handle(APP_SCHEME, async request => {
    const url = new URL(request.url);
    const file = url.host === APP_HOST ? resolveAppFile(root, url.pathname) : undefined;
    if (!file) return new Response('Not found', { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    if (!file.endsWith('.html')) return response;
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    return new Response(response.body, { status: response.status, headers });
  });
}

function hostInfo(): HostInfo {
  const os = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : 'other';
  return { kind: 'desktop', appVersion: app.getVersion(), os, arch: process.arch, shellVersion: `Electron ${process.versions.electron}` };
}

/** Only the app's own pages may call into the main process. */
function trusted(event: IpcMainInvokeEvent): boolean {
  return isTrustedSender(event.senderFrame?.url, devServer);
}

function registerIpc(): void {
  ipcMain.handle(IPC.hostInfo, event => {
    if (!trusted(event)) throw new Error('Untrusted sender.');
    return hostInfo();
  });
  ipcMain.handle(IPC.selectDirectory, async (event): Promise<DirectorySelection | null> => {
    if (!trusted(event)) throw new Error('Untrusted sender.');
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = { title: 'Choose a project folder', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const selected = result.canceled ? undefined : result.filePaths[0];
    return selected ? { name: path.basename(selected), path: selected } : null;
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Extalia',
    backgroundColor: '#1e1f22',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // The hidden smoke-test window must keep painting so captures are current.
      backgroundThrottling: !smokeTest,
    },
  });
  if (!smokeTest) window.once('ready-to-show', () => window.show());
  // External links open in the user's browser; the app window never navigates away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedAppUrl(url, devServer)) event.preventDefault();
  });
  void window.loadURL(devServer ? devServer.toString() : `${APP_ORIGIN}/index.html`);
  return window;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
  });
  app.whenReady().then(() => {
    serveWebBuild();
    registerIpc();
    const agents = startAgents({ devServer, dataDirectory: smokeDataDirectory });
    const updates = startUpdater({ smokeTest, work: agents.work, trusted });
    const window = createWindow();
    if (smokeTest) {
      // app.exit skips the quit events, so close the agent host first.
      void runSmokeTest(window).catch(() => 1).then(async code => { await agents.close(); app.exit(code); });
      return;
    }
    checkAfterLaunch(updates, window);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }, error => {
    console.error('Extalia Desktop failed to start.', error);
    app.exit(1);
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
