import type { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installerCopy } from '../scripts/installer-copy.mjs';
import { INSTALLER_CHANNELS } from '../src/installer/policy';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => unknown>(),
  windows: [] as unknown[], options: [] as Record<string, unknown>[],
  move: vi.fn(), confirm: vi.fn(),
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' }, session: Object.assign(new EventEmitter(), {
        setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
      }), setWindowOpenHandler: vi.fn(),
    });
    constructor(options: Record<string, unknown>) { super(); mocks.windows.push(this); mocks.options.push(options); }
    removeMenu() {}
    show() {}
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; this.emit('closed'); }
    loadURL(url: string) { this.webContents.mainFrame.url = url; return Promise.resolve(); }
  }
  return {
    BrowserWindow: Window,
    app: { isPackaged: true, isInApplicationsFolder: () => false, moveToApplicationsFolder: mocks.move },
    dialog: { showMessageBoxSync: mocks.confirm },
    ipcMain: {
      handle: (channel: string, handler: (event: unknown) => unknown) => mocks.handlers.set(channel, handler),
      removeHandler: (channel: string) => mocks.handlers.delete(channel),
    },
  };
});
// Source-only unit tests supply the same canonical metadata as the Desktop build.
const copy = await installerCopy();
vi.stubGlobal('__EXTALIA_INSTALLER_COPY__', copy);
const { createInstallerWindow } = await import('../src/installer/window');
afterAll(() => vi.unstubAllGlobals());

interface MockWindow extends EventEmitter {
  webContents: EventEmitter & {
    mainFrame: { url: string };
    session: EventEmitter;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
  };
  close(): void;
}
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  vi.clearAllMocks(); mocks.handlers.clear(); mocks.windows.length = 0; mocks.options.length = 0;
  mocks.move.mockReturnValue(true); mocks.confirm.mockReturnValue(0);
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); });
function setup(preview = true) {
  const onContinue = vi.fn(); const onClose = vi.fn();
  createInstallerWindow({ preview, onContinue, onClose });
  const window = mocks.windows[0] as MockWindow;
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  return { window, event, onContinue, onClose };
}

describe('isolated installer window', () => {
  it('refuses a source launch without injected build metadata before creating a window', async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    try {
      await expect(import('../src/installer/window')).rejects.toThrow('__EXTALIA_INSTALLER_COPY__ is not defined');
      expect(mocks.windows).toHaveLength(0);
      expect(mocks.move).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal('__EXTALIA_INSTALLER_COPY__', copy);
    }
  });
  it('loads only a local installer in a sandbox with a dedicated preload and session', () => {
    const { window } = setup();
    expect(window.webContents.mainFrame.url).toMatch(/^file:.*\/installer\/index\.html\?preview=1$/);
    expect(mocks.options[0]).toMatchObject({ title: copy.macWizardTitle, width: 900, height: 620, minWidth: 650,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, partition: 'extalia-installer' } });
    const options = mocks.options[0]?.webPreferences as { preload: string };
    expect(options.preload).toMatch(/installer\/preload\.cjs$/);
    expect(window.webContents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: 'deny' });
    for (const name of ['will-navigate', 'will-redirect']) {
      const preventDefault = vi.fn(); window.webContents.emit(name, { preventDefault }, 'https://example.com');
      expect(preventDefault).toHaveBeenCalledOnce();
    }
    const preventDefault = vi.fn(); window.webContents.session.emit('will-download', { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  });
  it('refuses foreign windows and same-URL child frames before any native effect', () => {
    const { event } = setup(false); const install = mocks.handlers.get(INSTALLER_CHANNELS.install)!;
    expect(() => install({ ...event, sender: {} })).toThrow('Untrusted installer sender');
    expect(() => install({ ...event, senderFrame: { ...event.senderFrame } })).toThrow('Untrusted installer sender');
    expect(mocks.move).not.toHaveBeenCalled();
  });
  it('simulates a preview install and delegates preview continuation without native installation', async () => {
    const { window, event, onContinue, onClose } = setup();
    expect(mocks.handlers.get(INSTALLER_CHANNELS.install)!(event)).toEqual({ state: 'preview' });
    expect(mocks.move).not.toHaveBeenCalled();
    expect(mocks.handlers.get(INSTALLER_CHANNELS.continue)!(event)).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(onContinue).toHaveBeenCalledOnce(); expect(onClose).not.toHaveBeenCalled();
    expect(mocks.handlers.size).toBe(0); expect(window.webContents.session.listenerCount('will-download')).toBe(0);
  });
  it('invokes the native API only from the trusted install handler and uses a native replacement dialog', () => {
    const { event } = setup(false);
    mocks.move.mockImplementation(options => options.conflictHandler('exists'));
    expect(mocks.handlers.get(INSTALLER_CHANNELS.install)!(event)).toEqual({ state: 'cancelled' });
    expect(mocks.confirm).toHaveBeenCalledWith(mocks.windows[0], expect.objectContaining({ defaultId: 0, cancelId: 0, buttons: ['Cancel', 'Replace'] }));
  });
  it('closing the installer invokes shutdown and removes its IPC handlers', () => {
    const { window, onClose, onContinue } = setup(); window.close();
    expect(onClose).toHaveBeenCalledOnce(); expect(onContinue).not.toHaveBeenCalled(); expect(mocks.handlers.size).toBe(0);
  });
});
