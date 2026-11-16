import { describe, expect, it, vi } from 'vitest';
import { OBSERVED_CONTROL_ROUTES, type ObservedControlAction, type ObservedControlDispatchInput, type ObservedControlRoute, type ObservedControlStatus } from '@extalia/platform';
import { ObservedControlService, type ObservedControlDriver, type ObservedControlDriverSnapshot, type ObservedControlTarget } from '../src/observedControlService.js';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
const capability = (status: ObservedControlStatus, route: ObservedControlRoute, action: ObservedControlAction) =>
  status.routes.find(value => value.route === route)!.capabilities.find(value => value.action === action)!.capabilityId!;
function fixture(options: { maxOperations?: number; maxSessions?: number } = {}) {
  let target: ObservedControlTarget | undefined = { sourceId: 'codex', nativeSessionId: 'original-thread', fingerprint: 'exact-source-reference', revision: 1, watching: true };
  const snapshots = new Map<ObservedControlRoute, ObservedControlDriverSnapshot>();
  const drivers = OBSERVED_CONTROL_ROUTES.map(definition => {
    snapshots.set(definition.route, { bindingId: `original-${definition.route}`, generation: 1, actions: [...definition.actions], relatedControls: [] });
    return { route: definition.route,
      status: vi.fn(async () => snapshots.get(definition.route)),
      dispatch: vi.fn(async (): Promise<{ state: 'queued' | 'submitted' }> => ({ state: definition.route === 'codex-queue' || definition.route === 'cooperative-inbox' || definition.route === 'official-cli-resume' ? 'queued' : 'submitted' })),
    };
  });
  const service = new ObservedControlService({ target: () => target, drivers, ...options });
  const driver = (route: ObservedControlRoute) => drivers.find(value => value.route === route)!;
  const input = async (route: ObservedControlRoute = 'codex-native', action: ObservedControlAction = 'start', operationId = 'operation-one'): Promise<ObservedControlDispatchInput> => ({
    operationId, capabilityId: capability(await service.status('observed-one'), route, action), text: 'Continue this conversation',
  });
  return { service, snapshots, drivers, driver, input, setTarget: (value: ObservedControlTarget | undefined) => { target = value; }, target: () => target! };
}

