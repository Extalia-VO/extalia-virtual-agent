import type { DirectorySelection, HostInfo } from '@extalia/platform';
import { BrowserWindow, app, dialog, ipcMain, net, protocol, shell, type IpcMainInvokeEvent } from 'electron';
import { createReadStream, mkdirSync, mkdtempSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { startAgents } from './agentsIpc';
import { IPC } from './ipc';
import { registerNotifications } from './notificationIpc';
import { registerRestart } from './restartIpc';
import { APP_HOST, APP_ORIGIN, APP_SCHEME, CONTENT_SECURITY_POLICY, MEDIA_TYPES, isAllowedAppUrl, isTrustedSender, parseByteRange, parseDevServerUrl, resolveAppFile } from './security';
import { runSmokeTest } from './smoke';
import { checkAfterLaunch, startUpdater } from './updater';

const smokeTest = process.argv.includes('--smoke-test');
let smokeDataDirectory: string | undefined;
let smokeHomeDirectory: string | undefined;
if (smokeTest) {
  if (process.platform === 'darwin') {
    // Hosted Macs can blocklist WebGL; use native ANGLE because this Electron
    // distribution lacks the Vulkan loader required for macOS SwiftShader.
    app.commandLine.appendSwitch('ignore-gpu-blocklist');
    // Hosted Apple Silicon runners can lose Dawn devices used by Skia Graphite.
    // Keep the full WebGL scene smoke while using the stable compositor backend.
    app.commandLine.appendSwitch('disable-skia-graphite');
  } else if (process.platform === 'linux' || process.platform === 'win32') {
    // Headless CI runners have no usable GPU. Opt into Chromium's software WebGL
    // only for the smoke test's bundled UI, before Electron initializes graphics.
    app.commandLine.appendSwitch('use-gl', 'angle');
    app.commandLine.appendSwitch('use-angle', 'swiftshader-webgl');
    app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  }
  // Smoke tests use a throwaway profile and agent data directory so they never touch the user's data.
  const profile = mkdtempSync(path.join(tmpdir(), 'extalia-smoke-'));
  app.setPath('userData', profile);
  smokeHomeDirectory = path.join(profile, 'home');
  mkdirSync(smokeHomeDirectory);
  smokeDataDirectory = path.join(profile, 'extalia-home');
  mkdirSync(smokeDataDirectory);
  // Keep Node/Electron helpers that consult process.env (including os.homedir)
  // inside the disposable profile too. These are process-local overrides only.
  process.env.HOME = smokeHomeDirectory;
  process.env.USERPROFILE = smokeHomeDirectory;
  process.env.APPDATA = path.join(smokeHomeDirectory, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(smokeHomeDirectory, 'AppData', 'Local');
  process.env.XDG_CONFIG_HOME = path.join(smokeHomeDirectory, '.config');
  process.env.XDG_DATA_HOME = path.join(smokeHomeDirectory, '.local', 'share');
  process.env.XDG_CACHE_HOME = path.join(smokeHomeDirectory, '.cache');
  process.env.XDG_STATE_HOME = path.join(smokeHomeDirectory, '.local', 'state');
  process.env.CODEX_HOME = path.join(smokeHomeDirectory, '.codex');
  process.env.CLAUDE_CONFIG_DIR = path.join(smokeHomeDirectory, '.claude');
  process.env.GEMINI_CLI_HOME = path.join(smokeHomeDirectory, '.gemini');
  process.env.ANTIGRAVITY_CONFIG_DIR = path.join(smokeHomeDirectory, '.gemini', 'config');
  process.env.ANTIGRAVITY_HOME = path.join(smokeHomeDirectory, '.gemini', 'antigravity');
  process.env.HERMES_HOME = path.join(smokeHomeDirectory, '.hermes');
  process.env.EXTALIA_HOME = smokeDataDirectory;
  process.env.EXTALIA_SECRET_STORE = 'memory';
} else if (app.isPackaged) {
  // Chromium's own profile (caches, local storage) stays in the system's application-data folder.
  // Extalia's data lives in ~/.extalia-vo (EXTALIA_HOME overrides it), shared with the Web Bridge;
  // the agent host copies data from the pre-0.0.21 folder <appData>/Extalia there once.
  app.setPath('userData', path.join(app.getPath('appData'), 'Extalia Desktop'));
}
const devServer = parseDevServerUrl(process.env.EXTALIA_WEB_URL);
if (process.env.EXTALIA_WEB_URL && !devServer) console.warn('EXTALIA_WEB_URL ignored: only http:// loopback addresses are allowed.');

// `stream` lets <video> read the Splash loop in byte ranges from the app scheme.
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

/** The web build is shipped beside the app when packaged, and read from the workspace in development. */
function webRoot(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'web') : path.resolve(__dirname, '../../web/dist');
}

/** Video in byte ranges, so the Splash loop can seek and loop (the file loader ignores Range here). */
async function serveMedia(file: string, type: string, rangeHeader: string | null): Promise<Response> {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return new Response('Not found', { status: 404 });
  const range = parseByteRange(rangeHeader, info.size);
  if (range === null) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
  const { start, end } = range ?? { start: 0, end: info.size - 1 };
  const headers: Record<string, string> = { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(body, { status: range ? 206 : 200, headers });
}

function serveWebBuild(): void {
  const root = webRoot();
  protocol.handle(APP_SCHEME, async request => {
    const url = new URL(request.url);
    const file = url.host === APP_HOST ? resolveAppFile(root, url.pathname) : undefined;
    if (!file) return new Response('Not found', { status: 404 });
    const media = MEDIA_TYPES[path.extname(file).toLowerCase()];
    if (media) return serveMedia(file, media, request.headers.get('range'));
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
    const agents = startAgents({ devServer, dataDirectory: smokeDataDirectory, smokeTest, homeDirectory: smokeHomeDirectory });
    const updates = startUpdater({ smokeTest, work: agents.work, trusted });
    registerRestart({ smokeTest, work: agents.work, trusted });
    registerNotifications({ smokeTest, devServer });
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
