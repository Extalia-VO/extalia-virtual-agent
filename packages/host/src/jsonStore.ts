import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { appendFile, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from './paths.js';

export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export const isNotFound = (error: unknown): boolean => errorCode(error) === 'ENOENT';

/** A data file exists but cannot be parsed. Extalia never overwrites such files on its own. */
export class CorruptFileError extends Error {
  override name = 'CorruptFileError';
  constructor(readonly file: string, reason: string) {
    super(`${file} is not valid JSON (${reason}). Extalia left it unchanged; repair or remove the file.`);
  }
}

/** Read a JSON file. A missing file yields `fallback`; a corrupt file throws `CorruptFileError`. */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if (isNotFound(error)) return fallback; throw error; }
  try { return JSON.parse(text) as T; }
  catch (error) { throw new CorruptFileError(file, error instanceof Error ? error.message : 'parse error'); }
}

export interface WriteOptions {
  /** File mode for the written file. Defaults to 0o600: Extalia data is private. */
  mode?: number;
}

/** Write a file by renaming a fully written temporary file over it, so readers never see a partial file. */
export async function writeFileAtomic(file: string, data: string | Uint8Array, { mode = PRIVATE_FILE_MODE }: WriteOptions = {}): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const handle = await open(temporary, 'wx', mode);
    try { await handle.writeFile(data); await handle.sync(); }
    finally { await handle.close(); }
    await renameWithRetry(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function writeJsonAtomic(file: string, value: unknown, options?: WriteOptions): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

/**
 * Opt-in publication barrier for a host-owned JSON journal. The caller serializes
 * writes and owns the trusted parent directories; this is not hostile-directory
 * CAS. POSIX acknowledgements include the file rename and newly created directory
 * names created by this writer. Earlier ancestor creation by another owner must
 * already be durably published; this is not a whole-profile creation barrier.
 * Windows retains atomic-file/process-restart recovery, but Node cannot
 * acknowledge directory-name flushing there, so power-loss durability is not
 * promised. Keep this writer for the journal's lifetime, including failed writes.
 */
export function createDurableJsonWriter(file: string, options?: WriteOptions): (value: unknown) => Promise<void> {
  const directory = path.resolve(path.dirname(file));
  let durableParent = path.dirname(directory);
  let identity: { dev: number; ino: number } | undefined;
  const assertDirectory = async () => {
    const current = await lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink()
      || identity && (current.dev !== identity.dev || current.ino !== identity.ino)) throw new Error('Journal directory changed during publication.');
    identity ??= { dev: current.dev, ino: current.ino };
  };
  return async value => {
    const firstCreated = await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    // A failed publication may leave these directories visible but unflushed.
    // Retain the boundary so the next attempt still publishes the entire chain.
    if (firstCreated) {
      const parent = path.dirname(path.resolve(firstCreated));
      if (path.relative(parent, durableParent).split(path.sep)[0] !== '..') durableParent = parent;
    }
    await assertDirectory();
    await writeJsonAtomic(file, value, options);
    if (process.platform !== 'win32') for (let current = directory;; current = path.dirname(current)) {
      const before = await lstat(current);
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Journal directory publication is unavailable.');
      const handle = await open(current, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isDirectory() || before.dev !== opened.dev || before.ino !== opened.ino) throw new Error('Journal directory changed during publication.');
        await handle.sync();
        const after = await lstat(current);
        if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) throw new Error('Journal directory changed during publication.');
      } finally { await handle.close(); }
      if (current === durableParent) break;
      if (path.dirname(current) === current) throw new Error('Journal directory publication is unavailable.');
    }
    await assertDirectory();
  };
}

/** Append one line (no line breaks inside) to a file, creating it and its directory when needed. */
export async function appendLine(file: string, line: string, { mode = PRIVATE_FILE_MODE }: WriteOptions = {}): Promise<void> {
  if (/[\r\n]/.test(line)) throw new Error('appendLine: the line must not contain line breaks.');
  await mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await appendFile(file, `${line}\n`, { encoding: 'utf8', mode });
}

// Windows refuses to replace a file another process (often an indexer or antivirus) briefly holds open.
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      const code = errorCode(error);
      if (process.platform !== 'win32' || attempt >= 5 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
      await delay(20 * attempt);
    }
  }
}
