import path from 'node:path';
import type { ObservedCodexNativeQueueStatus } from '@extalia/platform';
import { CodexNativeQueueError, readCodexNativeQueue, type CodexNativeQueueResult } from './codexNativeQueue.js';
import { environmentValue, findExecutable } from './executableDiscovery.js';
import type { ObservedCodexQueueTarget } from './observedCodexQueueService.js';

interface Options {
  homeDirectory?: string;
  env: Readonly<Record<string, string | undefined>>;
  target(id: string): ObservedCodexQueueTarget | undefined;
  labelsOnly(): boolean;
  read?: typeof readCodexNativeQueue;
  now?: () => number;
}
interface Reading {
  abort: AbortController;
  ids: Set<string>;
  done: Promise<CodexNativeQueueResult>;
}
interface Cached { expires: number; observedAt: string; result?: CodexNativeQueueResult; failure?: 'unavailable' | 'unsupported' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
function identity(source: ObservedCodexQueueTarget | undefined): string | undefined {
  if (!source || !text(source.threadId, 36) || !UUID.test(source.threadId) || !text(source.codexHome, 4096) || !path.isAbsolute(source.codexHome)
    || !text(source.sourceFingerprint, 16_384) || source.cwd !== undefined && (!text(source.cwd, 4096) || !path.isAbsolute(source.cwd))) return undefined;
  return JSON.stringify([source.codexHome, source.threadId, source.sourceFingerprint, source.cwd]);
}

/** Memory-only, read-only source inspection shared by all views of this host. */
export class ObservedCodexNativeQueueService {
  private readonly reads = new Map<string, Reading>();
  private readonly cache = new Map<string, Cached>();
  private readonly blocked = new Set<string>();
  private readonly generations = new Map<string, number>();
  private privacyGeneration = 0;
  private closed = false;
  private cleanupFailed = false;
  private readonly now: () => number;

  constructor(private readonly options: Options) { this.now = options.now ?? Date.now; }
  private target(id: string) { try { return this.options.target(id); } catch { return undefined; } }
  private generation(id: string) { return this.generations.get(id) ?? 0; }
  private isPrivate() { return this.options.labelsOnly(); }
  private unavailable(id: string, state: 'unavailable' | 'unsupported' | 'private' = 'unavailable'): ObservedCodexNativeQueueStatus {
    return { sessionId: id, state, items: [] };
  }
  private current(id: string, key: string, generation: number, privacy: number): boolean {
    const source = this.target(id);
    return !this.closed && !this.cleanupFailed && !this.blocked.has(id) && this.generation(id) === generation
      && this.privacyGeneration === privacy && !this.isPrivate() && source?.watching === true && identity(source) === key;
  }
  private project(id: string, source: ObservedCodexQueueTarget, cached: Cached): ObservedCodexNativeQueueStatus {
    if (!cached.result) return this.unavailable(id, cached.failure);
    return { sessionId: id, threadId: source.threadId, state: 'ready', items: structuredClone(cached.result.items),
      observedAt: cached.observedAt, ...(cached.result.truncated ? { truncated: true } : {}) };
  }

  async status(id: string): Promise<ObservedCodexNativeQueueStatus> {
    if (!text(id, 200)) throw new Error('Choose an observed Codex session.');
    if (this.closed || this.blocked.has(id) || this.cleanupFailed) return this.unavailable(id);
    const source = this.target(id), key = identity(source);
    if (!source || !key || !source.watching) return this.unavailable(id);
    if (this.isPrivate()) { this.invalidatePrivacy(); return this.unavailable(id, 'private'); }
    const generation = this.generation(id), privacy = this.privacyGeneration;
    for (const [key, value] of this.cache) if (value.expires <= this.now()) this.cache.delete(key);
    const cached = this.cache.get(key);
    if (cached) return this.project(id, source, cached);
    let reading = this.reads.get(key);
    if (!reading) {
      // A stale operation retains its slot until actual process cleanup settles.
      if (this.reads.size >= 2) return this.unavailable(id);
      const abort = new AbortController();
      reading = { abort, ids: new Set([id]), done: Promise.resolve().then(async () => {
        const bin = await findExecutable('codex', { env: this.options.env, platform: process.platform, homeDirectory: this.options.homeDirectory,
          override: environmentValue(this.options.env, 'EXTALIA_CODEX_BIN', process.platform) });
        if (!bin || abort.signal.aborted || !this.current(id, key, generation, privacy)) throw new CodexNativeQueueError();
        return (this.options.read ?? readCodexNativeQueue)({ bin, codexHome: source.codexHome, env: this.options.env,
          ...(source.cwd ? { cwd: source.cwd } : {}), threadId: source.threadId, signal: abort.signal });
      }) };
      const owned = reading;
      this.reads.set(key, owned);
      void owned.done.catch(error => { if (error instanceof CodexNativeQueueError && error.cleanupUnconfirmed) this.cleanupFailed = true; })
        .finally(() => { if (this.reads.get(key) === owned) this.reads.delete(key); });
    } else reading.ids.add(id);
    let result: CodexNativeQueueResult | undefined, failure: 'unavailable' | 'unsupported' | undefined;
    try { result = await reading.done; }
    catch (error) { failure = error instanceof CodexNativeQueueError ? error.state : 'unavailable'; }
    if (this.isPrivate()) { this.invalidatePrivacy(); return this.unavailable(id, 'private'); }
    if (!this.current(id, key, generation, privacy) || reading.abort.signal.aborted) return this.unavailable(id);
    const observedAt = new Date(this.now()).toISOString();
    const next: Cached = { expires: this.now() + (result ? 5000 : 1000), observedAt, result, failure };
    if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, next);
    return this.project(id, source, next);
  }

  /** Synchronously revoke replies, discard content, then drain exact admitted readers. */
  async drop(id: string): Promise<void> {
    this.blocked.add(id); this.generations.set(id, this.generation(id) + 1);
    // Cache entries have no public identity; clear the bounded cache rather than retaining a reverse index.
    this.cache.clear();
    const reads = [...this.reads.values()].filter(value => value.ids.has(id));
    for (const reading of reads) reading.abort.abort();
    await Promise.allSettled(reads.map(reading => reading.done));
    if (this.cleanupFailed) throw new CodexNativeQueueError('unavailable', true);
  }
  resume(id: string): void { this.blocked.delete(id); }
  /** Call synchronously before committing any privacy preference change. */
  invalidatePrivacy(): void {
    ++this.privacyGeneration; this.cache.clear();
    for (const reading of this.reads.values()) reading.abort.abort();
  }
  async close(): Promise<void> {
    this.closed = true; this.invalidatePrivacy();
    await Promise.allSettled([...this.reads.values()].map(reading => reading.done));
    if (this.cleanupFailed) throw new CodexNativeQueueError('unavailable', true);
  }
}
