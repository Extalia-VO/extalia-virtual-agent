import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { CodexPermissionHookAnswer, CodexPermissionHookDecision, CodexPermissionHookRequest, CodexPermissionHookStatus } from '@extalia/platform';

export interface CodexPermissionTarget {
  threadId: string;
  codexHome: string;
  sourceFingerprint: string;
  cwd?: string;
  watching: boolean;
}
interface Timers {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
interface Options {
  /** Host-owned canonical source binding. Undefined also disables admission. */
  target(id: string): CodexPermissionTarget | undefined;
  /** Resolves native UUID and canonical transcript path to one watched source. */
  resolve(payload: Record<string, unknown>): string | undefined;
  /** Dedicated permission secret; never the notification ingest token. */
  verifyToken(given: string): Promise<boolean>;
  timers?: Timers;
}
interface Pending {
  sessionId: string;
  source: string;
  nativeRequestId: string;
  view: CodexPermissionHookRequest;
  response: ServerResponse;
  request: IncomingMessage;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  check: ReturnType<typeof setTimeout>;
  disconnect(): void;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 64 * 1024;
const MAX_REQUESTS = 32;
const TTL = 55_000;
const PASS = { decision: 'pass', confirmed: false } as const;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const absolute = (value: unknown): value is string => text(value) && path.isAbsolute(value);
const fingerprint = (value: CodexPermissionTarget) => JSON.stringify([value.threadId, value.codexHome, value.sourceFingerprint, value.cwd]);
const unavailable = (sessionId: string, problem: string): CodexPermissionHookStatus => ({ sessionId, state: 'unavailable', requests: [], problem });

function reply(response: ServerResponse, value: unknown = PASS, status = 200) {
  if (response.destroyed || response.writableEnded || response.headersSent) return;
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(bytes);
}

/** JSON.parse validates syntax; this additional bounded scan rejects hidden duplicate keys. */
function uniqueKeys(source: string): boolean {
  const stack: Array<{ object: boolean; key: boolean; keys: Set<string> }> = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      const start = i++;
      while (i < source.length && source[i] !== '"') { if (source[i] === '\\') i++; i++; }
      const frame = stack.at(-1);
      if (frame?.object && frame.key) {
        const key = JSON.parse(source.slice(start, i + 1)) as string;
        if (frame.keys.has(key)) return false;
        frame.keys.add(key);
      }
    } else if (c === '{' || c === '[') {
      if (stack.length >= 64) return false;
      stack.push({ object: c === '{', key: c === '{', keys: new Set() });
    } else if (c === '}' || c === ']') stack.pop();
    else if (c === ':' && stack.at(-1)?.object) stack.at(-1)!.key = false;
    else if (c === ',' && stack.at(-1)?.object) stack.at(-1)!.key = true;
  }
  return true;
}

/** Only the complete Bash shape verified against native Codex 0.167.0 admits allow. */
function allowAvailable(payload: Record<string, unknown>, target: CodexPermissionTarget): boolean {
  const keys = ['session_id', 'turn_id', 'transcript_path', 'cwd', 'hook_event_name', 'model', 'permission_mode', 'tool_name', 'tool_input'];
  const input = payload.tool_input;
  return Object.keys(payload).length === keys.length && Object.keys(payload).every(key => keys.includes(key))
    && payload.tool_name === 'Bash' && payload.permission_mode === 'default' && text(payload.model, 512)
    && absolute(target.cwd) && payload.cwd === target.cwd
    && object(input) && Object.keys(input).every(key => key === 'command' || key === 'description')
    && text(input.command, MAX_BODY) && (input.description === undefined || typeof input.description === 'string');
}

/** Holds only the original hook HTTP response. No socket RPC, queue, transcript or persistent grant can decide it. */
export class CodexPermissionBroker {
  private readonly pending = new Map<string, Pending>();
  /** Bounded replay receipts retain no command, source payload or decision. */
  private readonly usedNonces = new Map<string, number>();
  private readonly paused = new Set<string>();
  private readonly receiving = new Set<ServerResponse>();
  private readonly timers: Timers;
  private reads = 0;
  private epoch = 0;
  private closed = false;

  constructor(private readonly options: Options) { this.timers = options.timers ?? { setTimeout, clearTimeout }; }

