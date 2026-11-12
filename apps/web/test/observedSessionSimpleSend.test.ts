import type { AgentHostApi, ObservedControlAction, ObservedControlDispatchInput, ObservedControlReceipt, ObservedControlRoute, ObservedControlRouteStatus, ObservedControlStatus } from '@extalia/platform';
import { afterEach, expect, it, vi } from 'vitest';
import { createObservedSessionControl } from '../src/observe/observedSessionControlModel';

const id = 'observed-session';
function route(name: ObservedControlRoute, action: ObservedControlAction, capabilityId = `${name}-${action}`): ObservedControlRouteStatus {
  const metadata = {
    'codex-native': { evidence: 'native-attachment', limit: 'existing-native-owner' },
    'hermes-native': { evidence: 'native-attachment', limit: 'existing-native-owner' },
    'codex-queue': { evidence: 'official-queue', limit: 'queue-receipt-only' },
    'cooperative-tool': { evidence: 'paired-tool', limit: 'waiting-tool-only' },
    'cooperative-inbox': { evidence: 'paired-inbox', limit: 'paired-consumer-only' },
  } as const;
  return { route: name, state: 'ready', ...metadata[name], capabilities: [{ action, capabilityId, available: true }], relatedControls: [] };
}
const status = (routes: ObservedControlRouteStatus[], bindingId = 'source-one'): ObservedControlStatus => ({ sessionId: id, state: 'ready', bindingId, routes });
const stops: (() => void)[] = [];
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function setup(routes = [route('cooperative-inbox', 'inbox-send')]) {
  const api = {
    observedControlStatus: vi.fn(async () => status(routes)),
    dispatchObservedControl: vi.fn(async (_id: string, input: ObservedControlDispatchInput): Promise<ObservedControlReceipt> => ({ sessionId: id, operationId: input.operationId, state: 'queued', retryable: false })),
  };
  const model = createObservedSessionControl(api as unknown as AgentHostApi, id);
  stops.push(model.start());
  return { api, model };
}
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); });

it('offers a simple send without selecting or dispatching on mount, eligibility checks, or polling', async () => {
  vi.useFakeTimers(); const { api, model } = setup(); await settle();
  model.setDraft('Send through the paired inbox');
  expect(model.canSend()).toBe(false); expect(model.canSendMessage()).toBe(true);
  await vi.advanceTimersByTimeAsync(6000);
  expect(model.getSnapshot().selected).toBe(''); expect(api.dispatchObservedControl).not.toHaveBeenCalled();
  await model.sendMessage();
  expect(api.dispatchObservedControl).toHaveBeenCalledExactlyOnceWith(id, expect.objectContaining({ capabilityId: 'cooperative-inbox-inbox-send', text: 'Send through the paired inbox' }));
  expect(model.getSnapshot()).toMatchObject({ selected: '', draft: '', receipt: { state: 'queued' } });
});

it.each([
  [route('codex-native', 'start'), 'codex-native-start'],
  [route('hermes-native', 'start'), 'hermes-native-start'],
  [route('cooperative-tool', 'reply-tool'), 'cooperative-tool-reply-tool'],
] as const)('uses the sole supported %s action', async (candidate, capabilityId) => {
  const { api, model } = setup([candidate]); await settle(); model.setDraft('Continue');
  expect(model.canSendMessage()).toBe(true); await model.sendMessage();
  expect(api.dispatchObservedControl).toHaveBeenCalledExactlyOnceWith(id, expect.objectContaining({ capabilityId }));
});

it('prefers the official queue to native starts and cooperative alternatives', async () => {
  const { api, model } = setup([route('codex-native', 'start'), route('hermes-native', 'start'), route('codex-queue', 'queue'), route('cooperative-inbox', 'inbox-send')]);
  await settle(); model.setDraft('Next task'); await model.sendMessage();
  expect(api.dispatchObservedControl).toHaveBeenCalledExactlyOnceWith(id, expect.objectContaining({ capabilityId: 'codex-queue-queue' }));
});

it('honors an explicit valid choice before defaults, including explicit steer', async () => {
  const { api, model } = setup([route('codex-native', 'steer'), route('codex-queue', 'queue')]);
  await settle(); model.setDraft('Change direction'); model.select('codex-native-steer');
  expect(model.canSend()).toBe(true); expect(model.canSendMessage()).toBe(true); await model.sendMessage();
  expect(api.dispatchObservedControl).toHaveBeenCalledExactlyOnceWith(id, expect.objectContaining({ capabilityId: 'codex-native-steer' }));
});

