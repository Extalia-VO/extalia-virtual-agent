import { describe, expect, it, vi } from 'vitest';
import { ObservedHermesService } from '../src/observedHermesService.js';
import type { HermesObservedRpc, HermesObservedRpcOptions } from '../src/hermesObservedControl.js';
import path from 'node:path';

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const waitFor = async (fn: () => boolean) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise(resolve => setTimeout(resolve, 2));
  expect(fn()).toBe(true);
};
function fixture(app = 'hermes') {
  const target = { app, nativeSessionId: 'native-one', watching: true, cwd: path.resolve('/projects/example'), profile: 'selected',
    profileHome: path.resolve('/profiles/selected'), fingerprint: 'retained-database-one', revision: 'watch-one' };
  const snapshot = {
    session_id: 'native-one', stored_session_id: 'native-one', authority_epoch: 7,
    replay_epoch: 'replay-one', last_sequence: 4, subscription_id: 'viewer-one', execution_generation: 3,
    running: false, pending: [] as unknown[], prompts: [] as unknown[],
    info: { desktop_protocol: 'hermes-gateway-v1', profile_id: target.profileHome, cwd: target.cwd },
  };
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'runtime.describe') return { profile_id: snapshot.info.profile_id, instance_id: 'owner-one', authority_epoch: 7, capabilities: ['durable-admission-v1'] };
    if (method === 'session.list') return { scope: 'live', sessions: [{ session_id: target.nativeSessionId, running: snapshot.running }] };
    if (method === 'session.resume') return { ...snapshot, session_id: target.nativeSessionId, stored_session_id: target.nativeSessionId };
    return {};
  });
  const rpc: HermesObservedRpc = { profileId: target.profileHome, instanceId: 'owner-one', request, close: vi.fn(async () => {}) };
  let rpcOptions!: HermesObservedRpcOptions;
  const factory = vi.fn(async (options: HermesObservedRpcOptions) => { rpcOptions = options; return rpc; });
  const service = new ObservedHermesService({
    target: id => id === 'observed-one' ? target : undefined,
    env: { EXTALIA_HERMES_BIN: process.execPath },
    rpcFactory: factory,
  });
  return { service, target, snapshot, request, rpc, factory, rpcOptions: () => rpcOptions };
}

