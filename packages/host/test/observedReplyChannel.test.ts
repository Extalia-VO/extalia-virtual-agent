import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { ObservedReplyChannels } from '../src/observedReplyChannel.js';

const brokers: ObservedReplyChannels[] = [];
const make = (target: { app: string; nativeSessionId: string; watching: boolean } = { app: 'gemini-cli', nativeSessionId: 'native-1', watching: true }, timers?: ConstructorParameters<typeof ObservedReplyChannels>[0]['timers']) => {
  const broker = new ObservedReplyChannels({ target: () => target, ...(timers ? { timers } : {}) });
  brokers.push(broker);
  return { broker, target };
};
const attach = (status: { url?: string; token?: string }, body: unknown = {}) => fetch(status.url!, {
  method: 'POST',
  headers: { Authorization: `Bearer ${status.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const waitFor = async (fn: () => boolean) => {
  for (let i = 0; i < 50 && !fn(); i++) await new Promise(resolve => setTimeout(resolve, 2));
  expect(fn()).toBe(true);
};
afterEach(async () => { await Promise.all(brokers.splice(0).map(broker => broker.close())); });

describe('ObservedReplyChannels', () => {
  it('creates a loopback-only, one-use channel and returns the manual answer to exactly one waiting caller', async () => {
    const { broker } = make();
    const created = await broker.create('observed-1');
    expect(created).toMatchObject({ sessionId: 'observed-1', state: 'waitingForAgent' });
    expect(created.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/reply\/[0-9a-f-]{36}$/);
    expect(created.token).toMatch(/^[a-f0-9]{64}$/);

    const wrongToken = await fetch(created.url!, { method: 'POST', headers: { Authorization: `Bearer ${'0'.repeat(64)}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(wrongToken.status).toBe(401);
    const origin = await fetch(created.url!, { method: 'POST', headers: { Authorization: `Bearer ${created.token}`, 'Content-Type': 'application/json', Origin: 'http://example.test' }, body: '{}' });
    expect(origin.status).toBe(403);
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(created.url!, { method: 'POST', headers: { Authorization: `Bearer ${created.token}`, 'Content-Type': 'application/json', Host: 'localhost' } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode ?? 0));
      });
      req.on('error', reject); req.end('{}');
    });
    expect(wrongHost).toBe(403);
    const badJson = await fetch(created.url!, { method: 'POST', headers: { Authorization: `Bearer ${created.token}`, 'Content-Type': 'application/json' }, body: '{' });
    expect(badJson.status).toBe(400);

    const caller = attach(created, { question: 'Which option?' });
    await waitFor(() => broker.status('observed-1').state === 'waitingForReply');
    expect(broker.status('observed-1')).toMatchObject({ state: 'waitingForReply', question: 'Which option?' });
    expect(broker.status('observed-1').token).toBeUndefined();
    const duplicate = await attach(created, {});
    expect(duplicate.status).toBe(404);

    expect(broker.answer('observed-1', { channelId: created.channelId!, text: '\0'.repeat(16_000) }).state).toBe('waitingForReply');
    const answerText = '界'.repeat(16_000);
    const answered = broker.answer('observed-1', { channelId: created.channelId!, text: answerText });
    expect(answered.state).toBe('answered');
    expect(await (await caller).json()).toEqual({ status: 'answered', text: answerText });
    expect(broker.answer('observed-1', { channelId: created.channelId!, text: 'Option C' }).state).toBe('answered');
  });

  it('rejects oversized requests without consuming the token and drops channels on source changes', async () => {
    const { broker, target } = make();
    const created = await broker.create('observed-2');
    const tooLarge = await fetch(created.url!, { method: 'POST', headers: { Authorization: `Bearer ${created.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'q'.repeat(20_000) }) });
    expect(tooLarge.status).toBe(413);
    const pending = attach(created, { question: 'Continue?' });
    await waitFor(() => broker.status('observed-2').state === 'waitingForReply');
    target.nativeSessionId = 'different-native-thread';
    expect(broker.answer('observed-2', { channelId: created.channelId!, text: 'Yes' }).state).toBe('unavailable');
    expect((await pending).status).toBe(410);
  });

  it('expires unanswered agent calls and the five-minute channel using injected timers', async () => {
    let now = 0;
    const scheduled: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];
    const timers = {
      setTimeout(callback: () => void, ms: number) { const entry = { at: now + ms, callback, cancelled: false }; scheduled.push(entry); return entry as unknown as ReturnType<typeof setTimeout>; },
      clearTimeout(timer: ReturnType<typeof setTimeout>) { (timer as unknown as { cancelled: boolean }).cancelled = true; },
    };
    const advance = (delta: number) => {
      now += delta;
      for (const entry of [...scheduled].sort((a, b) => a.at - b.at)) if (!entry.cancelled && entry.at <= now) { entry.cancelled = true; entry.callback(); }
    };
    const { broker } = make(undefined, timers);
    const created = await broker.create('observed-3');
    const pending = attach(created, { question: 'Reply?' });
    await waitFor(() => broker.status('observed-3').state === 'waitingForReply');
    advance(45_000);
    expect(broker.status('observed-3').state).toBe('expired');
    expect(await (await pending).json()).toMatchObject({ status: 'expired' });

    const fresh = await broker.create('observed-3');
    advance(5 * 60_000);
    expect(broker.status('observed-3')).toMatchObject({ state: 'expired', problem: 'Reply channel expired.' });
    expect(broker.answer('observed-3', { channelId: fresh.channelId!, text: 'Too late' }).state).toBe('expired');
  });

  it('settles a waiting caller on drop, enforces the global cap, and closes its listener', async () => {
    const targets = new Map(Array.from({ length: 33 }, (_, i) => [`s-${i}`, { app: 'antigravity', nativeSessionId: `thread-${i}`, watching: true }]));
    const broker = new ObservedReplyChannels({ target: id => targets.get(id) });
    brokers.push(broker);
    const channels = await Promise.all(Array.from({ length: 32 }, (_, i) => broker.create(`s-${i}`)));
    expect(channels.every(channel => channel.state === 'waitingForAgent')).toBe(true);
    expect((await broker.create('s-32')).state).toBe('unavailable');
    const waiting = attach(channels[0]!, { question: 'Any preference?' });
    await waitFor(() => broker.status('s-0').state === 'waitingForReply');
    broker.drop('s-0');
    expect(await (await waiting).json()).toMatchObject({ status: 'unavailable' });
    await broker.close();
    expect(broker.status('s-1').state).toBe('unavailable');
    await expect(fetch(channels[1]!.url!, { method: 'POST', headers: { Authorization: `Bearer ${channels[1]!.token}`, 'Content-Type': 'application/json' }, body: '{}' })).rejects.toThrow();
  });

  it('seals a channel dropped during listener startup and closes without leaving an orphan listener', async () => {
    const { broker } = make();
    const creating = broker.create('observed-race');
    broker.drop('observed-race');
    expect((await creating).state).toBe('unavailable');
    const second = broker.create('observed-race');
    const closing = broker.close();
    expect((await second).state).toBe('unavailable');
    await closing;
    expect(broker.status('observed-race').state).toBe('unavailable');
  });

  it('drops an abandoned HTTP waiter and invalidates its reply channel', async () => {
    const { broker } = make();
    const created = await broker.create('observed-4');
    const controller = new AbortController();
    const request = fetch(created.url!, { method: 'POST', headers: { Authorization: `Bearer ${created.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Reply?' }), signal: controller.signal }).catch(() => undefined);
    await waitFor(() => broker.status('observed-4').state === 'waitingForReply');
    controller.abort();
    await request;
    await waitFor(() => broker.status('observed-4').state === 'disconnected');
    expect(broker.answer('observed-4', { channelId: created.channelId!, text: 'No caller' }).state).toBe('unavailable');
  });
});
