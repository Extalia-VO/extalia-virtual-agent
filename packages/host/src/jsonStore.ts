import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
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
export async function writeFileAtomic(file: string, data: string, { mode = PRIVATE_FILE_MODE }: WriteOptions = {}): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const handle = await open(temporary, 'wx', mode);
    try { await handle.writeFile(data, 'utf8'); await handle.sync(); }
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
