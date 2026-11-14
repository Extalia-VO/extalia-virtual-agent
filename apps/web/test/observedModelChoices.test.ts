import type { AgentHostApi, ModelChoices } from '@extalia/platform';
import { afterEach, expect, it, vi } from 'vitest';
import { createObservedModelChoicesControl, OBSERVED_MODEL_CHOICES_LIMIT, OBSERVED_MODEL_CHOICES_POLL_MS, validateObservedModelChoices } from '../src/observe/observedModelChoices';

const sessionId = 'observed-session';
const catalog = (model = 'source-model'): ModelChoices => ({ runtime: 'extalia-native', models: [model], defaultModel: model, efforts: ['low', 'high'], defaultEffort: 'high' });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const stops: Array<() => void> = [];
function setup() {
  const api = { modelChoices: vi.fn(async () => catalog()), sendPrompt: vi.fn(), setSessionOptions: vi.fn() };
  const control = createObservedModelChoicesControl(api, sessionId);
  stops.push(control.start());
  return { api, control };
}
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); });

it('reads only the observed source catalog and polls every ten seconds while active', async () => {
  vi.useFakeTimers(); const { api, control } = setup(); await settle();
  expect(api.modelChoices).toHaveBeenCalledExactlyOnceWith('', sessionId);
  expect(control.getSnapshot()).toEqual({ phase: 'ready', choices: catalog(), refreshing: false });
  await vi.advanceTimersByTimeAsync(OBSERVED_MODEL_CHOICES_POLL_MS - 1); expect(api.modelChoices).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(api.modelChoices).toHaveBeenCalledTimes(2);
  expect(api.sendPrompt).not.toHaveBeenCalled(); expect(api.setSessionOptions).not.toHaveBeenCalled();
});

it('invalidates source settings immediately and looks up fresh choices once the old read settles', async () => {
  const { api, control } = setup(); await settle();
  const old = deferred<ModelChoices>(); api.modelChoices.mockReturnValueOnce(old.promise);
  const pending = control.refresh(); api.modelChoices.mockResolvedValue(catalog('new-source-model'));
  control.invalidateSource(); control.invalidateSource();
  expect(control.getSnapshot().choices).toBeUndefined(); expect(api.modelChoices).toHaveBeenCalledTimes(2);
  old.resolve(catalog('stale-model')); await pending; await settle();
  expect(api.modelChoices).toHaveBeenCalledTimes(3);
  expect(control.getSnapshot().choices?.defaultModel).toBe('new-source-model');
});

it.each(['hide', 'pause'] as const)('clears choices and suspends polling on %s, then refreshes on resume', async action => {
  vi.useFakeTimers(); const { api, control } = setup(); await settle();
  const toggle = action === 'hide' ? control.setVisible : (disabled: boolean) => control.setDisabled(!disabled);
  toggle(false); expect(control.getSnapshot()).toEqual({ phase: 'loading', refreshing: false });
  await vi.advanceTimersByTimeAsync(30_000); await control.refresh(); expect(api.modelChoices).toHaveBeenCalledTimes(1);
  toggle(true); await settle(); expect(api.modelChoices).toHaveBeenCalledTimes(2);
});

it('never overlaps slow reads across polling, manual refresh, repeated starts, pause or source changes', async () => {
  vi.useFakeTimers(); const pending = deferred<ModelChoices>();
  const api = { modelChoices: vi.fn(() => pending.promise) };
  const control = createObservedModelChoicesControl(api, sessionId); const stop = control.start(); stops.push(stop);
  control.start(); await control.refresh(); await vi.advanceTimersByTimeAsync(30_000);
  control.setDisabled(true); control.setDisabled(false); control.invalidateSource();
  expect(api.modelChoices).toHaveBeenCalledTimes(1);
  api.modelChoices.mockResolvedValue(catalog('fresh-model')); pending.resolve(catalog('old-model')); await settle();
  expect(api.modelChoices).toHaveBeenCalledTimes(2); expect(control.getSnapshot().choices?.defaultModel).toBe('fresh-model');
});

it.each(['hide', 'pause', 'stop', 'replace'] as const)('ignores late choices after %s', async action => {
  const { api, control } = setup(); await settle(); const pending = deferred<ModelChoices>();
  api.modelChoices.mockReturnValueOnce(pending.promise); const read = control.refresh();
  if (action === 'hide') control.setVisible(false);
  if (action === 'pause') control.setDisabled(true);
  if (action === 'stop') stops.pop()!();
  if (action === 'replace') api.modelChoices = vi.fn(async () => catalog('replacement-model'));
  pending.resolve(catalog('late-model')); await read;
  expect(control.getSnapshot().choices).toBeUndefined();
  if (action === 'replace') expect(control.getSnapshot().phase).toBe('unavailable');
});

it('starts a new session empty and keeps the original read bound to the original session', async () => {
  const { api, control } = setup(); await settle();
  const next = createObservedModelChoicesControl(api, 'next-session');
  expect(next.getSnapshot().choices).toBeUndefined(); stops.push(next.start()); await settle();
  expect(api.modelChoices).toHaveBeenLastCalledWith('', 'next-session');
  expect(control.getSnapshot().choices).toEqual(catalog());
});

