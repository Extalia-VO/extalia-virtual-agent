import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { connect as connectSocket } from 'node:net';
import type { HermesObservedAnswerInput, HermesObservedMessageInput, HermesObservedQuestion, HermesObservedStatus } from '@extalia/platform';
import { hermesEnvironment } from './hermes.js';

const MAX_FRAME = 1024 * 1024;
const RPC_TIMEOUT = 10_000;
const MAX_REQUESTS = 32;
const CLEANUP_PROBLEM = 'Hermes connection cleanup could not be confirmed. Control is disabled.';
type Row = Record<string, unknown>;
const row = (value: unknown): Row | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
const text = (value: unknown, max = 16_384): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const protocol = 'hermes-gateway-v1';

export type { HermesObservedAnswerInput, HermesObservedMessageInput, HermesObservedQuestion, HermesObservedStatus } from '@extalia/platform';
export interface HermesObservedRpc {
  request(method: string, params: Row): Promise<unknown>;
  close(): Promise<void>;
  profileId: string;
  instanceId: string;
}
export interface HermesObservedRpcOptions {
  bin: string;
  env?: NodeJS.ProcessEnv;
  profile?: string;
  signal: AbortSignal;
  onMessage(message: unknown): void;
  onClose(): void;
}
export type HermesObservedRpcFactory = (options: HermesObservedRpcOptions) => Promise<HermesObservedRpc>;
export interface HermesObservedControlOptions {
  sessionId: string;
  nativeSessionId: string;
  bin: string;
  env?: NodeJS.ProcessEnv;
  profile?: string;
  cwd?: string;
  onChange?: () => void;
  rpcFactory?: HermesObservedRpcFactory;
}

/** Public discover-only bootstrap. No owner creation, recovery, transcript or profile reads. */
function attach(options: HermesObservedRpcOptions): Promise<Row> {
  if (options.profile && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(options.profile)) return Promise.reject(new Error('Choose a valid Hermes profile.'));
  const args = [...(options.profile ? ['-p', options.profile] : []), 'gateway', 'attach', '--json'];
  return new Promise((resolve, reject) => {
    execFile(options.bin, args, {
      env: hermesEnvironment(options.env ?? process.env), signal: options.signal,
      timeout: RPC_TIMEOUT, maxBuffer: 65_536, killSignal: 'SIGKILL', encoding: 'utf8', windowsHide: true,
    }, (error, stdout) => {
      // Bootstrap output includes a one-use credential. Never propagate stdout/stderr/errors.
      if (error) { reject(new Error('Hermes needs an existing gateway and the public gateway attach command.')); return; }
      try {
        const value = row(JSON.parse(stdout));
        if (!value) throw new Error();
        resolve(value);
      } catch { reject(new Error('Hermes returned an invalid gateway attachment.')); }
    });
  });
}

