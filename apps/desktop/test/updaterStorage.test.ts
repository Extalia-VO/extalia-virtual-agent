import { AppImageUpdater, DebUpdater, MacUpdater, NsisUpdater, PacmanUpdater, RpmUpdater } from 'electron-updater';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProfileUpdater, profileUpdaterAdapter, type UpdaterApplication } from '../src/updaterStorage';

// The package uses CommonJS require('electron') internally. Replace only that
// runtime boundary; updater constructors, providers and HTTP executor are real.
const runtimeRequire = createRequire(import.meta.url);
const electronEntry = runtimeRequire.resolve('electron');
runtimeRequire('electron');
const electronModule = runtimeRequire.cache[electronEntry]!;
const originalElectron = electronModule.exports;
const requests: { options: { path?: string }; request: EventEmitter }[] = [];
const networkSession = {};
let metadataVersion = '1.2.3';
const electron = {
  app: application(path.join(tmpdir(), 'extalia-updater-unused')),
  autoUpdater: new EventEmitter(),
  session: { fromPartition: vi.fn(() => networkSession) },
  net: { request: vi.fn((options: { path?: string }) => {
    if (options.path?.includes('/fixture.')) throw new Error('Fixture payload request intentionally refused.');
    const request = Object.assign(new EventEmitter(), {
      end() {
        queueMicrotask(() => {
          const metadata = JSON.stringify({ version: metadataVersion, files: [{ url: 'fixture.exe', sha512: Buffer.alloc(64).toString('base64'), size: 1 }] });
          const response = Object.assign(Readable.from([metadata]), { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'text/yaml' } });
          request.emit('response', response);
        });
      },
      abort: vi.fn(),
    });
    requests.push({ options, request });
    return request;
  }) },
};

function application(root: string) {
  const events = new EventEmitter();
  return Object.assign(events, {
    isPackaged: true,
    getVersion: () => '1.2.3', getName: () => 'Extalia', getAppPath: () => path.join(root, 'app'),
    getPath: () => path.join(root, 'desktop-profile'), whenReady: async () => undefined,
    quit: vi.fn(), relaunch: vi.fn(),
  }) as unknown as UpdaterApplication;
}

beforeEach(() => {
  electronModule.exports = electron;
  electron.autoUpdater.removeAllListeners();
  requests.length = 0; metadataVersion = '1.2.3'; vi.clearAllMocks();
});
afterEach(() => { electronModule.exports = originalElectron; vi.unstubAllEnvs(); });

describe('profile-owned update storage', () => {
  it('roots downloads under the active profile and delegates the ordinary app lifecycle', async () => {
    const root = path.join(tmpdir(), 'extalia-example-profile');
    const app = application(root);
    const adapter = profileUpdaterAdapter(app, root, path.join(root, 'resources'));
    expect(adapter.baseCachePath).toBe(path.join(root, 'cache', 'updates'));
    expect(adapter.userDataPath).toBe(path.join(root, 'desktop-profile'));
    expect(adapter.appUpdateConfigPath).toBe(path.join(root, 'resources', 'app-update.yml'));
    expect(adapter.version).toBe('1.2.3'); expect(adapter.name).toBe('Extalia'); expect(adapter.isPackaged).toBe(true);
    await adapter.whenReady(); adapter.quit(); adapter.relaunch();
    expect(app.quit).toHaveBeenCalledOnce(); expect(app.relaunch).toHaveBeenCalledOnce();
    const quit = vi.fn(); adapter.onQuit(quit);
    (app as unknown as EventEmitter).emit('quit', {}, 7);
    expect(quit).toHaveBeenCalledWith(7);
  });

  it('keeps actual platform/package installers with the scoped adapter', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'extalia-update-storage-'));
    try {
      const resourcesPath = path.join(root, 'resources'); await mkdir(resourcesPath);
      const app = application(root); electron.app = app;
      const create = (platform: string) => createProfileUpdater({ app, platform, resourcesPath, dataDirectory: root });
      expect(create('win32')).toBeInstanceOf(NsisUpdater); expect(create('darwin')).toBeInstanceOf(MacUpdater);
      expect(create('linux')).toBeInstanceOf(AppImageUpdater);
      for (const [marker, Constructor] of [['deb', DebUpdater], ['rpm', RpmUpdater], ['pacman', PacmanUpdater], ['unknown', AppImageUpdater]] as const) {
        await writeFile(path.join(resourcesPath, 'package-type'), marker);
        expect(create('linux')).toBeInstanceOf(Constructor);
        expect(create('win32')).toBeInstanceOf(NsisUpdater); expect(create('darwin')).toBeInstanceOf(MacUpdater);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['win32', 'darwin', 'linux'])('checks using the actual %s Electron HTTP executor and retains login forwarding', async platform => {
    const root = await mkdtemp(path.join(tmpdir(), 'extalia-update-transport-'));
    try {
      const resourcesPath = path.join(root, 'resources'); await mkdir(resourcesPath);
      const app = application(root); electron.app = app;
      vi.stubEnv('APPIMAGE', path.join(root, 'current.AppImage'));
      const updater = createProfileUpdater({ app, platform, resourcesPath, dataDirectory: root });
      updater.logger = null; updater.autoDownload = false;
      updater.setFeedURL({ provider: 'generic', url: 'https://example.test/updates' });
      const login = vi.fn(); updater.on('login', login);
      expect(await updater.checkForUpdates()).toMatchObject({ isUpdateAvailable: false, updateInfo: { version: '1.2.3' } });
      expect(electron.net.request).toHaveBeenCalledOnce();
      expect(electron.session.fromPartition).toHaveBeenCalledWith('electron-updater', { cache: false });
      const authInfo = { isProxy: true }; const answer = vi.fn();
      requests[0]!.request.emit('login', authInfo, answer);
      expect(login).toHaveBeenCalledWith(authInfo, answer);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('prepares the real downloader cache only within the profile, without downloading an artifact', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'extalia-update-download-cache-'));
    try {
      const resourcesPath = path.join(root, 'resources'); await mkdir(resourcesPath);
      await writeFile(path.join(resourcesPath, 'app-update.yml'), 'provider: generic\nurl: https://example.test/updates\nupdaterCacheDirName: fixture-updater\n');
      const app = application(root); electron.app = app; metadataVersion = '2.0.0';
      const updater = createProfileUpdater({ app, platform: 'win32', resourcesPath, dataDirectory: root });
      updater.logger = null; updater.autoDownload = false; updater.disableDifferentialDownload = true;
      updater.setFeedURL({ provider: 'generic', url: 'https://example.test/updates' });
      expect(await updater.checkForUpdates()).toMatchObject({ isUpdateAvailable: true });
      await expect(updater.downloadUpdate()).rejects.toThrow('Fixture payload request intentionally refused');
      expect(await readdir(path.join(root, 'cache', 'updates', 'fixture-updater'))).toContain('pending');
      expect(requests).toHaveLength(1); // Only fixture metadata was returned; payload net.request throws.
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