describe('ObservedHermesService', () => {
  it('never creates an attachment for an observed session from another app', async () => {
    const f = fixture('codex');
    expect(await f.service.connect('observed-one')).toMatchObject({ state: 'unavailable', canSend: false });
    expect(f.factory).not.toHaveBeenCalled();
    await f.service.close();
  });

  it('resumes only the exact native session id from the injected public gateway', async () => {
    const f = fixture();
    const state = await f.service.connect('observed-one');
    expect(state).toMatchObject({ state: 'connected', nativeSessionId: 'native-one', executionGeneration: 3 });
    expect(f.request).not.toHaveBeenCalledWith('session.list', expect.anything());
    expect(f.request).toHaveBeenCalledWith('session.resume', { session_id: 'native-one', omit_messages: true });
    expect(f.rpcOptions()).toMatchObject({ env: { HERMES_HOME: f.target.profileHome } });
    expect(f.rpcOptions().profile).toBeUndefined();
    expect(f.request.mock.calls.some(([method]) => ['session.create', 'session.branch', 'session.activate'].includes(method))).toBe(false);
    await f.service.close();
  });

  it('refuses an unproven profile and an explicit different profile before any gateway attachment', async () => {
    const f = fixture();
    await expect(f.service.connect('observed-one', 'other')).rejects.toThrow('profile that owns');
    f.target.profileHome = '';
    expect(await f.service.connect('observed-one')).toMatchObject({ state: 'unavailable', canSend: false });
    expect(f.factory).not.toHaveBeenCalled();
    await f.service.close();
  });

  it.each(['cwd', 'profileHome', 'fingerprint', 'revision'] as const)('revokes a connection when retained %s authority changes, even with the same native id', async field => {
    const f = fixture();
    await f.service.connect('observed-one');
    f.target[field] += '-changed';
    expect(f.service.status('observed-one')).toMatchObject({ state: 'unavailable', canSend: false });
    await settle();
    expect(f.rpc.close).toHaveBeenCalledOnce();
    await f.service.close();
  });

  it('rechecks source authority after async gateway validation and before admitting a handover', async () => {
    const f = fixture(), connected = await f.service.connect('observed-one');
    f.request.mockClear();
    f.request.mockImplementationOnce(async () => {
      f.target.revision = 'new-workspace-authority';
      return { profile_id: f.rpc.profileId, instance_id: 'owner-one', authority_epoch: 7, capabilities: ['durable-admission-v1'] };
    });
    const result = await f.service.send('observed-one', { connectionId: connected.connectionId!, executionGeneration: 3, text: 'Continue the reviewed handover', intent: 'start' });
    expect(result.canSend).toBe(false);
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['runtime.describe']);
    await f.service.close();
  });

  it('refuses a gateway from another profile even when that owner consistently reports the same native session id', async () => {
    const f = fixture();
    f.rpc.profileId = path.resolve('/profiles/other'); f.snapshot.info.profile_id = f.rpc.profileId;
    expect(await f.service.connect('observed-one')).toMatchObject({ state: 'unavailable', canSend: false });
    expect(f.request).not.toHaveBeenCalled();
    await f.service.close();
  });

  it('seals a pause that arrives while the gateway attachment factory is pending', async () => {
    const f = fixture();
    f.factory.mockImplementationOnce(async options => new Promise(resolve => {
      options.signal.addEventListener('abort', () => resolve(f.rpc), { once: true });
    }));
    const connecting = f.service.connect('observed-one');
    await waitFor(() => f.factory.mock.calls.length === 1);
    expect(f.factory).toHaveBeenCalledOnce();
    const dropped = f.service.drop('observed-one');
    await expect(connecting).rejects.toThrow('observed Hermes session changed');
    await dropped;
    expect(f.request).not.toHaveBeenCalled();
    expect(f.rpc.close).toHaveBeenCalled();
    expect(f.service.status('observed-one')).toMatchObject({ state: 'unavailable', canSend: false });
    await f.service.close();
  });

  it('closes the old attachment when the observation is rebound to another native identity', async () => {
    const f = fixture();
    await f.service.connect('observed-one');
    f.target.nativeSessionId = 'native-rebound';
    expect(f.service.status('observed-one')).toMatchObject({ state: 'unavailable', nativeSessionId: 'native-rebound', canSend: false });
    await settle();
    expect(f.rpc.close).toHaveBeenCalledOnce();
    await f.service.close();
  });

  it('keeps failed connection cleanup sticky and refuses reconnection', async () => {
    const f = fixture();
    vi.mocked(f.rpc.close).mockRejectedValue(new Error('private cleanup detail'));
    const state = await f.service.connect('observed-one');
    await expect(f.service.disconnect('observed-one', state.connectionId!)).rejects.toThrow('cleanup could not be confirmed');
    await settle();
    expect(f.service.status('observed-one')).toMatchObject({ state: 'unavailable', problem: 'Hermes connection cleanup could not be confirmed.' });
    await expect(f.service.connect('observed-one')).rejects.toThrow('cleanup could not be confirmed');
    await expect(f.service.close()).rejects.toThrow('cleanup could not be confirmed');
  });

  it('rechecks the selected identity when the gateway bind returns after a pause', async () => {
    const f = fixture();
    let release!: (rpc: HermesObservedRpc) => void;
    f.factory.mockImplementationOnce(async () => new Promise(resolve => { release = resolve; }));
    const connecting = f.service.connect('observed-one');
    await waitFor(() => f.factory.mock.calls.length === 1);
    expect(f.factory).toHaveBeenCalledOnce();
    const closing = f.service.close();
    release(f.rpc);
    await expect(connecting).rejects.toThrow('observed Hermes session changed');
    await closing;
    expect(f.request).not.toHaveBeenCalled();
    expect(f.rpc.close).toHaveBeenCalled();
  });
});
