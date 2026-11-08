export interface InstallerBoot {
  preview: boolean;
  smokeTest: boolean;
  skip?: boolean;
  platform: string;
  packaged: boolean;
  inApplications: boolean;
}

/** macOS can translocate a downloaded app; native Applications detection covers both sources. */
export function shouldShowInstaller(input: InstallerBoot): boolean {
  if (input.preview) return true;
  return !input.skip && !input.smokeTest && input.platform === 'darwin' && input.packaged && !input.inApplications;
}

export type InstallResult = { state: 'installed' | 'cancelled' | 'blocked' | 'error' | 'preview' };
export interface InstallOperations {
  preview: boolean;
  eligible(): boolean;
  move(options: { conflictHandler(type: 'exists' | 'existsAndRunning'): boolean }): boolean;
  confirmReplacement(): boolean;
}

/** The only effect is Electron's native copy/relaunch, behind an explicit IPC request. */
export function installApplication(operations: InstallOperations): InstallResult {
  if (operations.preview) return { state: 'preview' };
  if (!operations.eligible()) return { state: 'blocked' };
  let blocked = false;
  try {
    const installed = operations.move({ conflictHandler: type => {
      if (type === 'existsAndRunning') { blocked = true; return false; }
      return operations.confirmReplacement();
    } });
    return { state: installed ? 'installed' : blocked ? 'blocked' : 'cancelled' };
  } catch {
    // Native errors can contain private local paths. The renderer uses catalog copy.
    return { state: 'error' };
  }
}

export interface InstallerSender {
  sender: unknown;
  senderFrame?: { url: string } | null;
}
export function isInstallerSender(event: InstallerSender, contents: unknown, mainFrame: unknown, url: string): boolean {
  return event.sender === contents && event.senderFrame === mainFrame && event.senderFrame?.url === url;
}

export const INSTALLER_CHANNELS = { install: 'extalia:installer:install', continue: 'extalia:installer:continue' } as const;
