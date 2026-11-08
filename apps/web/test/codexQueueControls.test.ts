import type { AgentHostApi, ObservedCodexQueueStatus } from '@extalia/platform';
import { afterEach, expect, it, vi } from 'vitest';
import { createCodexQueueControl } from '../src/observe/observedCodexQueueModel';
const id = 'session', threadId = '11111111-1111-4111-8111-111111111111';
const status = (enabled = false): ObservedCodexQueueStatus => ({ sessionId: id, threadId, enabled, canQueue: enabled });
const stops: (() => void)[] = [];
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture() {
  const api = { observedCodexQueueStatus: vi.fn(async () => status()), setObservedCodexQueue: vi.fn(async (_id: string, enabled: boolean) => status(enabled)), queueObservedCodexMessage: vi.fn(async () => ({ ...status(true), delivery: 'queued' as const })) };
  const model = createCodexQueueControl(api as unknown as AgentHostApi, id); stops.push(model.start()); return { api, model };
}
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); });
it('never enables or sends on mount; sends plain text only to the selected observation after opt in', async () => {
  const { api, model } = fixture(); await settle();
  expect(api.setObservedCodexQueue).not.toHaveBeenCalled(); expect(api.queueObservedCodexMessage).not.toHaveBeenCalled();
  await model.setEnabled(true); model.setDraft('Original-session message'); await model.send();
  expect(api.queueObservedCodexMessage).toHaveBeenCalledExactlyOnceWith(id, { text: 'Original-session message' });
  expect(model.getSnapshot().status?.delivery).toBe('queued'); expect(model.getSnapshot().draft).toBe('');
});
it('unknown receipt retains the draft and never resends automatically', async () => {
  vi.useFakeTimers(); const { api, model } = fixture(); await settle(); await model.setEnabled(true);
  api.queueObservedCodexMessage.mockResolvedValue({ ...status(true), canQueue: false, delivery: 'unknown' } as never);
  model.setDraft('Retain until reviewed'); await model.send(); await model.send();
  expect(api.queueObservedCodexMessage).toHaveBeenCalledTimes(1); expect(model.getSnapshot().draft).toBe('Retain until reviewed');
});
it('invalidates a foreign source status and ignores late responses after disposal', async () => {
  const { api, model } = fixture(); await settle();
  api.observedCodexQueueStatus.mockResolvedValue({ ...status(true), sessionId: 'other' }); await model.refresh();
  expect(model.getSnapshot()).toMatchObject({ phase: 'error', status: undefined });
  let resolve!: (value: ObservedCodexQueueStatus) => void;
  api.observedCodexQueueStatus.mockReturnValue(new Promise(done => { resolve = done; }));
  const read = model.refresh(); stops.pop()!(); resolve(status(true)); await read;
  expect(model.getSnapshot().status).toBeUndefined();
});
