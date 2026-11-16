import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DAEMON_SCHEMA_VERSION, parseDaemonFrame, type WorkMemoryActions } from '@extalia/protocol';
import { isNotFound, writeJsonAtomic } from './jsonStore.js';

export type WorkMemoryCapture = WorkMemoryActions['memory.capture']['input'];
export interface WorkMemoryPending { key: string; authority: string; phase: 'capture' | 'revoke'; input: WorkMemoryCapture }
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PENDING = 64;
const unavailable = 'The local work-memory outbox is unavailable or needs inspection.';
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
const regular = (info: Stats) => info.isFile() && info.nlink === 1 && info.size <= MAX_BYTES;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function workMemoryPendingKey(input: WorkMemoryCapture): string { return hash(input); }

/** Validate untrusted persisted bytes using the same strict wire contract as a fresh capture. */
function validPending(value: unknown): value is WorkMemoryPending {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'authority,input,key,phase' || !sha(value.key) || !sha(value.authority)
    || !['capture', 'revoke'].includes(String(value.phase))) return false;
  const parsed = parseDaemonFrame({ schemaVersion: DAEMON_SCHEMA_VERSION, kind: 'request', requestId: '00000000-0000-4000-8000-000000000001',
    op: 'learning.process', params: { action: 'memory.capture', input: value.input } });
  return parsed.ok && value.key === hash(value.input);
}

/**
 * Host-owned write-ahead journal. The host profile lock and trusted ancestors
 * own this directory; leaf identity checks do not promise hostile-directory CAS.
 * Only local, idempotent capture requests are replayed, never provider jobs.
 * POSIX publication flushes directory names as well as file contents. Windows
 * retains atomic-file/process-restart recovery, but Node cannot acknowledge a
 * directory-name flush there, so sudden-power-loss durability is not promised.
 */
export class WorkMemoryOutbox {
  private identity?: { dev: number; ino: number; canonical: string };
  private readonly file: string;
  private durableParent: string;
  constructor(readonly directory: string) {
    this.file = path.join(directory, 'pending.json');
    this.durableParent = path.dirname(path.resolve(directory));
  }

  private async root(create: boolean): Promise<boolean> {
    if (create) {
      const firstCreated = await mkdir(this.directory, { recursive: true, mode: 0o700 });
      // Acknowledging the first journal also publishes every newly created parent.
      // Keep this boundary after a failed sync so a retry flushes the full chain.
      if (firstCreated) this.durableParent = path.dirname(path.resolve(firstCreated));
    }
    let info: Stats;
    try { info = await lstat(this.directory); }
    catch (error) {
      if (isNotFound(error) && !create && !this.identity) return false;
      // eslint-disable-next-line preserve-caught-error -- Filesystem details must not escape memory diagnostics.
      throw new Error(unavailable);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(unavailable);
    const canonical = await realpath(this.directory);
    if (this.identity && (this.identity.dev !== info.dev || this.identity.ino !== info.ino || this.identity.canonical !== canonical)) throw new Error(unavailable);
    this.identity ??= { dev: info.dev, ino: info.ino, canonical };
    return true;
  }

  private async syncPublishedDirectories(): Promise<void> {
    if (process.platform === 'win32') return;
    // File fsync alone does not persist rename or mkdir names. Flush the deepest
    // names first, including the existing parent of the first newly created one.
    for (let directory = path.resolve(this.directory);; directory = path.dirname(directory)) {
      await this.root(false);
      const before = await lstat(directory);
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(unavailable);
      const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isDirectory() || before.dev !== opened.dev || before.ino !== opened.ino) throw new Error(unavailable);
        // Any unsupported/failed flush withholds acknowledgement; retry stays safe.
        await handle.sync();
        const current = await lstat(directory);
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error(unavailable);
      } finally { await handle.close(); }
      if (directory === this.durableParent) break;
      if (path.dirname(directory) === directory) throw new Error(unavailable);
    }
    await this.root(false);
  }

  async read(): Promise<WorkMemoryPending[]> {
    if (!await this.root(false)) return [];
    let before: Stats;
    try { before = await lstat(this.file); }
    catch (error) {
      if (isNotFound(error)) return [];
      // eslint-disable-next-line preserve-caught-error -- Filesystem details must not escape memory diagnostics.
      throw new Error(unavailable);
    }
    if (!regular(before)) throw new Error(unavailable);
    const handle = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat();
      if (!regular(opened) || !sameFile(before, opened)) throw new Error(unavailable);
      const bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const part = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!part.bytesRead) throw new Error(unavailable);
        offset += part.bytesRead;
      }
      const after = await handle.stat(), current = await lstat(this.file);
      if (!sameFile(opened, after) || !sameFile(after, current) || !regular(current)) throw new Error(unavailable);
      await this.root(false);
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!object(value) || Object.keys(value).sort().join(',') !== 'pending,version' || value.version !== 1 || !Array.isArray(value.pending)
        || value.pending.length > MAX_PENDING || !value.pending.every(validPending) || new Set(value.pending.map(item => item.key)).size !== value.pending.length) throw new Error(unavailable);
      return value.pending;
    } catch {
      throw new Error(unavailable);
    } finally { await handle.close(); }
  }

  async replace(pending: readonly WorkMemoryPending[]): Promise<void> {
    if (pending.length > MAX_PENDING || !pending.every(validPending) || new Set(pending.map(item => item.key)).size !== pending.length) throw new Error('The local work-memory outbox is full or invalid.');
    const value = { version: 1, pending };
    if (Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8') + 1 > MAX_BYTES) throw new Error('The local work-memory outbox is full.');
    await this.root(true);
    try { const current = await lstat(this.file); if (!regular(current)) throw new Error(unavailable); }
    catch (error) {
      // eslint-disable-next-line preserve-caught-error -- Filesystem details must not escape memory diagnostics.
      if (!isNotFound(error)) throw new Error(unavailable);
    }
    await writeJsonAtomic(this.file, value, { mode: 0o600 });
    await this.root(false);
    await this.syncPublishedDirectories();
  }
}
