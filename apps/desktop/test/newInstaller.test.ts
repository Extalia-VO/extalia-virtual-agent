import { describe, expect, it, vi } from 'vitest';
import { installApplication, isInstallerSender, shouldShowInstaller, type InstallerBoot, type InstallOperations } from '../src/installer/policy';

const mounted: InstallerBoot = { preview: false, smokeTest: false, platform: 'darwin', packaged: true,
  inApplications: false };

describe('installer boot admission', () => {
  it('offers installation for packaged macOS applications outside Applications, including translocated apps', () => {
    expect(shouldShowInstaller(mounted)).toBe(true);
    for (const platform of ['win32', 'linux']) expect(shouldShowInstaller({ ...mounted, platform })).toBe(false);
    expect(shouldShowInstaller({ ...mounted, packaged: false })).toBe(false);
    expect(shouldShowInstaller({ ...mounted, inApplications: true })).toBe(false);
    expect(shouldShowInstaller({ ...mounted, smokeTest: true })).toBe(false);
    expect(shouldShowInstaller({ ...mounted, skip: true })).toBe(false);
  });
  it('allows an isolated preview on every platform, including development and smoke invocation', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(shouldShowInstaller({ ...mounted, platform, preview: true, smokeTest: true, packaged: false, skip: true })).toBe(true);
    }
  });
});

describe('explicit native installation', () => {
  function setup() {
    return { preview: false, eligible: vi.fn(() => true), move: vi.fn<InstallOperations['move']>(() => true), confirmReplacement: vi.fn(() => false) };
  }
  it('never invokes a native operation from a preview or an ineligible application', () => {
    const operations = setup(); operations.preview = true;
    expect(installApplication(operations)).toEqual({ state: 'preview' });
    expect(operations.eligible).not.toHaveBeenCalled(); expect(operations.move).not.toHaveBeenCalled();
    operations.preview = false; operations.eligible.mockReturnValue(false);
    expect(installApplication(operations)).toEqual({ state: 'blocked' }); expect(operations.move).not.toHaveBeenCalled();
  });
  it('lets Electron copy and relaunch only after admission, without an additional launch operation', () => {
    const operations = setup();
    expect(installApplication(operations)).toEqual({ state: 'installed' }); expect(operations.move).toHaveBeenCalledOnce();
  });
  it('refuses an existing running application without requesting replacement or killing it', () => {
    const operations = setup();
    operations.move.mockImplementation(options => options.conflictHandler('existsAndRunning'));
    expect(installApplication(operations)).toEqual({ state: 'blocked' }); expect(operations.confirmReplacement).not.toHaveBeenCalled();
  });
  it('requires confirmation before replacing an existing application', () => {
    const operations = setup(); operations.move.mockImplementation(options => options.conflictHandler('exists'));
    expect(installApplication(operations)).toEqual({ state: 'cancelled' });
    operations.confirmReplacement.mockReturnValue(true);
    expect(installApplication(operations)).toEqual({ state: 'installed' });
  });
  it('distinguishes native cancellation and errors without exposing private native error text', () => {
    const operations = setup(); operations.move.mockReturnValue(false);
    expect(installApplication(operations)).toEqual({ state: 'cancelled' });
    operations.move.mockImplementation(() => { throw new Error('private installation location'); });
    expect(installApplication(operations)).toEqual({ state: 'error' });
  });
});

describe('installer IPC sender boundary', () => {
  it('requires the owned web contents, exact main frame identity, and exact installer URL', () => {
    const contents = {}; const url = 'file:///temporary/installer/index.html?preview=1'; const mainFrame = { url };
    expect(isInstallerSender({ sender: contents, senderFrame: mainFrame }, contents, mainFrame, url)).toBe(true);
    expect(isInstallerSender({ sender: {}, senderFrame: mainFrame }, contents, mainFrame, url)).toBe(false);
    expect(isInstallerSender({ sender: contents, senderFrame: { url } }, contents, mainFrame, url)).toBe(false);
    expect(isInstallerSender({ sender: contents, senderFrame: mainFrame }, contents, mainFrame, url.replace('?preview=1', ''))).toBe(false);
    expect(isInstallerSender({ sender: contents }, contents, mainFrame, url)).toBe(false);
  });
});
