import type { BrowserWindow } from 'electron';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAfterLaunch, startUpdater } from '../src/updater';

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (info: unknown) => void>(),
  authorize: vi.fn(), owned: vi.fn(), ipc: vi.fn(),
  updater: { autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false, on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn() },
}));
vi.mock('../src/updaterStorage', () => ({ createProfileUpdater: () => mocks.updater }));
vi.mock('../src/linuxInstallerUpdate', () => ({ authorizeLinuxInstallerUpdate: mocks.authorize, isLinuxInstallerAppImage: mocks.owned }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { isPackaged: true, getVersion: () => '1.0.0', on: vi.fn() },
  ipcMain: { handle: mocks.ipc },
}));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
function setup(target = 'linux') {
  Object.defineProperty(process, 'platform', { ...platform, value: target });
  const policy = startUpdater({ smokeTest: false, trusted: () => true, work: { isBusy: () => true, onIdle: () => () => undefined } });
  const event = { version: '2.0.0', downloadedFile: '/temporary/cache', files: [] };
  const available = () => mocks.listeners.get('update-available')!(event);
  const approve = async () => { available(); await policy.install('2.0.0'); };
  return { policy, event, available, approve, download: () => mocks.listeners.get('update-downloaded')!(event) };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.listeners.clear(); mocks.owned.mockReturnValue(true);
  mocks.updater.on.mockImplementation((event, listener) => { mocks.listeners.set(event, listener); });
  mocks.updater.downloadUpdate.mockResolvedValue([]);
  mocks.updater.checkForUpdates.mockResolvedValue(null);
  // Only a synthetic path reaches the mocked receipt verifier.
  vi.stubEnv('APPIMAGE', '/temporary/installation/app.AppImage');
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('electron updater consent and Linux receipt handoff', () => {
  it('checks without automatically downloading or installing when the app quits', async () => {
    const { policy, available } = setup();
    await policy.check(); available();
    expect(mocks.updater.autoDownload).toBe(false);
    expect(mocks.updater.autoInstallOnAppQuit).toBe(false);
    expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(policy.status()).toMatchObject({ state: 'available', latest: '2.0.0' });
    policy.dispose();
  });
  it('does not register or publish unsolicited downloads', () => {
    const { policy, available, download } = setup();
    available(); download();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(policy.status().state).toBe('available');
    expect(mocks.updater.autoInstallOnAppQuit).toBe(false);
    policy.dispose();
  });
  it('publishes ready only after the approved download receipt succeeds', async () => {
    const { policy, event, approve, download } = setup();
    await approve();
    mocks.authorize.mockImplementationOnce(() => {
      expect(mocks.updater.autoInstallOnAppQuit).toBe(false);
      expect(policy.status().state).not.toBe('ready');
    });
    download();
    expect(mocks.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.authorize).toHaveBeenCalledWith('/temporary/installation/app.AppImage', event);
    expect(mocks.updater.autoInstallOnAppQuit).toBe(false); expect(policy.status().state).toBe('ready'); policy.dispose();
  });
  it('publishes an error and keeps quit installation disabled after verification fails', async () => {
    const { policy, approve, download } = setup(); await approve();
    mocks.authorize.mockImplementationOnce(() => { throw new Error('receipt failed'); });
    download(); expect(policy.status()).toMatchObject({ state: 'error', detail: 'receipt failed' });
    expect(mocks.updater.autoInstallOnAppQuit).toBe(false); await expect(policy.install()).rejects.toThrow('No update is ready');
    expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled(); policy.dispose();
  });
  it('handles unreadable installer markers as an error with quit installation disabled', async () => {
    const { policy, approve, download } = setup(); await approve();
    mocks.owned.mockImplementationOnce(() => { throw new Error('unreadable marker'); });
    download(); expect(policy.status().state).toBe('error'); expect(mocks.updater.autoInstallOnAppQuit).toBe(false); policy.dispose();
  });
  it.each(['linux', 'win32'])('preserves explicit %s updates outside an owned installer prefix', async target => {
    mocks.owned.mockReturnValue(false); const { policy, approve, download } = setup(target); await approve(); download();
    expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.updater.autoInstallOnAppQuit).toBe(false);
    expect(policy.status().state).toBe('ready'); policy.dispose();
  });
  it('ignores completion for a different version than the one approved', async () => {
    const { policy, approve, event } = setup(); await approve();
    mocks.listeners.get('update-downloaded')!({ ...event, version: '3.0.0' });
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(policy.status()).toMatchObject({ state: 'downloading', latest: '2.0.0' });
    policy.dispose();
  });
  it('keeps trusted sender and expected version validation on the install IPC', async () => {
    const { policy, available } = setup(); available();
    const handler = mocks.ipc.mock.calls.at(-1)![1];
    expect(await handler({}, 'install', { version: '2.0.0' })).toMatchObject({ ok: false });
    expect(await handler({}, 'install', '3.0.0')).toMatchObject({ ok: false });
    expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(await handler({}, 'install', '2.0.0')).toMatchObject({ ok: true });
    expect(mocks.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    policy.dispose();
  });
});

class FakeWindow extends EventEmitter {
  destroyed = false;
  isDestroyed() { return this.destroyed; }
  close() { this.destroyed = true; this.emit('closed'); }
}

describe('launch checks', () => {
  it('checks once five seconds after the first visible window, even if scheduled twice', async () => {
    vi.useFakeTimers();
    const { policy } = setup();
    const window = new FakeWindow();
    checkAfterLaunch(policy, window as unknown as BrowserWindow);
    checkAfterLaunch(policy, window as unknown as BrowserWindow);
    window.emit('ready-to-show');
    await vi.advanceTimersByTimeAsync(4999);
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    checkAfterLaunch(policy, new FakeWindow() as unknown as BrowserWindow);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    policy.dispose();
  });
  it('cancels a destroyed window timer and lets the replacement window check', async () => {
    vi.useFakeTimers();
    const { policy } = setup();
    const window = new FakeWindow();
    checkAfterLaunch(policy, window as unknown as BrowserWindow);
    window.emit('ready-to-show'); window.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled();
    const replacement = new FakeWindow();
    checkAfterLaunch(policy, replacement as unknown as BrowserWindow);
    replacement.emit('ready-to-show');
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    policy.dispose();
  });
  it('does not check unsupported smoke builds', async () => {
    vi.useFakeTimers();
    const policy = startUpdater({ smokeTest: true, trusted: () => true, work: { isBusy: () => false, onIdle: () => () => undefined } });
    const window = new FakeWindow();
    checkAfterLaunch(policy, window as unknown as BrowserWindow);
    window.emit('ready-to-show');
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled();
    policy.dispose();
  });
});
