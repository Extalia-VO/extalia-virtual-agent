import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startUpdater } from '../src/updater';

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (info: unknown) => void>(),
  authorize: vi.fn(), owned: vi.fn(),
  updater: { autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false, on: vi.fn(), checkForUpdates: vi.fn(), quitAndInstall: vi.fn() },
}));
vi.mock('electron-updater', () => ({ autoUpdater: mocks.updater }));
vi.mock('../src/linuxInstallerUpdate', () => ({ authorizeLinuxInstallerUpdate: mocks.authorize, isLinuxInstallerAppImage: mocks.owned }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { isPackaged: true, getVersion: () => '1.0.0', on: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
function setup(target = 'linux') {
  Object.defineProperty(process, 'platform', { ...platform, value: target });
  const policy = startUpdater({ smokeTest: false, trusted: () => true, work: { isBusy: () => true, onIdle: () => () => undefined } });
  const event = { version: '2.0.0', downloadedFile: '/temporary/cache', files: [] };
  return { policy, event, download: () => mocks.listeners.get('update-downloaded')!(event) };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.listeners.clear(); mocks.owned.mockReturnValue(true);
  mocks.updater.on.mockImplementation((event, listener) => { mocks.listeners.set(event, listener); });
  // Only a synthetic path reaches the mocked receipt verifier.
  vi.stubEnv('APPIMAGE', '/temporary/installation/app.AppImage');
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); });

describe('electron updater Linux receipt handoff', () => {
  it('disables quit installation throughout verification and publishes ready after the receipt succeeds', () => {
    const { policy, event, download } = setup();
    mocks.authorize.mockImplementationOnce(() => {
      expect(mocks.updater.autoInstallOnAppQuit).toBe(false);
      expect(policy.status().state).not.toBe('ready');
    });
    download();
    expect(mocks.authorize).toHaveBeenCalledWith('/temporary/installation/app.AppImage', event);
    // electron-updater registers its first quit handler immediately after dispatch.
    expect(mocks.updater.autoInstallOnAppQuit).toBe(true); expect(policy.status().state).toBe('ready'); policy.dispose();
  });
  it('publishes an error and keeps quit installation disabled after verification fails', () => {
    const { policy, download } = setup(); mocks.authorize.mockImplementationOnce(() => { throw new Error('receipt failed'); });
    download(); expect(policy.status()).toMatchObject({ state: 'error', detail: 'receipt failed' });
    expect(mocks.updater.autoInstallOnAppQuit).toBe(false); expect(() => policy.install()).toThrow('No update is ready');
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled(); policy.dispose();
  });
  it('handles unreadable installer markers as an error with quit installation disabled', () => {
    const { policy, download } = setup(); mocks.owned.mockImplementationOnce(() => { throw new Error('unreadable marker'); });
    download(); expect(policy.status().state).toBe('error'); expect(mocks.updater.autoInstallOnAppQuit).toBe(false); policy.dispose();
  });
  it.each(['linux', 'win32'])('preserves normal %s updates outside an owned installer prefix', target => {
    mocks.owned.mockReturnValue(false); const { policy, download } = setup(target); download();
    expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.updater.autoInstallOnAppQuit).toBe(true);
    expect(policy.status().state).toBe('ready'); policy.dispose();
  });
});
