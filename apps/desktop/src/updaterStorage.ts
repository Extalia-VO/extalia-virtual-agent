import type { App } from 'electron';
import { AppImageUpdater, DebUpdater, MacUpdater, NsisUpdater, PacmanUpdater, RpmUpdater, type AppUpdater } from 'electron-updater';
import type { AppAdapter } from 'electron-updater/out/AppAdapter';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export type UpdaterApplication = Pick<App, 'isPackaged' | 'getVersion' | 'getName' | 'getAppPath' | 'getPath' | 'whenReady' | 'quit' | 'relaunch' | 'once'>;

/** Public electron-updater adapter: update payloads belong to the active Extalia profile. */
export function profileUpdaterAdapter(app: UpdaterApplication, dataDirectory: string, resourcesPath: string): AppAdapter {
  return {
    get version() { return app.getVersion(); },
    get name() { return app.getName(); },
    get isPackaged() { return app.isPackaged; },
    get appUpdateConfigPath() { return app.isPackaged ? path.join(resourcesPath, 'app-update.yml') : path.join(app.getAppPath(), 'dev-app-update.yml'); },
    get userDataPath() { return app.getPath('userData'); },
    baseCachePath: path.join(dataDirectory, 'cache', 'updates'),
    whenReady: () => app.whenReady(),
    quit: () => app.quit(),
    relaunch: () => app.relaunch(),
    onQuit: handler => { app.once('quit', (_event, exitCode) => handler(exitCode)); },
  };
}

/**
 * AppUpdater 6.8.9 deliberately leaves its HTTP executor null when an app
 * adapter is passed to the base constructor. Start the standard Electron
 * updater first, then specialize its declared protected app adapter. This
 * retains the real Electron transport and login forwarding without touching
 * undocumented/private executor fields.
 */
class ProfileNsisUpdater extends NsisUpdater {
  protected override readonly app: AppAdapter;
  constructor(adapter: AppAdapter) { super(); this.app = adapter; }
}
class ProfileMacUpdater extends MacUpdater {
  protected override readonly app: AppAdapter;
  constructor(adapter: AppAdapter) { super(); this.app = adapter; }
}
class ProfileAppImageUpdater extends AppImageUpdater {
  protected override readonly app: AppAdapter;
  constructor(adapter: AppAdapter) { super(); this.app = adapter; }
}
class ProfileDebUpdater extends DebUpdater {
  protected override readonly app: AppAdapter;
  constructor(adapter: AppAdapter) { super(); this.app = adapter; }
}
class ProfileRpmUpdater extends RpmUpdater {
  protected override readonly app: AppAdapter;
  constructor(adapter: AppAdapter) { super(); this.app = adapter; }
}
class ProfilePacmanUpdater extends PacmanUpdater {
  protected override readonly app: AppAdapter;
  constructor(adapter: AppAdapter) { super(); this.app = adapter; }
}

/** Keep the same platform/package selection as electron-updater's default factory. */
export function createProfileUpdater(input: { app: UpdaterApplication; dataDirectory: string; resourcesPath: string; platform: string }): AppUpdater {
  const adapter = profileUpdaterAdapter(input.app, input.dataDirectory, input.resourcesPath);
  if (input.platform === 'win32') return new ProfileNsisUpdater(adapter);
  if (input.platform === 'darwin') return new ProfileMacUpdater(adapter);
  let packageType: string | undefined;
  try { packageType = readFileSync(path.join(input.resourcesPath, 'package-type'), 'utf8').trim(); }
  catch { /* AppImage distributions have no package-type marker. */ }
  if (packageType === 'deb') return new ProfileDebUpdater(adapter);
  if (packageType === 'rpm') return new ProfileRpmUpdater(adapter);
  if (packageType === 'pacman') return new ProfilePacmanUpdater(adapter);
  return new ProfileAppImageUpdater(adapter);
}