  private target(id: string): CodexPermissionTarget | undefined {
    if (this.closed || this.paused.has(id) || !text(id, 200)) return undefined;
    try {
      const target = this.options.target(id);
      return target?.watching && UUID.test(target.threadId) && absolute(target.codexHome)
        && /^[0-9a-f]{64}$/.test(target.sourceFingerprint) && (target.cwd === undefined || absolute(target.cwd)) ? target : undefined;
    } catch { return undefined; }
  }

  private current(pending: Pending) {
    const target = this.target(pending.sessionId);
    return !!target && fingerprint(target) === pending.source && performance.now() < pending.deadline
      && !pending.request.aborted && !pending.response.destroyed && !pending.response.writableEnded;
  }

  private settle(pending: Pending, decision: CodexPermissionHookDecision = 'pass') {
    if (this.pending.get(pending.view.requestId) !== pending) return;
    this.pending.delete(pending.view.requestId);
    this.timers.clearTimeout(pending.timer);
    this.timers.clearTimeout(pending.check);
    pending.request.off('aborted', pending.disconnect);
    pending.response.off('close', pending.disconnect);
    reply(pending.response, decision === 'pass' ? PASS : {
      decision, confirmed: true, requestId: pending.nativeRequestId,
      nativeSessionId: pending.view.nativeSessionId, turnId: pending.view.turnId, toolName: pending.view.toolName,
    });
  }

  private recheck(pending: Pending) {
    if (!this.current(pending)) { this.settle(pending); return; }
    pending.check = this.timers.setTimeout(() => this.recheck(pending), 250);
  }

  status(id: string): CodexPermissionHookStatus {
    if (!this.target(id)) {
      for (const pending of [...this.pending.values()]) if (pending.sessionId === id) this.settle(pending);
      return unavailable(typeof id === 'string' ? id.slice(0, 200) : '', 'The watched Codex source is unavailable or permission hooks are disabled.');
    }
    for (const pending of [...this.pending.values()]) if (pending.sessionId === id && !this.current(pending)) this.settle(pending);
    return { sessionId: id, state: 'ready', requests: [...this.pending.values()].filter(pending => pending.sessionId === id).map(pending => ({ ...pending.view, availableDecisions: [...pending.view.availableDecisions] })) };
  }

  answer(id: string, input: CodexPermissionHookAnswer): CodexPermissionHookStatus {
    const pending = this.pending.get(input?.requestId);
    if (!pending || pending.sessionId !== id) return { ...this.status(id), problem: 'This native hook request is no longer waiting.' };
    if (!this.current(pending)) { this.settle(pending); return unavailable(id, 'The native hook caller or watched source changed.'); }
    if (input.payloadDigest !== pending.view.payloadDigest || !pending.view.availableDecisions.includes(input.decision)) return { ...this.status(id), problem: 'Review the complete current request before choosing an available decision.' };
    this.settle(pending, input.decision);
    return this.status(id);
  }

  drop(id: string): void {
    this.epoch++;
    if (text(id, 200)) this.paused.add(id);
    // A body not yet parsed has no trustworthy session association. Revoke it conservatively.
    for (const response of this.receiving) reply(response);
    for (const pending of [...this.pending.values()]) if (pending.sessionId === id) this.settle(pending);
  }

  resume(id: string): void { if (!this.closed) this.paused.delete(id); }

  private read(request: IncomingMessage): Promise<Buffer | undefined> {
    if (Number(request.headers['content-length']) > MAX_BODY) { request.resume(); return Promise.resolve(undefined); }
    return new Promise(resolve => {
      const chunks: Buffer[] = [];
      let size = 0;
      const done = (result?: Buffer) => {
        this.timers.clearTimeout(timer);
        request.off('data', data); request.off('end', end); request.off('error', fail); request.off('aborted', fail);
        request.resume(); resolve(result);
      };
      const data = (chunk: Buffer) => { size += chunk.length; if (size > MAX_BODY) done(); else chunks.push(chunk); };
      const end = () => done(Buffer.concat(chunks, size));
      const fail = () => done();
      const timer = this.timers.setTimeout(fail, 5_000);
      request.on('data', data); request.once('end', end); request.once('error', fail); request.once('aborted', fail);
    });
  }

