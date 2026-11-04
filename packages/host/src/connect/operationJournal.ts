import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rm, rmdir, stat } from 'node:fs/promises';
import { uptime } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentAppId } from '@extalia/platform';
import { errorCode, isNotFound, writeJsonAtomic } from '../jsonStore.js';
import { ConnectError, sha256, writeConfigFile } from './util.js';

/**
 * One connector operation at a time across processes (Desktop, Bridge and a
 * standalone `extalia connect`), with a write-ahead journal of every file it is
 * about to change. A journal left by a process that died is never replayed or
 * rolled back automatically: the user reviews it and chooses rollback or keep.
 *
 * Limits: the lock is advisory and only coordinates Extalia processes; the
 * journal records intent before each write, so a crash between journal and
 * write reads as "not applied". This is not filesystem CAS or OS-level locking.
 */

export type ConnectOperationKind = 'connect' | 'disconnect';

export interface JournalEntry {
  /** Resolved file that is written (a symlink's target). */
  target: string;
  existed: boolean;
  beforeSha256?: string;
  /** Snapshot file name of the original bytes, inside the journal directory. */
  snapshot?: string;
  /** `null`: the operation removes the file. */
  afterSha256: string | null;
  mode?: number;
}

interface Journal {
  schema: 'extalia.connect-journal.v1';
  id: string;
  operation: ConnectOperationKind;
  app: AgentAppId;
  pid: number;
  startedAt: string;
  entries: JournalEntry[];
}

interface LockInfo { schema: 'extalia.connect-lock.v1'; id: string; pid: number; operation: string; startedAt: string }

export type RecoveryEntryState = 'not-applied' | 'applied' | 'changed';

export interface InterruptedConnectOperation {
  operation: ConnectOperationKind;
  app: AgentAppId;
  startedAt: string;
  entries: { target: string; state: RecoveryEntryState }[];
}

export interface ConnectOperation {
  /** Record the original bytes and intended result of one file before it is written. */
  record(target: string, before: string | Uint8Array | undefined, after: string | Uint8Array | undefined, mode?: number): Promise<void>;
  /** All recorded writes finished or were rolled back: forget the journal. */
  complete(): Promise<void>;
}

export interface JournalOptions {
  now?: () => Date;
  alive?: (pid: number) => boolean;
  /** Command shown to the user for reviewing an interrupted operation. */
  recoverCommand: string;
}

const LABELS: Record<AgentAppId, string> = { codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini CLI', antigravity: 'Antigravity', hermes: 'Hermes' };
const APPS = new Set<string>(Object.keys(LABELS));
// A lock written before the last restart is stale even if its process id was reused since.
const RESTART_TOLERANCE_MS = 5 * 60_000;
// Serialize operations of one process; the file lock alone cannot tell two callers in the same process apart.
const inProcess = new Map<string, Promise<void>>();

const files = (connectDirectory: string) => ({
  lock: path.join(connectDirectory, 'operation.lock'),
  journal: path.join(connectDirectory, 'journal.json'),
  snapshots: path.join(connectDirectory, 'journal'),
});

function defaultAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return errorCode(error) !== 'ESRCH'; }
}

async function readText(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (isNotFound(error)) return undefined; throw error; }
}

async function readBytes(file: string): Promise<Buffer | undefined> {
  try { return await readFile(file); }
  catch (error) { if (isNotFound(error)) return undefined; throw error; }
}

function parseLock(text: string): LockInfo | undefined {
  try {
    const value = JSON.parse(text) as Partial<LockInfo>;
    if (value.schema === 'extalia.connect-lock.v1' && typeof value.id === 'string' && Number.isInteger(value.pid) && (value.pid as number) > 0 && typeof value.startedAt === 'string') return value as LockInfo;
  } catch { /* unreadable */ }
  return undefined;
}

