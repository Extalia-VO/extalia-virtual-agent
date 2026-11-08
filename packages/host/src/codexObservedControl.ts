import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type {
  ObservedCodexApprovalAnswerInput, ObservedCodexApprovalDecision, ObservedCodexApprovalRequest,
  ObservedCodexAnswerInput, ObservedCodexInputRequest, ObservedCodexMessageInput,
  ObservedCodexCommandAction, ObservedCodexFileChange, ObservedCodexPermissions,
  ObservedCodexQuestion, ObservedCodexStatus,
} from '@extalia/platform';

const MAX_FRAME = 1024 * 1024;
const RPC_TIMEOUT = 10_000;
const CLEANUP_PROBLEM = 'Codex proxy cleanup could not be confirmed.';
type ObjectValue = Record<string, unknown>;
type NativeId = string | number;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
const boundedText = (value: unknown, max = 16_384): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const nativeId = (value: unknown): value is NativeId => boundedText(value, 256) || typeof value === 'number' && Number.isSafeInteger(value);
const idKey = (id: NativeId): string => `${typeof id}:${id}`;

export interface CodexObservedRpc {
  request(method: string, params: ObjectValue): Promise<unknown>;
  notify(method: string, params: ObjectValue): Promise<void>;
  respond(id: NativeId, result: ObjectValue): Promise<void>;
  close(): Promise<void>;
}
export interface CodexObservedRpcOptions {
  bin: string;
  env?: NodeJS.ProcessEnv;
  socketPath: string;
  onMessage(message: unknown): void;
  onClose(problem?: string): void;
}
export type CodexObservedRpcFactory = (options: CodexObservedRpcOptions) => Promise<CodexObservedRpc>;
export interface CodexObservedControlOptions {
  sessionId: string;
  threadId: string;
  cwd?: string;
  bin: string;
  env?: NodeJS.ProcessEnv;
  onChange?: () => void;
  rpcFactory?: CodexObservedRpcFactory;
}

