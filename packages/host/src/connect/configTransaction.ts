import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { isNotFound } from '../jsonStore.js';
import { ConnectError, writableTarget, writeConfigFile } from './util.js';

export interface ConfigWrite {
  file: string;
  target: string;
  before: string | undefined;
  after: string;
  mode?: number;
}
async function read(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (isNotFound(error)) return undefined; throw error; }
}
/**
 * Preflight all files and roll back caught failures without overwriting concurrent
 * edits. This is not cross-process locking, crash atomicity or filesystem CAS.
 */
export async function commitConfigWrites(
  writes: readonly ConfigWrite[],
  write = writeConfigFile,
): Promise<void> {
  const seen = new Set<string>();
  const check = async (entry: ConfigWrite) => {
    if (path.resolve(await writableTarget(entry.file)) !== path.resolve(entry.target) || await read(entry.target) !== entry.before) {
      throw new ConnectError('A connection file or its link target changed. Review a new preview before applying.');
    }
  };
  for (const entry of writes) {
    const target = path.resolve(entry.target);
    if (seen.has(target)) throw new ConnectError('Connection files resolve to the same target. Nothing was written.');
    seen.add(target);
    await check(entry);
  }
  const attempted: ConfigWrite[] = [];
  try {
    for (const entry of writes) {
      await check(entry);
      attempted.push(entry);
      await write(entry.target, entry.after, entry.mode);
    }
  } catch (error) {
    let conflict = false;
    for (const entry of attempted.reverse()) {
      try {
        const current = await read(entry.target);
        if (current === entry.before) continue;
        if (current !== entry.after) { conflict = true; continue; }
        if (entry.before === undefined) await rm(entry.target);
        else await writeConfigFile(entry.target, entry.before, entry.mode);
      } catch { conflict = true; }
    }
    throw new ConnectError(conflict
      ? 'Connection failed; concurrent changes were preserved and rollback is incomplete. Inspect the connect backups before retrying.'
      : `Connection failed and file changes were rolled back: ${error instanceof Error ? error.message : 'write failed'}`);
  }
}
