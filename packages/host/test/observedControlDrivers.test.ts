import { describe, expect, it, vi } from 'vitest';
import type { HermesObservedStatus, ObservedCodexQueueStatus, ObservedCodexStatus, ObservedReplyStatus, ObservedInboxStatus } from '@extalia/platform';
import { createObservedControlDrivers } from '../src/observedControlDrivers.js';
import { ObservedControlRefusal, type ObservedControlDriverSnapshot } from '../src/observedControlService.js';

function fixture() {
  let source = 'codex';
  let codex: ObservedCodexStatus = { sessionId: 'observed-one', state: 'connected', connectionId: 'codex-connection', threadId: 'original-thread', canSend: true, canAnswer: true, canApprove: true, requests: [], delivery: 'submitted' };
  let queue: ObservedCodexQueueStatus = { sessionId: 'observed-one', enabled: true, canQueue: true, threadId: 'original-thread', delivery: 'queued', messageId: 'queue-receipt' };
  let hermes: HermesObservedStatus = { sessionId: 'observed-one', nativeSessionId: 'original-thread', state: 'connected', connectionId: 'hermes-connection', executionGeneration: 7, running: true, canSend: true, canAnswer: true, requests: [{ id: 'approval-one', kind: 'approval', executionGeneration: 7, question: 'Allow?', choices: ['allow', 'deny'] }], delivery: 'submitted' };
  let reply: ObservedReplyStatus = { sessionId: 'observed-one', state: 'waitingForReply', channelId: 'reply-channel', url: 'http://127.0.0.1:1/reply/example', token: 'private-token', question: 'Continue?' };
  let inbox: ObservedInboxStatus = { sessionId: 'observed-one', state: 'connected', channelId: 'inbox-channel', expiresAt: 123456, token: 'private-token' };
  const dependencies = {
    sourceId: () => source,
    codex: { status: vi.fn(async () => codex), send: vi.fn(async () => codex) },
    codexQueue: { status: vi.fn(async () => queue), send: vi.fn(async () => queue) },
    hermes: { status: vi.fn(() => hermes), send: vi.fn(async () => hermes) },
    replies: { status: vi.fn(() => reply), answer: vi.fn((): ObservedReplyStatus => ({ sessionId: 'observed-one', state: 'answered' })) },
    inboxes: { status: vi.fn(() => inbox), send: vi.fn((_id: string, input: { operationId?: string }): ObservedInboxStatus => ({ ...inbox,
      receipts: [{ operationId: input.operationId, messageId: 'inbox-receipt', state: 'delivered', createdAt: 1 }] })) },
  };
  const drivers = createObservedControlDrivers(dependencies);
  const driver = (route: string) => drivers.find(driver => driver.route === route)!;
  const snapshot = async (route: string) => (await driver(route).status('observed-one'))!;
  return { dependencies, driver, snapshot, source: (value: string) => { source = value; },
    codex: (value: Partial<ObservedCodexStatus>) => { codex = { ...codex, ...value }; },
    queue: (value: Partial<ObservedCodexQueueStatus>) => { queue = { ...queue, ...value }; },
    hermes: (value: Partial<HermesObservedStatus>) => { hermes = { ...hermes, ...value }; },
    reply: (value: Partial<ObservedReplyStatus>) => { reply = { ...reply, ...value }; },
    inbox: (value: Partial<ObservedInboxStatus>) => { inbox = { ...inbox, ...value }; },
  };
}
const message = { text: 'Continue the original conversation' };