it.each([
  [route('codex-native', 'steer')],
  [route('codex-native', 'start'), route('hermes-native', 'start'), route('cooperative-inbox', 'inbox-send')],
  [route('codex-queue', 'queue', 'queue-one'), route('codex-queue', 'queue', 'queue-two'), route('codex-native', 'start')],
  [route('cooperative-tool', 'reply-tool'), route('cooperative-inbox', 'inbox-send')],
])('does not infer steer or resolve ambiguous candidates: %s', async (...candidates) => {
  const { api, model } = setup(candidates); await settle(); model.setDraft('Keep draft');
  expect(model.canSendMessage()).toBe(false); await model.sendMessage();
  expect(model.getSnapshot()).toMatchObject({ selected: '', draft: 'Keep draft' }); expect(api.dispatchObservedControl).not.toHaveBeenCalled();
});

it('allows tools to resolve ambiguity with an explicit selection', async () => {
  const { api, model } = setup([route('cooperative-tool', 'reply-tool'), route('cooperative-inbox', 'inbox-send')]);
  await settle(); model.setDraft('Reply'); expect(model.canSendMessage()).toBe(false);
  model.select('cooperative-tool-reply-tool'); expect(model.canSendMessage()).toBe(true); await model.sendMessage();
  expect(api.dispatchObservedControl).toHaveBeenCalledExactlyOnceWith(id, expect.objectContaining({ capabilityId: 'cooperative-tool-reply-tool' }));
});

it('ignores unavailable and incompatible advertised defaults', async () => {
  const unavailable = { ...route('codex-queue', 'queue'), state: 'busy' as const };
  const incompatible = { ...route('codex-native', 'start'), evidence: 'paired-inbox' as const };
  const { api, model } = setup([unavailable, incompatible, route('cooperative-inbox', 'inbox-send')]);
  await settle(); model.setDraft('Reply'); await model.sendMessage();
  expect(api.dispatchObservedControl).toHaveBeenCalledExactlyOnceWith(id, expect.objectContaining({ capabilityId: 'cooperative-inbox-inbox-send' }));
});

it('retains stale selection notices and requires explicit tools selection to continue', async () => {
  const { api, model } = setup(); await settle(); model.setDraft('Keep'); model.select('cooperative-inbox-inbox-send');
  api.observedControlStatus.mockResolvedValue(status([route('codex-queue', 'queue')])); await model.refresh();
  expect(model.getSnapshot()).toMatchObject({ selected: '', notice: 'stale' });
  expect(model.canSendMessage()).toBe(false); await model.sendMessage(); expect(api.dispatchObservedControl).not.toHaveBeenCalled();
  model.select('codex-queue-queue'); expect(model.canSendMessage()).toBe(true);
});

it.each(['bindingId', 'sourceId', 'nativeSessionId'] as const)('blocks a draft after polling changes %s until tools explicitly confirms the new source', async field => {
  const { api, model } = setup([route('codex-queue', 'queue')]); await settle();
  const initial = { ...status([route('codex-queue', 'queue')]), sourceId: 'source-one', nativeSessionId: 'native-one' };
  api.observedControlStatus.mockResolvedValue(initial); await model.refresh(); model.setDraft('Draft for original source');
  expect(model.canSendMessage()).toBe(true); expect(model.getSnapshot().selected).toBe('');
  api.observedControlStatus.mockResolvedValue({ ...initial, [field]: 'replacement' }); await model.refresh();
  expect(model.getSnapshot()).toMatchObject({ selected: '', draft: 'Draft for original source', notice: 'stale' });
  expect(model.canSendMessage()).toBe(false); await model.sendMessage(); await model.refresh();
  expect(model.canSendMessage()).toBe(false); expect(api.dispatchObservedControl).not.toHaveBeenCalled();
  model.select('codex-queue-queue'); expect(model.canSendMessage()).toBe(true); await model.sendMessage();
  expect(api.dispatchObservedControl).toHaveBeenCalledExactlyOnceWith(id, expect.objectContaining({ capabilityId: 'codex-queue-queue', text: 'Draft for original source' }));
});

it('clears an explicit selection even when its capability survives a polled source change', async () => {
  const { api, model } = setup([route('codex-queue', 'queue')]); await settle();
  model.setDraft('Draft for original source'); model.select('codex-queue-queue');
  api.observedControlStatus.mockResolvedValue(status([route('codex-queue', 'queue')], 'source-two')); await model.refresh();
  expect(model.getSnapshot()).toMatchObject({ selected: '', notice: 'stale' });
  expect(model.canSend()).toBe(false); expect(model.canSendMessage()).toBe(false); expect(api.dispatchObservedControl).not.toHaveBeenCalled();
});

it('accepts the first status when a draft was entered during initial loading', async () => {
  const { api, model } = setup([route('codex-queue', 'queue')]); model.setDraft('Draft before connection'); await settle();
  expect(model.getSnapshot()).toMatchObject({ phase: 'ready', draft: 'Draft before connection', selected: '' });
  expect(model.getSnapshot().notice).toBeUndefined(); expect(model.canSendMessage()).toBe(true); expect(api.dispatchObservedControl).not.toHaveBeenCalled();
});

