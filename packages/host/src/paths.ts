import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';

/** Absolute directories below the Extalia data directory. */
export interface DataLayout {
  root: string;
  config: string;
  state: string;
  sessions: string;
  workspaces: string;
  skills: string;
  cache: string;
}

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export function dataLayout(dataDirectory: string): DataLayout {
  const root = path.resolve(dataDirectory);
  const at = (name: string) => path.join(root, name);
  return { root, config: at('config'), state: at('state'), sessions: at('sessions'), workspaces: at('workspaces'), skills: at('skills'), cache: at('cache') };
}

/** Create a directory readable only by the current user (POSIX). Existing directories are tightened too. */
export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (process.platform !== 'win32') await chmod(directory, PRIVATE_DIRECTORY_MODE);
}

export async function ensureLayout(layout: DataLayout): Promise<void> {
  await ensurePrivateDirectory(layout.root);
  for (const [key, directory] of Object.entries(layout)) if (key !== 'root') await ensurePrivateDirectory(directory);
}
