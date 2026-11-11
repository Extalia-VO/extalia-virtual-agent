import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import type { PromptQueueChange, PromptQueueItem, PromptQueueStatus } from '@extalia/platform';
import { isNotFound, writeJsonAtomic } from './jsonStore.js';

export interface PromptQueueTarget {
  identity: string; available: boolean; ready: boolean; maxTextLength: number; persist: boolean;
  /** Exact prior identities verified by the host as the same source and grants. At most four. */
  compatibleIdentities?: readonly string[];
  /** Captured from an actual live invocation, never a lookup of a later run at send time. */
  steering?: { identity: string; send(text: string): Promise<'sent' | 'unknown'> };
}
interface Options {
  dataDirectory: string;
  target(id: string): Promise<PromptQueueTarget | undefined>;
  dispatch(id: string, text: string): Promise<'sent' | 'unknown'>;
  /** A reserved dispatch settled; the caller can recheck its other host lifetimes. */
  onIdle?(): void;
  persist?<T>(write: () => Promise<T>): Promise<T>;
  drainTimeoutMs?: number;
  /** Zero disables periodic readiness checks, useful when the caller supplies every wake. */
  pollIntervalMs?: number;
}
interface Queue { sessionId: string; identity: string; revision: string; paused: boolean; persist: boolean; items: PromptQueueItem[] }
interface Operation { done: Promise<void>; generation: number; retired: boolean; handed: boolean; itemId?: string }
const MAX_QUEUES = 128, MAX_PENDING = 50, MAX_RECEIPTS = 20, MAX_TEXT = 100_000, MAX_COMPATIBLE_IDENTITIES = 4;
// JSON escaping can require six bytes for one text code unit.
const MAX_CHARACTERS = 8_000_000, MAX_FILE_BYTES = 64 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const receipt = (item: PromptQueueItem) => item.state === 'sent' || item.state === 'unknown';
const emptyRevision = (id: string, identity: string) => createHash('sha256').update(JSON.stringify([id, identity])).digest('hex');
function trimReceipts(queue: Queue) {
  while (queue.items.filter(receipt).length > MAX_RECEIPTS) {
    const index = queue.items.findIndex(item => item.state === 'sent');
    if (index < 0) break;
    queue.items.splice(index, 1);
  }
}

/** Pending prompts stay host-owned. A handoff receipt never cancels or edits a source turn. */
export class PromptQueues {
  private readonly queues = new Map<string, Queue>();
  private readonly generations = new Map<string, number>();
  private readonly blocked = new Set<string>();
  private readonly work = new Map<string, Operation>();
  private mutations: Promise<void> = Promise.resolve();
  private closing = false;
  private sealed = false;
  private failed = false;
  private closingPromise?: Promise<void>;
  private poll?: ReturnType<typeof setInterval>;
  private readonly file: string;
  private readonly drainMs: number;

  private constructor(private readonly options: Options) {
    this.file = path.join(options.dataDirectory, 'state', 'prompt-queues.json');
    this.drainMs = Math.max(1, Math.min(options.drainTimeoutMs ?? 5_000, 5_000));
  }

