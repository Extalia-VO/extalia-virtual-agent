import { DAEMON_PLANNING_OPS, DAEMON_PREPARATION_OPS, type DaemonOp, type DaemonPlanningBegin, type DaemonPreparationBegin } from '@extalia/protocol';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonUnavailableError, type DaemonClient } from '../src/daemon/client.js';
import * as jsonStore from '../src/jsonStore.js';
import { PlanningOwnership } from '../src/planningOwnership.js';
import { PreparationOwnership } from '../src/preparationOwnership.js';

const at = '2026-11-01T00:00:00.000Z', digest = 'a'.repeat(64);
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const roots: string[] = [];
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
afterEach(async () => { vi.restoreAllMocks(); while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

for (const kind of ['planning', 'preparation'] as const) describe(`${kind} status marker recheck`, () => {
  async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'extalia-status-ownership-')); roots.push(root);
    const file = path.join(root, 'ownership.json');
    const params = (n = 1): DaemonPreparationBegin => ({ invocationId: id(n), supervisorId: id(100), missionId: id(200 + n), canonicalWorkspaceId: id(300), sessionId: `s_example${n}`, workspaceId: 'w_example', connectionIds: [`c_example${n}`] });
    const request = (n = 1): DaemonPlanningBegin | DaemonPreparationBegin => {
      const { missionId: _missionId, canonicalWorkspaceId: _canonicalWorkspaceId, ...planning } = params(n);
      return kind === 'preparation' ? params(n) : planning;
    };
    await writeFile(file, JSON.stringify({ schema: `extalia.native-${kind}.v1`, pending: [request()] }));
    const registry = await (kind === 'planning' ? PlanningOwnership.open(file) : PreparationOwnership.open(file));
    const evidence = (n = 1) => ({ admission: { ...request(n), kind: kind === 'planning' ? 'native-planning' : 'native-mission-preparation', admittedAt: at, admissionDigest: digest }, observation: { invocationId: id(n), admissionDigest: digest, kind: kind === 'planning' ? 'local-pipeline-settled' : 'local-preparation-settled', recordedAt: at } });
    const fake = { usable: true, capabilities: [...(kind === 'planning' ? DAEMON_PLANNING_OPS : DAEMON_PREPARATION_OPS)] as DaemonOp[], request: vi.fn(async (_op: DaemonOp, _value: unknown): Promise<unknown> => evidence()) };
    const client = fake as unknown as DaemonClient, connect = vi.fn(async () => client);
    const check = (active = () => false) => registry.recheckInactive([id(1)], connect, active);
    return { root, file, registry, params, request, evidence, fake, client, connect, check, saved: async () => JSON.parse(await readFile(file, 'utf8')) as { pending: unknown[] } };
  }

  it('copies snapshots and does not connect while all selected sessions are active', async () => {
    const f = await fixture(), snapshot = f.registry.copiedSnapshot();
    snapshot[0]!.connectionIds.push('c_changed'); snapshot[0]!.sessionId = 's_changed';
    expect(f.registry.copiedSnapshot()).toEqual([f.request()]);
    expect(await f.check(() => true)).toMatchObject({ inspected: 0, retired: 0 });
    expect(f.connect).not.toHaveBeenCalled();
    expect((await f.saved()).pending).toEqual([f.request()]);
  });

  it('retires only exact positive observations and never observes or replays', async () => {
    const f = await fixture();
    expect(await f.check()).toEqual({ inspected: 1, retired: 1, status: 'checked', skippedActive: 0 });
    expect(f.fake.request.mock.calls.map(([op]) => op)).toEqual([`${kind}.inspect`]);
    expect((await f.saved()).pending).toEqual([]);
    expect(f.registry.hasUnresolved()).toBe(false);
  });

  it.each(['scope', 'digest', 'time', 'kind', 'missing'] as const)('retains a %s mismatch', async mismatch => {
    const f = await fixture(), evidence = f.evidence();
    if (mismatch === 'scope') evidence.admission.supervisorId = id(99);
    if (mismatch === 'digest') evidence.observation.admissionDigest = 'b'.repeat(64);
    if (mismatch === 'time') evidence.observation.recordedAt = '2026-10-31T23:59:59.999Z';
    if (mismatch === 'kind') evidence.observation.kind = 'remote-settled';
    f.fake.request.mockResolvedValue(mismatch === 'missing' ? { admission: evidence.admission } : evidence);
    expect(await f.check()).toMatchObject({ inspected: 1, retired: 0 });
    expect((await f.saved()).pending).toEqual([f.request()]);
  });

  it('reports unsupported capabilities without making an inspection RPC', async () => {
    const f = await fixture(); f.fake.capabilities = [];
    expect(await f.check()).toMatchObject({ status: 'unsupported', inspected: 0, retired: 0 });
    expect(f.fake.request).not.toHaveBeenCalled();
    expect(f.registry.hasUnresolved()).toBe(true);
  });

  it('retains the guard when activity begins during connection or inspection', async () => {
    for (const boundary of ['connect', 'inspect'] as const) {
      const f = await fixture(); let active = false;
      if (boundary === 'connect') f.connect.mockImplementation(async () => { active = true; return f.client; });
      else f.fake.request.mockImplementation(async () => { active = true; return f.evidence(); });
      expect(await f.check(() => active)).toMatchObject({ retired: 0, skippedActive: 1 });
      expect((await f.saved()).pending).toEqual([f.request()]);
    }
  });

  it('rechecks activity inside the serialized marker-removal queue', async () => {
    const f = await fixture(), entered = deferred<void>(), release = deferred<void>(), actual = jsonStore.writeJsonAtomic;
    vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; await actual(...args); });
    f.fake.request.mockImplementation(async (op, value) => op === `${kind}.begin` ? { ...value as object, kind: f.evidence().admission.kind, admittedAt: at, admissionDigest: digest } : f.evidence());
    const beginning = kind === 'planning' ? (f.registry as PlanningOwnership).begin(f.client, f.request(2)) : (f.registry as PreparationOwnership).begin(f.client, f.params(2));
    await entered.promise;
    let active = false;
    const checking = f.check(() => active);
    await vi.waitFor(() => expect(f.fake.request).toHaveBeenCalledWith(`${kind}.inspect`, { invocationId: id(1) }));
    active = true;
    release.resolve(); await beginning;
    expect(await checking).toMatchObject({ retired: 0 });
    expect((await f.saved()).pending).toEqual([f.request(), f.request(2)]);
  });

  it('retains an entry replaced while its old inspection is pending', async () => {
    const f = await fixture(), held = deferred<unknown>();
    // Reopen with no pending entries, so normal owner settlement can replace the exact ID.
    await writeFile(f.file, JSON.stringify({ schema: `extalia.native-${kind}.v1`, pending: [] }));
    const registry = kind === 'planning' ? await PlanningOwnership.open(f.file) : await PreparationOwnership.open(f.file);
    f.fake.request.mockImplementation(async (op, value) => op === `${kind}.begin` ? { ...value as object, kind: f.evidence().admission.kind, admittedAt: at, admissionDigest: digest } : op === `${kind}.observe` ? f.evidence().observation : held.promise);
    const begin = () => kind === 'planning' ? (registry as PlanningOwnership).begin(f.client, f.request()) : (registry as PreparationOwnership).begin(f.client, f.params());
    const owner = await begin();
    const checking = registry.recheckInactive([id(1)], f.connect, () => false);
    await vi.waitFor(() => expect(f.fake.request).toHaveBeenCalledWith(`${kind}.inspect`, { invocationId: id(1) }));
    await owner.settle(); await begin();
    held.resolve(f.evidence());
    expect(await checking).toMatchObject({ retired: 0 });
    expect((await f.saved()).pending).toEqual([f.request()]);
  });

  it('drains an in-flight inspection on close and never queues late marker removal', async () => {
    const f = await fixture(), held = deferred<unknown>();
    f.fake.request.mockImplementation(async () => held.promise);
    const checking = f.check();
    await vi.waitFor(() => expect(f.fake.request).toHaveBeenCalledTimes(1));
    let closed = false;
    const closing = f.registry.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    held.resolve(f.evidence());
    await Promise.all([checking, closing]);
    expect((await f.saved()).pending).toEqual([f.request()]);
    await expect(f.registry.begin(f.client, f.params())).rejects.toBeInstanceOf(DaemonUnavailableError);
  });
});