  /** Caller must check the exact listener Host and route before invoking this handler. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // IncomingMessage can emit ECONNRESET after `aborted`, including while auth is awaiting.
    // Keep this sink for the request's lifetime after the body reader removes its own listeners.
    request.on('error', () => undefined);
    if (request.headers.origin !== undefined) { request.resume(); reply(response, PASS, 403); return; }
    if (request.method !== 'POST') { request.resume(); reply(response, PASS, 405); return; }
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') { request.resume(); reply(response, PASS, 415); return; }
    if (this.closed || this.reads + this.pending.size >= MAX_REQUESTS) { request.resume(); reply(response); return; }
    this.reads++;
    this.receiving.add(response);
    const epoch = this.epoch;
    try {
      const token = typeof request.headers.authorization === 'string' ? /^Bearer (\S+)$/.exec(request.headers.authorization)?.[1] : undefined;
      if (!token || !(await this.options.verifyToken(token))) { request.resume(); reply(response, PASS, 401); return; }
      if (this.closed || this.epoch !== epoch || request.aborted || response.destroyed || response.writableEnded) { request.resume(); reply(response); return; }
      const body = await this.read(request);
      if (!body || request.aborted || response.destroyed || response.writableEnded || this.closed || this.epoch !== epoch) { reply(response); return; }
      const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
      const envelope: unknown = JSON.parse(source);
      if (!uniqueKeys(source) || !object(envelope) || Object.keys(envelope).length !== 2 || !text(envelope.requestId, 36) || !UUID.test(envelope.requestId) || !object(envelope.payload)) { reply(response); return; }
      const payload = envelope.payload;
      if (payload.hook_event_name !== 'PermissionRequest' || !text(payload.session_id, 36) || !UUID.test(payload.session_id)
        || !text(payload.turn_id, 200) || !text(payload.tool_name, 200) || !absolute(payload.transcript_path) || !absolute(payload.cwd) || !object(payload.tool_input)) { reply(response); return; }
      const id = this.options.resolve(payload);
      const target = id ? this.target(id) : undefined;
      if (!id || !target || target.threadId !== payload.session_id || target.cwd !== payload.cwd) { reply(response); return; }
      const sourceJson = JSON.stringify(payload);
      const payloadDigest = createHash('sha256').update(sourceJson).digest('hex');
      const now = performance.now();
      for (const [nonce, deadline] of this.usedNonces) if (deadline <= now) this.usedNonces.delete(nonce);
      // A retried request or simultaneous duplicate never inherits another caller's decision.
      if (this.usedNonces.has(envelope.requestId) || this.usedNonces.size >= 1024
        || [...this.pending.values()].some(pending => pending.sessionId === id && pending.view.turnId === payload.turn_id && pending.view.payloadDigest === payloadDigest)) { reply(response); return; }
      const view: CodexPermissionHookRequest = {
        requestId: randomUUID(), payloadDigest, nativeSessionId: payload.session_id, turnId: payload.turn_id,
        toolName: payload.tool_name, sourceJson, expiresAt: new Date(Date.now() + TTL).toISOString(),
        availableDecisions: allowAvailable(payload, target) ? ['allow', 'deny', 'pass'] : ['deny', 'pass'],
      };
      const pending: Pending = {
        sessionId: id, source: fingerprint(target), nativeRequestId: envelope.requestId, view, request, response,
        deadline: performance.now() + TTL,
        timer: undefined as unknown as ReturnType<typeof setTimeout>, check: undefined as unknown as ReturnType<typeof setTimeout>,
        disconnect: () => this.settle(pending),
      };
      this.usedNonces.set(envelope.requestId, now + TTL);
      this.pending.set(view.requestId, pending);
      request.once('aborted', pending.disconnect); response.once('close', pending.disconnect);
      pending.timer = this.timers.setTimeout(() => this.settle(pending), TTL);
      pending.check = this.timers.setTimeout(() => this.recheck(pending), 250);
    } catch { reply(response); }
    finally { this.reads--; this.receiving.delete(response); }
  }

  close(): void {
    this.closed = true; this.epoch++;
    for (const response of this.receiving) reply(response);
    for (const pending of [...this.pending.values()]) this.settle(pending);
    this.paused.clear();
    this.usedNonces.clear();
  }
}
