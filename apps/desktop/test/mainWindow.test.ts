import type { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  packaged: false,
  windows: [] as unknown[], options: [] as Record<string, unknown>[],
  appHandlers: new Map<string, () => void>(),
  installer: vi.fn(), startAgents: vi.fn(),
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    fullscreen: boolean;
    show = vi.fn(); focus = vi.fn();
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
    constructor(options: Record<string, unknown>) {
      super(); this.fullscreen = options.fullscreen === true;
      mocks.windows.push(this); mocks.options.push(options);
    }
    loadURL() { return Promise.resolve(); }
    isMinimized() { return false; }
    isFullScreen() { return this.fullscreen; }
    setFullScreen(value: boolean) { this.fullscreen = value; }
    static getAllWindows() { return mocks.windows; }
  }
  return {
    BrowserWindow: Window,
    app: {
      get isPackaged() { return mocks.packaged; },
      isInApplicationsFolder: () => true,
      getPath: () => '/tmp/extalia-desktop-test-profile', getVersion: () => '0.0.0',
      setPath: vi.fn(), commandLine: { appendSwitch: vi.fn() },
      requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
      on: (name: string, handler: () => void) => mocks.appHandlers.set(name, handler),
      quit: vi.fn(), exit: vi.fn(), relaunch: vi.fn(),
    },
    dialog: { showOpenDialog: vi.fn() }, ipcMain: { handle: vi.fn() },
    net: { fetch: vi.fn() }, protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    shell: { openExternal: vi.fn() },
  };
});
vi.mock('node:fs', () => ({
  createReadStream: vi.fn(), mkdirSync: vi.fn(), mkdtempSync: () => '/tmp/extalia-desktop-test-profile',
}));
vi.mock('../src/agentsIpc', () => ({ startAgents: mocks.startAgents }));
vi.mock('../src/installer/window', () => ({ createInstallerWindow: mocks.installer }));
vi.mock('../src/notificationIpc', () => ({ registerNotifications: vi.fn() }));
vi.mock('../src/restartIpc', () => ({ registerRestart: vi.fn() }));
vi.mock('../src/updater', () => ({ startUpdater: vi.fn(), checkAfterLaunch: vi.fn() }));
vi.mock('../src/smoke', () => ({ runSmokeTest: () => new Promise<number>(() => undefined) }));

interface MockWindow extends EventEmitter {
  show: ReturnType<typeof vi.fn>;
  isFullScreen(): boolean;
  setFullScreen(value: boolean): void;
}
const originalArgv = process.argv;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
let originalEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  originalEnv = { ...process.env };
  delete process.env.EXTALIA_WEB_URL;
  process.argv = [process.execPath, 'desktop-test'];
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: '/tmp/extalia-desktop-test-resources' });
  mocks.packaged = false; mocks.windows.length = 0; mocks.options.length = 0; mocks.appHandlers.clear();
  mocks.startAgents.mockReturnValue({ work: {}, close: vi.fn(async () => undefined) });
  vi.stubGlobal('__dirname', '/tmp/extalia-desktop-test-source');
});
afterEach(() => {
  process.argv = originalArgv;
  Object.defineProperty(process, 'platform', originalPlatform);
  if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources);
  else Reflect.deleteProperty(process, 'resourcesPath');
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  vi.unstubAllGlobals();
});

async function boot(flags: string[] = []) {
  process.argv.push(...flags);
  await import('../src/main');
  await new Promise(resolve => setImmediate(resolve));
  return mocks.windows[0] as MockWindow | undefined;
}

describe('Desktop launch fullscreen', () => {
  it.each(['darwin', 'win32', 'linux'])('starts ordinary development %s windows fullscreen before showing them', async platform => {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
    const window = await boot();
    expect(mocks.options[0]).toMatchObject({ fullscreen: true, show: false });
    expect(mocks.options[0]).not.toHaveProperty('kiosk');
    expect(window?.show).not.toHaveBeenCalled();
    expect(window?.isFullScreen()).toBe(true);
    window?.emit('ready-to-show');
    expect(window?.show).toHaveBeenCalledOnce();
  });

  it('uses the same fullscreen startup in an installed packaged build', async () => {
    mocks.packaged = true;
    const window = await boot();
    expect(mocks.options[0]).toMatchObject({ fullscreen: true, show: false });
    expect(window?.isFullScreen()).toBe(true);
    expect(mocks.installer).not.toHaveBeenCalled();
  });

  it('keeps the isolated smoke window hidden and at its fixed diagnostic size', async () => {
    const window = await boot(['--smoke-test']);
    expect(mocks.options[0]).toMatchObject({ fullscreen: false, width: 1280, height: 820, show: false });
    window?.emit('ready-to-show');
    expect(window?.show).not.toHaveBeenCalled();
    expect(mocks.startAgents).toHaveBeenCalledWith(expect.objectContaining({ smokeTest: true,
      dataDirectory: path.join('/tmp/extalia-desktop-test-profile', 'extalia-home'), homeDirectory: path.join('/tmp/extalia-desktop-test-profile', 'home') }));
  });

  it('leaves installer preview sizing to its separate installer window', async () => {
    await boot(['--installer-preview']);
    expect(mocks.windows).toHaveLength(0);
    expect(mocks.installer).toHaveBeenCalledWith(expect.objectContaining({ preview: true }));
    expect(mocks.startAgents).not.toHaveBeenCalled();
  });

  it('preserves a user exit from native fullscreen when the existing window is activated', async () => {
    const window = await boot();
    window!.setFullScreen(false);
    mocks.appHandlers.get('activate')!();
    expect(window!.isFullScreen()).toBe(false);
    expect(mocks.windows).toHaveLength(1);
  });

  it('starts a newly recreated main window fullscreen after all prior windows close', async () => {
    await boot();
    mocks.windows.length = 0; mocks.options.length = 0;
    mocks.appHandlers.get('activate')!();
    expect(mocks.options[0]).toMatchObject({ fullscreen: true, show: false });
    expect(mocks.windows).toHaveLength(1);
  });
});