describe('unified observed control ownership and receipts', () => {
  it.each(OBSERVED_CONTROL_ROUTES.flatMap(route => route.actions.map(action => ({ route: route.route, action }))))('dispatches only the selected $route / $action transport', async ({ route, action }) => {
    const f = fixture(), input = await f.input(route, action);
    expect(await f.service.dispatch('observed-one', input)).toMatchObject({ route, action, state: action === 'queue' || action === 'inbox-send' || route === 'official-cli-resume' ? 'queued' : 'submitted', retryable: false });
    expect(f.driver(route).dispatch).toHaveBeenCalledWith('observed-one', { action, text: input.text, operationId: input.operationId }, expect.objectContaining({ bindingId: `original-${route}`, generation: 1 }));
    for (const driver of f.drivers.filter(driver => driver.route !== route)) expect(driver.dispatch).not.toHaveBeenCalled();
  });
  it('publishes route limits and capabilities without exposing driver identities, paths or secrets', async () => {
    const f = fixture();
    f.snapshots.set('codex-native', { bindingId: 'private-native-connection', generation: 'private-turn', actions: ['start'], relatedControls: [{ kind: 'questions', available: true }], problem: 'Connect to the original app.' });
    const status = await f.service.status('observed-one');
    expect(status.routes.find(route => route.route === 'codex-native')).toMatchObject({ evidence: 'native-attachment', limit: 'existing-native-owner', capabilities: [{ action: 'start', available: true }, { action: 'steer', available: false }], relatedControls: [{ kind: 'questions', available: true }] });
    expect(JSON.stringify(status)).not.toMatch(/private-native-connection|private-turn|exact-source-reference/);
    expect(f.drivers.every(driver => driver.dispatch.mock.calls.length === 0)).toBe(true);
  });
  it('makes transcript-only or notification-only sources unavailable rather than deriving authority from provider identity', async () => {
    const service = new ObservedControlService({ target: () => ({ sourceId: 'claude', nativeSessionId: 'thread-one', fingerprint: 'source', revision: 1, watching: true }), drivers: [] });
    const status = await service.status('observed-one');
    expect(status.state).toBe('unavailable');
    expect(status.routes.every(route => route.capabilities.every(action => !action.available && !action.capabilityId))).toBe(true);
  });
  it.each(['fingerprint', 'revision', 'sourceId', 'nativeSessionId'] as const)('rejects a changed host %s before calling a transport', async key => {
    const f = fixture(), input = await f.input();
    f.setTarget({ ...f.target(), [key]: key === 'revision' ? 2 : 'replacement' });
    expect(await f.service.dispatch('observed-one', input)).toMatchObject({ state: 'rejected' });
    expect(f.driver('codex-native').dispatch).not.toHaveBeenCalled();
  });
  it('rejects changed driver identity and exact generation even if no fresh status was requested', async () => {
    for (const field of ['bindingId', 'generation'] as const) {
      const f = fixture(), input = await f.input();
      f.snapshots.set('codex-native', { ...f.snapshots.get('codex-native')!, [field]: 'changed' });
      expect(await f.service.dispatch('observed-one', input)).toMatchObject({ state: 'rejected' });
      expect(f.driver('codex-native').dispatch).not.toHaveBeenCalled();
    }
  });
  it('invalidates a pending inspection synchronously on pause/drop and rejects old capabilities after resume', async () => {
    const f = fixture(), input = await f.input(), pending = deferred<ObservedControlDriverSnapshot | undefined>();
    f.driver('codex-native').status.mockImplementationOnce(() => pending.promise);
    const sending = f.service.dispatch('observed-one', input);
    f.service.drop('observed-one');
    pending.resolve(f.snapshots.get('codex-native'));
    expect(await sending).toMatchObject({ state: 'rejected' });
    expect(f.driver('codex-native').dispatch).not.toHaveBeenCalled();
    await f.service.status('observed-one');
    expect(await f.service.dispatch('observed-one', { ...input, operationId: 'operation-after-resume' })).toMatchObject({ state: 'rejected' });
  });
  it('discards a status snapshot whose source changes while its driver is inspecting', async () => {
    const f = fixture(), pending = deferred<ObservedControlDriverSnapshot | undefined>();
    f.driver('codex-native').status.mockImplementationOnce(() => pending.promise);
    const status = f.service.status('observed-one');
    f.setTarget({ ...f.target(), revision: 2 });
    pending.resolve(f.snapshots.get('codex-native'));
    expect(await status).toMatchObject({ state: 'unavailable' });
  });
  it('coalesces duplicate in-flight operation IDs and rejects altered payloads or a competing route', async () => {
    const f = fixture(), status = await f.service.status('observed-one'), pending = deferred<{ state: 'submitted' }>();
    const input = { operationId: 'same-operation', capabilityId: capability(status, 'codex-native', 'start'), text: 'Original message' };
    f.driver('codex-native').dispatch.mockImplementationOnce(() => pending.promise);
    const first = f.service.dispatch('observed-one', input), duplicate = f.service.dispatch('observed-one', { ...input });
    expect(await f.service.dispatch('observed-one', { ...input, text: 'Changed message' })).toMatchObject({ state: 'rejected' });
    expect(await f.service.dispatch('observed-one', { ...input, operationId: 'other-operation', capabilityId: capability(status, 'cooperative-tool', 'reply-tool') })).toMatchObject({ state: 'rejected' });
    await vi.waitFor(() => expect(f.driver('codex-native').dispatch).toHaveBeenCalledTimes(1));
    expect((await f.service.status('observed-one')).routes.every(route => route.capabilities.every(action => !action.available))).toBe(true);
    pending.resolve({ state: 'submitted' });
    expect(await first).toEqual(await duplicate);
    expect(await f.service.dispatch('observed-one', input)).toEqual(await first);
    expect(f.driver('codex-native').dispatch).toHaveBeenCalledTimes(1);
  });
  it('seals uncertain delivery for the exact attachment, preserves the receipt and never falls back', async () => {
    const f = fixture(), input = await f.input();
    f.driver('codex-native').dispatch.mockRejectedValueOnce(new Error('private provider diagnostic'));
    const receipt = await f.service.dispatch('observed-one', input);
    expect(receipt).toMatchObject({ state: 'unknown', retryable: false });
    expect(JSON.stringify(receipt)).not.toContain('private provider diagnostic');
    expect(await f.service.dispatch('observed-one', input)).toEqual(receipt);
    const status = await f.service.status('observed-one');
    expect(status.routes.find(route => route.route === 'codex-native')).toMatchObject({ state: 'uncertain', capabilities: [{ action: 'start', available: false }, { action: 'steer', available: false }] });
    expect(f.drivers.filter(driver => driver.route !== 'codex-native').every(driver => driver.dispatch.mock.calls.length === 0)).toBe(true);
    f.snapshots.set('codex-native', { ...f.snapshots.get('codex-native')!, bindingId: 'explicit-reconnection' });
    expect(capability(await f.service.status('observed-one'), 'codex-native', 'start')).toBeTruthy();
    expect(await f.service.dispatch('observed-one', input)).toEqual(receipt);
  });
  it.each(OBSERVED_CONTROL_ROUTES)('refuses delivery overclaims from $route', async definition => {
    const target = { sourceId: 'manual-tool', nativeSessionId: 'paired-one', fingerprint: 'paired-reference', revision: 1, watching: true };
    const dispatch = vi.fn(async () => ({ state: 'resolved' as const }));
    const service = new ObservedControlService({ target: () => target, drivers: [{ route: definition.route,
      status: () => ({ bindingId: 'paired-channel', generation: 1, actions: [...definition.actions] }), dispatch }] });
    const action = definition.actions[0]!;
    const capabilityId = capability(await service.status('observed-one'), definition.route, action);
    expect(await service.dispatch('observed-one', { operationId: 'claimed-delivery', capabilityId, text: 'A message' })).toMatchObject({ state: 'unknown' });
    expect(dispatch).toHaveBeenCalledOnce();
    expect((await service.status('observed-one')).routes.find(route => route.route === definition.route)?.state).toBe('uncertain');
  });
  it('treats loss of source authority during delivery as uncertain', async () => {
    const f = fixture(), input = await f.input(), pending = deferred<{ state: 'submitted' }>();
    f.driver('codex-native').dispatch.mockImplementationOnce(() => pending.promise);
    const result = f.service.dispatch('observed-one', input);
    await vi.waitFor(() => expect(f.driver('codex-native').dispatch).toHaveBeenCalledOnce());
    f.service.drop('observed-one');
    pending.resolve({ state: 'submitted' });
    expect(await result).toMatchObject({ state: 'unknown' });
  });
  it('fails closed for malformed, removed or throwing adapter status without calling effects', async () => {
    const f = fixture(), input = await f.input();
    f.driver('codex-native').status.mockRejectedValueOnce(new Error('secret'));
    expect(await f.service.dispatch('observed-one', input)).toMatchObject({ state: 'rejected' });
    f.snapshots.delete('codex-native');
    expect((await f.service.status('observed-one')).routes.find(route => route.route === 'codex-native')?.state).toBe('unavailable');
    expect(f.driver('codex-native').dispatch).not.toHaveBeenCalled();
  });
  it('bounds the receipt ledger without evicting an uncertain result into a duplicate effect', async () => {
    const f = fixture({ maxOperations: 1 }), input = await f.input();
    f.driver('codex-native').dispatch.mockRejectedValueOnce(new Error('lost'));
    expect(await f.service.dispatch('observed-one', input)).toMatchObject({ state: 'unknown' });
    expect(await f.service.dispatch('observed-one', await f.input('codex-queue', 'queue', 'new-operation'))).toMatchObject({ state: 'rejected' });
    expect(await f.service.dispatch('observed-one', input)).toMatchObject({ state: 'unknown' });
    expect(f.driver('codex-queue').dispatch).not.toHaveBeenCalled();
  });
  it('does not issue capabilities for paused, missing or closed targets', async () => {
    const f = fixture();
    f.setTarget({ ...f.target(), watching: false });
    expect(await f.service.status('observed-one')).toMatchObject({ state: 'unavailable' });
    f.setTarget(undefined);
    expect(await f.service.status('observed-one')).toMatchObject({ state: 'unavailable' });
    f.service.close();
    expect(await f.service.status('observed-one')).toMatchObject({ state: 'unavailable' });
  });
  it('keeps capability IDs stable while status polls the same binding, then consumes them after one dispatch', async () => {
    const f = fixture(), input = await f.input();
    expect(capability(await f.service.status('observed-one'), 'codex-native', 'start')).toBe(input.capabilityId);
    await f.service.dispatch('observed-one', input);
    expect(capability(await f.service.status('observed-one'), 'codex-native', 'start')).not.toBe(input.capabilityId);
    expect(await f.service.dispatch('observed-one', { ...input, operationId: 'another-operation' })).toMatchObject({ state: 'rejected' });
  });
  it('rejects messages exceeding the universal character or UTF-8 byte limit before consuming authority', async () => {
    const f = fixture(), input = await f.input();
    for (const text of ['x'.repeat(16_001), 'é'.repeat(9_000), 'message\0with-null']) {
      expect(await f.service.dispatch('observed-one', { ...input, text })).toMatchObject({ state: 'rejected' });
    }
    expect(f.driver('codex-native').dispatch).not.toHaveBeenCalled();
    expect(await f.service.dispatch('observed-one', input)).toMatchObject({ state: 'submitted' });
  });
  it('requires one owner per transport route', () => {
    const driver: ObservedControlDriver = { route: 'codex-native', status: () => undefined, dispatch: async () => ({ state: 'unknown' }) };
    expect(() => new ObservedControlService({ target: () => undefined, drivers: [driver, driver] })).toThrow('one owner');
  });
});
