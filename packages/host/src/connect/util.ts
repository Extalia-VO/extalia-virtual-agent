import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isNotFound, writeFileAtomic } from '../jsonStore.js';

export type Env = Readonly<Record<string, string | undefined>>;

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** A message that is safe to show to the user as is. */
export class ConnectError extends Error {
  override name = 'UserError';
}

/** Quote one command-line argument for the shell that runs the hook command. */
export function quoteArgument(value: string, platform: string): string {
  if (platform === 'win32') return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export async function readTextIfExists(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (isNotFound(error)) return undefined; throw error; }
}

/**
 * Where to write when `file` is a symbolic link (dotfile managers): the link's
 * target, so the link itself survives. A missing file resolves to its own path.
 */
export async function writableTarget(file: string): Promise<string> {
  try { return await realpath(file); }
  catch (error) { if (isNotFound(error)) return file; throw error; }
}

/** Atomic write that keeps the mode of an existing file (new files get `fallbackMode`). */
export async function writeConfigFile(file: string, content: string, fallbackMode = 0o600): Promise<void> {
  let mode = fallbackMode;
  try { mode = (await stat(file)).mode & 0o777; } catch (error) { if (!isNotFound(error)) throw error; }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, content, { mode });
  if (process.platform !== 'win32') await chmod(file, mode);
}

export async function isExecutable(file: string): Promise<boolean> {
  try { await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return (await stat(file)).isFile(); }
  catch { return false; }
}

/** First executable named `name` on PATH. */
export async function findOnPath(name: string, env: Env, platform: string): Promise<string | undefined> {
  const separator = platform === 'win32' ? ';' : ':';
  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of (env.PATH ?? '').split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** `~/`-style display of a path, for readable output. */
export function displayPath(file: string, home: string): string {
  const normalizedHome = home.replace(/[\\/]+$/, '');
  return normalizedHome && file.startsWith(`${normalizedHome}${path.sep}`) ? `~${file.slice(normalizedHome.length)}` : file;
}
