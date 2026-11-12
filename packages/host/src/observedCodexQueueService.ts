import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { ObservedCodexQueueMessageInput, ObservedCodexQueueStatus } from '@extalia/platform';
import { queueCodexMessage, type CodexQueueOptions, type CodexQueueResult } from './codexQueue.js';
import { environmentValue, findExecutable } from './executableDiscovery.js';
import { isNotFound, writeJsonAtomic } from './jsonStore.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BINDINGS = 128;
const MAX_FILE_BYTES = 1024 * 1024;
const UNKNOWN = 'Codex queue status is unknown. Check the native queue before explicitly enabling another submission.';

export interface ObservedCodexQueueTarget {
  threadId: string;
  /** Canonical, trusted profile root supplied by the authoritative source resolver. */
  codexHome: string;
  /** Stable source path and file identity; excludes append-sensitive size and timestamps. */
  sourceFingerprint: string;
  cwd?: string;
  watching: boolean;
}
interface Binding {
  sessionId: string; threadId: string; codexHome: string; sourceFingerprint: string;
  lastDelivery?: 'queued' | 'unknown';
  lastMessageId?: string;
}
interface Operation { generation: number; abort: AbortController; done: Promise<void>; submitted?: Binding }
interface Options {
  homeDirectory?: string;
  dataDirectory: string;
  env: Readonly<Record<string, string | undefined>>;
  target(id: string): ObservedCodexQueueTarget | undefined;
  queue?: (options: CodexQueueOptions) => Promise<CodexQueueResult>;
}

function validId(id: unknown): id is string { return typeof id === 'string' && id.length > 0 && id.length <= 200 && !id.includes('\0'); }
function validHome(home: unknown): home is string { return typeof home === 'string' && home.length <= 4096 && path.isAbsolute(home) && !home.includes('\0'); }
function validBinding(value: unknown, version: 1 | 2): value is Binding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Binding;
  return validId(item.sessionId) && typeof item.threadId === 'string' && item.threadId.length === 36 && UUID.test(item.threadId)
    && validHome(item.codexHome) && typeof item.sourceFingerprint === 'string' && /^[0-9a-f]{64}$/.test(item.sourceFingerprint)
    && (version === 1 ? Object.keys(item).length === 4 : Object.keys(item).every(key => ['sessionId', 'threadId', 'codexHome', 'sourceFingerprint', 'lastDelivery', 'lastMessageId'].includes(key)))
    && (item.lastDelivery === undefined || version === 2 && (item.lastDelivery === 'queued' || item.lastDelivery === 'unknown'))
    && (item.lastMessageId === undefined || version === 2 && item.lastDelivery === 'queued' && typeof item.lastMessageId === 'string' && item.lastMessageId.length === 36 && UUID.test(item.lastMessageId));
}
function same(left: Binding | undefined, right: Binding | undefined): boolean {
  return !!left && !!right && left.threadId === right.threadId && left.codexHome === right.codexHome && left.sourceFingerprint === right.sourceFingerprint;
}

/** Owns opt-in metadata and short CLI lifetimes, never an agent engine or source-app configuration. */
export class ObservedCodexQueueService {
  private readonly bindings = new Map<string, Binding>();
  private readonly work = new Map<string, Operation>();
  private readonly generations = new Map<string, number>();
  private readonly blocked = new Set<string>();
  private readonly delivery = new Map<string, 'queued' | 'unknown'>();
  private readonly messageIds = new Map<string, string>();
  private readonly cleanupFailures = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  private persistenceFailed = false;
  private closed = false;
  private readonly file: string;

  private constructor(private readonly options: Options) {
    this.file = path.join(options.dataDirectory, 'state', 'observed-codex-queue.json');
  }

