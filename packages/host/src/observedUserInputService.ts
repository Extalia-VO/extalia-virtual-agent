import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { CodexUserInputEvidence } from '@extalia/importers';
import type { ObservedCodexStatus, ObservedUserInputAnswer, ObservedUserInputRequest, ObservedUserInputStatus } from '@extalia/platform';
import type { ObservedCodexService } from './observedCodexService.js';
import type { ObservedCodexQueueService, ObservedCodexQueueTarget } from './observedCodexQueueService.js';
import { isNotFound, writeJsonAtomic } from './jsonStore.js';

interface Options {
  dataDirectory: string;
  target(id: string): ObservedCodexQueueTarget | undefined;
  evidence(id: string): CodexUserInputEvidence | undefined;
  labelsOnly(): boolean;
  native: Pick<ObservedCodexService, 'status' | 'answer'>;
  queue: Pick<ObservedCodexQueueService, 'status' | 'setEnabled' | 'send'>;
}
interface Receipt { id: string; state: 'queued' | 'unknown' }
interface Entry { request: ObservedUserInputRequest; callId?: string; nativeId?: string; connectionId?: string }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0');
const binding = (value: ObservedCodexQueueTarget | undefined) => value && hash([value.threadId, value.codexHome, value.sourceFingerprint, value.cwd]);