function parseJournal(text: string): Journal | undefined {
  try {
    const value = JSON.parse(text) as Partial<Journal>;
    if (value.schema !== 'extalia.connect-journal.v1' || typeof value.id !== 'string' || !APPS.has(String(value.app))
      || (value.operation !== 'connect' && value.operation !== 'disconnect') || typeof value.startedAt !== 'string' || !Array.isArray(value.entries)) return undefined;
    const valid = value.entries.every(entry => entry && typeof entry.target === 'string' && path.isAbsolute(entry.target) && typeof entry.existed === 'boolean'
      && (entry.afterSha256 === null || typeof entry.afterSha256 === 'string')
      && (!entry.existed || (typeof entry.beforeSha256 === 'string' && typeof entry.snapshot === 'string' && /^\d+\.before$/.test(entry.snapshot))));
    return valid ? value as Journal : undefined;
  } catch { return undefined; }
}

async function readJournal(file: string): Promise<Journal | undefined> {
  const text = await readText(file);
  if (text === undefined) return undefined;
  const journal = parseJournal(text);
  if (!journal) throw new ConnectError(`The connection journal ${file} cannot be read. Extalia left it and every configuration unchanged; inspect the connect backups, then remove the file.`);
  return journal;
}

/** The lock holder still runs: alive, not written before the last boot, and (for our own pid) inside this process's queue. */
function holderRuns(holder: LockInfo, alive: (pid: number) => boolean, lockFile: string): boolean {
  const started = Date.parse(holder.startedAt);
  if (Number.isFinite(started) && started < Date.now() - uptime() * 1000 - RESTART_TOLERANCE_MS) return false;
  // Our own pid holds a file lock only inside the in-process queue; otherwise it is left over from a reused pid.
  if (holder.pid === process.pid) return inProcess.has(path.resolve(lockFile));
  return alive(holder.pid);
}

/**
 * Remove a stale lock while holding an exclusive breaker file, so two processes
 * that both saw the same stale lock cannot each delete a fresh one.
 */
async function breakStaleLock(lockFile: string, existing: string): Promise<void> {
  const breaker = `${lockFile}.break`;
  try {
    const handle = await open(breaker, 'wx', 0o600);
    await handle.close();
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    // A breaker left by a process that died while breaking expires after a few seconds.
    const old = await stat(breaker).then(entry => Date.now() - entry.mtimeMs > 5000, () => false);
    if (old) await rm(breaker, { force: true });
    await delay(50);
    return;
  }
  try { if (await readText(lockFile) === existing) await rm(lockFile, { force: true }); }
  finally { await rm(breaker, { force: true }); }
}

async function acquireFileLock(lockFile: string, operation: string, alive: (pid: number) => boolean, now: () => Date): Promise<() => Promise<void>> {
  const directory = path.dirname(lockFile);
  // Directories created only for the lock are removed again, so a refused operation leaves nothing behind.
  const firstCreated = await mkdir(directory, { recursive: true, mode: 0o700 });
  const cleanup = async () => {
    if (!firstCreated) return;
    for (let current = directory; ; current = path.dirname(current)) {
      try { await rmdir(current); } catch { return; }
      if (path.resolve(current) === path.resolve(firstCreated)) return;
    }
  };
  const info: LockInfo = { schema: 'extalia.connect-lock.v1', id: randomBytes(8).toString('hex'), pid: process.pid, operation, startedAt: now().toISOString() };
  const content = `${JSON.stringify(info)}\n`;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const handle = await open(lockFile, 'wx', 0o600);
      try { await handle.writeFile(content, 'utf8'); } finally { await handle.close(); }
      return async () => { if (await readText(lockFile) === content) { await rm(lockFile, { force: true }); await cleanup(); } };
    } catch (error) {
      // Another process removed the directory it created for a refused operation: create it again.
      if (errorCode(error) === 'ENOENT') { await mkdir(directory, { recursive: true, mode: 0o700 }); continue; }
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const existing = await readText(lockFile);
    if (existing === undefined) continue;
    const holder = parseLock(existing);
    if (!holder) {
      // Possibly still being written by its creator.
      const recent = await stat(lockFile).then(entry => Date.now() - entry.mtimeMs < 2000, () => false);
      if (recent) { await delay(100); continue; }
    } else if (holderRuns(holder, alive, lockFile) && holder.pid !== process.pid) {
      throw new ConnectError('Another Extalia connection change is in progress. Wait for it to finish, then try again. Nothing was written.');
    }
    await breakStaleLock(lockFile, existing);
  }
  throw new ConnectError('Could not take the connection lock; another Extalia process keeps changing connections. Try again.');
}