it('accepts a new source while the draft is empty and permits a subsequent new message', async () => {
  const { api, model } = setup([route('codex-queue', 'queue')]); await settle();
  api.observedControlStatus.mockResolvedValue({ ...status([route('codex-queue', 'queue')], 'source-two'), sourceId: 'source-two', nativeSessionId: 'native-two' });
  await model.refresh(); expect(model.getSnapshot().notice).toBeUndefined(); expect(model.getSnapshot().draft).toBe('');
  model.setDraft('Draft for new source'); expect(model.canSendMessage()).toBe(true); await model.sendMessage();
  expect(api.dispatchObservedControl).toHaveBeenCalledExactlyOnceWith(id, expect.objectContaining({ text: 'Draft for new source' }));
});

it('permits routine capability rotation on the same source before a simple send', async () => {
  const { api, model } = setup([route('codex-queue', 'queue')]); await settle(); model.setDraft('Keep source');
  api.observedControlStatus.mockResolvedValue(status([route('codex-queue', 'queue', 'replacement')])); await model.refresh();
  expect(model.getSnapshot()).toMatchObject({ selected: '', draft: 'Keep source' }); expect(model.getSnapshot().notice).toBeUndefined();
  expect(model.canSendMessage()).toBe(true); await model.sendMessage();
  expect(api.dispatchObservedControl).toHaveBeenCalledExactlyOnceWith(id, expect.objectContaining({ capabilityId: 'replacement' }));
});

it('does not choose a default after a failed status read recovers', async () => {
  const { api, model } = setup(); await settle(); model.setDraft('Keep');
  api.observedControlStatus.mockRejectedValueOnce(new Error('connection closed')); await model.refresh(); await model.refresh();
  expect(model.getSnapshot()).toMatchObject({ phase: 'ready', notice: 'failed' });
  expect(model.canSendMessage()).toBe(false); await model.sendMessage(); expect(api.dispatchObservedControl).not.toHaveBeenCalled();
});

it.each(['unknown', 'transport-error'] as const)('blocks a replacement default after %s without retrying', async outcome => {
  vi.useFakeTimers(); const { api, model } = setup([route('codex-queue', 'queue')]); await settle(); model.setDraft('Keep');
  api.dispatchObservedControl.mockImplementation(async (_id, input) => {
    api.observedControlStatus.mockResolvedValue(status([route('codex-queue', 'queue', 'replacement')]));
    if (outcome === 'transport-error') throw new Error('connection closed');
    return { sessionId: id, operationId: input.operationId, state: 'unknown', retryable: false };
  });
  await model.sendMessage(); await vi.advanceTimersByTimeAsync(6000); await model.sendMessage();
  expect(model.canSendMessage()).toBe(false); expect(model.getSnapshot()).toMatchObject({ draft: 'Keep', receipt: { state: 'unknown' } });
  expect(api.dispatchObservedControl).toHaveBeenCalledTimes(1);
});

it.each(['binding', 'capability'] as const)('pins the default through preflight and refuses changed %s without fallback', async change => {
  const { api, model } = setup([route('codex-queue', 'queue'), route('cooperative-inbox', 'inbox-send')]); await settle(); model.setDraft('Keep');
  api.observedControlStatus.mockResolvedValue(change === 'binding'
    ? status([route('codex-queue', 'queue'), route('cooperative-inbox', 'inbox-send')], 'source-two')
    : status([route('codex-native', 'start'), route('cooperative-inbox', 'inbox-send')]));
  await model.sendMessage();
  expect(model.getSnapshot()).toMatchObject({ selected: '', draft: 'Keep', notice: 'stale' });
  expect(model.canSendMessage()).toBe(false); expect(api.dispatchObservedControl).not.toHaveBeenCalled();
});

it('blocks duplicate sends while pending and retains the newer draft', async () => {
  const { api, model } = setup(); await settle(); model.setDraft('First');
  let resolve!: (value: ObservedControlReceipt) => void;
  api.dispatchObservedControl.mockReturnValue(new Promise(done => { resolve = done; }));
  const send = model.sendMessage(); await settle();
  expect(model.canSendMessage()).toBe(false); await model.sendMessage(); await model.send();
  const input = api.dispatchObservedControl.mock.calls[0]![1];
  expect(input.operationId).toMatch(/^[a-f0-9-]{36}$/); expect(input.text).toBe('First');
  model.setDraft('Next draft'); resolve({ sessionId: id, operationId: input.operationId, state: 'queued', retryable: false }); await send;
  expect(api.dispatchObservedControl).toHaveBeenCalledTimes(1); expect(model.getSnapshot().draft).toBe('Next draft');
});

it.each([['empty text', ' '], ['NUL text', 'invalid\0prompt'], ['UTF-8 byte overflow', '界'.repeat(6000)]])('applies existing prompt limits to simple sending: %s', async (_label, draft) => {
  const { api, model } = setup(); await settle(); model.setDraft(draft);
  expect(model.canSendMessage()).toBe(false); await model.sendMessage(); expect(api.dispatchObservedControl).not.toHaveBeenCalled();
});
