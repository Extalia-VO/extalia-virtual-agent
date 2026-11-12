import * as jsonStore from '../src/jsonStore.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { CodexUserInputEvidence } from '@extalia/importers';
import type { ObservedCodexQueueStatus, ObservedCodexStatus } from '@extalia/platform';
import { ObservedUserInputService } from '../src/observedUserInputService.js';
import type { ObservedCodexQueueTarget } from '../src/observedCodexQueueService.js';
async function fixture() {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'extalia-input-'));
  let source: ObservedCodexQueueTarget | undefined = { codexHome: path.join(dataDirectory, 'codex'), sourceFingerprint: 'source-one', threadId: '11111111-1111-4111-8111-111111111111', watching: true };
  let evidence: CodexUserInputEvidence = { requests: [{ callId: 'call-one', canAnswer: true, questions: [{ title: 'Which scope?', options: ['One', 'Two'] }, { title: 'Any detail?', options: [] }] }], replies: [] };
  let labelsOnly = false;
  let nativeStatus: ObservedCodexStatus = { sessionId: 'session-one', state: 'disconnected', canAnswer: false, canSend: false, requests: [] };
  const native = { status: vi.fn(async () => nativeStatus), answer: vi.fn(async () => nativeStatus) };
  const queue = { status: vi.fn(async (): Promise<ObservedCodexQueueStatus> => ({ sessionId: 'session-one', enabled: true, canQueue: true })), setEnabled: vi.fn(async () => ({ sessionId: 'session-one', enabled: true, canQueue: true })), send: vi.fn(async (_id: string, _input: { text: string }) => ({ sessionId: 'session-one', enabled: true, canQueue: true, delivery: 'queued' as const })) };
  const options = { dataDirectory, target: () => source, evidence: () => evidence, labelsOnly: () => labelsOnly, native, queue };
  const service = await ObservedUserInputService.create(options);
  const input = async () => { const request = (await service.status('session-one')).requests[0]!; return { requestId: request.id, revision: request.revision, answers: Object.fromEntries(request.questions.map((question, index) => [question.id, index ? 'User detail' : 'One'])) }; };
  return { service, options, queue, native, input, setPrivacy: () => { labelsOnly = true; service.invalidatePrivacy(); }, replace: () => { source = { ...source!, sourceFingerprint: 'source-two' }; }, removeQueueSource: () => { source = undefined; }, setEvidence: (value: CodexUserInputEvidence) => { evidence = value; }, setNative: (value: ObservedCodexStatus) => { nativeStatus = value; }, cleanup: async () => { await service.close(); await rm(dataDirectory, { recursive: true, force: true }); } };
}
function nativeQuestion(): ObservedCodexStatus {
  return { sessionId: 'session-one', state: 'connected', threadId: '11111111-1111-4111-8111-111111111111', connectionId: 'connection-one', canAnswer: true, canSend: false,
    requests: [{ id: 'rpc-one', turnId: 'turn-one', itemId: 'item-one', state: 'pending', questions: [{ id: 'q-one', header: 'Scope', question: 'Which scope?', isOther: true, isSecret: false, options: [] }] }] };
}
describe('observed input aggregation and delivery', () => {
  it('queues exact same-thread reply envelopes and persists only safe receipts across restart', async () => {
    const f = await fixture();
    try {
      const input = await f.input();
      expect((await f.service.answer('session-one', input)).requests[0]).toMatchObject({ state: 'queued', canAnswer: false });
      const text = f.queue.send.mock.calls[0]?.[1]?.text;
      expect(text).toBe(`<send_user_message_question_reply>${JSON.stringify([{ questionItemId: '["request_user_input_async","call-one",0]', question: 'Which scope?', answer: 'One' }, { questionItemId: '["request_user_input_async","call-one",1]', question: 'Any detail?', answer: 'User detail' }])}</send_user_message_question_reply>`);
      const saved = await readFile(path.join(f.options.dataDirectory, 'state', 'observed-user-input.json'), 'utf8');
      expect(saved).not.toMatch(/Which scope|User detail|codexHome|call-one/);
      const restored = await ObservedUserInputService.create(f.options);
      expect((await restored.status('session-one')).requests[0]).toMatchObject({ state: 'queued', canAnswer: false });
      await expect(restored.answer('session-one', input)).rejects.toThrow('already answered');
      await restored.close();
      expect(f.queue.send).toHaveBeenCalledOnce();
    } finally { await f.cleanup(); }
  });
  it('rejects oversized UTF-8 envelopes before queue enablement or durable admission and permits a shorter retry', async () => {
    const f = await fixture();
    try {
      f.queue.status.mockResolvedValue({ sessionId: 'session-one', enabled: false, canQueue: false, canEnable: true });
      const input = await f.input();
      const oversized = { ...input, answers: Object.fromEntries(Object.keys(input.answers).map(id => [id, '界'.repeat(3000)])) };
      await expect(f.service.answer('session-one', oversized)).rejects.toThrow('combined answer is too long');
      expect(f.queue.setEnabled).not.toHaveBeenCalled();
      expect(f.queue.send).not.toHaveBeenCalled();
      await expect(readFile(path.join(f.options.dataDirectory, 'state', 'observed-user-input.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await f.service.status('session-one')).requests[0]).toMatchObject({ state: 'pending', canAnswer: true });
      const shortened = { ...input, answers: Object.fromEntries(Object.keys(input.answers).map(id => [id, '精簡'])) };
      expect((await f.service.answer('session-one', shortened)).requests[0]?.state).toBe('queued');
      expect(f.queue.setEnabled).toHaveBeenCalledOnce();
      expect(f.queue.send).toHaveBeenCalledOnce();
    } finally { await f.cleanup(); }
  });
  it('keeps uncertain delivery across restart and blocks concurrent and stale answers', async () => {
    const f = await fixture();
    try {
      f.queue.send.mockRejectedValueOnce(new Error('delivery unknown'));
      const input = await f.input(), first = f.service.answer('session-one', input);
      await expect(f.service.answer('session-one', input)).rejects.toThrow('already being submitted');
      expect((await first).requests[0]?.state).toBe('unknown');
      const restored = await ObservedUserInputService.create(f.options);
      expect((await restored.status('session-one')).requests[0]).toMatchObject({ state: 'unknown', canAnswer: false });
      await restored.close();
      f.replace();
      await expect(f.service.answer('session-one', input)).rejects.toThrow('changed');
      expect(f.queue.send).toHaveBeenCalledOnce();
    } finally { await f.cleanup(); }
  });
  it('resolves only exact correlated source replies and retains other unanswered questions', async () => {
    const f = await fixture();
    try {
      const evidence = f.options.evidence()!;
      f.setEvidence({ ...evidence, replies: [{ questionItemId: '["request_user_input_async","call-one",0]', question: 'Different question' }] });
      expect((await f.service.status('session-one')).requests[0]?.questions).toHaveLength(2);
      f.setEvidence({ ...evidence, replies: [{ questionItemId: '["request_user_input_async","call-one",0]', question: 'Which scope?' }] });
      expect((await f.service.status('session-one')).requests[0]?.questions).toHaveLength(1);
      f.setEvidence({ ...evidence, replies: evidence.requests[0]!.questions.map((question, index) => ({ questionItemId: JSON.stringify(['request_user_input_async', 'call-one', index]), question: question.title })) });
      expect((await f.service.status('session-one')).requests).toEqual([]);
    } finally { await f.cleanup(); }
  });
  it('bounds public responses and never advertises async answers when queue capability is unavailable', async () => {
    const f = await fixture();
    try {
      f.setEvidence({ replies: [], requests: Array.from({ length: 100 }, (_, index) => ({ callId: `call-${index}`, canAnswer: true, askedAt: new Date(index * 1000).toISOString(), questions: [{ title: 'Scope?', options: [] }] })) });
      const ready = await f.service.status('session-one');
      expect(ready.requests).toHaveLength(32);
      expect(ready.requests.every(request => request.canAnswer)).toBe(true);
      f.queue.status.mockResolvedValue({ sessionId: 'session-one', enabled: false, canQueue: false, canEnable: false });
      const unavailable = await f.service.status('session-one');
      expect(unavailable.requests.every(request => !request.canAnswer)).toBe(true);
      await expect(f.service.answer('session-one', await f.input())).rejects.toThrow('unavailable');
      expect(f.queue.send).not.toHaveBeenCalled();
      expect(f.queue.setEnabled).not.toHaveBeenCalled();
      f.queue.status.mockResolvedValue({ sessionId: 'session-one', enabled: true, canQueue: false, delivery: 'unknown' });
      expect((await f.service.status('session-one')).requests.every(request => !request.canAnswer)).toBe(true);
    } finally { await f.cleanup(); }
  });
  it('revalidates source answer capability after a queue status await', async () => {
    const f = await fixture();
    try {
      const input = await f.input();
      let release!: (value: ObservedCodexQueueStatus) => void;
      const pending = new Promise<ObservedCodexQueueStatus>(resolve => { release = resolve; });
      f.queue.status.mockImplementationOnce(() => pending);
      const answer = f.service.answer('session-one', input);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      const evidence = f.options.evidence()!;
      f.setEvidence({ ...evidence, requests: evidence.requests.map(request => ({ ...request, canAnswer: false, conflicted: true })) });
      release({ sessionId: 'session-one', enabled: true, canQueue: true });
      await expect(answer).rejects.toThrow('changed');
      expect(f.queue.send).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
  it('rechecks exact source replies after the durable write-ahead await', async () => {
    const f = await fixture();
    const actual = jsonStore.writeJsonAtomic;
    let started!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementationOnce(async (...args) => { started(); await gate; return actual(...args); });
    try {
      const input = await f.input(), answer = f.service.answer('session-one', input);
      await began;
      const evidence = f.options.evidence()!;
      f.setEvidence({ ...evidence, replies: [{ questionItemId: '["request_user_input_async","call-one",0]', question: 'Which scope?' }] });
      release();
      await expect(answer).rejects.toThrow('changed before submission');
      expect(f.queue.send).not.toHaveBeenCalled();
      expect((await f.service.status('session-one')).requests[0]?.state).toBe('unknown');
    } finally { release(); spy.mockRestore(); await f.cleanup(); }
  });
  it('keeps receipt corruption fail-closed without preventing host startup', async () => {
    const f = await fixture();
    try {
      await mkdir(path.join(f.options.dataDirectory, 'state'), { recursive: true });
      await writeFile(path.join(f.options.dataDirectory, 'state', 'observed-user-input.json'), 'invalid');
      const restored = await ObservedUserInputService.create(f.options);
      const status = await restored.status('session-one');
      expect(status.state).toBe('ready');
      expect(status.requests[0]?.canAnswer).toBe(false);
      const request = status.requests[0]!;
      await expect(restored.answer('session-one', { requestId: request.id, revision: request.revision, answers: Object.fromEntries(request.questions.map(question => [question.id, 'One'])) })).rejects.toThrow();
      expect(f.queue.send).not.toHaveBeenCalled();
      await restored.close();
    } finally { await f.cleanup(); }
  });
  it('keeps a verified native question answerable when its queue source disappears', async () => {
    const f = await fixture();
    try {
      f.setEvidence({ requests: [], replies: [] });
      f.setNative(nativeQuestion());
      const input = await f.input();
      f.queue.status.mockClear();
      f.removeQueueSource();
      expect((await f.service.status('session-one')).requests[0]).toMatchObject({ id: input.requestId, revision: input.revision, origin: 'codex-native', identityVerified: true, canAnswer: true });
      await f.service.answer('session-one', input);
      expect(f.native.answer).toHaveBeenCalledWith('session-one', { connectionId: 'connection-one', requestId: 'rpc-one', answers: { 'q-one': 'One' } });
      expect(f.queue.status).not.toHaveBeenCalled();
      expect(f.queue.setEnabled).not.toHaveBeenCalled();
      expect(f.queue.send).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
  it.each(['pause', 'disconnect', 'closed', 'private', 'stale-connection', 'stale-thread'] as const)('rejects native-only answers after %s', async reason => {
    const f = await fixture();
    try {
      f.removeQueueSource();
      const status = nativeQuestion();
      f.setNative(status);
      const input = await f.input();
      if (reason === 'pause') await f.service.drop('session-one');
      else if (reason === 'disconnect') f.setNative({ ...status, state: 'disconnected', canAnswer: false, requests: [] });
      else if (reason === 'closed') await f.service.close();
      else if (reason === 'private') f.setPrivacy();
      else if (reason === 'stale-connection') f.setNative({ ...status, connectionId: 'connection-two' });
      else f.setNative({ ...status, threadId: '22222222-2222-4222-8222-222222222222' });
      const current = await f.service.status('session-one');
      if (reason === 'private') expect(current).toMatchObject({ state: 'private', requests: [] });
      else if (reason.startsWith('stale-')) expect(current.requests[0]?.id).not.toBe(input.requestId);
      else expect(current).toMatchObject({ state: 'unavailable', requests: [] });
      await expect(f.service.answer('session-one', input)).rejects.toThrow();
      expect(f.native.answer).not.toHaveBeenCalled();
      expect(f.queue.status).not.toHaveBeenCalled();
      expect(f.queue.setEnabled).not.toHaveBeenCalled();
      expect(f.queue.send).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
  it('delegates native questions to their exact connection callback and suppresses private content', async () => {
    const f = await fixture();
    try {
      f.setEvidence({ requests: [], replies: [] });
      f.setNative({ sessionId: 'session-one', state: 'connected', threadId: '11111111-1111-4111-8111-111111111111', connectionId: 'connection-one', canAnswer: true, canSend: false, requests: [{ id: 'rpc-one', turnId: 'turn-one', itemId: 'item-one', state: 'pending', questions: [{ id: 'q-one', header: 'Scope', question: 'Which scope?', isOther: true, isSecret: false, options: [{ label: 'One', description: 'Scoped implementation' }] }] }] });
      expect((await f.service.status('session-one')).requests[0]?.questions[0]).toMatchObject({ options: ['One'], optionDescriptions: ['Scoped implementation'] });
      const input = await f.input();
      await f.service.answer('session-one', input);
      expect(f.native.answer).toHaveBeenCalledWith('session-one', { connectionId: 'connection-one', requestId: 'rpc-one', answers: { 'q-one': 'One' } });
      expect(f.queue.send).not.toHaveBeenCalled();
      f.setPrivacy();
      expect(await f.service.status('session-one')).toEqual({ sessionId: 'session-one', state: 'private', requests: [] });
      await expect(f.service.answer('session-one', input)).rejects.toThrow('unavailable');
    } finally { await f.cleanup(); }
  });
});

it('separates verified pending identity from availability of the async reply route', async () => {
  const f = await fixture();
  try {
    f.queue.status.mockResolvedValue({ sessionId: 'session-one', enabled: false, canQueue: false });
    expect((await f.service.status('session-one')).requests[0]).toMatchObject({ identityVerified: true, canAnswer: false });
    f.setEvidence({ requests: [{ callId: 'unbound:1', canAnswer: false, questions: [{ title: 'Legacy question', options: [] }] }], replies: [] });
    expect((await f.service.status('session-one')).requests[0]).toMatchObject({ identityVerified: false, canAnswer: false });
  } finally { await f.cleanup(); }
});
