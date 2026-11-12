import { resolveDataDirectory, type DataDirectoryInput } from '@extalia/platform';
import path from 'node:path';

/** Chromium owns only this child of the same profile used by the agent host. */
export function desktopProfilePaths(input: DataDirectoryInput): { dataDirectory: string; userData: string; sessionData: string } {
  const paths = input.platform === 'win32' ? path.win32 : path.posix;
  const dataDirectory = paths.resolve(resolveDataDirectory(input));
  const chromium = paths.join(dataDirectory, 'desktop-profile');
  return { dataDirectory, userData: chromium, sessionData: chromium };
}