describe('existing observed control transport adapters', () => {
  it('checks source ownership before querying native provider-specific status', async () => {
    const f = fixture();
    f.source('gemini');
    expect(await f.driver('codex-native').status('observed-one')).toBeUndefined();
    expect(await f.driver('codex-queue').status('observed-one')).toBeUndefined();
    expect(await f.driver('hermes-native').status('observed-one')).toBeUndefined();
    expect(f.dependencies.codex.status).not.toHaveBeenCalled();
    expect(f.dependencies.codexQueue.status).not.toHaveBeenCalled();
    expect(f.dependencies.hermes.status).not.toHaveBeenCalled();
    expect(await f.driver('cooperative-tool').status('observed-one')).toMatchObject({ actions: ['reply-tool'] });
    expect(await f.driver('cooperative-inbox').status('observed-one')).toMatchObject({ actions: ['inbox-send'] });
  });
  it('keeps an idle Codex start separate from steering its exact active turn', async () => {
    const f = fixture(), driver = f.driver('codex-native');
    const idle = await f.snapshot('codex-native');
    expect(idle).toMatchObject({ bindingId: 'codex-connection', generation: 'idle', actions: ['start'], relatedControls: [{ kind: 'questions', available: true }, { kind: 'approvals', available: true }] });
    expect(await driver.dispatch('observed-one', { ...message, action: 'start' }, idle)).toEqual({ state: 'submitted' });
    expect(f.dependencies.codex.send).toHaveBeenLastCalledWith('observed-one', { connectionId: 'codex-connection', text: message.text });
    f.codex({ activeTurnId: 'exact-turn' });
    const active = await f.snapshot('codex-native');
    expect(active.actions).toEqual(['steer']);
    await driver.dispatch('observed-one', { ...message, action: 'steer' }, active);
    expect(f.dependencies.codex.send).toHaveBeenLastCalledWith('observed-one', { connectionId: 'codex-connection', text: message.text, activeTurnId: 'exact-turn' });
    await expect(driver.dispatch('observed-one', { ...message, action: 'start' }, idle)).rejects.toBeInstanceOf(ObservedControlRefusal);
    expect(f.dependencies.codex.send).toHaveBeenCalledTimes(2);
  });
  it('never silently switches a native start into steer, or steers an unrelated current turn', async () => {
    const f = fixture(), driver = f.driver('codex-native'), snapshot = await f.snapshot('codex-native');
    f.codex({ activeTurnId: 'new-turn' });
    await expect(driver.dispatch('observed-one', { ...message, action: 'start' }, snapshot)).rejects.toBeInstanceOf(ObservedControlRefusal);
    expect(f.dependencies.codex.send).not.toHaveBeenCalled();
    const active = await f.snapshot('codex-native');
    f.codex({ activeTurnId: 'replacement-turn' });
    await expect(driver.dispatch('observed-one', { ...message, action: 'steer' }, active)).rejects.toBeInstanceOf(ObservedControlRefusal);
    expect(f.dependencies.codex.send).not.toHaveBeenCalled();
  });
  it('offers only enabled and ready official queue submission and preserves its receipt', async () => {
    const f = fixture(), driver = f.driver('codex-queue'), snapshot = await f.snapshot('codex-queue');
    expect(await driver.dispatch('observed-one', { ...message, action: 'queue' }, snapshot)).toEqual({ state: 'queued', messageId: 'queue-receipt' });
    expect(f.dependencies.codexQueue.send).toHaveBeenCalledWith('observed-one', { text: message.text });
    f.queue({ enabled: false });
    expect(await driver.status('observed-one')).toBeUndefined();
    await expect(driver.dispatch('observed-one', { ...message, action: 'queue' }, snapshot)).rejects.toBeInstanceOf(ObservedControlRefusal);
    expect(f.dependencies.codexQueue.send).toHaveBeenCalledOnce();
  });
  it('binds Hermes steering intent to the original connection and execution generation', async () => {
    const f = fixture(); f.source('hermes');
    const driver = f.driver('hermes-native'), snapshot = await f.snapshot('hermes-native');
    expect(snapshot).toMatchObject({ bindingId: 'hermes-connection', generation: 7, actions: ['steer'], relatedControls: [{ kind: 'questions', available: false }, { kind: 'approvals', available: true }] });
    expect(await driver.dispatch('observed-one', { ...message, action: 'steer' }, snapshot)).toEqual({ state: 'submitted' });
    expect(f.dependencies.hermes.send).toHaveBeenCalledWith('observed-one', { connectionId: 'hermes-connection', executionGeneration: 7, text: message.text, intent: 'steer' });
    f.hermes({ running: false });
    await expect(driver.dispatch('observed-one', { ...message, action: 'steer' }, snapshot)).rejects.toBeInstanceOf(ObservedControlRefusal);
    expect(f.dependencies.hermes.send).toHaveBeenCalledOnce();
    const idle = await f.snapshot('hermes-native');
    expect(idle.actions).toEqual(['start']);
    await driver.dispatch('observed-one', { ...message, action: 'start' }, idle);
    expect(f.dependencies.hermes.send).toHaveBeenLastCalledWith('observed-one', expect.objectContaining({ intent: 'start' }));
  });
  it('rejects a changed Hermes execution generation', async () => {
    const f = fixture(); f.source('hermes');
    const snapshot = await f.snapshot('hermes-native');
    f.hermes({ executionGeneration: 8 });
    await expect(f.driver('hermes-native').dispatch('observed-one', { ...message, action: 'steer' }, snapshot)).rejects.toBeInstanceOf(ObservedControlRefusal);
    expect(f.dependencies.hermes.send).not.toHaveBeenCalled();
  });
  it.each(['claude', 'gemini', 'antigravity', 'hermes', 'manual-tool'])('returns only a cooperative submitted receipt for a live %s tool call', async source => {
    const f = fixture(); f.source(source);
    const driver = f.driver('cooperative-tool'), snapshot = await f.snapshot('cooperative-tool');
    expect(JSON.stringify(snapshot)).not.toContain('private-token');
    expect(await driver.dispatch('observed-one', { ...message, action: 'reply-tool' }, snapshot)).toEqual({ state: 'submitted' });
    expect(f.dependencies.replies.answer).toHaveBeenCalledWith('observed-one', { channelId: 'reply-channel', text: message.text });
    f.reply({ state: 'waitingForAgent' });
    expect(await driver.status('observed-one')).toBeUndefined();
    await expect(driver.dispatch('observed-one', { ...message, action: 'reply-tool' }, snapshot)).rejects.toBeInstanceOf(ObservedControlRefusal);
    expect(f.dependencies.replies.answer).toHaveBeenCalledOnce();
  });
  it('keeps inbox enqueue receipts queued even if the original consumer polls immediately', async () => {
    const f = fixture(), driver = f.driver('cooperative-inbox'), snapshot = await f.snapshot('cooperative-inbox');
    expect(JSON.stringify(snapshot)).not.toContain('private-token');
    expect(await driver.dispatch('observed-one', { ...message, action: 'inbox-send' }, snapshot)).toEqual({ state: 'queued', messageId: 'inbox-receipt' });
    expect(f.dependencies.inboxes.send).toHaveBeenCalledWith('observed-one', { channelId: 'inbox-channel', text: message.text, operationId: expect.any(String) });
    f.inbox({ channelId: 'replacement-channel' });
    await expect(driver.dispatch('observed-one', { ...message, action: 'inbox-send' }, snapshot)).rejects.toBeInstanceOf(ObservedControlRefusal);
    expect(f.dependencies.inboxes.send).toHaveBeenCalledOnce();
  });
  it('refuses when the inbox rejects enqueue with a capacity problem, without marking uncertain', async () => {
    const f = fixture();
    f.dependencies.inboxes.send.mockReturnValueOnce({ sessionId: 'observed-one', state: 'connected', channelId: 'inbox-channel', problem: 'Inbox queue is full.', receipts: [] });
    await expect(f.driver('cooperative-inbox').dispatch('observed-one', { ...message, action: 'inbox-send' }, await f.snapshot('cooperative-inbox'))).rejects.toThrow(ObservedControlRefusal);
    expect(f.dependencies.inboxes.send).toHaveBeenCalledOnce();
  });
  it('reports unknown when the inbox has no matching enqueue receipt without an explicit problem', async () => {
    const f = fixture();
    f.dependencies.inboxes.send.mockReturnValueOnce({ sessionId: 'observed-one', state: 'connected', channelId: 'inbox-channel', receipts: [] });
    expect(await f.driver('cooperative-inbox').dispatch('observed-one', { ...message, action: 'inbox-send' }, await f.snapshot('cooperative-inbox'))).toEqual({ state: 'unknown' });
    expect(f.dependencies.inboxes.send).toHaveBeenCalledOnce();
  });
  it.each(['cooperative-tool', 'cooperative-inbox'])('rejects oversized %s text before effect', async route => {
    const f = fixture(), driver = f.driver(route), snapshot = await f.snapshot(route), action = route === 'cooperative-tool' ? 'reply-tool' : 'inbox-send';
    for (const text of ['x'.repeat(16_001), 'é'.repeat(9_000)]) await expect(driver.dispatch('observed-one', { text, action }, snapshot)).rejects.toBeInstanceOf(ObservedControlRefusal);
    expect(f.dependencies.replies.answer).not.toHaveBeenCalled();
    expect(f.dependencies.inboxes.send).not.toHaveBeenCalled();
  });
  it('keeps native send uncertainty unknown without selecting another route', async () => {
    const f = fixture(), snapshot = await f.snapshot('codex-native');
    f.codex({ delivery: 'unknown' });
    expect(await f.driver('codex-native').dispatch('observed-one', { ...message, action: 'start' }, snapshot)).toEqual({ state: 'unknown' });
    expect(f.dependencies.inboxes.send).not.toHaveBeenCalled();
    expect(f.dependencies.codexQueue.send).not.toHaveBeenCalled();
  });
  it('refuses forged actions even with a real attachment snapshot', async () => {
    const f = fixture(), snapshot: ObservedControlDriverSnapshot = await f.snapshot('codex-native');
    await expect(f.driver('codex-native').dispatch('observed-one', { ...message, action: 'queue' }, snapshot)).rejects.toBeInstanceOf(ObservedControlRefusal);
    expect(f.dependencies.codex.send).not.toHaveBeenCalled();
  });
});
