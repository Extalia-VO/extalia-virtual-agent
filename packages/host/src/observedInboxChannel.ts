import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ObservedInboxReceipt, ObservedInboxSend, ObservedInboxStatus } from '@extalia/platform';

export type { ObservedInboxStatus } from '@extalia/platform';
export interface ObservedInboxTarget { app: string; nativeSessionId: string; watching: boolean; sourceBinding: string }
interface Timers {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
interface Options { target(id: string): ObservedInboxTarget | undefined; timers?: Timers }
interface Waiter { response: ServerResponse; timer: ReturnType<typeof setTimeout>; acknowledged?: string }
interface Message { receipt: ObservedInboxReceipt; text?: string; digest: string }
interface Channel {
  sessionId: string; fingerprint: string; channelId: string; token?: string; url: string;
  state: ObservedInboxStatus['state']; expiresAt: number; messages: Message[]; waiter?: Waiter;
  expires: ReturnType<typeof setTimeout>; monitor?: ReturnType<typeof setTimeout>;
}
const TTL = 30 * 60_000;
const MAX_WAIT = 25_000;
const MAX_TEXT = 16_000;
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200;
const fingerprint = (t: ObservedInboxTarget) => JSON.stringify([t.app, t.nativeSessionId, t.sourceBinding]);
const unavailable = (id: string, problem: string): ObservedInboxStatus => ({ sessionId: typeof id === 'string' ? id.slice(0, 200) : '', state: 'unavailable', problem });
function json(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed || response.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.length, 'cache-control': 'no-store' });
  response.end(bytes);
}