  static async create(options: Options): Promise<PromptQueues> {
    const queues = new PromptQueues(options);
    try {
      const info = await lstat(queues.file);
      const uid = process.platform === 'win32' ? undefined : process.getuid?.();
      if (!info.isFile() || info.size > MAX_FILE_BYTES || uid !== undefined && (info.uid !== uid || (info.mode & 0o077) !== 0)) throw new Error();
      const handle = await open(queues.file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
      let bytes: Buffer;
      try {
        const current = await handle.stat();
        if (current.dev !== info.dev || current.ino !== info.ino || !current.isFile() || current.size > MAX_FILE_BYTES
          || uid !== undefined && (current.uid !== uid || (current.mode & 0o077) !== 0)) throw new Error();
        const chunks: Buffer[] = []; let size = 0;
        for (;;) {
          const chunk = Buffer.alloc(64 * 1024), read = await handle.read(chunk);
          if (!read.bytesRead) break;
          size += read.bytesRead; if (size > MAX_FILE_BYTES) throw new Error();
          chunks.push(chunk.subarray(0, read.bytesRead));
        }
        bytes = Buffer.concat(chunks, size);
      } finally { await handle.close(); }
      const raw = JSON.parse(bytes.toString('utf8')) as { version?: unknown; queues?: unknown };
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 2 || raw.version !== 1 || !Array.isArray(raw.queues) || raw.queues.length > MAX_QUEUES) throw new Error();
      let characters = 0;
      for (const rawQueue of raw.queues) {
        if (!rawQueue || typeof rawQueue !== 'object' || Array.isArray(rawQueue)) throw new Error();
        const queue = rawQueue as Queue;
        if (Object.keys(queue).sort().join(',') !== 'identity,items,paused,revision,sessionId' || !string(queue.sessionId, 200) || !string(queue.identity, 4096)
          || !UUID.test(queue.revision) || typeof queue.paused !== 'boolean' || !Array.isArray(queue.items) || queue.items.length > MAX_PENDING + MAX_RECEIPTS + 1 || queues.queues.has(queue.sessionId)) throw new Error();
        const ids = new Set<string>();
        for (const item of queue.items) {
          if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'createdAt,id,state,text' || !UUID.test(item.id) || ids.has(item.id)
            || !string(item.text, MAX_TEXT) || !item.text.trim() || !['pending', 'sending', 'sent', 'unknown'].includes(item.state)
            || !string(item.createdAt, 40) || !Number.isFinite(Date.parse(item.createdAt))) throw new Error();
          ids.add(item.id); characters += item.text.length;
        }
        if (queue.items.filter(item => item.state === 'pending').length > MAX_PENDING || queue.items.filter(item => item.state === 'sending').length > 1
          || queue.items.filter(receipt).length > MAX_RECEIPTS || queue.items.some(item => item.state === 'sending') && queue.items.some(item => item.state === 'unknown')
          || characters > MAX_CHARACTERS) throw new Error();
        for (const item of queue.items) if (item.state === 'sending') item.state = 'unknown';
        queue.paused = true; queue.persist = true; queue.revision = randomUUID(); trimReceipts(queue);
        queues.queues.set(queue.sessionId, queue);
      }
      await queues.save();
    } catch (error) { if (!isNotFound(error)) { queues.failed = true; queues.queues.clear(); } }
    const interval = options.pollIntervalMs ?? 500;
    if (interval > 0) { queues.poll = setInterval(() => queues.wake(), Math.max(10, interval)); queues.poll.unref(); }
    return queues;
  }

  private serial<T>(action: () => Promise<T>, internal = false): Promise<T> {
    const result = this.mutations.then(() => {
      if (!internal && (this.closing || this.failed)) throw new Error('Prompt queue is unavailable or the host is closing.');
      return action();
    });
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }
  private generation(id: string) { return this.generations.get(id) ?? 0; }
  private revoke(id: string) { this.generations.set(id, this.generation(id) + 1); }
  private touch(queue: Queue) { queue.revision = randomUUID(); }
  private async target(id: string): Promise<PromptQueueTarget | undefined> {
    if (!string(id, 200) || this.blocked.has(id)) return undefined;
    try {
      const target = await this.options.target(id);
      return target && string(target.identity, 4096) && typeof target.available === 'boolean' && typeof target.ready === 'boolean'
        && (target.compatibleIdentities === undefined || Array.isArray(target.compatibleIdentities)
          && target.compatibleIdentities.length <= MAX_COMPATIBLE_IDENTITIES && target.compatibleIdentities.every(identity => string(identity, 4096)))
        && typeof target.persist === 'boolean' && Number.isInteger(target.maxTextLength) && target.maxTextLength > 0 && target.maxTextLength <= MAX_TEXT ? target : undefined;
    } catch { return undefined; }
  }
  private async save() {
    if (this.failed || this.sealed) throw new Error('Prompt queue persistence is unavailable.');
    const value = { version: 1, queues: [...this.queues.values()].filter(queue => queue.persist && queue.items.length).map(({ persist: _persist, ...queue }) => structuredClone(queue)) };
    try { await (this.options.persist ? this.options.persist(() => writeJsonAtomic(this.file, value, { mode: 0o600 })) : writeJsonAtomic(this.file, value, { mode: 0o600 })); }
    catch { this.failed = true; for (const queue of this.queues.values()) queue.paused = true; throw new Error('Could not save the prompt queue. Automatic dispatch is disabled.'); }
  }
  private async inspect(id: string, create = false) {
    const target = await this.target(id);
    let queue = this.queues.get(id);
    if (queue && !queue.items.length && target && queue.identity !== target.identity) { this.queues.delete(id); this.revoke(id); queue = undefined; }
    if (!queue && create && target) {
      queue = { sessionId: id, identity: target.identity, revision: emptyRevision(id, target.identity), paused: true, persist: target.persist, items: [] };
    }
    let changed = false;
    if (queue && target?.available && queue.identity !== target.identity && target.compatibleIdentities?.includes(queue.identity)
      && !queue.items.some(item => item.state === 'sending' || item.state === 'unknown')) {
      queue.identity = target.identity; this.revoke(id); changed = true;
    }
    const matched = !!queue && !!target && queue.identity === target.identity;
    if (queue && (!matched || !target?.available) && !queue.paused) { queue.paused = true; this.revoke(id); changed = true; }
    if (queue?.persist && matched && !target!.persist) { queue.persist = false; changed = true; }
    if (queue && changed) { this.touch(queue); await this.save(); }
    return { queue, target, matched };
  }
  private view(id: string, queue?: Queue, target?: PromptQueueTarget, matched = false): PromptQueueStatus {
    const supported = !this.closing && !this.failed && !!target?.available && matched;
    return { sessionId: id, revision: queue?.revision ?? '', supported, paused: queue?.paused ?? true,
      canSteer: supported && !!target?.steering && !queue?.items.some(item => item.state === 'sending' || item.state === 'unknown'),
      maxTextLength: target?.maxTextLength ?? MAX_TEXT, items: queue ? structuredClone(queue.items) : [],
      ...(!supported ? { problem: this.failed ? 'Saved prompt queue is unavailable. Inspect its metadata before continuing.' : 'The original session or source is unavailable. Pending prompts have not been retargeted.' } : {}) };
  }
  status(id: string): Promise<PromptQueueStatus> {
    return this.serial(async () => { const { queue, target, matched } = await this.inspect(id, true); return this.view(id, queue, target, matched); });
  }

  change(id: string, input: PromptQueueChange): Promise<PromptQueueStatus> {
    if (input?.action === 'steer') return this.steer(id, input);
    const generation = this.generation(id);
    return this.serial(async () => {
      const { queue, target, matched } = await this.inspect(id, true);
      const localRemoval = input?.action === 'delete' || input?.action === 'acknowledge';
      if (!queue || !localRemoval && (!target?.available || !matched)) throw new Error('The original queue source is unavailable.');
      if (!input || input.revision !== queue.revision) throw new Error('The prompt queue changed. Refresh before editing it.');
      const pending = queue.items.filter(item => item.state === 'pending');
      if (input.action === 'add' || input.action === 'edit') {
        if (input.action === 'add' && input.start !== undefined && typeof input.start !== 'boolean') throw new Error('Choose whether to start the queue.');
        if (input.action === 'add' && input.start) {
          if (generation !== this.generation(id)) throw new Error('The queue was suspended. Refresh before starting it.');
          if (queue.items.some(item => item.state === 'unknown' || item.state === 'sending')) throw new Error('Inspect and acknowledge the unknown receipt, or wait for sending, before starting.');
        }
        if (!string(input.text, target!.maxTextLength) || !input.text.trim()) throw new Error(`Write 1–${target!.maxTextLength} characters without null bytes.`);
        const item = input.action === 'edit' ? queue.items.find(item => item.id === input.itemId && item.state === 'pending') : undefined;
        if (input.action === 'edit' && !item) throw new Error('Only pending prompts can be edited.');
        if (input.action === 'add' && pending.length >= MAX_PENDING) throw new Error('This queue already has 50 pending prompts.');
        if (input.action === 'add' && !queue.items.length && [...this.queues.values()].filter(queue => queue.items.length).length >= MAX_QUEUES) throw new Error('The prompt queue limit has been reached.');
        const characters = [...this.queues.values()].reduce((total, queue) => total + queue.items.reduce((total, item) => total + item.text.length, 0), 0);
        if (characters - (item?.text.length ?? 0) + input.text.length > MAX_CHARACTERS) throw new Error('The total pending prompt storage limit has been reached.');
        if (item) item.text = input.text;
        else queue.items.push({ id: randomUUID(), text: input.text, state: 'pending', createdAt: new Date().toISOString() });
        if (input.action === 'add' && input.start) { queue.paused = false; this.revoke(id); }
      } else if (input.action === 'delete' || input.action === 'acknowledge') {
        const index = queue.items.findIndex(item => item.id === input.itemId && (input.action === 'delete' ? item.state === 'pending' : receipt(item)));
        if (index < 0) throw new Error(input.action === 'delete' ? 'Only pending prompts can be deleted.' : 'Only sent or unknown local receipts can be acknowledged.');
        queue.items.splice(index, 1);
      } else if (input.action === 'reorder') {
        if (!Array.isArray(input.itemIds) || input.itemIds.length !== pending.length || new Set(input.itemIds).size !== pending.length || input.itemIds.some(itemId => !pending.some(item => item.id === itemId))) throw new Error('Reordering requires every current pending prompt exactly once.');
        const ordered = input.itemIds.map(itemId => pending.find(item => item.id === itemId)!);
        let index = 0; queue.items = queue.items.map(item => item.state === 'pending' ? ordered[index++]! : item);
      } else if (input.action === 'pause') {
        if (typeof input.paused !== 'boolean') throw new Error('Choose whether the queue is paused.');
        if (!input.paused && generation !== this.generation(id)) throw new Error('The queue was suspended. Refresh before starting it.');
        if (!input.paused && queue.items.some(item => item.state === 'unknown' || item.state === 'sending')) throw new Error('Inspect and acknowledge the unknown receipt, or wait for sending, before starting.');
        queue.paused = input.paused; this.revoke(id);
      } else throw new Error('Unknown prompt queue action.');
      this.touch(queue);
      if (queue.items.length || !queue.paused) this.queues.set(id, queue); else this.queues.delete(id);
      await this.save();
      const current = this.queues.get(id);
      const empty = !current && target ? { ...queue, identity: target.identity, paused: true, revision: emptyRevision(id, target.identity), persist: target.persist } : undefined;
      return this.view(id, current ?? empty, target, !!target && (!current || current.identity === target.identity));
    }).then(status => { this.wake(id); return status; });
  }

  wake(id?: string): void {
    if (this.closing || this.failed) return;
    for (const sessionId of id === undefined ? this.queues.keys() : [id]) {
      if (this.work.has(sessionId) || this.blocked.has(sessionId)) continue;
      const operation: Operation = { done: Promise.resolve(), generation: this.generation(sessionId), retired: false, handed: false };
      this.work.set(sessionId, operation);
      operation.done = this.dispatchOne(sessionId, operation).catch(() => undefined).finally(() => {
        if (this.work.get(sessionId) === operation) this.work.delete(sessionId);
        if (operation.itemId !== undefined && !operation.retired && !this.closing && !this.isBusy) {
          try { this.options.onIdle?.(); } catch { /* Detached host observer. */ }
        }
      });
    }
  }
  get isBusy(): boolean { return [...this.work.values()].some(operation => !operation.retired && operation.itemId !== undefined); }
  /** Local admission guard for optional post-task work; never discovers or dispatches a source. */
  hasUnfinished(id: string): boolean { return this.queues.get(id)?.items.some(item => item.state !== 'sent') ?? false; }
  /** Serialize a reviewed session move against enqueue/dispatch; only completed receipts can follow it. */
  withIdleSession<T>(id: string, action: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const queue = this.queues.get(id);
      if (queue?.items.some(item => item.state !== 'sent') || this.work.get(id)?.itemId !== undefined) {
        throw new Error('Finish or remove pending prompts and inspect uncertain deliveries before moving this session.');
      }
      const result = await action();
      if (queue) {
        const target = await this.target(id);
        if (target) { queue.identity = target.identity; queue.paused = true; this.revoke(id); this.touch(queue); await this.save(); }
      }
      return result;
    });
  }
  private async steer(id: string, input: Extract<PromptQueueChange, { action: 'steer' }>): Promise<PromptQueueStatus> {
    const generation = this.generation(id);
    let settle!: () => void;
    const operation: Operation = { done: new Promise<void>(resolve => { settle = resolve; }), generation, retired: false, handed: false };
    try {
      const selected = await this.serial(async () => {
        const { queue, target, matched } = await this.inspect(id, true);
        if (!queue || !matched || !target?.available || !target.steering) throw new Error('This source cannot steer its current turn.');
        if (input.revision !== queue.revision) throw new Error('The prompt queue changed. Refresh before editing it.');
        if (generation !== this.generation(id)) throw new Error('The queue was suspended. Refresh before steering it.');
        if (queue.items.some(item => item.state === 'sending' || item.state === 'unknown')) throw new Error('Inspect and acknowledge the unknown receipt, or wait for sending, before steering.');
        const item = queue.items.find(item => item.id === input.itemId && item.state === 'pending');
        if (!item || item.text.length > target.maxTextLength) throw new Error('Only a bounded pending prompt can steer a turn.');
        const selected = { text: item.text, identity: queue.identity, steering: { ...target.steering } };
        item.state = 'sending'; operation.itemId = item.id; this.work.set(id, operation);
        this.touch(queue); await this.save();
        return selected;
      });
      await this.handoff(id, operation, selected);
      return await this.status(id);
    } finally {
      if (this.work.get(id) === operation) this.work.delete(id);
      settle();
      if (operation.itemId !== undefined && !operation.retired && !this.closing && !this.isBusy) {
        try { this.options.onIdle?.(); } catch { /* Detached host observer. */ }
      }
      this.wake(id);
    }
  }
  private async dispatchOne(id: string, operation: Operation) {
    const selected = await this.serial(async () => {
      const { queue, target, matched } = await this.inspect(id);
      if (operation.retired || !queue || !target?.available || !target.ready || !matched || queue.paused || this.blocked.has(id)
        || operation.generation !== this.generation(id) || queue.items.some(item => item.state === 'sending' || item.state === 'unknown')) return undefined;
      const item = queue.items.find(item => item.state === 'pending');
      if (!item || item.text.length > target.maxTextLength) return undefined;
      item.state = 'sending'; operation.itemId = item.id; this.touch(queue); await this.save();
      return { text: item.text, identity: queue.identity };
    });
    if (!selected) return;
    await this.handoff(id, operation, selected);
  }
  private async handoff(id: string, operation: Operation, selected: { text: string; identity: string; steering?: NonNullable<PromptQueueTarget['steering']> }) {
    const ready = (target?: PromptQueueTarget) => selected.steering ? !!target?.steering && target.steering.identity === selected.steering.identity : !!target?.ready;
    const handed = await this.serial(async () => {
      const { queue, target, matched } = await this.inspect(id);
      const item = queue?.items.find(item => item.id === operation.itemId && item.state === 'sending');
      if (!item || !queue) return false;
      if (operation.retired || this.closing || (!selected.steering && queue.paused) || !target?.available || !ready(target) || !matched || queue.identity !== selected.identity
        || operation.generation !== this.generation(id)) { item.state = 'pending'; this.touch(queue); await this.save(); return false; }
      operation.handed = true;
      return true;
    }, true);
    if (!handed) return;
    // A queued pause/suspend may run between preflight completion and this continuation.
    // Keep this last generation check and the actual callback invocation synchronous.
    const current = this.queues.get(id);
    if (operation.retired || this.closing || this.blocked.has(id) || !current || (!selected.steering && current.paused) || operation.generation !== this.generation(id)) {
      operation.handed = false;
      await this.serial(async () => {
        const queue = this.queues.get(id), item = queue?.items.find(item => item.id === operation.itemId && item.state === 'sending');
        if (queue && item) { item.state = 'pending'; this.touch(queue); await this.save(); }
      }, true);
      return;
    }
    let outcome: 'sent' | 'unknown';
    try { outcome = await (selected.steering ? selected.steering.send(selected.text) : this.options.dispatch(id, selected.text)); } catch { outcome = 'unknown'; }
    if (operation.retired || this.sealed) return;
    await this.serial(async () => {
      if (operation.retired || this.sealed) return;
      const queue = this.queues.get(id), item = queue?.items.find(item => item.id === operation.itemId && item.state === 'sending');
      if (!queue || !item) return;
      item.state = outcome === 'sent' ? 'sent' : 'unknown';
      if (item.state === 'unknown') { queue.paused = true; this.revoke(id); }
      trimReceipts(queue); this.touch(queue); await this.save();
    }, true);
  }

  /** Revokes pre-handoff work immediately while preserving drafts and handed-off receipts. */
  suspend(id: string): Promise<void> {
    this.revoke(id);
    const queue = this.queues.get(id); if (queue) { queue.paused = true; this.touch(queue); }
    return this.serial(async () => { if (this.queues.has(id)) await this.save(); }, true);
  }
  private async drain(operations: Operation[]) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.allSettled(operations.map(operation => operation.done)), new Promise<void>(resolve => { timer = setTimeout(resolve, this.drainMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  async drop(id: string): Promise<void> {
    this.blocked.add(id); this.revoke(id);
    const queue = this.queues.get(id); if (queue) queue.paused = true;
    const operation = this.work.get(id);
    if (operation) { await this.drain([operation]); operation.retired = true; }
    await this.serial(async () => { if (this.queues.delete(id)) await this.save(); }, true);
  }
  close(): Promise<void> {
    return this.closingPromise ??= (async () => {
      this.closing = true; if (this.poll) clearInterval(this.poll);
      for (const [id, queue] of this.queues) { this.revoke(id); queue.paused = true; }
      const operations = [...this.work.values()]; await this.drain(operations);
      for (const operation of operations) operation.retired = true;
      await this.serial(async () => {
        for (const queue of this.queues.values()) {
          queue.paused = true;
          for (const item of queue.items) if (item.state === 'sending') item.state = 'unknown';
          trimReceipts(queue); this.touch(queue);
        }
        if (!this.failed && [...this.queues.values()].some(queue => queue.persist)) await this.save();
      }, true);
      this.sealed = true; await this.mutations;
    })();
  }
}
