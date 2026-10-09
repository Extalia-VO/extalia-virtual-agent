import { open, readFile, rm, stat } from 'node:fs/promises';
import { uptime } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { errorCode } from './jsonStore.js';
import { ensurePrivateDirectory, PRIVATE_FILE_MODE } from './paths.js';

export type HostKind = 'desktop' | 'bridge';

export interface HostLock {
  release(): Promise<void>;
}

interface LockInfo {
  pid: number;
  kind: HostKind;
  startedAt: string;
}

const KIND_LABEL: Record<HostKind, string> = { desktop: 'Desktop', bridge: 'Bridge' };

/** Another Extalia host (Desktop or Bridge) already uses this data directory. */
export class HostLockedError extends Error {
  override name = 'HostLockedError';
  constructor(readonly kind: HostKind, readonly pid: number, readonly lockFile: string) {
    super(`Extalia is already running (${KIND_LABEL[kind]}, process ${pid}). Close it first.`);
  }
}

function parseLock(text: string): LockInfo | undefined {
  try {
    const value = JSON.parse(text) as Partial<LockInfo>;
    if (Number.isInteger(value.pid) && (value.pid as number) > 0 && (value.kind === 'desktop' || value.kind === 'bridge') && typeof value.startedAt === 'string') return value as LockInfo;
  } catch { /* unreadable: treated as stale */ }
  return undefined;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return errorCode(error) !== 'ESRCH'; }
}

// A lock written before the last restart is stale even if its process id was reused since.
const RESTART_TOLERANCE_MS = 5 * 60_000;

function isStale(info: LockInfo | undefined): boolean {
  if (!info || !isAlive(info.pid)) return true;
  const started = Date.parse(info.startedAt);
  return Number.isFinite(started) && started < Date.now() - uptime() * 1000 - RESTART_TOLERANCE_MS;
}

async function isRecent(file: string): Promise<boolean> {
  try { return Date.now() - (await stat(file)).mtimeMs < 2000; } catch { return false; }
}

async function readLock(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (errorCode(error) === 'ENOENT') return undefined; throw error; }
}

/**
 * Make sure only one host uses a data directory. The lock file `host.lock`
 * is created exclusively; a lock left by a process that no longer runs is
 * replaced. Throws `HostLockedError` when another host is running.
 */
export async function acquireHostLock(stateDirectory: string, kind: HostKind): Promise<HostLock> {
  await ensurePrivateDirectory(stateDirectory);
  const file = path.join(stateDirectory, 'host.lock');
  const info: LockInfo = { pid: process.pid, kind, startedAt: new Date().toISOString() };
  const content = `${JSON.stringify(info)}\n`;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const handle = await open(file, 'wx', PRIVATE_FILE_MODE);
      try { await handle.writeFile(content, 'utf8'); }
      finally { await handle.close(); }
      return { release: () => releaseLock(file, content) };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const existing = await readLock(file);
    if (existing === undefined) continue;
    const holder = parseLock(existing);
    // An unreadable lock may belong to a host that created it and is still writing it.
    if (!holder && await isRecent(file)) { await delay(100); continue; }
    if (!isStale(holder)) throw new HostLockedError(holder!.kind, holder!.pid, file);
    // Re-read right before removing so a lock another host just wrote is not deleted.
    if ((await readLock(file)) === existing) await rm(file, { force: true });
  }
  throw new Error(`Could not take the host lock ${file}; another Extalia host is starting. Try again.`);
}

async function releaseLock(file: string, content: string): Promise<void> {
  // Only remove the lock when it is still ours.
  if ((await readLock(file)) === content) await rm(file, { force: true });
}
