export interface LinuxInstallerOptions {
  appImage: string;
  output: string;
  icon?: string;
  version: string;
  copy?: Record<string, string>;
}
/** Build an offline, user-only executable installer. Never executes its payload. */
export function buildLinuxInstaller(options: LinuxInstallerOptions): Promise<void>;
export function verifyLinuxInstaller(options: Omit<LinuxInstallerOptions, 'output'> & { installer: string }): Promise<void>;
