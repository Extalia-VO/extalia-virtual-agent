import { DAEMON_PREPARATION_OPS, type DaemonOp, type DaemonPreparationBegin } from '@extalia/protocol';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonRequestError, DaemonUnavailableError, type DaemonClient } from '../src/daemon/client.js';
import * as jsonStore from '../src/jsonStore.js';
import { PreparationOwnership } from '../src/preparationOwnership.js';

const at = '2026-11-01T12:00:00.000Z', sha = 'a'.repeat(64);
const roots: string[] = [];
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const params = (n = 1): DaemonPreparationBegin => ({ invocationId: id(n), missionId: id(n + 20), supervisorId: id(1000), canonicalWorkspaceId: id(2000), sessionId: `s_example${n}`, workspaceId: 'w_example', connectionIds: [`c_example${n}`] });
const admission = (request = params()) => ({ ...structuredClone(request), kind: 'native-mission-preparation', admittedAt: at, admissionDigest: sha });
const observation = (request = params()) => ({ invocationId: request.invocationId, admissionDigest: sha, kind: 'local-preparation-settled', recordedAt: at });
const envelope = (pending: DaemonPreparationBegin[]) => ({ schema: 'extalia.native-preparation.v1', pending });
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
class FakeClient {
  usable = true; capabilities: readonly DaemonOp[] = DAEMON_PREPARATION_OPS; failure: 'crashed' | undefined;
  handle?: (op: DaemonOp, value: unknown) => unknown | Promise<unknown>;
  request = vi.fn(async (op: DaemonOp, value: unknown) => {
    if (this.handle) return this.handle(op, value);
    if (op === 'preparation.begin') return admission(value as DaemonPreparationBegin);
    if (op === 'preparation.observe') return { ...(value as object), recordedAt: at };
    throw new DaemonRequestError('not_found');
  });
  get client(): DaemonClient { return this as unknown as DaemonClient; }
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-preparation-')); roots.push(root);
  const file = path.join(root, 'preparation.json'), registry = await PreparationOwnership.open(file), client = new FakeClient();
  return { root, file, registry, client, saved: async () => JSON.parse(await readFile(file, 'utf8')) as { pending: DaemonPreparationBegin[] } };
}
afterEach(async () => { vi.restoreAllMocks(); while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

describe('native mission preparation ownership', () => {
  it('persists the complete scope before daemon admission and blocks intersecting scopes', async () => {
    const f = await fixture(), held = deferred<unknown>();
    f.client.handle = async (op, value) => {
      expect(op).toBe('preparation.begin'); expect((await f.saved()).pending).toEqual([params()]);
      expect(value).toEqual(params()); expect(() => f.registry.assertClear(params().sessionId)).toThrow(/unresolved/);
      return held.promise.then(() => admission(value as DaemonPreparationBegin));
    };
    const beginning = f.registry.begin(f.client.client, params());
    expect(f.registry.hasUnresolved()).toBe(true);
    await expect(f.registry.begin(f.client.client, { ...params(2), connectionIds: params().connectionIds })).rejects.toThrow(/unresolved/);
    held.resolve(undefined); const owned = await beginning; owned.check();
    expect(f.client.request).toHaveBeenCalledTimes(1);
  });

  it.each(['missionId', 'supervisorId', 'canonicalWorkspaceId', 'sessionId', 'workspaceId', 'connectionIds'] as const)('rejects a forged %s acknowledgement', async field => {
    const f = await fixture();
    f.client.handle = (_op, value) => {
      const changed = structuredClone(value as DaemonPreparationBegin);
      if (field === 'connectionIds') changed.connectionIds = ['c_forged']; else (changed as unknown as Record<string, unknown>)[field] = field.endsWith('Id') ? id(7) : 'w_forged';
      return admission(changed);
    };
    await expect(f.registry.begin(f.client.client, params())).rejects.toBeInstanceOf(DaemonUnavailableError);
    expect((await f.saved()).pending).toEqual([params()]);
  });

  it('retains a marker when the initial write fails and never sends admission', async () => {
    const f = await fixture(); vi.spyOn(jsonStore, 'writeJsonAtomic').mockRejectedValueOnce(new Error('disk failed'));
    await expect(f.registry.begin(f.client.client, params())).rejects.toThrow(/metadata/);
    expect(f.client.request).not.toHaveBeenCalled();
    expect(() => f.registry.assertClear(params().sessionId)).toThrow(/unresolved/);
  });

  it('clears only with the original client acknowledgement and preserves uncertain scope', async () => {
    const f = await fixture(), replacement = new FakeClient(), owner = await f.registry.begin(f.client.client, params());
    f.client.usable = false; f.client.failure = 'crashed';
    await expect(owner.settle()).rejects.toBeInstanceOf(DaemonUnavailableError);
    expect(replacement.request).not.toHaveBeenCalled(); expect((await f.saved()).pending).toEqual([params()]);
    expect(() => f.registry.assertWorkspaceClear(params().workspaceId)).toThrow(/unresolved/);
  });

  it('keeps the guard if an observation acknowledgement is ambiguous', async () => {
    const f = await fixture(), owner = await f.registry.begin(f.client.client, params());
    f.client.handle = () => ({ ...observation(), admissionDigest: 'b'.repeat(64) });
    await expect(owner.settle()).rejects.toBeInstanceOf(DaemonUnavailableError);
    expect((await f.saved()).pending).toEqual([params()]);
  });

  it('recovers only a matching inspected admission with positive local-settlement evidence', async () => {
    const f = await fixture(); await writeFile(f.file, JSON.stringify(envelope([params(), params(2)])));
    f.client.handle = (op, value) => {
      expect(op).toBe('preparation.inspect');
      const request = (value as { invocationId: string }).invocationId === params().invocationId ? params() : params(2);
      return { admission: admission(request), ...(request.invocationId === params().invocationId ? { observation: observation(request) } : {}) };
    };
    const registry = await PreparationOwnership.open(f.file, async () => f.client.client);
    expect((await f.saved()).pending).toEqual([params(2)]);
    expect(() => registry.assertClear(params().sessionId)).not.toThrow();
    expect(() => registry.assertClear(params(2).sessionId)).toThrow(/unresolved/);
    expect(f.client.request.mock.calls.map(([op]) => op)).toEqual(['preparation.inspect', 'preparation.inspect']);
  });

  it('retains persisted guards when recovery is unavailable', async () => {
    const f = await fixture(); await writeFile(f.file, JSON.stringify(envelope([params()])));
    const registry = await PreparationOwnership.open(f.file, async () => { throw new DaemonUnavailableError('crashed'); });
    expect(() => registry.assertClear(params().sessionId)).toThrow(/unresolved/);
  });

  it('closes synchronously and drains queued marker writes', async () => {
    const f = await fixture(), entered = deferred<void>(), finish = deferred<void>(), actual = jsonStore.writeJsonAtomic;
    vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementationOnce(async (...args) => { entered.resolve(); await finish.promise; await actual(...args); });
    const first = f.registry.begin(f.client.client, params()), result = expect(first).rejects.toEqual(new DaemonUnavailableError('shutting_down'));
    await entered.promise; const closing = f.registry.close();
    await expect(f.registry.begin(f.client.client, params(2))).rejects.toEqual(new DaemonUnavailableError('shutting_down'));
    finish.resolve(); await Promise.all([closing, result]);
    expect(f.client.request).not.toHaveBeenCalled(); expect((await f.saved()).pending).toEqual([params()]);
  });

  it('fails closed on malformed or wrong-schema persisted markers', async () => {
    const f = await fixture(); await writeFile(f.file, JSON.stringify({ ...envelope([params()]), schema: 'wrong' }));
    await expect(PreparationOwnership.open(f.file)).rejects.toThrow(/metadata/);
  });
});