async function withInProcessQueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = inProcess.get(key) ?? Promise.resolve();
  let done!: () => void;
  const current = new Promise<void>(resolve => { done = resolve; });
  const chained = previous.then(() => current);
  inProcess.set(key, chained);
  await previous;
  try { return await task(); }
  finally {
    done();
    if (inProcess.get(key) === chained) inProcess.delete(key);
  }
}

function interruptedMessage(journal: Journal, recoverCommand: string): string {
  return `An earlier ${journal.operation === 'connect' ? 'connection' : 'disconnection'} of ${LABELS[journal.app]} (started ${journal.startedAt}) did not finish. `
    + `Extalia did not change anything automatically. Review it with \`${recoverCommand}\`, then roll it back or keep the current files. Nothing was written.`;
}

/**
 * Run `task` holding the connector lock. A leftover journal of a process that
 * stopped refuses the task. `task` receives a journal to record each write in.
 */
export async function withConnectOperation<T>(
  connectDirectory: string,
  operation: { kind: ConnectOperationKind; app: AgentAppId },
  options: JournalOptions,
  task: (journal: ConnectOperation) => Promise<T>,
): Promise<T> {
  const now = options.now ?? (() => new Date());
  const paths = files(connectDirectory);
  return withInProcessQueue(path.resolve(paths.lock), async () => {
    const release = await acquireFileLock(paths.lock, `${operation.kind}:${operation.app}`, options.alive ?? defaultAlive, now);
    try {
      const leftover = await readJournal(paths.journal);
      if (leftover) throw new ConnectError(interruptedMessage(leftover, options.recoverCommand));
      // Snapshots without a journal belong to an operation that never recorded a write.
      await rm(paths.snapshots, { recursive: true, force: true });
      let journal: Journal | undefined;
      const handle: ConnectOperation = {
        async record(target, before, after, mode) {
          const resolved = path.resolve(target);
          if (!journal) {
            journal = { schema: 'extalia.connect-journal.v1', id: randomBytes(8).toString('hex'), operation: operation.kind, app: operation.app, pid: process.pid, startedAt: now().toISOString(), entries: [] };
            await mkdir(paths.snapshots, { recursive: true, mode: 0o700 });
          }
          const afterSha256 = after === undefined ? null : sha256(after);
          const existing = journal.entries.find(entry => entry.target === resolved);
          if (existing) existing.afterSha256 = afterSha256;
          else {
            const entry: JournalEntry = { target: resolved, existed: before !== undefined, afterSha256, ...(mode !== undefined ? { mode } : {}) };
            if (before !== undefined) {
              const snapshot = `${journal.entries.length}.before`;
              const fileHandle = await open(path.join(paths.snapshots, snapshot), 'wx', 0o600);
              try { await fileHandle.writeFile(before); await fileHandle.sync(); } finally { await fileHandle.close(); }
              entry.beforeSha256 = sha256(before);
              entry.snapshot = snapshot;
            }
            journal.entries.push(entry);
          }
          await writeJsonAtomic(paths.journal, journal, { mode: 0o600 });
        },
        async complete() {
          if (!journal) return;
          // Retries cover files briefly held by indexers or antivirus on Windows.
          await rm(paths.journal, { force: true, maxRetries: 5, retryDelay: 100 });
          await rm(paths.snapshots, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          journal = undefined;
        },
      };
      return await task(handle);
    } finally {
      await release();
    }
  });
}

async function classify(entry: JournalEntry): Promise<RecoveryEntryState> {
  const current = await readBytes(entry.target);
  const matchesBefore = entry.existed ? current !== undefined && sha256(current) === entry.beforeSha256 : current === undefined;
  if (matchesBefore) return 'not-applied';
  const matchesAfter = entry.afterSha256 === null ? current === undefined : current !== undefined && sha256(current) === entry.afterSha256;
  return matchesAfter ? 'applied' : 'changed';
}

async function describeJournal(journal: Journal): Promise<InterruptedConnectOperation> {
  return {
    operation: journal.operation, app: journal.app, startedAt: journal.startedAt,
    entries: await Promise.all(journal.entries.map(async entry => ({ target: entry.target, state: await classify(entry) }))),
  };
}

/** Read-only: an interrupted operation whose process no longer holds the lock. */
export async function inspectInterruptedOperation(connectDirectory: string, alive: (pid: number) => boolean = defaultAlive): Promise<InterruptedConnectOperation | undefined> {
  const paths = files(connectDirectory);
  // Read the lock first: a journal seen afterwards was written while that lock (if any) was held.
  const lock = parseLock(await readText(paths.lock) ?? '');
  const text = await readText(paths.journal);
  if (text === undefined) return undefined;
  const journal = parseJournal(text);
  if (!journal) throw new ConnectError(`The connection journal ${paths.journal} cannot be read. Extalia left it and every configuration unchanged; inspect the connect backups, then remove the file.`);
  // Still running, in this or another process: not interrupted.
  if (lock && lock.pid === journal.pid && holderRuns(lock, alive, paths.lock)) return undefined;
  return describeJournal(journal);
}

export type RecoveryAction = 'preview' | 'rollback' | 'keep';

export interface RecoveryReport {
  operation?: InterruptedConnectOperation;
  action: RecoveryAction;
  /** Files restored to their original bytes or removed again. */
  restored: string[];
  resolved: boolean;
}

/**
 * Review an interrupted operation. `rollback` restores every applied file and
 * refuses when any file changed since; `keep` forgets the journal and leaves all
 * files as they are. `preview` changes nothing.
 */
export async function recoverInterruptedOperation(connectDirectory: string, action: RecoveryAction, options: Omit<JournalOptions, 'recoverCommand'> = {}): Promise<RecoveryReport> {
  const now = options.now ?? (() => new Date());
  const paths = files(connectDirectory);
  if (action === 'preview') {
    const operation = await inspectInterruptedOperation(connectDirectory, options.alive);
    return { ...(operation ? { operation } : {}), action, restored: [], resolved: false };
  }
  return withInProcessQueue(path.resolve(paths.lock), async () => {
    const release = await acquireFileLock(paths.lock, `recover:${action}`, options.alive ?? defaultAlive, now);
    try {
      const journal = await readJournal(paths.journal);
      if (!journal) return { action, restored: [], resolved: false };
      const operation = await describeJournal(journal);
      const restored: string[] = [];
      if (action === 'rollback') {
        const changed = operation.entries.filter(entry => entry.state === 'changed');
        if (changed.length) {
          throw new ConnectError(`${changed.length} file(s) changed after the interrupted operation, so Extalia cannot roll it back safely. Nothing was written. Inspect them and the connect backups, then keep the current files.`);
        }
        const snapshots = new Map<JournalEntry, Buffer>();
        for (const entry of journal.entries) {
          if (!entry.existed) continue;
          const original = await readBytes(path.join(paths.snapshots, entry.snapshot!));
          if (!original || sha256(original) !== entry.beforeSha256) throw new ConnectError('A saved original in the connection journal is missing or damaged. Nothing was written. Inspect the connect backups, then keep the current files.');
          snapshots.set(entry, original);
        }
        for (const entry of [...journal.entries].reverse()) {
          const state = await classify(entry);
          if (state === 'not-applied') continue;
          if (state === 'changed') throw new ConnectError(`A file changed during recovery; ${restored.length} file(s) were already restored. Review again before continuing.`);
          if (entry.existed) await writeConfigFile(entry.target, snapshots.get(entry)!, entry.mode);
          else await rm(entry.target, { force: true });
          restored.push(entry.target);
        }
      }
      await rm(paths.journal, { force: true });
      await rm(paths.snapshots, { recursive: true, force: true });
      return { operation, action, restored, resolved: true };
    } finally {
      await release();
    }
  });
}