it('catches synchronous throws and rejected reads without exposing errors, and retries polling', async () => {
  vi.useFakeTimers(); const { api, control } = setup(); await settle();
  api.modelChoices.mockImplementationOnce(() => { throw new Error('private details'); });
  await expect(control.refresh()).resolves.toBeUndefined(); expect(control.getSnapshot()).toEqual({ phase: 'unavailable', refreshing: false });
  api.modelChoices.mockRejectedValueOnce(new Error('private details'));
  await vi.advanceTimersByTimeAsync(10_000); expect(control.getSnapshot().phase).toBe('unavailable');
  await vi.advanceTimersByTimeAsync(10_000); expect(control.getSnapshot().phase).toBe('ready');
  const pending = deferred<ModelChoices>(); api.modelChoices.mockReturnValueOnce(pending.promise); const read = control.refresh();
  stops.pop()!(); pending.reject(new Error('late private details')); await expect(read).resolves.toBeUndefined();
  expect(control.getSnapshot().choices).toBeUndefined();
});

it('supports hosts missing the capability without starting polling', async () => {
  vi.useFakeTimers(); const control = createObservedModelChoicesControl({} as Pick<AgentHostApi, 'modelChoices'>, sessionId);
  stops.push(control.start()); await control.refresh(); await vi.advanceTimersByTimeAsync(30_000);
  expect(control.hasCapability).toBe(false); expect(control.getSnapshot()).toEqual({ phase: 'unsupported', refreshing: false });
  expect(vi.getTimerCount()).toBe(0);
});

it('copies a bounded catalog and validates model ids and effort values before display', () => {
  const source = catalog(); const safe = validateObservedModelChoices(source);
  source.models[0] = 'changed-model'; source.efforts.length = 0;
  expect(safe).toEqual(catalog());
  const maximum = { ...catalog(), models: Array.from({ length: OBSERVED_MODEL_CHOICES_LIMIT }, (_, index) => `model-${index}`) };
  expect(validateObservedModelChoices(maximum).models).toHaveLength(OBSERVED_MODEL_CHOICES_LIMIT);
  for (const patch of [
    { models: [...maximum.models, 'one-too-many'] }, { models: ['--invalid-model'] }, { models: ['x'.repeat(201)] },
    { models: ['model\n'] }, { defaultModel: 'bad model' }, { efforts: ['unknown'] }, { defaultEffort: 'unknown' }, { runtime: 'unknown' },
  ]) expect(() => validateObservedModelChoices({ ...catalog(), ...patch } as ModelChoices)).toThrow();
});

it('turns malformed responses into unavailable and drops the previous catalog', async () => {
  const { api, control } = setup(); await settle(); api.modelChoices.mockResolvedValueOnce({ ...catalog(), efforts: ['unknown'] } as unknown as ModelChoices);
  await control.refresh(); expect(control.getSnapshot()).toEqual({ phase: 'unavailable', refreshing: false });
});

it('requires bound native settings authority and preserves only safe observed selection fields', () => {
  const value = { ...catalog(), observedSelection: { model: 'example-model', effort: 'high' as const, canSetSettings: true,
    connectionId: 'connection', settingsRevision: 2, privateData: 'omitted' } };
  const valid = validateObservedModelChoices(value);
  expect(valid.observedSelection).toEqual({ model: 'example-model', effort: 'high', canSetSettings: true, connectionId: 'connection', settingsRevision: 2 });
  expect(() => validateObservedModelChoices({ ...value, observedSelection: { ...value.observedSelection, connectionId: undefined } })).toThrow();
  expect(() => validateObservedModelChoices({ ...value, observedSelection: { ...value.observedSelection, uncertain: true } })).toThrow();
});

it('waits for a fresh source snapshot after mutation even when an older catalog read is in flight', async () => {
  const { api, control } = setup(); await settle();
  const old = deferred<ModelChoices>(); api.modelChoices.mockReturnValueOnce(old.promise);
  const reading = control.refresh(); await settle();
  api.modelChoices.mockResolvedValue(catalog('new-source-model'));
  let done = false; const refreshed = control.invalidateSource().then(() => { done = true; });
  expect(done).toBe(false); expect(control.getSnapshot().choices).toBeUndefined();
  old.resolve(catalog('old-source-model')); await reading; await refreshed;
  expect(control.getSnapshot().choices?.defaultModel).toBe('new-source-model');
  expect(done).toBe(true);
});

it('preserves validated per-model effort maps and omits unsupported modelEfforts entries', () => {
  const valid = validateObservedModelChoices({
    ...catalog('gemini-4-argon'),
    models: ['gemini-4-argon', 'gemini-pro-orchestrator'],
    efforts: ['low', 'medium'],
    modelEfforts: {
      'gemini-4-argon': ['low', 'medium', 'high'],
      'gemini-pro-orchestrator': [],
    },
  });
  expect(valid.modelEfforts).toEqual({
    'gemini-4-argon': ['low', 'medium', 'high'],
    'gemini-pro-orchestrator': [],
  });
});