/** Persistent across polls, memory-only, manually paired transport. No implicit retries. */
export class ObservedInboxChannels {
  private readonly channels = new Map<string, Channel>();
  private readonly pending = new Map<string, symbol>();
  private readonly timers: Timers;
  private server?: Server;
  private starting?: Promise<void>;
  private port?: number;
  private activeRequests = 0;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly options: Options) { this.timers = options.timers ?? { setTimeout, clearTimeout }; }
  private target(id: string) {
    const t = this.options.target(id);
    return t?.watching && validId(t.app) && validId(t.nativeSessionId) && typeof t.sourceBinding === 'string' && t.sourceBinding.length > 0 ? t : undefined;
  }
  private ensureServer(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Inbox closed.'));
    if (this.starting) return this.starting;
    const server = createServer((request, response) => {
      if (this.activeRequests >= 64) { json(response, 503, { status: 'busy' }); request.resume(); return; }
      this.activeRequests++;
      let released = false;
      const release = () => { if (!released) { released = true; this.activeRequests--; } };
      response.once('close', release);
      response.once('finish', release);
      void this.handle(request, response).catch(() => json(response, 400, { status: 'unavailable' }));
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.maxHeadersCount = 32;
    server.maxConnections = 64;
    this.server = server;
    this.starting = new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('Inbox listener unavailable.')); return; }
        this.port = address.port; resolve();
      });
    });
    return this.starting;
  }
  private view(c: Channel): ObservedInboxStatus {
    return { sessionId: c.sessionId, state: c.state, channelId: c.channelId,
      ...(c.token ? { url: c.url, token: c.token } : {}), polling: !!c.waiter,
      expiresAt: c.expiresAt, queued: c.messages.filter(m => m.receipt.state === 'queued').length,
      receipts: c.messages.slice(-32).map(m => ({ ...m.receipt })) };
  }
  private validate(c: Channel) {
    if (this.channels.get(c.sessionId) !== c) return false;
    const target = this.target(c.sessionId);
    if (this.closed || !target || fingerprint(target) !== c.fingerprint) {
      if (this.channels.get(c.sessionId) === c) this.drop(c.sessionId);
      return false;
    }
    return true;
  }
  private monitor(c: Channel) {
    c.monitor = this.timers.setTimeout(() => { if (this.validate(c) && c.state === 'connected') this.monitor(c); }, 250);
    c.monitor.unref?.();
  }
  async create(id: string): Promise<ObservedInboxStatus> {
    if (!validId(id)) return unavailable(id, 'Choose an observed session.');
    if (this.closed) return unavailable(id, 'Inbox channels are closed.');
    const target = this.target(id);
    if (!target) return unavailable(id, 'Only a watched observed session can pair an inbox.');
    const initialFingerprint = fingerprint(target);
    this.drop(id);
    const generation = Symbol(id);
    this.pending.set(id, generation);
    try { await this.ensureServer(); } catch { if (this.pending.get(id) === generation) this.pending.delete(id); return unavailable(id, 'Could not start the loopback inbox.'); }
    const current = this.target(id);
    if (this.closed || this.pending.get(id) !== generation || !current || fingerprint(current) !== initialFingerprint || !this.port) {
      if (this.pending.get(id) === generation) this.pending.delete(id);
      return unavailable(id, 'Observed session changed while pairing.');
    }
    this.pending.delete(id);
    for (const [key, c] of this.channels) if (c.state !== 'connected' && this.channels.size >= 32) this.channels.delete(key);
    if (this.channels.size >= 32) return unavailable(id, 'The inbox channel limit has been reached.');
    const channelId = randomUUID();
    const c: Channel = { sessionId: id, fingerprint: initialFingerprint, channelId, token: randomBytes(32).toString('hex'),
      url: `http://127.0.0.1:${this.port}/inbox/${channelId}`, state: 'connected', expiresAt: Date.now() + TTL, messages: [], expires: undefined as unknown as ReturnType<typeof setTimeout> };
    c.expires = this.timers.setTimeout(() => this.revoke(c, 'expired'), TTL);
    c.expires.unref?.();
    this.channels.set(id, c);
    this.monitor(c);
    return this.view(c);
  }
  status(id: string): ObservedInboxStatus {
    if (!validId(id)) return unavailable(id, 'Choose an observed session.');
    const c = this.channels.get(id);
    if (!c) return this.closed ? unavailable(id, 'Inbox channels are closed.') : { sessionId: id, state: 'disconnected' };
    if (!this.validate(c)) return { ...this.view(c), problem: 'Observed session changed, paused, or stopped.' };
    return this.view(c);
  }
  send(id: string, input: ObservedInboxSend): ObservedInboxStatus {
    const c = this.channels.get(id);
    if (!c || !input || c.channelId !== input.channelId || !this.validate(c) || c.state !== 'connected') return unavailable(id, 'This inbox channel is no longer active.');
    const fail = (problem: string) => ({ ...this.view(c), problem });
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > MAX_TEXT || Buffer.byteLength(input.text) > 16 * 1024) return fail('Enter a message of 1 to 16,000 characters and at most 16 KiB.');
    if (input.operationId !== undefined && (typeof input.operationId !== 'string' || !ID.test(input.operationId))) return fail('Invalid operation ID.');
    const digest = createHash('sha256').update(input.text).digest('hex');
    const previous = input.operationId === undefined ? undefined : c.messages.find(m => m.receipt.operationId === input.operationId);
    if (previous) return previous.digest === digest ? this.view(c) : fail('Operation ID already belongs to a different message.');
    if (c.messages.filter(m => m.receipt.state === 'queued').length >= 16) return fail('Inbox queue is full.');
    // Retain every operation receipt until re-pairing; never evict a deduplication key.
    if (c.messages.length >= 128) return fail('Inbox receipt limit reached; pair a new channel.');
    c.messages.push({ text: input.text, digest, receipt: { messageId: randomUUID(), ...(input.operationId ? { operationId: input.operationId } : {}), state: 'queued', createdAt: Date.now() } });
    this.deliver(c);
    return this.view(c);
  }
  private settle(c: Channel, code: number, result: unknown) {
    const waiter = c.waiter;
    if (!waiter) return;
    c.waiter = undefined;
    this.timers.clearTimeout(waiter.timer);
    json(waiter.response, code, result);
  }
  private deliver(c: Channel) {
    const waiter = c.waiter;
    const m = c.messages.find(message => message.receipt.state === 'queued');
    if (!waiter || !m || !this.validate(c)) return;
    // A broken response is uncertain, and is never automatically replayed.
    m.receipt.state = 'unknown';
    waiter.response.once('finish', () => { if (m.receipt.state === 'unknown') m.receipt.state = 'delivered'; });
    const text = m.text;
    m.text = undefined;
    this.settle(c, 200, { status: 'message', message: { messageId: m.receipt.messageId, text }, ...(waiter.acknowledged ? { acknowledged: waiter.acknowledged } : {}) });
  }
  private revoke(c: Channel, state: 'expired' | 'unavailable') {
    this.timers.clearTimeout(c.expires);
    if (c.monitor) this.timers.clearTimeout(c.monitor);
    c.token = undefined; c.state = state;
    for (const m of c.messages) { if (m.receipt.state === 'queued') m.receipt.state = 'cancelled'; m.text = undefined; }
    this.settle(c, state === 'expired' ? 408 : 410, { status: state });
  }
  drop(id: string): void {
    this.pending.delete(id);
    const c = this.channels.get(id);
    if (c) this.revoke(c, 'unavailable');
  }
  private async handle(request: IncomingMessage, response: ServerResponse) {
    const headerCount = (name: string) => request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index]!.toLowerCase() === name).length;
    if (headerCount('host') !== 1 || headerCount('authorization') !== 1 || request.headers.host !== `127.0.0.1:${this.port}` || request.headers.origin !== undefined) { json(response, 403, { status: 'unavailable' }); request.resume(); return; }
    const match = /^\/inbox\/([^/]+)$/.exec(request.url ?? '');
    const c = match && UUID.test(match[1]!) ? [...this.channels.values()].find(channel => channel.channelId === match[1]) : undefined;
    if (request.method !== 'POST' || !c) { json(response, 404, { status: 'unavailable' }); request.resume(); return; }
    if (!this.validate(c) || c.state !== 'connected') { json(response, c.state === 'expired' ? 408 : 410, { status: c.state === 'expired' ? 'expired' : 'unavailable' }); request.resume(); return; }
    const authorization = request.headers.authorization;
    const candidate = Buffer.from(typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
    const expected = Buffer.from(c.token ?? '');
    if (!expected.length || candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) { json(response, 401, { status: 'unavailable' }); request.resume(); return; }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers['content-type'] ?? '')) { json(response, 415, { status: 'unavailable' }); request.resume(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    const bodyTimer = this.timers.setTimeout(() => { json(response, 408, { status: 'unavailable' }); request.destroy(); }, 5_000);
    try {
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 1024) { json(response, 413, { status: 'unavailable' }); request.resume(); return; }
        chunks.push(bytes);
      }
    } finally { this.timers.clearTimeout(bodyTimer); }
    if (response.destroyed || response.writableEnded) return;
    if (!this.validate(c) || c.state !== 'connected') {
      const expired = this.view(c).state === 'expired';
      json(response, expired ? 408 : 410, { status: expired ? 'expired' : 'unavailable' });
      return;
    }
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid body.');
      row = value as Record<string, unknown>;
    } catch { json(response, 400, { status: 'unavailable' }); return; }
    if (Object.keys(row).some(key => !['operation', 'ack', 'waitMs'].includes(key)) || row.operation !== 'poll' ||
      (row.ack !== undefined && (typeof row.ack !== 'string' || !UUID.test(row.ack))) ||
      (row.waitMs !== undefined && (typeof row.waitMs !== 'number' || !Number.isInteger(row.waitMs) || row.waitMs < 0 || row.waitMs > MAX_WAIT))) { json(response, 400, { status: 'unavailable' }); return; }
    if (c.waiter) { json(response, 409, { status: 'busy' }); return; }
    let acknowledged: string | undefined;
    if (typeof row.ack === 'string') {
      const m = c.messages.find(message => message.receipt.messageId === row.ack);
      if (!m || !['delivered', 'unknown', 'acknowledged'].includes(m.receipt.state)) { json(response, 409, { status: 'unavailable' }); return; }
      m.receipt.state = 'acknowledged'; acknowledged = row.ack;
    }
    // An acknowledgement by itself never consumes the next queued message.
    if (acknowledged && row.waitMs === undefined) { json(response, 200, { status: 'empty', acknowledged }); return; }
    const waitMs = typeof row.waitMs === 'number' ? row.waitMs : 0;
    const timer = this.timers.setTimeout(() => this.settle(c, 200, { status: 'empty', ...(acknowledged ? { acknowledged } : {}) }), waitMs);
    c.waiter = { response, timer, acknowledged };
    const waiter = c.waiter;
    response.once('close', () => { if (c.waiter === waiter) { c.waiter = undefined; this.timers.clearTimeout(timer); } });
    this.deliver(c);
    if (!waitMs && c.waiter === waiter) this.settle(c, 200, { status: 'empty', ...(acknowledged ? { acknowledged } : {}) });
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.pending.clear();
    for (const c of this.channels.values()) this.revoke(c, 'unavailable');
    this.closing = (async () => {
      await this.starting?.catch(() => undefined);
      const server = this.server;
      if (server?.listening) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      this.server = undefined; this.port = undefined;
    })();
    return this.closing;
  }
}
