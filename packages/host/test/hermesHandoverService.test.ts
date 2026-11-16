import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HermesHandoverService } from '../src/hermesHandoverService.js';
import type { HermesObservedRpc, HermesObservedRpcOptions } from '../src/hermesObservedControl.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
async function fixture() {
  const root = await temp(), project = path.join(root, 'project'), profile = path.join(root, 'hermes', 'profiles', 'selected');
  await mkdir(project); await mkdir(profile, { recursive: true });
  const cwd = await realpath(project), profileHome = await realpath(profile);
  const authority = { id: 'workspace-one', cwd, profile: 'selected', profileHome, fingerprint: 'current-profile-and-project' };
  const description = { profile_id: profileHome, instance_id: 'gateway-one', authority_epoch: 7, capabilities: ['durable-admission-v1'],
    session_create: { sources: ['cli', 'tui'], parameters: ['request_id', 'source', 'cwd'] } };
  const stored = new Map<string, { nativeId: string; body: string }>();
  let lostAck = false;
  const request = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'runtime.describe') return description;
    if (method !== 'session.create') throw new Error('Only native metadata creation is allowed.');
    const key = String(params.request_id), previous = stored.get(key), body = JSON.stringify(params);
    if (previous && previous.body !== body) throw new Error('Idempotent request body changed.');
    const nativeId = previous?.nativeId ?? `local-created-${stored.size + 1}`;
    stored.set(key, { nativeId, body });
    if (lostAck) { lostAck = false; throw new Error('The owner committed but the acknowledgement was lost.'); }
    return { session_id: nativeId, stored_session_id: nativeId, authority_epoch: description.authority_epoch, execution_generation: 0, running: false,
      messages: [], message_count: 0, pending: [], prompts: [],
      info: { desktop_protocol: 'hermes-gateway-v1', profile_id: description.profile_id, cwd } };
  });
  const factory = vi.fn(async (_options: HermesObservedRpcOptions): Promise<HermesObservedRpc> => ({ profileId: description.profile_id, instanceId: description.instance_id, request, close: vi.fn(async () => {}) }));
  const options = { file: path.join(root, 'host', 'hermes-create.json'), authority: vi.fn(async (scope: string) => scope === authority.id ? { ...authority } : undefined),
    env: { EXTALIA_HERMES_BIN: process.execPath }, rpcFactory: factory };
  const service = new HermesHandoverService(options);
  return { service, options, authority, description, request, factory, stored, loseAck: () => { lostAck = true; } };
}