/** Bounded loopback WebSocket to the existing owner; never starts an agent engine. */
export const createHermesObservedRpc: HermesObservedRpcFactory = async (options) => {
  const attached = await attach(options);
  const endpoint = row(attached.endpoint);
  const profileId = attached.profile_id ?? endpoint?.profile_id;
  const instanceId = attached.instance_id ?? endpoint?.instance_id;
  if (!text(profileId, 4096) || !text(instanceId, 256) || !text(attached.url, 2048) || !Array.isArray(attached.protocols)) throw new Error('Hermes returned an invalid gateway attachment.');
  let url: URL;
  try { url = new URL(attached.url); } catch { throw new Error('Hermes returned an invalid gateway attachment.'); }
  const protocols = attached.protocols;
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.pathname !== '/api/ws' || url.search || url.hash || url.username || url.password ||
      protocols.length !== 2 || protocols[0] !== protocol || typeof protocols[1] !== 'string' || !/^hermes-gateway-ticket\.[A-Za-z0-9._~-]{1,2048}$/.test(protocols[1])) throw new Error('Hermes requires an authenticated loopback gateway.');
  if (options.signal.aborted) throw new Error('Hermes attachment was cancelled.');
  const socket = connectSocket({ host: url.hostname === '[::1]' ? '::1' : url.hostname, port: Number(url.port) });
  const key = randomBytes(16).toString('base64');
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let closed = false, upgraded = false, nextId = 0;
  let buffered: Buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [], fragmentBytes = 0;
  let resolveHandshake!: () => void, rejectHandshake!: (error: Error) => void;
  const handshake = new Promise<void>((resolve, reject) => { resolveHandshake = resolve; rejectHandshake = reject; });
  void handshake.catch(() => undefined);
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const abort = () => finish();
  const finish = () => {
    if (closed) return;
    closed = true; clearTimeout(handshakeTimer); options.signal.removeEventListener('abort', abort);
    socket.destroy(); buffered = Buffer.alloc(0); fragments = []; fragmentBytes = 0;
    rejectHandshake(new Error('Hermes gateway disconnected.'));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Hermes gateway disconnected.')); }
    pending.clear(); options.onClose();
  };
  const handshakeTimer = setTimeout(finish, RPC_TIMEOUT);
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) finish();
  const write = (bytes: Buffer) => {
    if (closed || bytes.length > MAX_FRAME + 14 || socket.writableLength + bytes.length > MAX_FRAME + 14) throw new Error('Hermes transport is unavailable or full.');
    socket.write(bytes);
  };
  const frame = (opcode: number, payload: Buffer) => {
    if (payload.length > MAX_FRAME) throw new Error('Hermes message exceeds the transport limit.');
    const extended = payload.length < 126 ? 0 : payload.length <= 0xffff ? 2 : 8;
    const bytes = Buffer.allocUnsafe(6 + extended + payload.length);
    bytes[0] = 0x80 | opcode; bytes[1] = 0x80 | (extended === 0 ? payload.length : extended === 2 ? 126 : 127);
    if (extended === 2) bytes.writeUInt16BE(payload.length, 2);
    if (extended === 8) bytes.writeBigUInt64BE(BigInt(payload.length), 2);
    const mask = randomBytes(4); mask.copy(bytes, 2 + extended);
    for (let i = 0; i < payload.length; i++) bytes[6 + extended + i] = payload[i]! ^ mask[i % 4]!;
    write(bytes);
  };
  const dispatch = (bytes: Buffer) => {
    const value = row(JSON.parse(decoder.decode(bytes)));
    if (!value || value.jsonrpc !== '2.0') throw new Error();
    if (typeof value.method === 'string') {
      // This canonical client handles generation-bound prompts, not legacy server requests.
      if ('id' in value) {
        if (!text(value.id, 256) && !(typeof value.id === 'number' && Number.isSafeInteger(value.id))) throw new Error();
        frame(1, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'Unsupported request.' } })));
      } else options.onMessage(value);
      return;
    }
    if (typeof value.id !== 'number') return;
    const entry = pending.get(value.id);
    if (!entry) return;
    pending.delete(value.id); clearTimeout(entry.timer);
    if ('error' in value) entry.reject(new Error('Hermes rejected the request.'));
    else if ('result' in value) entry.resolve(value.result);
    else { entry.reject(new Error('Invalid Hermes response.')); throw new Error(); }
  };
  const parse = () => {
    if (!upgraded) {
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) { if (buffered.length > 8192) throw new Error(); return; }
      if (end > 8188) throw new Error();
      const lines = buffered.subarray(0, end).toString('latin1').split('\r\n');
      if (!/^HTTP\/1\.1 101(?: [\x20-\x7e]*)?$/.test(lines.shift() ?? '')) throw new Error();
      const headers = new Map<string, string>();
      for (const line of lines) {
        const match = /^([!#$%&'*+.^_`|~0-9a-zA-Z-]+):[ \t]*([^\r\n]*)$/.exec(line);
        if (!match || /[^\x20-\x7e\t]/.test(match[2]!) || headers.has(match[1]!.toLowerCase())) throw new Error();
        headers.set(match[1]!.toLowerCase(), match[2]!.trim());
      }
      if (headers.get('upgrade')?.toLowerCase() !== 'websocket' || !headers.get('connection')?.toLowerCase().split(',').some(token => token.trim() === 'upgrade') ||
          headers.get('sec-websocket-accept') !== accept || headers.get('sec-websocket-protocol') !== protocol ||
          ['sec-websocket-extensions', 'content-length', 'transfer-encoding'].some(name => headers.has(name))) throw new Error();
      buffered = buffered.subarray(end + 4); upgraded = true; clearTimeout(handshakeTimer); resolveHandshake();
    }
    while (!closed && buffered.length >= 2) {
      const first = buffered[0]!, second = buffered[1]!, opcode = first & 15, fin = (first & 128) !== 0;
      if (first & 0x70 || second & 128 || ![0, 1, 8, 9, 10].includes(opcode)) throw new Error();
      let size = second & 127, header = 2;
      if (size === 126) { if (buffered.length < 4) return; size = buffered.readUInt16BE(2); header = 4; if (size < 126) throw new Error(); }
      else if (size === 127) { if (buffered.length < 10) return; const length = buffered.readBigUInt64BE(2); if (length < 65536n || length > BigInt(MAX_FRAME)) throw new Error(); size = Number(length); header = 10; }
      if (size > MAX_FRAME || opcode >= 8 && (!fin || size > 125)) throw new Error();
      if (buffered.length < header + size) return;
      const payload = buffered.subarray(header, header + size); buffered = buffered.subarray(header + size);
      if (opcode === 9) { frame(10, payload); continue; }
      if (opcode === 10) continue;
      if (opcode === 8) { finish(); return; }
      if (opcode === 1) { if (fragments.length) throw new Error(); if (fin) { dispatch(payload); continue; } }
      else if (!fragments.length) throw new Error();
      if (fragmentBytes + size > MAX_FRAME || fragments.length >= 1024) throw new Error();
      fragments.push(Buffer.from(payload)); fragmentBytes += size;
      if (fin) { const bytes = Buffer.concat(fragments, fragmentBytes); fragments = []; fragmentBytes = 0; dispatch(bytes); }
    }
  };
  socket.once('connect', () => {
    try { write(Buffer.from(`GET /api/ws HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${protocols.join(', ')}\r\n\r\n`)); } catch { finish(); }
  });
  socket.on('data', (chunk: Buffer) => {
    try { for (let offset = 0; offset < chunk.length && !closed; offset += 65536) { buffered = Buffer.concat([buffered, chunk.subarray(offset, offset + 65536)]); parse(); } } catch { finish(); }
  });
  socket.once('error', finish); socket.once('close', finish);
  await handshake;
  return {
    profileId, instanceId,
    request(method, params) {
      if (closed || pending.size >= MAX_REQUESTS) return Promise.reject(new Error('Hermes transport is unavailable or full.'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Hermes request timed out.')); finish(); }, RPC_TIMEOUT);
        pending.set(id, { resolve, reject, timer });
        try { frame(1, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }))); }
        catch { clearTimeout(timer); pending.delete(id); reject(new Error('Hermes transport write failed.')); finish(); }
      });
    },
    async close() { finish(); },
  };
};