/** One owned byte proxy to an existing Unix WebSocket server; never an engine. */
export const createCodexObservedRpc: CodexObservedRpcFactory = async (options) => {
  const child = spawn(options.bin, ['app-server', 'proxy', '--sock', options.socketPath], {
    env: options.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  const key = randomBytes(16).toString('base64');
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let closed = false;
  let closing: Promise<void> | undefined;
  let cleanupProblemReported = false;
  const reportCleanupProblem = () => {
    if (cleanupProblemReported) return;
    cleanupProblemReported = true; options.onClose(CLEANUP_PROBLEM);
  };
  let nextId = 0;
  let buffered: Buffer = Buffer.alloc(0);
  let upgraded = false;
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  let acceptHandshake!: () => void;
  let rejectHandshake!: (error: Error) => void;
  const handshake = new Promise<void>((resolve, reject) => { acceptHandshake = resolve; rejectHandshake = reject; });
  // The owner gets its close handle immediately, including while Upgrade is pending.
  // A caller may close before issuing its first RPC.
  void handshake.catch(() => {});
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const exited = new Promise<void>((resolve) => { child.once('close', () => resolve()); });
  const finish = () => {
    if (closed) return;
    closed = true; clearTimeout(handshakeTimer);
    rejectHandshake(new Error('Codex proxy disconnected.'));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Codex proxy disconnected.')); }
    pending.clear(); buffered = Buffer.alloc(0); fragments = []; fragmentBytes = 0;
    options.onClose();
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    finish();
    closing = (async () => {
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 250);
      let reapTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([exited, new Promise<never>((_, reject) => {
          reapTimer = setTimeout(() => reject(new Error(CLEANUP_PROBLEM)), 2000);
        })]);
      } catch (error) {
        reportCleanupProblem(); throw error;
      } finally { clearTimeout(killTimer); clearTimeout(reapTimer); }
    })();
    return closing;
  };
  const stop = () => { void close().catch(reportCleanupProblem); };
  const writeBytes = (bytes: Buffer): Promise<void> => {
    if (closed) return Promise.reject(new Error('Codex proxy disconnected.'));
    if (bytes.length > MAX_FRAME + 14 || child.stdin.writableLength + bytes.length > MAX_FRAME + 14) return Promise.reject(new Error('Codex message exceeds the transport limit.'));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Codex proxy write timed out.')); stop(); }, RPC_TIMEOUT);
      child.stdin.write(bytes, (error) => {
        clearTimeout(timer);
        if (error) reject(new Error('Codex proxy write failed.')); else resolve();
      });
    });
  };
  const writeFrame = (opcode: number, payload: Buffer): Promise<void> => {
    if (payload.length > MAX_FRAME) return Promise.reject(new Error('Codex message exceeds the transport limit.'));
    const extended = payload.length < 126 ? 0 : payload.length <= 0xffff ? 2 : 8;
    const frame = Buffer.allocUnsafe(2 + extended + 4 + payload.length);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | (extended === 0 ? payload.length : extended === 2 ? 126 : 127);
    if (extended === 2) frame.writeUInt16BE(payload.length, 2);
    if (extended === 8) frame.writeBigUInt64BE(BigInt(payload.length), 2);
    const mask = randomBytes(4); mask.copy(frame, 2 + extended);
    for (let index = 0; index < payload.length; index++) frame[6 + extended + index] = payload[index]! ^ mask[index % 4]!;
    return writeBytes(frame);
  };
  const dispatch = (payload: Buffer) => {
    const message = object(JSON.parse(decoder.decode(payload)));
    if (!message) throw new Error('Invalid Codex message.');
    if (typeof message.method === 'string') { options.onMessage(message); return; }
    if (!nativeId(message.id)) return;
    const entry = pending.get(idKey(message.id));
    if (!entry) return;
    pending.delete(idKey(message.id)); clearTimeout(entry.timer);
    if ('error' in message) entry.reject(new Error('Codex rejected the request.'));
    else if ('result' in message) entry.resolve(message.result);
    else { entry.reject(new Error('Invalid Codex response.')); throw new Error('Invalid Codex response.'); }
  };
  const parse = () => {
    if (!upgraded) {
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) { if (buffered.length > 8192) throw new Error('Codex Upgrade headers exceed the limit.'); return; }
      if (end + 4 > 8192) throw new Error('Codex Upgrade headers exceed the limit.');
      const lines = buffered.subarray(0, end).toString('latin1').split('\r\n');
      if (!/^HTTP\/1\.1 101(?: [\x20-\x7e]*)?$/.test(lines.shift() ?? '')) throw new Error('Codex WebSocket Upgrade was rejected.');
      const headers = new Map<string, string>();
      for (const line of lines) {
        const match = /^([!#$%&'*+.^_`|~0-9a-zA-Z-]+):[ \t]*([^\r\n]*)$/.exec(line);
        if (!match || /[^\x20-\x7e\t]/.test(match[2]!)) throw new Error('Invalid Codex Upgrade header.');
        const name = match[1]!.toLowerCase();
        if (headers.has(name)) throw new Error('Duplicate Codex Upgrade header.');
        headers.set(name, match[2]!.trim());
      }
      if (headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
          !headers.get('connection')?.toLowerCase().split(',').some((token) => token.trim() === 'upgrade') ||
          headers.get('sec-websocket-accept') !== accept ||
          ['sec-websocket-extensions', 'sec-websocket-protocol', 'content-length', 'transfer-encoding'].some((name) => headers.has(name))) throw new Error('Invalid Codex WebSocket Upgrade.');
      buffered = buffered.subarray(end + 4); upgraded = true; clearTimeout(handshakeTimer); acceptHandshake();
    }
    while (!closed && buffered.length >= 2) {
      const first = buffered[0]!; const second = buffered[1]!;
      const fin = (first & 0x80) !== 0; const opcode = first & 15;
      if ((first & 0x70) !== 0 || (second & 0x80) !== 0 || ![0, 1, 8, 9, 10].includes(opcode)) throw new Error('Unsupported Codex WebSocket frame.');
      let size = second & 127; let header = 2;
      if (size === 126) {
        if (buffered.length < 4) return;
        size = buffered.readUInt16BE(2); header = 4;
        if (size < 126) throw new Error('Non-canonical Codex WebSocket length.');
      } else if (size === 127) {
        if (buffered.length < 10) return;
        const length = buffered.readBigUInt64BE(2); header = 10;
        if (length < 65536n || length > BigInt(MAX_FRAME)) throw new Error('Codex frame exceeds the transport limit.');
        size = Number(length);
      }
      if (size > MAX_FRAME || opcode >= 8 && (!fin || size > 125)) throw new Error('Invalid Codex control frame.');
      if (buffered.length < header + size) return;
      const payload = buffered.subarray(header, header + size); buffered = buffered.subarray(header + size);
      if (opcode === 9) { void writeFrame(10, payload).catch(stop); continue; }
      if (opcode === 10) continue;
      if (opcode === 8) {
        if (size === 1) throw new Error('Invalid Codex close frame.');
        if (size >= 2) {
          const code = payload.readUInt16BE(0);
          if (code < 1000 || code >= 5000 || [1004, 1005, 1006, 1015].includes(code) || code >= 1016 && code < 3000) throw new Error('Invalid Codex close code.');
          decoder.decode(payload.subarray(2));
        }
        const acknowledgment = writeFrame(8, payload); finish(); void acknowledgment.then(stop, stop); return;
      }
      if (opcode === 1) {
        if (fragments.length) throw new Error('Interleaved Codex WebSocket messages.');
        if (fin) { dispatch(payload); continue; }
      } else if (!fragments.length) throw new Error('Unexpected Codex continuation frame.');
      if (fragmentBytes + payload.length > MAX_FRAME || fragments.length >= 1024) throw new Error('Codex message exceeds the transport limit.');
      fragments.push(Buffer.from(payload)); fragmentBytes += payload.length;
      if (fin) { const message = Buffer.concat(fragments, fragmentBytes); fragments = []; fragmentBytes = 0; dispatch(message); }
    }
  };
  child.once('error', () => { finish(); stop(); });
  child.once('close', finish);
  child.stdin.on('error', () => { finish(); stop(); });
  child.stdout.on('error', () => { finish(); stop(); });
  child.stdout.on('data', (chunk: Buffer) => {
    if (closed) return;
    try {
      // Process a bounded slice at a time, allowing coalesced frames without an
      // unbounded aggregate buffer. Frames and fragmented messages cap at 1 MiB.
      for (let offset = 0; offset < chunk.length && !closed; offset += 65536) {
        buffered = Buffer.concat([buffered, chunk.subarray(offset, offset + 65536)]);
        parse();
      }
    } catch { stop(); }
  });
  const handshakeTimer = setTimeout(stop, RPC_TIMEOUT);
  void writeBytes(Buffer.from(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`)).catch(stop);
  const write = async (message: ObjectValue): Promise<void> => {
    const payload = Buffer.from(JSON.stringify(message));
    if (payload.length > MAX_FRAME) throw new Error('Codex message exceeds the transport limit.');
    await handshake;
    await writeFrame(1, payload);
  };
  return {
    request(method, params) {
      if (closed || pending.size >= 32) return Promise.reject(new Error('Codex proxy unavailable.'));
      const id = `extalia-${++nextId}`;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(stop, RPC_TIMEOUT);
        pending.set(idKey(id), { resolve, reject, timer });
        void write({ id, method, params }).catch(stop);
      });
    },
    notify: (method, params) => write({ method, params }),
    respond: (id, result) => write({ id, result }),
    close,
  };
};

interface SocketPin { path: string; dev: number; ino: number }
async function validateSocket(socketPath: string): Promise<SocketPin> {
  if (process.platform === 'win32' || !path.isAbsolute(socketPath) || socketPath.includes('\0') || path.normalize(socketPath) !== socketPath) throw new Error('A trusted local Unix socket is required.');
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Socket ownership cannot be verified.');
  // macOS publishes /tmp and /var as root-owned system aliases. Only these exact
  // aliases are accepted; caller-controlled symlinks are never followed.
  let expected = socketPath;
  for (const alias of ['/tmp', '/var']) {
    if (!expected.startsWith(`${alias}/`)) continue;
    const entry = await lstat(alias);
    if (entry.isSymbolicLink()) {
      if (entry.uid !== 0) throw new Error('Untrusted socket path.');
      expected = (await realpath(alias)) + expected.slice(alias.length);
    }
    break;
  }
  const canonical = await realpath(socketPath);
  if (canonical !== expected) throw new Error('Socket symlinks are not supported.');
  const socket = await lstat(canonical);
  if (!socket.isSocket() || socket.uid !== uid || socket.isSymbolicLink() || (socket.mode & 0o022) !== 0) throw new Error('Socket must belong to the current user.');
  let directory = path.dirname(canonical);
  let immediate = true;
  while (true) {
    const entry = await lstat(directory);
    const writable = (entry.mode & 0o022) !== 0;
    const sharedSystemAncestor = !immediate && entry.uid === 0 && (entry.mode & 0o1000) !== 0;
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.uid !== uid && entry.uid !== 0) || (immediate && entry.uid !== uid) || writable && !sharedSystemAncestor) throw new Error('Socket directory is not private and trusted.');
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent; immediate = false;
  }
  return { path: canonical, dev: socket.dev, ino: socket.ino };
}

interface PendingRequest { nativeId: NativeId; generation: number; blocking: boolean; view: ObservedCodexInputRequest; slot: string }
interface PendingApproval { nativeId: NativeId; generation: number; view: ObservedCodexApprovalRequest; slot: string }
interface UnsupportedRequest { nativeId: NativeId; turnId: string; itemId: string; slot: string }

/** Ephemeral attachment to one exact observed thread on an existing Codex server. */
export class CodexObservedControl {
  private rpc?: CodexObservedRpc;
  private pin?: SocketPin;
  private generation = 0;
  private connectionId?: string;
  private state: ObservedCodexStatus['state'] = 'disconnected';
  private activeTurnId?: string;
  private activity: 'idle' | 'active' | 'unknown' = 'unknown';
  private problem?: string;
  private delivery?: ObservedCodexStatus['delivery'];
  private readonly requests = new Map<string, PendingRequest>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly unsupported = new Map<string, UnsupportedRequest>();
  private readonly fileChanges = new Map<string, ObservedCodexFileChange[]>();
  private readonly seenRequests = new Map<string, string>();
  private staged: unknown[] = [];
  private ready = false;
  private busy = false;
  private turnRevision = 0;
  // Cleanup uncertainty survives generation changes and removal of the RPC handle.
  private cleanupFailed = false;
  constructor(private readonly options: CodexObservedControlOptions) {}

  status(): ObservedCodexStatus {
    const connected = this.state === 'connected';
    return {
      sessionId: this.options.sessionId, state: this.state, connectionId: this.connectionId,
      threadId: connected ? this.options.threadId : undefined, activeTurnId: this.activeTurnId,
      canSend: connected && !this.busy && (this.activity === 'idle' || !!this.activeTurnId) && !this.hasBlockingRequest(), canAnswer: connected && [...this.requests.values()].some((request) => request.view.state === 'pending'),
      requests: structuredClone([...this.requests.values()].map((request) => request.view)),
      approvals: structuredClone([...this.approvals.values()].map((request) => request.view)),
      canApprove: connected && [...this.approvals.values()].some((request) => request.view.state === 'pending' && request.view.turnId === this.activeTurnId && request.generation === this.generation),
      problem: this.problem, delivery: this.delivery,
    };
  }
  private hasBlockingRequest(): boolean {
    return this.approvals.size > 0 || this.unsupported.size > 0 || [...this.requests.values()].some((request) => request.blocking);
  }
  private clearTurnRequests(): void {
    this.requests.clear(); this.approvals.clear(); this.unsupported.clear(); this.fileChanges.clear();
  }
  private changed(): void { this.options.onChange?.(); }
  private failCleanup(): void {
    this.cleanupFailed = true; this.invalidate('unavailable', CLEANUP_PROBLEM);
  }
  private stopRpc(): void {
    void this.rpc?.close().catch(() => { this.failCleanup(); });
  }
  private invalidate(state: ObservedCodexStatus['state'], problem?: string): void {
    ++this.generation; this.ready = false;
    this.state = this.cleanupFailed ? 'unavailable' : state;
    this.problem = this.cleanupFailed ? CLEANUP_PROBLEM : problem;
    this.connectionId = undefined; this.activeTurnId = undefined; this.activity = 'unknown'; this.clearTurnRequests(); this.seenRequests.clear(); this.staged = [];
    if (this.delivery === 'submitted') this.delivery = 'unknown';
    this.changed();
  }
  async close(): Promise<void> {
    const rpc = this.rpc; this.rpc = undefined; this.pin = undefined;
    this.invalidate('disconnected');
    try { await rpc?.close(); } catch { this.failCleanup(); }
    if (this.cleanupFailed) throw new Error(CLEANUP_PROBLEM);
  }
  async connect(socketPath: string): Promise<ObservedCodexStatus> {
    await this.close();
    const generation = this.generation;
    try {
      const pin = await validateSocket(socketPath);
      if (generation !== this.generation) throw new Error('Connection superseded.');
      this.pin = pin;
      const rpc = await (this.options.rpcFactory ?? createCodexObservedRpc)({
        bin: this.options.bin, env: this.options.env, socketPath: pin.path,
        onMessage: (message) => {
          if (generation !== this.generation) return;
          if (this.ready) this.message(message);
          else if (this.staged.length < 128) this.staged.push(message);
          else { this.invalidate('unavailable', 'Codex sent too many attachment events.'); this.stopRpc(); }
        },
        onClose: (problem) => {
          if (problem) this.failCleanup();
          else if (generation === this.generation) this.invalidate('unavailable', 'The Codex connection closed. Reconnect explicitly.');
        },
      });
      if (generation !== this.generation) {
        try { await rpc.close(); } catch { this.failCleanup(); }
        if (this.cleanupFailed) throw new Error(CLEANUP_PROBLEM);
        return this.status();
      }
      this.rpc = rpc;
      await rpc.request('initialize', { clientInfo: { name: 'extalia_observer', version: '1' }, capabilities: { experimentalApi: true } });
      if (generation !== this.generation) throw new Error('Connection superseded.');
      await rpc.notify('initialized', {});
      if (generation !== this.generation) throw new Error('Connection superseded.');
      const loaded = object(await rpc.request('thread/loaded/list', { limit: 100 }));
      if (generation !== this.generation) throw new Error('Connection superseded.');
      if (!loaded || !Array.isArray(loaded.data) || loaded.data.length > 100 || !loaded.data.every((id) => boundedText(id, 256)) || !loaded.data.includes(this.options.threadId)) throw new Error('Invalid thread inventory.');
      this.verifyThread(await rpc.request('thread/read', { threadId: this.options.threadId, includeTurns: false }));
      await this.revalidate(generation);
      const resumed = this.verifyThread(await rpc.request('thread/resume', { threadId: this.options.threadId, excludeTurns: true }));
      if (generation !== this.generation) throw new Error('Connection superseded.');
      this.activity = object(resumed.status)?.type === 'idle' ? 'idle' : 'unknown';
      const turns = resumed.turns;
      if (Array.isArray(turns)) {
        for (const value of turns) {
          const turn = object(value);
          if (turn?.status === 'inProgress' && boundedText(turn.id, 256)) {
            if (this.activeTurnId) throw new Error('Ambiguous active Codex turn.');
            this.activeTurnId = turn.id; this.activity = 'active';
          }
        }
      }
      if (object(resumed.status)?.type === 'active' && !this.activeTurnId) {
        const page = object(await rpc.request('thread/turns/list', {
          threadId: this.options.threadId, limit: 4, sortDirection: 'desc', itemsView: 'notLoaded',
        }));
        if (generation !== this.generation) throw new Error('Connection superseded.');
        if (!page || !Array.isArray(page.data) || page.data.length > 4) throw new Error('Invalid active turn metadata.');
        const ids = new Set<string>();
        for (const value of page.data) {
          const turn = object(value);
          if (!turn || !boundedText(turn.id, 256) || ids.has(turn.id) ||
              !['inProgress', 'completed', 'interrupted', 'failed'].includes(String(turn.status)) ||
              turn.itemsView !== 'notLoaded' || !Array.isArray(turn.items) || turn.items.length !== 0) throw new Error('Invalid active turn metadata.');
          ids.add(turn.id);
          if (turn.status === 'inProgress') {
            if (this.activeTurnId) throw new Error('Ambiguous active Codex turn.');
            this.activeTurnId = turn.id;
          }
        }
        if (!this.activeTurnId) throw new Error('The active Codex turn could not be verified.');
        this.activity = 'active';
      }
      this.state = 'connected'; this.connectionId = randomUUID(); this.ready = true;
      const staged = this.staged; this.staged = [];
      for (const message of staged) this.message(message);
      this.changed();
    } catch {
      if (generation === this.generation) {
        const rpc = this.rpc; this.rpc = undefined;
        this.invalidate('unavailable', 'Could not attach to the exact observed Codex thread on this socket.');
        try { await rpc?.close(); } catch { this.failCleanup(); }
      }
      if (this.cleanupFailed) throw new Error(CLEANUP_PROBLEM);
    }
    return this.status();
  }
  private verifyThread(value: unknown): ObjectValue {
    const response = object(value); const thread = object(response?.thread);
    if (!thread || thread.id !== this.options.threadId || (this.options.cwd !== undefined && thread.cwd !== this.options.cwd)) throw new Error('Observed thread identity mismatch.');
    if (this.options.cwd !== undefined && response?.cwd !== undefined && response.cwd !== this.options.cwd) throw new Error('Observed workspace mismatch.');
    return thread;
  }
  private async revalidate(generation: number): Promise<void> {
    const previous = this.pin;
    if (generation !== this.generation || !previous) throw new Error('Stale Codex connection.');
    try {
      const pin = await validateSocket(previous.path);
      if (generation !== this.generation) throw new Error('Stale Codex connection.');
      if (pin.dev !== previous.dev || pin.ino !== previous.ino) throw new Error('Codex socket changed.');
    } catch {
      if (generation === this.generation) await this.close();
      throw new Error('Codex socket is no longer trusted. Reconnect explicitly.');
    }
  }
  private requireConnection(id: string): { rpc: CodexObservedRpc; generation: number } {
    if (this.state !== 'connected' || id !== this.connectionId || !this.rpc) throw new Error('Stale Codex connection.');
    return { rpc: this.rpc, generation: this.generation };
  }
  async send(input: ObservedCodexMessageInput): Promise<ObservedCodexStatus> {
    const { rpc, generation } = this.requireConnection(input.connectionId);
    if (!this.status().canSend || !boundedText(input.text, 65_536) || !input.text.trim()) throw new Error('A bounded message is required.');
    if (input.activeTurnId !== this.activeTurnId) throw new Error('The active Codex turn changed.');
    this.busy = true; this.changed();
    try {
      await this.revalidate(generation);
      if (input.activeTurnId !== this.activeTurnId || this.hasBlockingRequest()) throw new Error('The active Codex turn changed.');
      const params = { threadId: this.options.threadId, input: [{ type: 'text', text: input.text }] };
      if (input.activeTurnId) {
        await rpc.request('turn/steer', { ...params, expectedTurnId: input.activeTurnId });
      } else {
        const thread = this.verifyThread(await rpc.request('thread/read', { threadId: this.options.threadId, includeTurns: false }));
        if (object(thread.status)?.type !== 'idle' || this.activeTurnId || generation !== this.generation) throw new Error('Codex is no longer idle.');
        await this.revalidate(generation);
        if (this.activeTurnId) throw new Error('Codex is no longer idle.');
        const revision = this.turnRevision;
        const response = object(await rpc.request('turn/start', params)); const turn = object(response?.turn);
        if (generation === this.generation && revision === this.turnRevision && boundedText(turn?.id, 256) && turn.status === 'inProgress') { this.activeTurnId = turn.id; this.activity = 'active'; }
      }
      if (generation !== this.generation) throw new Error('Codex delivery is unknown after disconnect.');
      this.delivery = 'submitted';
    } finally { this.busy = false; this.changed(); }
    return this.status();
  }
  async answer(input: ObservedCodexAnswerInput): Promise<ObservedCodexStatus> {
    const { rpc, generation } = this.requireConnection(input.connectionId);
    const request = this.requests.get(input.requestId);
    if (!request || request.generation !== generation || request.view.state !== 'pending' || request.view.turnId !== this.activeTurnId) throw new Error('This Codex question has expired or was already submitted.');
    const answers = object(input.answers);
    if (!answers || Object.keys(answers).length !== request.view.questions.length) throw new Error('Answer every current question exactly once.');
    const nativeAnswers: ObjectValue = Object.create(null) as ObjectValue;
    for (const question of request.view.questions) {
      const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
      if (!boundedText(answer, 16_384) || !answer.trim() || (!question.isOther && question.options.length > 0 && !question.options.some((option) => option.label === answer))) throw new Error('Invalid answer for the current Codex question.');
      nativeAnswers[question.id] = { answers: [answer] };
    }
    // Reserve synchronously: concurrent submissions cannot write a second response.
    request.view.state = 'submitted'; this.changed();
    try {
      await this.revalidate(generation);
      if (this.requests.get(input.requestId) !== request || request.view.turnId !== this.activeTurnId) throw new Error('This Codex question has expired.');
      await rpc.respond(request.nativeId, { answers: nativeAnswers });
      if (generation !== this.generation) throw new Error('Codex delivery is unknown after disconnect.');
      if (this.requests.get(input.requestId) === request) this.delivery = 'submitted';
      this.changed();
    } catch (error) {
      // Never retry a possibly delivered answer, and never retain its contents.
      if (generation === this.generation && this.requests.get(input.requestId) === request) { this.requests.delete(input.requestId); this.delivery = 'unknown'; this.changed(); }
      throw error;
    }
    return this.status();
  }
  async answerApproval(input: ObservedCodexApprovalAnswerInput): Promise<ObservedCodexStatus> {
    const { rpc, generation } = this.requireConnection(input.connectionId);
    const request = this.approvals.get(input.requestId);
    if (!request || request.generation !== generation || request.view.state !== 'pending' || request.view.turnId !== this.activeTurnId) throw new Error('This Codex approval has expired or was already submitted.');
    if (!request.view.availableDecisions.includes(input.decision)) throw new Error('Choose an offered one-action Codex decision.');
    // Only the validated native request supplies grant scopes. No frontend RPC,
    // session cache, policy amendment or automatic-review flag can be supplied.
    const result = request.view.kind === 'permissions'
      ? { permissions: input.decision === 'accept' ? structuredClone(request.view.permissions) : {}, scope: 'turn' }
      : { decision: input.decision };
    request.view.state = 'submitted'; this.changed();
    try {
      await this.revalidate(generation);
      if (this.approvals.get(input.requestId) !== request || request.view.turnId !== this.activeTurnId) throw new Error('This Codex approval has expired.');
      await rpc.respond(request.nativeId, result);
      if (generation !== this.generation) throw new Error('Codex delivery is unknown after disconnect.');
      if (this.approvals.get(input.requestId) === request) this.delivery = 'submitted';
      this.changed();
    } catch (error) {
      if (generation === this.generation && this.approvals.get(input.requestId) === request) {
        this.approvals.delete(input.requestId);
        this.unsupported.set(idKey(request.nativeId), { nativeId: request.nativeId, turnId: request.view.turnId, itemId: request.view.itemId, slot: request.slot });
        this.delivery = 'unknown'; this.changed();
      }
      throw error;
    }
    return this.status();
  }
  private message(value: unknown): void {
    const message = object(value); const params = object(message?.params);
    if (!message || !params || params.threadId !== this.options.threadId) return;
    if (message.method === 'serverRequest/resolved' && nativeId(params.requestId)) {
      for (const [id, request] of this.requests) {
        if (idKey(request.nativeId) === idKey(params.requestId)) { this.requests.delete(id); this.delivery = 'resolved'; this.changed(); }
      }
      for (const [id, request] of this.approvals) {
        if (idKey(request.nativeId) === idKey(params.requestId)) { this.approvals.delete(id); this.delivery = 'resolved'; this.changed(); }
      }
      if (this.unsupported.delete(idKey(params.requestId))) this.changed();
      return;
    }
    if (message.method === 'thread/closed') {
      this.invalidate('unavailable', 'The observed Codex thread closed.'); this.stopRpc(); return;
    }
    if (message.method === 'thread/status/changed') {
      const type = object(params.status)?.type;
      if (type === 'idle') {
        ++this.turnRevision; this.activity = 'idle'; this.activeTurnId = undefined; this.clearTurnRequests();
      } else if (type === 'active') this.activity = 'active';
      else if (type === 'notLoaded' || type === 'systemError') {
        ++this.turnRevision; this.activity = 'unknown'; this.activeTurnId = undefined; this.clearTurnRequests();
      }
      this.changed(); return;
    }
    if ((message.method === 'item/started' || message.method === 'item/fileChange/patchUpdated') && params.turnId === this.activeTurnId) {
      const item = message.method === 'item/started' ? object(params.item) : { id: params.itemId, type: 'fileChange', changes: params.changes };
      if (item?.type === 'fileChange' && boundedText(item.id, 256)) {
        const changes = parseFileChanges(item.changes);
        if (changes && JSON.stringify(changes) === JSON.stringify(this.fileChanges.get(item.id))) return;
        // A replaced preview also invalidates any decision made against it.
        for (const [id, request] of this.approvals) {
          if (request.view.itemId === item.id && request.view.kind === 'fileChange') {
            this.approvals.delete(id);
            this.unsupported.set(idKey(request.nativeId), { nativeId: request.nativeId, turnId: request.view.turnId, itemId: request.view.itemId, slot: request.slot });
          }
        }
        this.fileChanges.delete(item.id);
        if (changes && this.fileChanges.size < 16) this.fileChanges.set(item.id, changes);
        this.changed();
      }
      return;
    }
    if (message.method === 'item/completed' && params.turnId === this.activeTurnId) {
      const item = object(params.item);
      for (const [id, request] of this.requests) {
        if (request.view.itemId === item?.id) this.requests.delete(id);
      }
      for (const [id, request] of this.approvals) if (request.view.itemId === item?.id) this.approvals.delete(id);
      for (const [id, request] of this.unsupported) if (request.itemId === item?.id) this.unsupported.delete(id);
      if (typeof item?.id === 'string') this.fileChanges.delete(item.id);
      this.changed(); return;
    }
    const turn = object(params.turn);
    if (message.method === 'turn/started' && boundedText(turn?.id, 256)) {
      ++this.turnRevision;
      if (this.activeTurnId !== turn.id) this.clearTurnRequests();
      this.activeTurnId = turn.id; this.activity = 'active'; this.changed(); return;
    }
    if (message.method === 'turn/completed' && turn?.id === this.activeTurnId) {
      ++this.turnRevision;
      this.activeTurnId = undefined; this.activity = 'idle'; this.clearTurnRequests();
      if (this.delivery === 'submitted') this.delivery = 'unknown';
      this.changed(); return;
    }
    const method = message.method;
    if (!['item/tool/requestUserInput', 'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(String(method)) || !nativeId(message.id) || !boundedText(params.turnId, 256) || params.turnId !== this.activeTurnId || !boundedText(params.itemId, 256)) return;
    const questions = method === 'item/tool/requestUserInput' ? parseQuestions(params.questions) : undefined;
    if (method === 'item/tool/requestUserInput' && (!questions || typeof params.isBlocking !== 'boolean')) return;
    const key = idKey(message.id);
    const fingerprint = createHash('sha256').update(JSON.stringify({ method, params })).digest('hex');
    const slot = `${method}:${params.itemId}:${typeof params.approvalId === 'string' ? params.approvalId : ''}`;
    const previous = this.seenRequests.get(key);
    if (previous === fingerprint) return;
    // A different request in the same callback slot replaces the old preview.
    // Reused native IDs with changed contents are never approvable.
    for (const [id, request] of this.requests) if (request.slot === slot || idKey(request.nativeId) === key) this.requests.delete(id);
    for (const [id, request] of this.approvals) if (request.slot === slot || idKey(request.nativeId) === key) this.approvals.delete(id);
    for (const [id, request] of this.unsupported) if (request.slot === slot) this.unsupported.delete(id);
    if (previous || this.seenRequests.size >= 1024 || this.requests.size + this.approvals.size + this.unsupported.size >= 16) {
      this.invalidate('unavailable', 'Codex approval identity or request limits changed. Reconnect explicitly.'); this.stopRpc(); return;
    }
    this.seenRequests.set(key, fingerprint);
    if (method === 'item/tool/requestUserInput') {
      const id = randomUUID();
      this.requests.set(id, { nativeId: message.id, generation: this.generation, slot, blocking: params.isBlocking === true, view: { id, turnId: params.turnId, itemId: params.itemId, state: 'pending', questions: questions! } });
    } else {
      const id = randomUUID();
      const view = parseApproval(method as string, params, { id, turnId: params.turnId, itemId: params.itemId, state: 'pending', availableDecisions: [] }, this.fileChanges.get(params.itemId), this.options.cwd);
      if (view) this.approvals.set(id, { nativeId: message.id, generation: this.generation, slot, view });
      else this.unsupported.set(key, { nativeId: message.id, turnId: params.turnId, itemId: params.itemId, slot });
    }
    this.changed();
  }
}

const nullableText = (value: unknown, max = 16_384): boolean => value === undefined || value === null || typeof value === 'string' && value.length <= max;
const knownKeys = (value: ObjectValue, keys: string[]): boolean => Object.keys(value).every((key) => keys.includes(key));

/** Validate the installed 0.167.0 native scopes before retaining or returning them. */
function parsePermissions(value: unknown): ObservedCodexPermissions | undefined {
  const profile = object(value);
  if (!profile || !knownKeys(profile, ['network', 'fileSystem'])) return undefined;
  if (profile.network !== undefined && profile.network !== null) {
    const network = object(profile.network);
    if (!network || !knownKeys(network, ['enabled']) || network.enabled !== undefined && network.enabled !== null && typeof network.enabled !== 'boolean') return undefined;
  }
  if (profile.fileSystem !== undefined && profile.fileSystem !== null) {
    const fs = object(profile.fileSystem);
    if (!fs || !knownKeys(fs, ['entries', 'globScanMaxDepth', 'read', 'write']) || fs.globScanMaxDepth !== undefined && fs.globScanMaxDepth !== null && (!Number.isSafeInteger(fs.globScanMaxDepth) || Number(fs.globScanMaxDepth) < 1)) return undefined;
    for (const name of ['read', 'write']) {
      const paths = fs[name];
      if (paths !== undefined && paths !== null && (!Array.isArray(paths) || paths.length > 128 || !paths.every((entry) => boundedText(entry, 4096) && path.isAbsolute(entry)))) return undefined;
    }
    if (fs.entries !== undefined && fs.entries !== null) {
      if (!Array.isArray(fs.entries) || fs.entries.length > 128) return undefined;
      for (const value of fs.entries) {
        const entry = object(value); const target = object(entry?.path);
        if (!entry || !knownKeys(entry, ['access', 'path']) || !['read', 'write', 'deny'].includes(String(entry.access)) || !target) return undefined;
        if (target.type === 'path') {
          if (!knownKeys(target, ['type', 'path']) || !boundedText(target.path, 4096) || !path.isAbsolute(target.path)) return undefined;
        } else if (target.type === 'glob_pattern') {
          if (!knownKeys(target, ['type', 'pattern']) || !boundedText(target.pattern, 4096)) return undefined;
        } else if (target.type === 'special') {
          const special = object(target.value);
          if (!knownKeys(target, ['type', 'value']) || !special) return undefined;
          if (special.kind === 'project_roots' || special.kind === 'unknown') {
            if (!knownKeys(special, special.kind === 'unknown' ? ['kind', 'path', 'subpath'] : ['kind', 'subpath']) || !nullableText(special.subpath, 4096) || special.kind === 'unknown' && !boundedText(special.path, 4096)) return undefined;
          } else if (!knownKeys(special, ['kind']) || !['root', 'minimal', 'tmpdir', 'slash_tmp'].includes(String(special.kind))) return undefined;
        } else return undefined;
      }
    }
  }
  if (JSON.stringify(profile).length > 131_072) return undefined;
  return structuredClone(profile) as ObservedCodexPermissions;
}

function parseCommandActions(value: unknown): ObservedCodexCommandAction[] | undefined {
  if (!Array.isArray(value) || value.length > 128) return undefined;
  for (const entry of value) {
    const action = object(entry);
    if (!action || !boundedText(action.command, 65_536)) return undefined;
    if (action.type === 'read') {
      if (!knownKeys(action, ['type', 'command', 'name', 'path']) || !boundedText(action.name, 4096) || !boundedText(action.path, 4096)) return undefined;
    } else if (action.type === 'listFiles' || action.type === 'search') {
      if (!knownKeys(action, action.type === 'search' ? ['type', 'command', 'path', 'query'] : ['type', 'command', 'path']) || !nullableText(action.path, 4096) || !nullableText(action.query, 4096)) return undefined;
    } else if (action.type !== 'unknown' || !knownKeys(action, ['type', 'command'])) return undefined;
  }
  if (JSON.stringify(value).length > 131_072) return undefined;
  return structuredClone(value) as ObservedCodexCommandAction[];
}

function parseFileChanges(value: unknown): ObservedCodexFileChange[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) return undefined;
  for (const entry of value) {
    const change = object(entry); const kind = object(change?.kind);
    if (!change || !knownKeys(change, ['path', 'diff', 'kind']) || !boundedText(change.path, 4096) || typeof change.diff !== 'string' || change.diff.length > 262_144 || !kind) return undefined;
    if (kind.type === 'update') {
      if (!knownKeys(kind, ['type', 'move_path']) || !nullableText(kind.move_path, 4096)) return undefined;
    } else if (!['add', 'delete'].includes(String(kind.type)) || !knownKeys(kind, ['type'])) return undefined;
  }
  if (JSON.stringify(value).length > 262_144) return undefined;
  return structuredClone(value) as ObservedCodexFileChange[];
}

function parseApproval(
  method: string, params: ObjectValue,
  base: Pick<ObservedCodexApprovalRequest, 'id' | 'turnId' | 'itemId' | 'state' | 'availableDecisions'>,
  changes: ObservedCodexFileChange[] | undefined, cwd: string | undefined,
): ObservedCodexApprovalRequest | undefined {
  if (!Number.isSafeInteger(params.startedAtMs) || !nullableText(params.reason) || !nullableText(params.environmentId, 256)) return undefined;
  const keys = ['itemId', 'startedAtMs', 'threadId', 'turnId', 'reason'];
  const extraKeys = method === 'item/permissions/requestApproval' ? ['cwd', 'environmentId', 'permissions']
    : method === 'item/fileChange/requestApproval' ? ['grantRoot']
      : ['additionalPermissions', 'approvalId', 'availableDecisions', 'command', 'commandActions', 'cwd', 'environmentId', 'kind', 'networkApprovalContext', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments'];
  if (!knownKeys(params, [...keys, ...extraKeys])) return undefined;
  const common = { ...base, reason: typeof params.reason === 'string' ? params.reason : undefined, environmentId: typeof params.environmentId === 'string' ? params.environmentId : undefined };
  if (method === 'item/permissions/requestApproval') {
    const permissions = parsePermissions(params.permissions);
    if (!permissions || !boundedText(params.cwd, 4096) || !path.isAbsolute(params.cwd)) return undefined;
    return { ...common, kind: 'permissions', cwd: params.cwd, permissions, scope: 'turn', availableDecisions: ['accept', 'decline'] };
  }
  if (method === 'item/fileChange/requestApproval') {
    if (!changes || !nullableText(params.grantRoot, 4096)) return undefined;
    const grantRoot = typeof params.grantRoot === 'string' ? params.grantRoot : undefined;
    // Native 0.167.0 describes this root as a session grant and leaves its
    // enforcement uncertain. Never accept that possible persistent authority.
    const availableDecisions: ObservedCodexApprovalDecision[] = grantRoot ? ['decline', 'cancel'] : ['accept', 'decline', 'cancel'];
    return { ...common, kind: 'fileChange', cwd, changes: structuredClone(changes), grantRoot, availableDecisions };
  }
  if (!nullableText(params.command, 65_536) || !nullableText(params.cwd, 4096) || !nullableText(params.approvalId, 256)) return undefined;
  const commandKind = params.kind ?? 'command';
  if (commandKind !== 'command' && commandKind !== 'writeStdin' && commandKind !== 'humanCommand') return undefined;
  const commandActions = params.commandActions === undefined || params.commandActions === null ? undefined : parseCommandActions(params.commandActions);
  if (params.commandActions !== undefined && params.commandActions !== null && !commandActions) return undefined;
  const additionalPermissions = params.additionalPermissions === undefined || params.additionalPermissions === null ? undefined : parsePermissions(params.additionalPermissions);
  if (params.additionalPermissions !== undefined && params.additionalPermissions !== null && !additionalPermissions) return undefined;
  let networkApprovalContext: { host: string; protocol: 'http' | 'https' | 'socks5Tcp' | 'socks5Udp' } | undefined;
  if (params.networkApprovalContext !== undefined && params.networkApprovalContext !== null) {
    const network = object(params.networkApprovalContext);
    if (!network || !knownKeys(network, ['host', 'protocol']) || !boundedText(network.host, 4096) || !['http', 'https', 'socks5Tcp', 'socks5Udp'].includes(String(network.protocol))) return undefined;
    networkApprovalContext = { host: network.host, protocol: network.protocol as 'http' | 'https' | 'socks5Tcp' | 'socks5Udp' };
  }
  // A managed-network request has its own complete target; ordinary command and
  // stdin prompts require the full native action and working directory.
  if (!networkApprovalContext && (!boundedText(params.command, 65_536) || !boundedText(params.cwd, 4096) || !path.isAbsolute(params.cwd))) return undefined;
  let availableDecisions: ObservedCodexApprovalDecision[] = ['accept', 'decline', 'cancel'];
  if (params.availableDecisions !== undefined && params.availableDecisions !== null) {
    if (!Array.isArray(params.availableDecisions) || params.availableDecisions.length > 32) return undefined;
    availableDecisions = params.availableDecisions.filter((choice): choice is ObservedCodexApprovalDecision => choice === 'accept' || choice === 'decline' || choice === 'cancel');
    if (!availableDecisions.length || new Set(availableDecisions).size !== availableDecisions.length) return undefined;
  }
  return { ...common, kind: 'commandExecution', commandKind, command: typeof params.command === 'string' ? params.command : undefined, cwd: typeof params.cwd === 'string' ? params.cwd : undefined, commandActions, networkApprovalContext, additionalPermissions, availableDecisions };
}

function parseQuestions(value: unknown): ObservedCodexQuestion[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return undefined;
  const questions: ObservedCodexQuestion[] = []; const ids = new Set<string>();
  for (const entry of value) {
    const question = object(entry);
    if (!question || !boundedText(question.id, 256) || ids.has(question.id) || !boundedText(question.header, 1024) || !boundedText(question.question) || question.isOther !== undefined && typeof question.isOther !== 'boolean' || question.isSecret !== undefined && typeof question.isSecret !== 'boolean') return undefined;
    const options = question.options ?? [];
    if (!Array.isArray(options) || options.length > 32) return undefined;
    const parsed: ObservedCodexQuestion['options'] = []; const labels = new Set<string>();
    for (const entry of options) {
      const option = object(entry);
      if (!option || !boundedText(option.label, 1024) || typeof option.description !== 'string' || option.description.length > 8192 || labels.has(option.label)) return undefined;
      labels.add(option.label); parsed.push({ label: option.label, description: option.description });
    }
    ids.add(question.id); questions.push({ id: question.id, header: question.header, question: question.question, isOther: question.isOther === true, isSecret: question.isSecret === true, options: parsed });
  }
  return questions;
}