describe('explicit Hermes destination creation', () => {
  it('keeps passive discovery launch-free and only creates after a current authenticated contract review', async () => {
    const f = await fixture();
    expect(await f.service.describe('workspace-one')).toMatchObject({ state: 'setup-required', profile: 'selected' });
    expect(f.factory).not.toHaveBeenCalled();
    expect(await f.service.create('workspace-one', { revision: 'not-reviewed', operationId: 'create-one' })).toMatchObject({ state: 'rejected' });
    expect(f.factory).not.toHaveBeenCalled();
    const review = await f.service.prepare('workspace-one');
    expect(review.state).toBe('ready');
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['runtime.describe']);
    const result = await f.service.create('workspace-one', { revision: review.revision!, operationId: 'create-one' });
    expect(result).toMatchObject({ state: 'created', nativeSessionId: 'local-created-1', cwd: f.authority.cwd, profileHome: f.authority.profileHome });
    expect(f.factory.mock.calls.every(([options]) => options.env?.HERMES_HOME === f.authority.profileHome && options.profile === undefined)).toBe(true);
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['runtime.describe', 'runtime.describe', 'session.create']);
    expect(f.request.mock.calls.at(-1)?.[1]).toEqual({ request_id: expect.stringMatching(/^extalia-[a-f0-9]{64}$/), source: 'cli', cwd: f.authority.cwd });
    expect((await f.service.describe('workspace-one')).state).toBe('setup-required');
    expect(f.factory).toHaveBeenCalledTimes(2);
    expect(await f.service.markRegistered('create-one', 'observed-one')).toBe(true);
    expect(await f.service.pendingCreation('workspace-one')).toBeUndefined();
    await f.service.close();
  });

  it('deduplicates concurrent create and preserves exact native receipts after host restart', async () => {
    const f = await fixture(), review = await f.service.prepare('workspace-one');
    const input = { revision: review.revision!, operationId: 'create-one' };
    const values = await Promise.all([f.service.create('workspace-one', input), f.service.create('workspace-one', input)]);
    expect(values[0]).toEqual(values[1]);
    expect(f.stored.size).toBe(1);
    expect(f.request.mock.calls.filter(([method]) => method === 'session.create')).toHaveLength(1);
    await f.service.close();
    const reopened = new HermesHandoverService(f.options);
    expect(await reopened.creationStatus('workspace-one', 'create-one')).toEqual(values[0]);
    expect(await reopened.create('workspace-one', input)).toEqual(values[0]);
    expect(f.request.mock.calls.filter(([method]) => method === 'session.create')).toHaveLength(1);
    expect(await reopened.markRegistered('create-one', 'observed-one')).toBe(true);
    expect(await reopened.markRegistered('create-one', 'other-observation')).toBe(false);
    await reopened.close();
  });

  it('recovers a lost acknowledgement with the same idempotent request after both hosts restart, never a prompt', async () => {
    const f = await fixture(), review = await f.service.prepare('workspace-one');
    f.loseAck();
    const first = await f.service.create('workspace-one', { revision: review.revision!, operationId: 'create-one' });
    expect(first).toMatchObject({ state: 'unknown', retryable: false });
    expect(first.nativeSessionId).toBeUndefined();
    expect(await f.service.pendingCreation('workspace-one')).toEqual({ operationId: 'create-one', state: 'unknown' });
    const original = f.request.mock.calls.find(([method]) => method === 'session.create')![1];
    await f.service.close();
    f.description.instance_id = 'gateway-restarted'; f.description.authority_epoch++;
    const reopened = new HermesHandoverService(f.options);
    const result = await reopened.inspectCreation('workspace-one', 'create-one');
    expect(result).toMatchObject({ state: 'created', nativeSessionId: 'local-created-1' });
    expect(f.stored.size).toBe(1);
    expect(f.request.mock.calls.filter(([method]) => method === 'session.create').map(([, input]) => input)).toEqual([original, original]);
    expect(f.request.mock.calls.every(([method]) => ['runtime.describe', 'session.create'].includes(method))).toBe(true);
    await reopened.close();
  });

  it.each(['cwd', 'request_id', 'source'])('refuses unsupported native %s creation before mutation', async parameter => {
    const f = await fixture(); f.description.session_create.parameters = f.description.session_create.parameters.filter(value => value !== parameter);
    expect(await f.service.prepare('workspace-one')).toMatchObject({ state: 'unavailable' });
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['runtime.describe']);
    expect(f.stored.size).toBe(0);
    await f.service.close();
  });

  it('revalidates scope before create and prevents an old receipt from being inspected under a changed profile', async () => {
    const f = await fixture(), review = await f.service.prepare('workspace-one');
    f.authority.fingerprint = 'changed-profile-authority';
    expect(await f.service.create('workspace-one', { revision: review.revision!, operationId: 'create-one' })).toMatchObject({ state: 'rejected' });
    expect(f.stored.size).toBe(0);
    const next = await f.service.prepare('workspace-one'); f.loseAck();
    await f.service.create('workspace-one', { revision: next.revision!, operationId: 'create-one' });
    f.request.mockClear(); f.authority.fingerprint = 'another-profile';
    expect(await f.service.inspectCreation('workspace-one', 'create-one')).toMatchObject({ state: 'rejected' });
    expect(await f.service.create('workspace-one', { revision: next.revision!, operationId: 'create-one' })).toMatchObject({ state: 'rejected' });
    expect(f.request).not.toHaveBeenCalled();
    await f.service.close();
  });

  it('does not use a new operation to bypass an unregistered or uncertain creation', async () => {
    const f = await fixture(), first = await f.service.prepare('workspace-one'); f.loseAck();
    await f.service.create('workspace-one', { revision: first.revision!, operationId: 'create-one' });
    const next = await f.service.prepare('workspace-one');
    expect(await f.service.create('workspace-one', { revision: next.revision!, operationId: 'create-two' })).toMatchObject({ state: 'rejected' });
    expect(f.stored.size).toBe(1);
    await f.service.close();
  });

  it('fails closed on a malformed journal and leaves its bytes unchanged', async () => {
    const f = await fixture(); await f.service.close();
    await mkdir(path.dirname(f.options.file), { recursive: true }); await writeFile(f.options.file, '{broken journal');
    const before = await readFile(f.options.file), reopened = new HermesHandoverService(f.options);
    expect(await reopened.prepare('workspace-one')).toMatchObject({ state: 'unavailable' });
    expect(await reopened.create('workspace-one', { revision: 'anything', operationId: 'create-one' })).toMatchObject({ state: 'rejected' });
    expect(f.factory).not.toHaveBeenCalled();
    expect(await readFile(f.options.file)).toEqual(before);
    await reopened.close();
  });

  it('owns explicit preparation until a late bootstrap and its actual cleanup have both settled', async () => {
    const f = await fixture();
    let release!: (rpc: HermesObservedRpc) => void, closeRelease!: () => void;
    f.factory.mockImplementationOnce(async () => new Promise(resolve => { release = resolve; }));
    const prepared = f.service.prepare('workspace-one');
    expect(f.service.isBusy()).toBe(true);
    for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 2));
    expect(release).toBeTypeOf('function');
    let finished = false;
    const closing = f.service.close().then(() => { finished = true; });
    const closed = vi.fn(async () => new Promise<void>(resolve => { closeRelease = resolve; }));
    release({ profileId: f.description.profile_id, instanceId: f.description.instance_id, request: f.request, close: closed });
    for (let i = 0; i < 20 && !closeRelease; i++) await Promise.resolve();
    expect(closed).toHaveBeenCalledOnce(); expect(finished).toBe(false); expect(f.service.isBusy()).toBe(true);
    expect(f.request).not.toHaveBeenCalled();
    closeRelease();
    expect(await prepared).toMatchObject({ state: 'unavailable' }); await closing;
    expect(finished).toBe(true); expect(f.service.isBusy()).toBe(false);
  });

  it('keeps unconfirmed transport cleanup fenced instead of releasing operation ownership', async () => {
    const f = await fixture();
    f.factory.mockImplementationOnce(async () => ({ profileId: f.description.profile_id, instanceId: f.description.instance_id, request: f.request,
      close: vi.fn(async () => { throw new Error('Unconfirmed native transport cleanup'); }) }));
    expect(await f.service.prepare('workspace-one')).toMatchObject({ state: 'unavailable' });
    expect(f.service.isBusy()).toBe(true);
    await expect(f.service.close()).rejects.toThrow('cleanup could not be confirmed');
  });

  it('refuses a consistent but foreign native profile before inspecting its sessions', async () => {
    const f = await fixture(); f.description.profile_id = path.join(f.authority.profileHome, 'foreign');
    expect(await f.service.prepare('workspace-one')).toMatchObject({ state: 'unavailable' });
    expect(f.request).not.toHaveBeenCalled();
    await f.service.close();
  });
});