/** Ephemeral attachment to one exact live canonical session; no historical adoption or engine. */
export class HermesObservedControl {
  private rpc?: HermesObservedRpc;
  private abort?: AbortController;
  private connected = false;
  private closed = false;
  private busy = false;
  private generation?: number;
  private running = false;
  private connectionId?: string;
  private requests = new Map<string, HermesObservedQuestion>();
  private problem?: string;
  private delivery?: HermesObservedStatus['delivery'];
  private epoch?: number;
  private replayEpoch?: string;
  private sequence = 0;
  private buffering?: unknown[];
  private invalidated = false;
  private connecting?: Promise<HermesObservedStatus>;
  private cleanupFailed = false;
  private readonly closedRpcs = new WeakMap<HermesObservedRpc, Promise<void>>();
  private readonly cleanupWork = new Set<Promise<void>>();

  constructor(private readonly options: HermesObservedControlOptions) {
    if (!text(options.sessionId, 200) || !text(options.nativeSessionId, 256)) throw new Error('Choose an exact observed Hermes session.');
  }
  status(): HermesObservedStatus {
    return {
      sessionId: this.options.sessionId, nativeSessionId: this.options.nativeSessionId,
      state: this.cleanupFailed ? 'unavailable' : this.connected ? 'connected' : this.problem ? 'unavailable' : 'disconnected',
      ...(this.connected ? { connectionId: this.connectionId, executionGeneration: this.generation } : {}),
      running: this.running, canSend: this.connected && !this.busy && !this.cleanupFailed, canAnswer: this.connected && !this.busy && !this.cleanupFailed && this.requests.size > 0,
      requests: this.connected ? [...this.requests.values()].map(request => ({ ...request, choices: [...request.choices] })) : [],
      ...(this.cleanupFailed ? { problem: CLEANUP_PROBLEM } : this.problem ? { problem: this.problem } : {}), ...(this.delivery ? { delivery: this.delivery } : {}),
    };
  }
  private changed() { this.options.onChange?.(); }
  private closeRpc(rpc: HermesObservedRpc): Promise<void> {
    const previous = this.closedRpcs.get(rpc);
    if (previous) return previous;
    let closing: Promise<void>;
    try { closing = Promise.resolve(rpc.close()); } catch { closing = Promise.reject(new Error(CLEANUP_PROBLEM)); }
    const pending = closing.catch(() => {
      this.cleanupFailed = true; this.connected = false; this.connectionId = undefined; this.requests.clear(); this.running = false;
      this.problem = CLEANUP_PROBLEM; this.changed(); throw new Error(CLEANUP_PROBLEM);
    });
    this.closedRpcs.set(rpc, pending); this.cleanupWork.add(pending);
    // Observe background event-stream cleanup immediately and retain its failure independently.
    void pending.then(() => this.cleanupWork.delete(pending), () => this.cleanupWork.delete(pending));
    return pending;
  }
  private lost() {
    this.connected = false; this.invalidated = true; this.connectionId = undefined; this.requests.clear(); this.running = false;
    this.problem = 'Hermes gateway disconnected. Connect again.'; this.changed();
  }
  private question(value: unknown): HermesObservedQuestion {
    const prompt = row(value);
    if (!prompt || !text(prompt.prompt_id, 256) || !integer(prompt.execution_generation) || !['approval', 'clarify'].includes(String(prompt.kind)) ||
        !Array.isArray(prompt.choices) || prompt.choices.length > 64 || prompt.choices.some(choice => typeof choice !== 'string' || choice.length > 4096) ||
        [prompt.command, prompt.description, prompt.question].some(value => value !== undefined && value !== null && (typeof value !== 'string' || value.length > 16_384)) ||
        prompt.multi_select !== undefined && prompt.multi_select !== null && typeof prompt.multi_select !== 'boolean') throw new Error('Hermes returned an invalid native question.');
    const kind = prompt.kind as HermesObservedQuestion['kind'];
    if (kind === 'clarify' && prompt.multi_select === true) throw new Error('This Hermes multi-select question is not supported. Answer it in Hermes.');
    // Permanent approvals edit source-app configuration; this connection has no such setup flow.
    const choices = (prompt.choices as string[]).filter(choice => kind === 'clarify' || ['once', 'session', 'deny'].includes(choice));
    if (kind === 'approval' && choices.length === 0) throw new Error('This Hermes approval has no supported choices. Answer it in Hermes.');
    return {
      id: prompt.prompt_id, kind, executionGeneration: prompt.execution_generation,
      question: typeof prompt.question === 'string' ? prompt.question : typeof prompt.description === 'string' ? prompt.description : 'Approve this Hermes action?',
      choices,
      ...(typeof prompt.command === 'string' ? { command: prompt.command } : {}), ...(typeof prompt.description === 'string' ? { description: prompt.description } : {}),
      ...(typeof prompt.multi_select === 'boolean' ? { multiSelect: prompt.multi_select } : {}),
    };
  }
  private message(message: unknown) {
    if (this.buffering) { if (this.buffering.length >= 128) { this.invalidated = true; if (this.rpc) void this.closeRpc(this.rpc).catch(() => undefined); } else this.buffering.push(message); return; }
    const envelope = row(message), event = row(envelope?.params);
    if (envelope?.method !== 'event' || !event || event.session_id !== this.options.nativeSessionId || !this.connected) return;
    try {
      if (event.type === 'session.replay_gap' || event.authority_epoch !== undefined && event.authority_epoch !== this.epoch || event.replay_epoch !== this.replayEpoch || !integer(event.seq)) throw new Error();
      if (event.seq <= this.sequence) return;
      if (event.seq !== this.sequence + 1) throw new Error();
      this.sequence = event.seq;
      const payload = row(event.payload);
      const generation = event.execution_generation ?? (event.type === 'session.info' ? payload?.execution_generation : undefined);
      if (integer(generation) && generation !== this.generation) {
        if (generation < this.generation!) throw new Error();
        this.generation = generation; this.requests.clear();
      }
      if (event.type === 'approval.request' || event.type === 'clarify.request') {
        const request = this.question(payload);
        if (request.executionGeneration !== this.generation || this.requests.size >= MAX_REQUESTS && !this.requests.has(request.id)) throw new Error();
        this.requests.set(request.id, request); this.running = true;
      } else if (event.type === 'approval.settled' || event.type === 'clarify.settled') {
        if (text(payload?.prompt_id, 256)) this.requests.delete(payload.prompt_id);
      } else if (event.type === 'session.info') {
        if (payload?.stored_session_id !== this.options.nativeSessionId || payload.authority_epoch !== this.epoch || !integer(payload.execution_generation) || typeof payload.running !== 'boolean' ||
            !Array.isArray(payload.pending) || payload.pending.some(value => row(value)?.status === 'unknown')) throw new Error();
        this.running = payload.running;
        if (!this.running) this.requests.clear();
      } else if (event.type === 'message.complete' && generation === this.generation) { this.running = false; this.requests.clear(); }
      else if (event.type === 'message.start' || event.type === 'message.delta' || event.type === 'tool.start') this.running = true;
      this.changed();
    } catch { this.lost(); if (this.rpc) void this.closeRpc(this.rpc).catch(() => undefined); }
  }
  private async live(rpc: HermesObservedRpc) {
    const listed = row(await rpc.request('session.list', { scope: 'live', limit: 200 }));
    if (listed?.scope !== 'live' || !Array.isArray(listed.sessions) || listed.sessions.length > 200 || !listed.sessions.some(value => row(value)?.session_id === this.options.nativeSessionId)) throw new Error('The exact Hermes session is not live in this gateway.');
  }
  private async snapshot(rpc: HermesObservedRpc) {
    await this.live(rpc);
    const result = row(await rpc.request('session.resume', { session_id: this.options.nativeSessionId, omit_messages: true }));
    const info = row(result?.info);
    if (!result || result.session_id !== this.options.nativeSessionId || result.stored_session_id !== this.options.nativeSessionId ||
        result.authority_epoch !== this.epoch || !integer(result.execution_generation) || typeof result.running !== 'boolean' || !text(result.subscription_id, 256) ||
        !text(result.replay_epoch, 256) || !integer(result.last_sequence) || info?.desktop_protocol !== protocol || info.profile_id !== rpc.profileId ||
        this.options.cwd !== undefined && info.cwd !== this.options.cwd || !Array.isArray(result.prompts) || result.prompts.length > MAX_REQUESTS ||
        !Array.isArray(result.pending) || result.pending.some(value => row(value)?.status === 'unknown')) throw new Error('Hermes did not confirm the exact live session identity.');
    const questions = result.prompts.map(value => this.question(value));
    if (questions.some(value => value.executionGeneration !== result.execution_generation) || new Set(questions.map(value => value.id)).size !== questions.length) throw new Error('Hermes returned stale native questions.');
    this.generation = result.execution_generation; this.running = result.running; this.replayEpoch = result.replay_epoch; this.sequence = result.last_sequence;
    this.requests = new Map(questions.map(value => [value.id, value]));
  }
  connect(): Promise<HermesObservedStatus> {
    if (this.cleanupFailed) return Promise.reject(new Error(CLEANUP_PROBLEM));
    if (this.connecting) return Promise.reject(new Error('Wait for the current Hermes attachment.'));
    const pending = this.connectNow(); this.connecting = pending;
    void pending.finally(() => { if (this.connecting === pending) this.connecting = undefined; }).catch(() => undefined);
    return pending;
  }
  private async connectNow(): Promise<HermesObservedStatus> {
    if (this.cleanupFailed) throw new Error(CLEANUP_PROBLEM);
    if (this.closed || this.busy || this.rpc) throw new Error('This Hermes connection is not available.');
    this.busy = true; this.problem = undefined; this.invalidated = false; this.abort = new AbortController(); this.buffering = [];
    try {
      const rpc = await (this.options.rpcFactory ?? createHermesObservedRpc)({
        bin: this.options.bin, env: this.options.env, profile: this.options.profile, signal: this.abort.signal,
        onMessage: message => this.message(message), onClose: () => this.lost(),
      });
      this.rpc = rpc;
      if (this.closed || this.abort.signal.aborted || this.invalidated) throw new Error('Hermes attachment was cancelled.');
      const description = row(await rpc.request('runtime.describe', {}));
      if (!description || description.profile_id !== rpc.profileId || description.instance_id !== rpc.instanceId || !integer(description.authority_epoch) ||
          !Array.isArray(description.capabilities) || !description.capabilities.includes('durable-admission-v1')) throw new Error('Hermes does not expose the shared native gateway protocol.');
      this.epoch = description.authority_epoch;
      await this.snapshot(rpc);
      if (this.closed || this.invalidated) throw new Error('Hermes attachment was cancelled.');
      this.connected = true; this.connectionId = randomUUID();
      const buffered = this.buffering; this.buffering = undefined;
      for (const message of buffered ?? []) this.message(message);
      if (!this.connected) throw new Error('Hermes event stream changed while attaching.');
    } catch (error) {
      this.connected = false; this.requests.clear(); this.buffering = undefined;
      const problem = error instanceof Error ? error.message : 'Hermes attachment failed.';
      this.abort.abort(); if (this.rpc) await this.closeRpc(this.rpc); this.rpc = undefined;
      this.running = false; this.connectionId = undefined; this.problem = problem;
    } finally { this.busy = false; this.changed(); }
    return this.status();
  }
  private current(connectionId: string) {
    if (this.cleanupFailed || this.closed || this.busy || !this.connected || connectionId !== this.connectionId || !this.rpc) throw new Error('This Hermes connection is no longer active.');
    return this.rpc;
  }
  async send(input: HermesObservedMessageInput): Promise<HermesObservedStatus> {
    const rpc = this.current(input?.connectionId);
    if (!text(input?.text) || !input.text.trim() || input.executionGeneration !== this.generation) throw new Error('Use the current Hermes turn and a nonempty message.');
    this.busy = true; this.delivery = undefined;
    try {
      await this.live(rpc);
      if (!this.connected || input.executionGeneration !== this.generation) throw new Error('Hermes changed while sending.');
      if (input.intent !== undefined && input.intent !== (this.running ? 'steer' : 'start')) throw new Error('Hermes changed before the selected action could be admitted.');
      const generation = this.generation;
      const method = this.running ? 'session.steer' : 'prompt.submit';
      const result = row(await rpc.request(method, { session_id: this.options.nativeSessionId, text: input.text,
        ...(this.running ? { execution_generation: generation } : { submission_id: randomUUID() }) }));
      if (!this.connected || !result || (method === 'session.steer'
        ? result.status !== 'queued' || result.execution_generation !== generation || result.authority_epoch !== this.epoch
        : row(result.ref)?.session_id !== this.options.nativeSessionId || row(result.ref)?.profile_id !== rpc.profileId || !text(result.admission_id, 256) || !integer(result.sequence) ||
          !['queued', 'started', 'terminal'].includes(String(result.status)) || result.authority_epoch !== this.epoch || result.execution_generation !== null && !integer(result.execution_generation))) throw new Error('Hermes did not confirm message admission.');
      this.delivery = 'submitted';
    } catch { this.delivery = 'unknown'; this.connected = false; this.requests.clear(); this.abort?.abort(); await this.closeRpc(rpc); this.problem = 'Hermes delivery was not confirmed. Do not resend automatically.'; }
    finally { this.busy = false; this.changed(); }
    return this.status();
  }
  async answer(input: HermesObservedAnswerInput): Promise<HermesObservedStatus> {
    const rpc = this.current(input?.connectionId), question = this.requests.get(input?.requestId);
    if (!question || input.executionGeneration !== this.generation || question.executionGeneration !== input.executionGeneration ||
        (question.kind === 'approval' ? !question.choices.includes(input.choice ?? '') || input.answer !== undefined : typeof input.answer !== 'string' || input.answer.length > 16_384 || input.choice !== undefined)) throw new Error('Choose a current Hermes question and an explicit native reply.');
    this.busy = true; this.delivery = undefined;
    // Retire immediately. Ambiguous completion must never make a second reply possible.
    this.requests.delete(question.id);
    try {
      const result = row(await rpc.request(question.kind === 'approval' ? 'approval.respond' : 'clarify.respond', {
        session_id: this.options.nativeSessionId, execution_generation: input.executionGeneration, prompt_id: question.id,
        ...(question.kind === 'approval' ? { choice: input.choice } : { answer: input.answer }),
      }));
      if (!this.connected || result?.prompt_id !== question.id || !['resolved', 'already_resolved'].includes(String(result.status))) throw new Error();
      if (result.status === 'resolved') { this.delivery = 'resolved'; this.problem = undefined; }
      else this.problem = 'Hermes already resolved this native question. This reply was not accepted.';
    } catch { this.delivery = 'unknown'; this.connected = false; this.requests.clear(); this.abort?.abort(); await this.closeRpc(rpc); this.problem = 'Hermes did not confirm this reply. Connect again to inspect its native state.'; }
    finally { this.busy = false; this.changed(); }
    return this.status();
  }
  async disconnect(): Promise<HermesObservedStatus> {
    this.connected = false; this.connectionId = undefined; this.requests.clear(); this.running = false; this.invalidated = true;
    this.abort?.abort(); const rpc = this.rpc; this.rpc = undefined;
    await Promise.allSettled([...(rpc ? [this.closeRpc(rpc)] : []), ...(this.connecting ? [this.connecting] : []), ...this.cleanupWork]);
    if (this.cleanupFailed) throw new Error(CLEANUP_PROBLEM);
    this.problem = undefined; this.delivery = undefined; this.changed(); return this.status();
  }
  async close(): Promise<void> { this.closed = true; await this.disconnect(); }
}
