import { DAEMON_PLANNING_OPS, type DaemonOp, type DaemonPlanningBegin } from '@extalia/protocol';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonRequestError, DaemonUnavailableError, type DaemonClient } from '../src/daemon/client.js';
import * as jsonStore from '../src/jsonStore.js';
import { PlanningOwnership } from '../src/planningOwnership.js';

const at = '2026-10-31T12:00:00.000Z', sha = 'a'.repeat(64);
const roots: string[] = [];
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const params = (n = 1): DaemonPlanningBegin => ({ invocationId: id(n), supervisorId: id(1000), sessionId: `s_example${n}`, workspaceId: 'w_example', connectionIds: [`c_example${n}`] });
const admission = (request = params()) => ({ ...structuredClone(request), kind: 'native-planning', admittedAt: at, admissionDigest: sha });
const observation = (request = params()) => ({ invocationId: request.invocationId, admissionDigest: sha, kind: 'local-pipeline-settled', recordedAt: at });
const envelope = (pending: DaemonPlanningBegin[]) => ({ schema: 'extalia.native-planning.v1', pending });
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
class FakeClient {
  usable = true;
  capabilities: readonly DaemonOp[] = DAEMON_PLANNING_OPS;
  failure: 'crashed' | undefined;
  handle?: (op: DaemonOp, value: unknown) => unknown | Promise<unknown>;
  request = vi.fn(async (op: DaemonOp, value: unknown) => {
    if (this.handle) return this.handle(op, value);
    if (op === 'planning.begin') return admission(value as DaemonPlanningBegin);
    if (op === 'planning.observe') return { ...(value as object), recordedAt: at };
    throw new DaemonRequestError('not_found');
  });
  get client(): DaemonClient { return this as unknown as DaemonClient; }
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-planning-')); roots.push(root);
  const file = path.join(root, 'planning.json');
  const registry = await PlanningOwnership.open(file);
  const client = new FakeClient();
  return { root, file, registry, client, saved: async () => JSON.parse(await readFile(file, 'utf8')) as { pending: DaemonPlanningBegin[] } };
}
afterEach(async () => {
  vi.restoreAllMocks();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe('native planning durable scope ownership', () => {
  it('does not start a daemon without saved pending markers', async () => {
    const f = await fixture(), recover = vi.fn(async () => f.client.client);
    await PlanningOwnership.open(f.file, recover);
    await writeFile(f.file, JSON.stringify(envelope([])));
    await PlanningOwnership.open(f.file, recover);
    expect(recover).not.toHaveBeenCalled();
  });

  it('installs the memory guard synchronously and saves the marker before admitting', async () => {
    const f = await fixture(), held = deferred<unknown>();
    f.client.handle = async (op, request) => {
      expect(op).toBe('planning.begin');
      expect((await f.saved()).pending).toEqual([params()]);
      expect(() => f.registry.assertClear(params().sessionId)).toThrow(/unresolved/);
      return held.promise.then(() => admission(request as DaemonPlanningBegin));
    };
    const beginning = f.registry.begin(f.client.client, params());
    expect(() => f.registry.assertClear(params().sessionId)).toThrow(/unresolved/);
    expect(() => f.registry.assertClear(undefined, params().connectionIds)).toThrow(/unresolved/);
    await expect(f.registry.begin(f.client.client, { ...params(2), sessionId: params().sessionId })).rejects.toThrow(/unresolved/);
    await expect(f.registry.begin(f.client.client, { ...params(2), connectionIds: params().connectionIds })).rejects.toThrow(/unresolved/);
    held.resolve(undefined);
    const owned = await beginning;
    owned.check();
    expect(f.client.request).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent writes and preserves independent markers', async () => {
    const f = await fixture();
    const owners = await Promise.all([f.registry.begin(f.client.client, params()), f.registry.begin(f.client.client, params(2))]);
    expect((await f.saved()).pending).toEqual([params(), params(2)]);
    await Promise.all(owners.map(owner => owner.settle()));
    expect((await f.saved()).pending).toEqual([]);
  });

  it('clones admission scope and settles once on the original client before removing its guard', async () => {
    const f = await fixture(), request = params(), held = deferred<unknown>();
    const beginning = f.registry.begin(f.client.client, request);
    request.sessionId = 's_changed'; request.connectionIds[0] = 'c_changed';
    const owned = await beginning;
    f.client.handle = (op, value) => { expect(op).toBe('planning.observe'); return held.promise.then(() => ({ ...(value as object), recordedAt: at })); };
    const first = owned.settle(), second = owned.settle();
    expect(first).toBe(second);
    expect(() => f.registry.assertClear(params().sessionId)).toThrow(/unresolved/);
    expect((await f.saved()).pending).toEqual([params()]);
    held.resolve(undefined);
    await Promise.all([first, second, owned.settle()]);
    expect(f.client.request.mock.calls.map(([op]) => op)).toEqual(['planning.begin', 'planning.observe']);
    expect((await f.saved()).pending).toEqual([]);
    expect(() => f.registry.assertClear(params().sessionId, params().connectionIds)).not.toThrow();
  });

  it.each(DAEMON_PLANNING_OPS)('requires optional capability %s before any marker or admission', async missing => {
    const f = await fixture(); f.client.capabilities = DAEMON_PLANNING_OPS.filter(op => op !== missing);
    await expect(f.registry.begin(f.client.client, params())).rejects.toEqual(new DaemonUnavailableError('missing_capability'));
    expect(f.client.request).not.toHaveBeenCalled();
    await expect(readFile(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => f.registry.assertClear(params().sessionId)).not.toThrow();
  });

  it('refuses unusable clients and invalid scope without saving markers', async () => {
    const f = await fixture(); f.client.usable = false; f.client.failure = 'crashed';
    await expect(f.registry.begin(f.client.client, params())).rejects.toEqual(new DaemonUnavailableError('crashed'));
    f.client.usable = true;
    for (const invalid of [{ ...params(), prompt: 'example' }, { ...params(), sessionId: '/example' }, { ...params(), connectionIds: ['c_z', 'c_a'] }]) {
      await expect(f.registry.begin(f.client.client, invalid)).rejects.toEqual(new DaemonRequestError('invalid_request'));
    }
    expect(f.client.request).not.toHaveBeenCalled();
    await expect(readFile(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['invocationId', 'supervisorId', 'sessionId', 'workspaceId', 'connectionIds', 'kind', 'admittedAt', 'admissionDigest', 'unknown'] as const)(
    'retains ownership after a mismatched or malformed admission %s', async field => {
      const f = await fixture();
      f.client.handle = () => ({ ...admission(), [field]: field === 'connectionIds' ? ['c_foreign'] : field === 'admissionDigest' ? 'bad' : field === 'admittedAt' ? 'bad' : 'foreign' });
      await expect(f.registry.begin(f.client.client, params())).rejects.toEqual(new DaemonUnavailableError('malformed_reply'));
      expect((await f.saved()).pending).toEqual([params()]);
      expect(() => f.registry.assertClear(params().sessionId)).toThrow(/unresolved/);
    },
  );

  it.each(['invalid_request', 'conflict', 'capacity_exceeded'] as const)('clears only definitive begin refusal %s', async code => {
    const f = await fixture(); f.client.handle = () => { throw new DaemonRequestError(code); };
    await expect(f.registry.begin(f.client.client, params())).rejects.toEqual(new DaemonRequestError(code));
    expect((await f.saved()).pending).toEqual([]);
    expect(() => f.registry.assertClear(params().sessionId)).not.toThrow();
  });

  it.each([new DaemonUnavailableError('timeout'), new DaemonRequestError('storage_failure'), new DaemonRequestError('internal')])(
    'retains ambiguous admission failure $code', async error => {
      const f = await fixture(); f.client.handle = () => { throw error; };
      await expect(f.registry.begin(f.client.client, params())).rejects.toBe(error);
      expect((await f.saved()).pending).toEqual([params()]);
      const restarted = await PlanningOwnership.open(f.file);
      expect(() => restarted.assertClear(undefined, params().connectionIds)).toThrow(/unresolved/);
    },
  );

  it('keeps a conservative memory guard when the prewrite fails and sends nothing', async () => {
    const f = await fixture();
    vi.spyOn(jsonStore, 'writeJsonAtomic').mockRejectedValueOnce(new Error('write failed'));
    await expect(f.registry.begin(f.client.client, params())).rejects.toThrow(/metadata/);
    expect(f.client.request).not.toHaveBeenCalled();
    expect(() => f.registry.assertClear(params().sessionId)).toThrow(/unresolved/);
    // A later independent write persists the failed reservation too.
    await f.registry.begin(f.client.client, params(2));
    expect((await f.saved()).pending).toEqual([params(), params(2)]);
  });

  it('retains the guard if clearing a definitive refusal cannot be saved', async () => {
    const f = await fixture(), actual = jsonStore.writeJsonAtomic;
    vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementationOnce(actual).mockRejectedValueOnce(new Error('write failed'));
    f.client.handle = () => { throw new DaemonRequestError('conflict'); };
    await expect(f.registry.begin(f.client.client, params())).rejects.toThrow(/metadata/);
    expect((await f.saved()).pending).toEqual([params()]);
    expect(() => f.registry.assertClear(params().sessionId)).toThrow(/unresolved/);
  });

  it('rechecks the original connection after writeahead and after admission', async () => {
    const f = await fixture(), actual = jsonStore.writeJsonAtomic;
    vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementationOnce(async (...args) => { await actual(...args); f.client.usable = false; });
    await expect(f.registry.begin(f.client.client, params())).rejects.toBeInstanceOf(DaemonUnavailableError);
    expect(f.client.request).not.toHaveBeenCalled();
    f.client.usable = true;
    f.client.handle = (_op, value) => { f.client.usable = false; return admission(value as DaemonPlanningBegin); };
    await expect(f.registry.begin(f.client.client, params(2))).rejects.toBeInstanceOf(DaemonUnavailableError);
    expect((await f.saved()).pending).toEqual([params(), params(2)]);
  });

  it('never reconnects after the original connection is lost', async () => {
    const f = await fixture(), replacement = new FakeClient(), recover = vi.fn(async () => replacement.client);
    const registry = await PlanningOwnership.open(f.file, recover), owned = await registry.begin(f.client.client, params());
    f.client.usable = false; f.client.failure = 'crashed';
    expect(() => owned.check()).toThrow(DaemonUnavailableError);
    const completion = owned.settle();
    await expect(completion).rejects.toEqual(new DaemonUnavailableError('crashed'));
    expect(owned.settle()).toBe(completion);
    expect(recover).not.toHaveBeenCalled(); expect(replacement.request).not.toHaveBeenCalled();
    expect(f.client.request.mock.calls.map(([op]) => op)).toEqual(['planning.begin']);
    expect((await f.saved()).pending).toEqual([params()]);
  });

  it.each(['identity', 'digest', 'kind', 'timestamp', 'earlier', 'unknown', 'lost'])(
    'requires a matching usable observation acknowledgement: %s', async mismatch => {
      const f = await fixture(), owned = await f.registry.begin(f.client.client, params());
      f.client.handle = () => {
        if (mismatch === 'lost') f.client.usable = false;
        return { ...observation(), ...(mismatch === 'identity' ? { invocationId: id(2) } : mismatch === 'digest' ? { admissionDigest: 'b'.repeat(64) }
          : mismatch === 'kind' ? { kind: 'remote-settled' } : mismatch === 'timestamp' ? { recordedAt: 'bad' }
            : mismatch === 'earlier' ? { recordedAt: '2026-10-31T11:59:59.999Z' } : mismatch === 'unknown' ? { duplicate: true } : {}) };
      };
      await expect(owned.settle()).rejects.toBeInstanceOf(DaemonUnavailableError);
      expect((await f.saved()).pending).toEqual([params()]);
      expect(() => f.registry.assertClear(params().sessionId)).toThrow(/unresolved/);
    },
  );

  it('keeps guards after a valid observation when the marker removal cannot persist', async () => {
    const f = await fixture(), owned = await f.registry.begin(f.client.client, params());
    vi.spyOn(jsonStore, 'writeJsonAtomic').mockRejectedValueOnce(new Error('write failed'));
    const completion = owned.settle();
    await expect(completion).rejects.toThrow(/metadata/);
    expect(owned.settle()).toBe(completion);
    expect((await f.saved()).pending).toEqual([params()]);
    expect(() => f.registry.assertWorkspaceClear(params().workspaceId)).toThrow(/unresolved/);
  });

  it('keeps loaded guards for session, connection and workspace regardless of backend', async () => {
    const f = await fixture(); await writeFile(f.file, JSON.stringify(envelope([params()])));
    const registry = await PlanningOwnership.open(f.file);
    expect(() => registry.assertClear(params().sessionId)).toThrow(/unresolved/);
    expect(() => registry.assertClear('s_different', params().connectionIds)).toThrow(/unresolved/);
    expect(() => registry.assertWorkspaceClear(params().workspaceId)).toThrow(/unresolved/);
    expect(() => registry.assertClear(params().sessionId, params().connectionIds, params().invocationId)).not.toThrow();
    expect(() => registry.assertClear('s_different', ['c_different'])).not.toThrow();
    expect(() => registry.assertWorkspaceClear('w_different')).not.toThrow();
  });

  it('recovers only matching positively observed receipts and never observes on restart', async () => {
    const f = await fixture(); await writeFile(f.file, JSON.stringify(envelope([params(), params(2)])));
    f.client.handle = (op, value) => {
      expect(op).toBe('planning.inspect');
      return (value as { invocationId: string }).invocationId === params().invocationId
        ? { admission: admission(), observation: observation() } : { admission: admission(params(2)) };
    };
    const registry = await PlanningOwnership.open(f.file, async () => f.client.client);
    expect((await f.saved()).pending).toEqual([params(2)]);
    expect(() => registry.assertClear(params().sessionId)).not.toThrow();
    expect(() => registry.assertClear(params(2).sessionId)).toThrow(/unresolved/);
    expect(f.client.request.mock.calls.map(([op]) => op)).toEqual(['planning.inspect', 'planning.inspect']);
  });

  it.each(['missing', 'unsupported', 'failed', 'unusable', 'foreign', 'mismatched-observation', 'lost', 'clear-failed'])(
    'retains startup ownership on %s inspection', async scenario => {
      const f = await fixture(); await writeFile(f.file, JSON.stringify(envelope([params()])));
      if (scenario === 'unsupported') f.client.capabilities = [];
      if (scenario === 'unusable') f.client.usable = false;
      if (scenario === 'clear-failed') vi.spyOn(jsonStore, 'writeJsonAtomic').mockRejectedValueOnce(new Error('write failed'));
      f.client.handle = () => {
        if (scenario === 'missing') throw new DaemonRequestError('not_found');
        if (scenario === 'failed') throw new DaemonUnavailableError('timeout');
        if (scenario === 'lost') f.client.usable = false;
        return { admission: admission(scenario === 'foreign' ? { ...params(), supervisorId: id(2) } : params()),
          observation: { ...observation(), ...(scenario === 'mismatched-observation' ? { admissionDigest: 'b'.repeat(64) } : {}) } };
      };
      const registry = await PlanningOwnership.open(f.file, async () => f.client.client);
      expect((await f.saved()).pending).toEqual([params()]);
      expect(() => registry.assertClear(params().sessionId)).toThrow(/unresolved/);
      expect(f.client.request.mock.calls.every(([op]) => op === 'planning.inspect')).toBe(true);
    },
  );

  it('keeps saved markers if recovery cannot connect', async () => {
    const f = await fixture(); await writeFile(f.file, JSON.stringify(envelope([params()])));
    const registry = await PlanningOwnership.open(f.file, async () => { throw new DaemonUnavailableError('crashed'); });
    expect(() => registry.assertClear(params().sessionId)).toThrow(/unresolved/);
  });

  it('fails closed on malformed, duplicate or oversized metadata without connecting', async () => {
    const f = await fixture(), recover = vi.fn(async () => f.client.client);
    const invalid = [
      'bad JSON', JSON.stringify(null), JSON.stringify([]), JSON.stringify({ pending: [] }),
      JSON.stringify({ ...envelope([]), schema: 'unknown' }), JSON.stringify({ ...envelope([]), extra: true }),
      JSON.stringify(envelope([{ ...params(), prompt: 'example' } as DaemonPlanningBegin])),
      JSON.stringify(envelope([{ ...params(), connectionIds: ['c_z', 'c_a'] }])),
      JSON.stringify(envelope([params(), params()])), JSON.stringify(envelope(Array.from({ length: 129 }, (_, n) => params(n + 1)))),
      ' '.repeat(1024 * 1024 + 1),
    ];
    for (const value of invalid) {
      await writeFile(f.file, value);
      await expect(PlanningOwnership.open(f.file, recover)).rejects.toThrow(/metadata/);
      expect(await readFile(f.file, 'utf8')).toBe(value);
    }
    expect(recover).not.toHaveBeenCalled();
  });

  it('refuses new admission at the 128-marker cap', async () => {
    const f = await fixture(); await writeFile(f.file, JSON.stringify(envelope(Array.from({ length: 128 }, (_, n) => params(n + 1)))));
    const registry = await PlanningOwnership.open(f.file);
    await expect(registry.begin(f.client.client, params(129))).rejects.toEqual(new DaemonRequestError('capacity_exceeded'));
    expect(f.client.request).not.toHaveBeenCalled();
    expect((await f.saved()).pending).toHaveLength(128);
  });

  it('closes synchronously and drains delayed queued writes before another host can write', async () => {
    const f = await fixture(), started = deferred<void>(), finish = deferred<void>(), actual = jsonStore.writeJsonAtomic;
    const write = vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementationOnce(async (...args) => {
      started.resolve(); await finish.promise; await actual(...args);
    });
    const first = f.registry.begin(f.client.client, params()), second = f.registry.begin(f.client.client, params(2));
    const firstResult = expect(first).rejects.toEqual(new DaemonUnavailableError('shutting_down'));
    const secondResult = expect(second).rejects.toEqual(new DaemonUnavailableError('shutting_down'));
    await started.promise;
    let drained = false;
    const closing = f.registry.close().then(() => { drained = true; });
    expect(f.registry.close()).toBe(f.registry.close());
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(f.registry.begin(f.client.client, params(3))).rejects.toEqual(new DaemonUnavailableError('shutting_down'));
    expect(() => f.registry.assertClear('s_unrelated')).toThrow(DaemonUnavailableError);
    expect(() => f.registry.assertWorkspaceClear('w_unrelated')).toThrow(DaemonUnavailableError);
    finish.resolve();
    await Promise.all([closing, firstResult, secondResult]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(f.client.request).not.toHaveBeenCalled();
    expect((await f.saved()).pending).toEqual([params(), params(2)]);
    const next = await PlanningOwnership.open(f.file);
    await next.begin(f.client.client, params(3));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((await f.saved()).pending).toEqual([params(), params(2), params(3)]);
    expect(write).toHaveBeenCalledTimes(3);
    await next.close();
  });

  it.skipIf(process.platform === 'win32')('keeps close pending until directory fsync finishes', async () => {
    const f = await fixture(), entered = deferred<void>(), finish = deferred<void>(), directory = await fs.open(f.root, 'r');
    const prototype = Object.getPrototypeOf(directory) as { sync(): Promise<void> }, sync = prototype.sync;
    await directory.close();
    vi.spyOn(prototype, 'sync').mockImplementation(async function (this: Awaited<ReturnType<typeof fs.open>>) {
      if ((await this.stat()).isDirectory()) { entered.resolve(); await finish.promise; }
      await sync.call(this);
    });
    const beginning = f.registry.begin(f.client.client, params());
    const result = expect(beginning).rejects.toEqual(new DaemonUnavailableError('shutting_down'));
    await entered.promise;
    let closed = false;
    const barrier = f.registry.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish.resolve();
    await Promise.all([barrier, result]);
    expect(f.client.request).not.toHaveBeenCalled();
    expect((await f.saved()).pending).toEqual([params()]);
  });

  it.each(['admitted', 'refused'] as const)('ignores a late %s begin acknowledgement after close', async kind => {
    const f = await fixture(), entered = deferred<void>(), ack = deferred<unknown>();
    f.client.handle = () => { entered.resolve(); return ack.promise; };
    const beginning = f.registry.begin(f.client.client, params());
    const result = expect(beginning).rejects.toEqual(new DaemonUnavailableError('shutting_down'));
    await entered.promise;
    await f.registry.close();
    if (kind === 'admitted') ack.resolve(admission()); else ack.reject(new DaemonRequestError('conflict'));
    await result;
    expect((await f.saved()).pending).toEqual([params()]);
    expect(f.client.request.mock.calls.map(([op]) => op)).toEqual(['planning.begin']);
  });

  it('refuses check and settlement after close without creating an observation', async () => {
    const f = await fixture(), owned = await f.registry.begin(f.client.client, params());
    const close = f.registry.close();
    expect(() => owned.check()).toThrow(DaemonUnavailableError);
    await expect(owned.settle()).rejects.toEqual(new DaemonUnavailableError('shutting_down'));
    await close;
    expect(f.client.request.mock.calls.map(([op]) => op)).toEqual(['planning.begin']);
    expect((await f.saved()).pending).toEqual([params()]);
  });

  it('never queues marker removal from an observation reply arriving after close', async () => {
    const f = await fixture(), owned = await f.registry.begin(f.client.client, params()), ack = deferred<unknown>();
    f.client.handle = () => ack.promise;
    const settling = owned.settle(), result = expect(settling).rejects.toEqual(new DaemonUnavailableError('shutting_down'));
    await f.registry.close();
    const next = await PlanningOwnership.open(f.file);
    await next.begin(new FakeClient().client, params(2));
    ack.resolve(observation());
    await result;
    expect((await f.saved()).pending).toEqual([params(), params(2)]);
    await next.close();
  });

  it('drains a marker removal already writing before close and refuses later settlement', async () => {
    const f = await fixture(), owned = await f.registry.begin(f.client.client, params()), entered = deferred<void>(), finish = deferred<void>();
    const actual = jsonStore.writeJsonAtomic;
    vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementationOnce(async (...args) => { entered.resolve(); await finish.promise; await actual(...args); });
    const settling = owned.settle(), result = expect(settling).rejects.toEqual(new DaemonUnavailableError('shutting_down'));
    await entered.promise;
    let closed = false;
    const barrier = f.registry.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    finish.resolve(); await Promise.all([barrier, result]);
    expect((await f.saved()).pending).toEqual([]);
    await expect(owned.settle()).rejects.toEqual(new DaemonUnavailableError('shutting_down'));
    expect(f.client.request.mock.calls.map(([op]) => op)).toEqual(['planning.begin', 'planning.observe']);
  });

  it('awaits startup recovery marker writes before returning the registry for shutdown', async () => {
    const f = await fixture(), entered = deferred<void>(), finish = deferred<void>(), actual = jsonStore.writeJsonAtomic;
    await writeFile(f.file, JSON.stringify(envelope([params()])));
    f.client.handle = op => { expect(op).toBe('planning.inspect'); return { admission: admission(), observation: observation() }; };
    vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementationOnce(async (...args) => { entered.resolve(); await finish.promise; await actual(...args); });
    let opened = false;
    const opening = PlanningOwnership.open(f.file, async () => f.client.client).then(value => { opened = true; return value; });
    await entered.promise;
    expect(opened).toBe(false);
    finish.resolve();
    const registry = await opening;
    await registry.close();
    expect((await f.saved()).pending).toEqual([]);
    expect(f.client.request.mock.calls.map(([op]) => op)).toEqual(['planning.inspect']);
  });
});
