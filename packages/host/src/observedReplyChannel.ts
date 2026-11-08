import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ObservedReplyStatus } from '@extalia/platform';

export type { ObservedReplyStatus } from '@extalia/platform';
type ObservedReplyState = ObservedReplyStatus['state'];
export interface ObservedReplyTarget { app: string; nativeSessionId: string; watching: boolean }
interface TimerApi {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
interface Options { target(id: string): ObservedReplyTarget | undefined; timers?: TimerApi }
interface Channel {
  sessionId: string;
  fingerprint: string;
  channelId: string;
  token?: string;
  url: string;
  state: ObservedReplyState;
  question?: string;
  problem?: string;
  expires: ReturnType<typeof setTimeout>;
  waiter?: { response: ServerResponse; timer: ReturnType<typeof setTimeout>; settled: boolean };
}
const MAX_CHANNELS = 32;
const CHANNEL_TTL_MS = 5 * 60_000;
const WAITER_TTL_MS = 45_000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_QUESTION_CHARS = 2_000;
const MAX_ANSWER_CHARS = 16_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const unavailable = (sessionId: string, problem: string): ObservedReplyStatus => ({ sessionId, state: 'unavailable', problem });
const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200;
const boundedId = (value: unknown) => typeof value === 'string' ? value.slice(0, 200) : '';
const fingerprint = (target: ObservedReplyTarget) => JSON.stringify([target.app, target.nativeSessionId]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bearer = (request: IncomingMessage, token: string) => {
  const value = request.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const candidate = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
};
const json = (response: ServerResponse, status: number, value: unknown) => {
  if (response.destroyed || response.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
  response.end(bytes);
};

/** Manual, one-use reply rendezvous for an observed agent that explicitly calls the advertised tool. */
export class ObservedReplyChannels {
  private readonly channels = new Map<string, Channel>();
  private readonly byChannelId = new Map<string, Channel>();
  private readonly timers: TimerApi;
  private readonly pendingCreates = new Map<string, symbol>();
  private server?: Server;
  private listen?: Promise<void>;
  private port?: number;
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly options: Options) {
    this.timers = options.timers ?? { setTimeout, clearTimeout };
  }

  private target(id: string) {
    if (!validId(id)) return undefined;
    const target = this.options.target(id);
    return target?.watching && typeof target.app === 'string' && target.app.length > 0
      && typeof target.nativeSessionId === 'string' && target.nativeSessionId.length > 0 ? target : undefined;
  }

  private ensureServer(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Reply channels are closed.'));
    if (this.listen) return this.listen;
    const server = createServer((request, response) => { void this.handle(request, response).catch(() => json(response, 500, { error: 'Reply request failed.' })); });
    server.requestTimeout = 15_000;
    this.server = server;
    this.listen = new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off('listening', onListening); this.listen = undefined; this.server = undefined; reject(error); };
      const onListening = () => {
        server.off('error', onError);
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('Could not read the reply listener address.')); return; }
        this.port = address.port;
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });
    return this.listen;
  }

  private view(channel: Channel): ObservedReplyStatus {
    const base: ObservedReplyStatus = { sessionId: channel.sessionId, state: channel.state };
    if (channel.channelId) base.channelId = channel.channelId;
    if (channel.url) base.url = channel.url;
    if (channel.token) base.token = channel.token;
    if (channel.question !== undefined) base.question = channel.question;
    if (channel.problem) base.problem = channel.problem;
    return base;
  }

  private validate(channel: Channel): boolean {
    const target = this.target(channel.sessionId);
    if (this.closed || !target || fingerprint(target) !== channel.fingerprint) {
      this.drop(channel.sessionId, 'Observed session changed, paused, or stopped.');
      return false;
    }
    return true;
  }

  async create(id: string): Promise<ObservedReplyStatus> {
    if (!validId(id)) return unavailable(boundedId(id), 'Choose an observed session.');
    if (this.closed) return unavailable(id, 'Reply channels are closed.');
    const target = this.target(id);
    if (!target) return unavailable(id, 'Only a watched observed session can create a reply channel.');
    this.drop(id);
    const generation = Symbol(id);
    this.pendingCreates.set(id, generation);
    const failCreate = (problem: string) => {
      if (this.pendingCreates.get(id) === generation) this.pendingCreates.delete(id);
      return unavailable(id, problem);
    };
    try { await this.ensureServer(); }
    catch { return failCreate('Could not start the loopback reply listener.'); }
    const current = this.target(id);
    if (this.closed || this.pendingCreates.get(id) !== generation || !current || fingerprint(current) !== fingerprint(target) || !this.port) return failCreate('The observed session changed while creating its reply channel.');
    this.makeRoom();
    if (this.channels.size >= MAX_CHANNELS) return failCreate('The reply channel limit has been reached.');
    const channelId = randomUUID();
    const channel: Channel = {
      sessionId: id, fingerprint: fingerprint(target), channelId,
      token: randomBytes(32).toString('hex'), url: `http://127.0.0.1:${this.port}/reply/${channelId}`,
      state: 'waitingForAgent', expires: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    channel.expires = this.timers.setTimeout(() => this.expire(channel, 'Reply channel expired.'), CHANNEL_TTL_MS);
    if (this.pendingCreates.get(id) !== generation || this.closed) { this.timers.clearTimeout(channel.expires); return failCreate('The observed session changed while creating its reply channel.'); }
    this.pendingCreates.delete(id);
    this.channels.set(id, channel);
    this.byChannelId.set(channelId, channel);
    return this.view(channel);
  }

  private makeRoom() {
    for (const [id, channel] of this.channels) {
      if (this.channels.size < MAX_CHANNELS) break;
      if (channel.state === 'waitingForAgent' || channel.state === 'waitingForReply') continue;
      this.timers.clearTimeout(channel.expires);
      this.channels.delete(id);
      this.byChannelId.delete(channel.channelId);
    }
  }

  status(id: string): ObservedReplyStatus {
    if (!validId(id)) return unavailable(boundedId(id), 'Choose an observed session.');
    const channel = this.channels.get(id);
    if (!channel) return this.closed ? unavailable(id, 'Reply channels are closed.') : { sessionId: id, state: 'disconnected' };
    if (!this.validate(channel)) return unavailable(id, 'Observed session changed, paused, or stopped.');
    return this.view(channel);
  }

  answer(id: string, input: { channelId: string; text: string }): ObservedReplyStatus {
    if (!validId(id)) return unavailable(boundedId(id), 'Choose an observed session.');
    const channel = this.channels.get(id);
    if (!channel || channel.channelId !== input?.channelId) return unavailable(id, 'This reply channel is no longer active.');
    if (!this.validate(channel)) return unavailable(id, 'Observed session changed, paused, or stopped.');
    if (channel.state !== 'waitingForReply' || !channel.waiter || channel.waiter.settled) return { ...this.view(channel), problem: 'There is no active question waiting for a reply.' };
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > MAX_ANSWER_CHARS) return { ...this.view(channel), problem: 'Enter a reply of 1 to 16,000 characters.' };
    if (Buffer.byteLength(JSON.stringify({ status: 'answered', text: input.text }), 'utf8') > MAX_RESPONSE_BYTES) return { ...this.view(channel), problem: 'Reply is too large to return safely.' };
    const waiter = channel.waiter;
    waiter.settled = true;
    this.timers.clearTimeout(waiter.timer);
    this.timers.clearTimeout(channel.expires);
    channel.waiter = undefined;
    channel.state = 'answered';
    channel.question = undefined;
    json(waiter.response, 200, { status: 'answered', text: input.text });
    return this.view(channel);
  }

  drop(id: string, problem = 'Reply channel was dropped.'): void {
    this.pendingCreates.delete(id);
    const channel = this.channels.get(id);
    if (!channel) return;
    this.channels.delete(id);
    this.byChannelId.delete(channel.channelId);
    this.timers.clearTimeout(channel.expires);
    channel.token = undefined;
    channel.state = 'unavailable';
    channel.problem = problem;
    this.settleUnavailable(channel);
  }

  private expire(channel: Channel, problem: string) {
    if (this.channels.get(channel.sessionId) !== channel) return;
    this.byChannelId.delete(channel.channelId);
    if (channel.waiter) {
      channel.state = 'expired';
      channel.problem = problem;
      this.settleWaiter(channel, 408, { status: 'expired', problem });
    } else {
      channel.state = 'expired';
      channel.problem = problem;
    }
    channel.token = undefined;
  }

  private settleWaiter(channel: Channel, status: number, body: unknown) {
    const waiter = channel.waiter;
    if (!waiter || waiter.settled) return;
    waiter.settled = true;
    this.timers.clearTimeout(waiter.timer);
    channel.waiter = undefined;
    json(waiter.response, status, body);
  }

  private settleUnavailable(channel: Channel) {
    if (!channel.waiter) return;
    this.settleWaiter(channel, 410, { status: 'unavailable', problem: channel.problem ?? 'Reply channel is unavailable.' });
  }

  private async readBody(request: IncomingMessage, response: ServerResponse): Promise<Buffer | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BODY_BYTES) { json(response, 413, { error: 'Request body exceeds 16 KiB.' }); request.resume(); return undefined; }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const port = this.port;
    if (!port || request.headers.host !== `127.0.0.1:${port}` || request.headers.origin !== undefined) {
      json(response, 403, { error: 'Local reply request rejected.' }); request.resume(); return;
    }
    const match = /^\/reply\/([0-9a-f-]{36})$/i.exec(request.url ?? '');
    if (match && !UUID_PATTERN.test(match[1]!)) { json(response, 404, { error: 'Reply channel not found.' }); request.resume(); return; }
    const channel = match ? this.byChannelId.get(match[1]!) : undefined;
    if (request.method !== 'POST' || !channel) { json(response, 404, { error: 'Reply channel not found.' }); request.resume(); return; }
    if (!this.validate(channel)) { json(response, 410, { error: 'Reply channel is unavailable.' }); request.resume(); return; }
    if (!channel.token || !bearer(request, channel.token)) { json(response, 401, { error: 'Invalid or already used reply token.' }); request.resume(); return; }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers['content-type'] ?? '')) { json(response, 415, { error: 'Content-Type must be application/json.' }); request.resume(); return; }
    const body = await this.readBody(request, response);
    if (!body || response.writableEnded) return;
    let payload: unknown;
    try { payload = JSON.parse(body.toString('utf8')); } catch { json(response, 400, { error: 'Invalid JSON.' }); return; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => key !== 'question')) {
      json(response, 400, { error: 'Expected an object with an optional question.' }); return;
    }
    const question = (payload as { question?: unknown }).question;
    if (question !== undefined && (typeof question !== 'string' || question.length > MAX_QUESTION_CHARS)) { json(response, 400, { error: 'Question must be at most 2,000 characters.' }); return; }
    if (!this.validate(channel) || channel.state !== 'waitingForAgent' || !channel.token) { json(response, 409, { error: 'Reply channel already has an agent or has expired.' }); return; }
    channel.token = undefined;
    channel.question = question as string | undefined;
    channel.state = 'waitingForReply';
    this.byChannelId.delete(channel.channelId);
    const timer = this.timers.setTimeout(() => {
      if (channel.waiter !== waiter || waiter.settled) return;
      channel.state = 'expired';
      channel.problem = 'Agent reply request expired after 45 seconds.';
      this.settleWaiter(channel, 408, { status: 'expired', problem: channel.problem });
    }, WAITER_TTL_MS);
    const waiter: NonNullable<Channel['waiter']> = { response, timer, settled: false };
    channel.waiter = waiter;
    response.once('close', () => {
      if (!waiter.settled && channel.waiter === waiter) this.drop(channel.sessionId, 'Agent disconnected before receiving a reply.');
    });
    request.once('aborted', () => {
      if (!waiter.settled && channel.waiter === waiter) this.drop(channel.sessionId, 'Agent disconnected before receiving a reply.');
    });
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.channels.keys()]) this.drop(id, 'Reply channels are closed.');
    this.pendingCreates.clear();
    const server = this.server;
    const starting = this.listen;
    this.closing = (async () => {
      await starting?.catch(() => undefined);
      if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      this.server = undefined;
      this.listen = undefined;
      this.port = undefined;
    })();
    return this.closing;
  }
}