/** Aggregates exact native callbacks and async same-thread messages without claiming source consumption. */
export class ObservedUserInputService {
  private readonly receipts = new Map<string, Receipt['state']>();
  private readonly busy = new Map<string, Promise<unknown>>();
  private writes: Promise<void> = Promise.resolve();
  private failed = false;
  private closed = false;
  private privacy = 0;
  private readonly generations = new Map<string, number>();
  private generation(id: string): string { return `${this.privacy}:${this.generations.get(id) ?? 0}`; }
  private readonly blocked = new Set<string>();
  private readonly file: string;
  private constructor(private readonly options: Options) { this.file = path.join(options.dataDirectory, 'state', 'observed-user-input.json'); }
  static async create(options: Options): Promise<ObservedUserInputService> {
    const service = new ObservedUserInputService(options);
    let handle;
    try { handle = await open(service.file, 'r'); } catch (error) { if (!isNotFound(error)) service.failed = true; return service; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid observed input receipts.');
      const bytes = Buffer.alloc(1024 * 1024 + 1);
      const read = await handle.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > 1024 * 1024) throw new Error('Invalid observed input receipts.');
      const value = JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8')) as { version: unknown; receipts: Receipt[] };
      if (value.version !== 1 || !Array.isArray(value.receipts) || value.receipts.length > 4096) throw new Error('Invalid observed input receipts.');
      for (const item of value.receipts) {
        if (!item || !/^[a-f0-9]{64}$/.test(item.id) || !['queued', 'unknown'].includes(item.state) || service.receipts.has(item.id)) throw new Error('Invalid observed input receipt.');
        service.receipts.set(item.id, item.state);
      }
    } catch { service.failed = true; }
    finally { await handle.close().catch(() => { service.failed = true; }); }
    return service;
  }
  private persist(): Promise<void> {
    const pending = this.writes.then(() => writeJsonAtomic(this.file, { version: 1, receipts: [...this.receipts].map(([id, state]) => ({ id, state })) }, { mode: 0o600 }));
    this.writes = pending.catch(() => { this.failed = true; });
    return pending;
  }
  private active(id: string, privacy: string): boolean {
    return !this.closed && !this.blocked.has(id) && !this.options.labelsOnly() && this.generation(id) === privacy;
  }
  private current(id: string, key: string | undefined, privacy: string): boolean {
    return this.active(id, privacy) && this.options.target(id)?.watching === true && binding(this.options.target(id)) === key;
  }
  private nativeBinding(id: string, native: ObservedCodexStatus): string | undefined {
    return native.sessionId === id && native.state === 'connected' && text(native.connectionId, 200) && text(native.threadId, 200)
      ? hash([id, native.threadId, native.connectionId]) : undefined;
  }
  private entries(id: string, key: string | undefined, native: ObservedCodexStatus, answering = false): Entry[] {
    const entries: Entry[] = [];
    const nativeKey = this.nativeBinding(id, native);
    for (const item of nativeKey ? native.requests.slice(0, 128) : []) {
      if (!item.questions.length || item.questions.length > 10) continue;
      const questions = item.questions.map(question => ({ id: question.id, title: question.question, options: question.options.map(option => option.label), optionDescriptions: question.options.map(option => option.description), allowOther: question.isOther || question.options.length === 0, isSecret: question.isSecret }));
      const requestId = hash([nativeKey, 'native', item.id, item.turnId, item.itemId]);
      entries.push({ nativeId: item.id, connectionId: native.connectionId, request: { id: requestId, revision: hash([requestId, questions, this.generation(id)]), origin: 'codex-native', identityVerified: true, state: item.state, questions,
        canAnswer: native.canAnswer && item.state === 'pending' && (answering || !this.busy.has(id)) } });
    }
    if (!key) return entries;
    const evidence = this.options.evidence(id);
    for (const item of evidence?.requests.slice(0, 128) ?? []) {
      const unresolved = item.questions.map((question, index) => ({ question, index })).filter(({ question, index }) =>
        !evidence?.replies.some(reply => reply.questionItemId === JSON.stringify(['request_user_input_async', item.callId, index]) && reply.question === question.title));
      if (!unresolved.length) continue;
      const requestId = hash([key, 'async', item.callId, item.questions]);
      const questions = unresolved.map(({ question, index }) => ({ id: hash([requestId, index]), title: question.title, options: question.options, allowOther: true, isSecret: false }));
      const state = this.receipts.get(requestId) ?? 'pending';
      entries.push({ callId: item.callId, request: { id: requestId, revision: hash([requestId, questions, this.generation(id), item.canAnswer, item.conflicted]), origin: 'codex-async', identityVerified: item.canAnswer && !item.conflicted, state, questions,
        canAnswer: item.canAnswer && state === 'pending' && !this.failed && (answering || !this.busy.has(id)), ...(item.askedAt ? { askedAt: item.askedAt } : {}) } });
    }
    return entries;
  }
  async status(id: string): Promise<ObservedUserInputStatus> {
    if (!text(id, 200)) throw new Error('Choose an observed session.');
    const unavailable = (state: 'private' | 'unavailable' = 'unavailable'): ObservedUserInputStatus => ({ sessionId: id, state, requests: [] });
    if (this.options.labelsOnly()) return unavailable('private');
    const key = binding(this.options.target(id)), privacy = this.generation(id);
    if (!this.active(id, privacy)) return unavailable();
    let native = await this.options.native.status(id);
    if (!this.active(id, privacy)) return unavailable(this.options.labelsOnly() ? 'private' : 'unavailable');
    const queue = key && this.current(id, key, privacy)
      ? await this.options.queue.status(id).catch(() => ({ sessionId: id, enabled: false, canEnable: false, canQueue: false, busy: false, delivery: undefined }))
      : undefined;
    if (queue) native = await this.options.native.status(id);
    if (!this.active(id, privacy)) return unavailable(this.options.labelsOnly() ? 'private' : 'unavailable');
    const asyncKey = key && this.current(id, key, privacy) ? key : undefined;
    if (!asyncKey && !this.nativeBinding(id, native)) return unavailable();
    const requests = this.entries(id, asyncKey, native).map(entry => ({ ...entry.request,
      canAnswer: entry.request.canAnswer && (entry.request.origin === 'codex-native' || queue !== undefined && (queue.enabled ? queue.canQueue : queue.canEnable === true) && queue.delivery !== 'unknown' && !queue.busy),
    }));
    const priority = { pending: 0, unknown: 1, queued: 2, submitted: 3 };
    requests.reverse(); // Source order is authoritative when older rollouts omit timestamps.
    requests.sort((left, right) => priority[left.state] - priority[right.state] || Number(right.canAnswer) - Number(left.canAnswer) || Number(left.origin === 'codex-async') - Number(right.origin === 'codex-async') || (right.askedAt ?? '').localeCompare(left.askedAt ?? ''));
    return { sessionId: id, state: 'ready', requests: requests.slice(0, 32) };
  }
  answer(id: string, input: ObservedUserInputAnswer): Promise<ObservedUserInputStatus> {
    if (this.busy.has(id)) return Promise.reject(new Error('An answer is already being submitted.'));
    // Reserve synchronously before the first await; readers expose the same in-flight state.
    const work = Promise.resolve().then(() => this.submit(id, input));
    this.busy.set(id, work);
    return work.finally(() => { if (this.busy.get(id) === work) this.busy.delete(id); }).then(() => this.status(id));
  }
  private async submit(id: string, input: ObservedUserInputAnswer): Promise<void> {
    const key = binding(this.options.target(id)), privacy = this.generation(id);
    if (!this.active(id, privacy)) throw new Error('This observed input is unavailable.');
    const native = await this.options.native.status(id);
    if (!this.active(id, privacy)) throw new Error('The observed source changed.');
    const entry = this.entries(id, key && this.current(id, key, privacy) ? key : undefined, native, true).find(entry => entry.request.id === input?.requestId);
    if (!entry || entry.request.revision !== input?.revision || entry.request.state !== 'pending' || !entry.request.canAnswer
      || (entry.nativeId ? !native.canAnswer : !this.options.evidence(id)?.requests.find(item => item.callId === entry.callId)?.canAnswer)) throw new Error('This input request changed or was already answered.');
    if (!input.answers || typeof input.answers !== 'object' || Array.isArray(input.answers) || Object.keys(input.answers).length !== entry.request.questions.length) throw new Error('Answer each question exactly once.');
    for (const question of entry.request.questions) {
      const answer = input.answers[question.id];
      if (!Object.hasOwn(input.answers, question.id) || !text(answer, 4000) || !question.allowOther && !question.options.includes(answer)) throw new Error('Enter a valid answer for each question.');
    }
    if (entry.nativeId && entry.connectionId) {
      await this.options.native.answer(id, { connectionId: entry.connectionId, requestId: entry.nativeId, answers: input.answers });
      return;
    }
    if (!key || !this.current(id, key, privacy)) throw new Error('This observed input is unavailable.');
    const asyncCurrent = () => !this.failed && this.current(id, key, privacy);
    if (!asyncCurrent()) throw new Error('Observed input receipts are unavailable.');
    if (this.receipts.size >= 4096) throw new Error('The observed input receipt limit has been reached.');
    const sourceRequest = this.options.evidence(id)?.requests.find(item => item.callId === entry.callId);
    if (!sourceRequest) throw new Error('The source input is unavailable.');
    const answers = sourceRequest.questions.flatMap((question, index) => {
      const answer = input.answers[hash([entry.request.id, index])];
      return answer === undefined ? [] : [{ questionItemId: JSON.stringify(['request_user_input_async', entry.callId, index]), question: question.title, answer }];
    });
    const message = `<send_user_message_question_reply>${JSON.stringify(answers)}</send_user_message_question_reply>`;
    if (message.length > 16_000 || Buffer.byteLength(message, 'utf8') > 16 * 1024) throw new Error('The combined answer is too long.');
    let queue = await this.options.queue.status(id);
    if (!asyncCurrent() || queue.delivery === 'unknown' || queue.busy || (!queue.enabled && queue.canEnable !== true)) throw new Error('Codex queue delivery is unavailable or uncertain.');
    if (!queue.enabled) queue = await this.options.queue.setEnabled(id, true);
    if (!queue.canQueue || !asyncCurrent()) throw new Error('Codex queue delivery is unavailable.');
    const refreshed = this.entries(id, key, await this.options.native.status(id), true).find(item => item.request.id === entry.request.id);
    if (!refreshed || refreshed.request.revision !== input.revision || refreshed.request.state !== 'pending' || !refreshed.request.canAnswer || !asyncCurrent()) throw new Error('The source input changed.');
    // Contains no prompt, question, answer, thread id or path. Crash/restart never silently enables a retry.
    this.receipts.set(entry.request.id, 'unknown');
    await this.persist();
    const admitted = this.entries(id, key, native, true).find(item => item.request.id === entry.request.id);
    if (!asyncCurrent() || admitted?.request.revision !== input.revision) throw new Error('The observed input changed before submission.');
    try {
      const receipt = await this.options.queue.send(id, { text: message });
      if (asyncCurrent() && receipt.delivery === 'queued') { this.receipts.set(entry.request.id, 'queued'); await this.persist(); }
    } catch { /* Delivery may have happened. The write-ahead unknown receipt remains authoritative. */ }
  }
  invalidatePrivacy(): void { ++this.privacy; }
  async drop(id: string): Promise<void> { this.blocked.add(id); this.generations.set(id, (this.generations.get(id) ?? 0) + 1); await this.busy.get(id)?.catch(() => undefined); }
  resume(id: string): void { this.blocked.delete(id); }
  async close(): Promise<void> { this.closed = true; ++this.privacy; await Promise.allSettled(this.busy.values()); await this.writes; }
}