  static async create(options: Options): Promise<ObservedCodexQueueService> {
    const service = new ObservedCodexQueueService(options);
    let handle;
    try { handle = await open(service.file, 'r'); }
    catch (error) { if (isNotFound(error)) return service; throw error; }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('Invalid Codex queue setup file.');
      if (info.size > MAX_FILE_BYTES) throw new Error('Codex queue setup exceeds its size limit.');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > MAX_FILE_BYTES) throw new Error('Codex queue setup exceeds its size limit.');
      const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Codex queue setup file.');
      const data = value as { version?: unknown; bindings?: unknown };
      if (data.version !== 1 && data.version !== 2 || !Array.isArray(data.bindings) || data.bindings.length > MAX_BINDINGS || Object.keys(data).length !== 2) throw new Error('Invalid Codex queue setup file.');
      for (const binding of data.bindings) {
        if (!validBinding(binding, data.version) || service.bindings.has(binding.sessionId)) throw new Error('Invalid Codex queue source binding.');
        service.bindings.set(binding.sessionId, { ...binding });
        if (binding.lastDelivery) service.delivery.set(binding.sessionId, binding.lastDelivery);
        if (binding.lastMessageId) service.messageIds.set(binding.sessionId, binding.lastMessageId);
      }
    } finally { await handle.close(); }
    return service;
  }

  private target(id: string): { source?: ObservedCodexQueueTarget; binding?: Binding } {
    if (!validId(id)) throw new Error('Choose an observed Codex session.');
    const source = this.options.target(id);
    if (!source || typeof source.threadId !== 'string' || source.threadId.length !== 36 || !UUID.test(source.threadId) || !validHome(source.codexHome)
      || typeof source.sourceFingerprint !== 'string' || !source.sourceFingerprint || source.sourceFingerprint.length > 16_384) return {};
    const binding = { sessionId: id, threadId: source.threadId, codexHome: source.codexHome,
      sourceFingerprint: createHash('sha256').update(source.sourceFingerprint).digest('hex') };
    return { source, binding };
  }
  private generation(id: string) { return this.generations.get(id) ?? 0; }
  private seal(id: string) {
    this.generations.set(id, this.generation(id) + 1);
    const operation = this.work.get(id);
    // An interrupted submission may already be durable. Seal uncertainty before awaiting it.
    if (operation?.submitted && same(this.bindings.get(id), operation.submitted)) {
      this.delivery.set(id, 'unknown');
      this.messageIds.delete(id);
      const binding = this.bindings.get(id)!;
      if (binding.lastDelivery !== 'unknown') {
        this.bindings.set(id, { ...operation.submitted, lastDelivery: 'unknown' });
        // Queue a compensating record if revocation races a confirmed-receipt write.
        void this.persist().catch(() => undefined);
      }
    }
    operation?.abort.abort();
  }
  private persist(): Promise<void> {
    const pending = this.writes.then(async () => {
      await writeJsonAtomic(this.file, { version: 2, bindings: [...this.bindings.values()] }, { mode: 0o600 });
    });
    this.writes = pending.catch(() => { this.persistenceFailed = true; });
    return pending;
  }
  private async binary(): Promise<string | undefined> {
    return findExecutable('codex', { env: this.options.env, platform: process.platform, homeDirectory: this.options.homeDirectory,
      override: environmentValue(this.options.env, 'EXTALIA_CODEX_BIN', process.platform) });
  }
  private reason(id: string, source: ObservedCodexQueueTarget | undefined, binding: Binding | undefined): string | undefined {
    if (this.closed) return 'The Extalia host is closed.';
    if (this.persistenceFailed) return 'Codex queue setup could not be saved. Queue submission is disabled.';
    if (this.cleanupFailures.has(id)) return 'Codex queue child cleanup is unconfirmed. Queue submission is disabled.';
    if (!source || !binding) return 'Only a verified observed Codex source can use queue submission.';
    if (!source.watching || this.blocked.has(id)) return 'Resume observation before queueing a Codex message.';
    if (this.bindings.has(id) && !same(this.bindings.get(id), binding)) return 'The observed Codex source changed. Enable queue submission for this source again.';
    if (!this.bindings.has(id)) return 'Enable queue submission for this observed Codex source first.';
    if (this.delivery.get(id) === 'unknown') return UNKNOWN;
    return undefined;
  }

  async status(id: string): Promise<ObservedCodexQueueStatus> {
    let { source, binding } = this.target(id);
    const operation = this.work.get(id);
    if (operation && (!source?.watching || !same(this.bindings.get(id), binding))) this.seal(id);
    let problem = this.reason(id, source, binding);
    const binaryAvailable = source?.watching && binding && !this.closed ? Boolean(await this.binary()) : false;
    if (!problem && !binaryAvailable) problem = 'Codex CLI with queue support was not found.';
    // Discovery is read-only but can yield while pause, shutdown or source replacement occurs.
    ({ source, binding } = this.target(id));
    if (operation && (!source?.watching || !same(this.bindings.get(id), binding))) this.seal(id);
    problem = this.reason(id, source, binding) ?? problem;
    const busy = this.work.has(id);
    return { sessionId: id, ...(binding ? { threadId: binding.threadId } : {}), enabled: same(this.bindings.get(id), binding),
      canEnable: binaryAvailable && !!source?.watching && !!binding && !this.closed && !this.persistenceFailed && !this.cleanupFailures.has(id)
        && !this.blocked.has(id) && !busy && (!this.bindings.has(id) || same(this.bindings.get(id), binding)) && this.delivery.get(id) !== 'unknown',
      canQueue: !problem && !busy, ...(busy ? { busy: true } : {}),
      ...(same(this.bindings.get(id), binding) && this.delivery.has(id) ? { delivery: this.delivery.get(id) } : {}),
      ...(same(this.bindings.get(id), binding) && this.delivery.get(id) === 'queued' && this.messageIds.has(id) ? { messageId: this.messageIds.get(id) } : {}),
      ...(problem ? { problem } : {}) };
  }

  private run(id: string, action: (operation: Operation) => Promise<void>): Promise<void> {
    this.target(id);
    if (this.closed) return Promise.reject(new Error('The Extalia host is closed.'));
    if (this.work.has(id)) return Promise.reject(new Error('Wait for the current Codex queue operation to finish.'));
    const operation: Operation = { generation: this.generation(id), abort: new AbortController(), done: Promise.resolve() };
    operation.done = Promise.resolve().then(() => action(operation));
    this.work.set(id, operation);
    void operation.done.finally(() => { if (this.work.get(id) === operation) this.work.delete(id); }).catch(() => undefined);
    return operation.done;
  }
  private current(id: string, operation: Operation, binding: Binding): boolean {
    const target = this.target(id);
    return !this.closed && !this.blocked.has(id) && !operation.abort.signal.aborted && operation.generation === this.generation(id)
      && !!target.source?.watching && same(target.binding, binding) && same(this.bindings.get(id), binding);
  }

  setEnabled(id: string, enabled: boolean): Promise<ObservedCodexQueueStatus> {
    this.target(id);
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('Choose whether Codex queue submission is enabled.'));
    if (this.closed) return Promise.reject(new Error('The Extalia host is closed.'));
    if (!enabled) {
      this.seal(id);
      this.bindings.delete(id);
      this.delivery.delete(id);
      this.messageIds.delete(id);
      const pending = this.persist();
      return Promise.all([pending, this.work.get(id)?.done.catch(() => undefined)]).then(() => this.status(id));
    }
    return this.run(id, async operation => {
      const { source, binding } = this.target(id);
      if (!source?.watching || !binding || this.blocked.has(id)) throw new Error('Choose a verified watched Codex source.');
      if (operation.generation !== this.generation(id) || this.closed) throw new Error('The observed source changed.');
      if (this.persistenceFailed || this.cleanupFailures.has(id)) throw new Error('Codex queue setup or cleanup is unconfirmed.');
      if (!this.bindings.has(id) && this.bindings.size >= MAX_BINDINGS) throw new Error('The Codex queue setup limit has been reached. Disable another source first.');
      this.bindings.set(id, binding);
      this.delivery.delete(id);
      this.messageIds.delete(id);
      await this.persist();
      if (!this.current(id, operation, binding)) throw new Error('The observed source changed. Enable queue submission again.');
    }).then(() => this.status(id));
  }

  send(id: string, input: ObservedCodexQueueMessageInput): Promise<ObservedCodexQueueStatus> {
    return this.run(id, async operation => {
      if (typeof input?.text !== 'string' || !input.text.trim() || input.text.length > 16_000 || input.text.includes('\0')) throw new Error('Codex queue text must contain 1–16000 characters without null bytes.');
      const { source, binding } = this.target(id);
      const problem = this.reason(id, source, binding);
      if (problem || !binding) throw new Error(problem ?? 'The observed Codex source changed.');
      const bin = await this.binary();
      if (!bin) throw new Error('Codex CLI with queue support was not found.');
      if (!this.current(id, operation, binding)) throw new Error('The observed Codex source changed before submission.');
      // Write-ahead metadata contains no text. A crash from this point cannot silently permit a retry.
      this.bindings.set(id, { ...binding, lastDelivery: 'unknown' });
      this.delivery.set(id, 'unknown');
      this.messageIds.delete(id);
      await this.persist();
      if (!this.current(id, operation, binding)) throw new Error('The observed Codex source changed before submission.');
      operation.submitted = binding;
      try {
        const receipt = await (this.options.queue ?? queueCodexMessage)({ bin, env: { ...this.options.env, CODEX_HOME: binding.codexHome }, threadId: binding.threadId, text: input.text, signal: operation.abort.signal });
        if (this.current(id, operation, binding) && receipt.state === 'queued'
          && (receipt.messageId === undefined || receipt.messageId.length === 36 && UUID.test(receipt.messageId))) {
          this.bindings.set(id, { ...binding, lastDelivery: 'queued', ...(receipt.messageId ? { lastMessageId: receipt.messageId } : {}) });
          await this.persist();
          if (this.current(id, operation, binding)) {
            this.delivery.set(id, 'queued');
            if (receipt.messageId) this.messageIds.set(id, receipt.messageId);
          }
        }
      } catch (error) {
        if ((error as { cleanupUnconfirmed?: unknown } | null)?.cleanupUnconfirmed === true) this.cleanupFailures.add(id);
        if (this.current(id, operation, binding)) {
          this.bindings.set(id, { ...binding, lastDelivery: 'unknown' });
          this.delivery.set(id, 'unknown');
          this.messageIds.delete(id);
        }
      }
    }).then(() => this.status(id));
  }

  /** Pause/delete closes admission synchronously, then drains the exact admitted operation. */
  async drop(id: string): Promise<void> {
    this.blocked.add(id);
    this.seal(id);
    await this.work.get(id)?.done.catch(() => undefined);
    await this.writes;
    if (this.cleanupFailures.has(id)) throw new Error('Codex queue child cleanup is unconfirmed.');
  }
  resume(id: string): void { this.blocked.delete(id); }
  async close(): Promise<void> {
    this.closed = true;
    for (const id of this.work.keys()) this.seal(id);
    await Promise.allSettled([...this.work.values()].map(operation => operation.done));
    await this.writes;
    if (this.cleanupFailures.size || this.persistenceFailed) throw new Error('Codex queue cleanup or setup persistence is unconfirmed.');
  }
}
