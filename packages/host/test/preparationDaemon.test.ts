import { createAgentHost } from '../src/service.js';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonOp, DaemonPreparationAdmission, DaemonPreparationBegin, DaemonPreparationObservationRecord } from '@extalia/protocol';
import type { AgentHostRuntime } from '../src/service.js';

import { DaemonClient, DaemonUnavailableError, DaemonRequestError } from '../src/daemon/client.js';
import * as credentials from '../src/secrets.js';
import * as jsonStore from '../src/jsonStore.js';
import { WorktreeManager } from '../src/worktrees/index.js';
import { DAEMON_BINARY, HAS_DAEMON, coreFile, queryCore } from './daemonBackend.js';
import { mockModelDiscovery } from './modelDiscoveryFixture.js';

// Real Rust preparation storage with synthetic providers and isolated temporary homes only.
if (!HAS_DAEMON) console.warn('preparationDaemon.test.ts skipped: build with cargo build -p extalia-daemon.');
const roots: string[] = [], closes: (() => Promise<void>)[] = [], releases: (() => void)[] = [];
afterEach(async () => {
  while (releases.length) releases.pop()!();
  while (closes.length) await closes.pop()!();
  vi.restoreAllMocks();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});
const reply = (model = 'model-a') => Response.json({ model, choices: [{ message: { content: 'Reviewed read-only; no verified evidence claimed.' }, finish_reason: 'stop' }] });
const catalog = () => Response.json({ data: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }] });
const observed = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
function held<T>(fallback: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  releases.push(() => resolve(fallback));
  return { promise, resolve };
}
interface Call { url: string; signal?: AbortSignal | null; text: string }
async function fixture(handler: (call: Call) => Response | Promise<Response> = call => call.url.endsWith('/models') ? catalog() : reply(), options: { git?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-preparation-daemon-')); roots.push(root);
  const project = path.join(root, 'project'), independentProject = path.join(root, 'independent-project'), home = path.join(root, 'home'), data = path.join(root, 'data');
  await Promise.all([mkdir(project, { recursive: true }), mkdir(independentProject, { recursive: true }), mkdir(home, { recursive: true })]);
  await writeFile(path.join(project, 'README.md'), 'Synthetic fixture.\n');
  if (options.git) {
    const gitEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig') };
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: project, env: gitEnv, stdio: 'pipe' });
    git('init', '-q'); git('add', 'README.md'); git('commit', '-qm', 'Synthetic fixture');
  }
  const children: ChildProcess[] = [], calls: Call[] = [], log: string[] = [];
  const open = async (core: 'rust' | 'typescript' = 'rust') => {
    const runtime = await createAgentHost({
      kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 60_000,
      env: { EXTALIA_NATIVE_CORE: core, EXTALIA_DAEMON_PATH: DAEMON_BINARY, EXTALIA_SECRET_STORE: 'memory', HOME: home, PATH: options.git ? process.env.PATH ?? '' : '', PLAN_KEY_A: 'opaque-plan-key-a', PLAN_KEY_B: 'opaque-plan-key-b', PLAN_KEY_C: 'opaque-plan-key-c' },
      fetch: async (url, init) => { const call = { url: String(url), signal: init?.signal, text: typeof init?.body === 'string' ? init.body : '' }; calls.push(call); return handler(call); },
      modelDiscovery: mockModelDiscovery(async (url, init) => { const call = { url: String(url), signal: init?.signal, text: typeof init?.body === 'string' ? init.body : '' }; calls.push(call); return handler(call); }),
      daemon: { log: line => { log.push(line); }, spawn: (binary, args, options) => { const child = spawn(binary, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child); return child; } },
    });
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await runtime.close(); } };
    closes.push(close); return { runtime, host: runtime.host, close };
  };
  const first = await open();
  const add = async (label: string) => (await first.host.saveConnection({ name: `Provider ${label}`, preset: 'custom', api: 'openai-chat', baseUrl: `https://${label.toLowerCase()}.example.com/v1`, model: `model-${label.toLowerCase()}`, credential: { kind: 'env', variable: `PLAN_KEY_${label}` }, features: { memory: 'off', skills: 'off' } })).connections.find(item => item.name === `Provider ${label}`)!;
  const a = await add('A'), b = await add('B'), c = await add('C');
  const workspace = (await first.host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: a.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces.find(item => item.name === 'Project')!;
  await first.host.setWorkspaceMissionConnections(workspace.id, [b.id]);
  const independent = (await first.host.saveWorkspace({ name: 'Independent', projectLocation: independentProject, connectionId: c.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces.find(item => item.name === 'Independent')!;
  const session = await first.host.createSession(workspace.id), other = await first.host.createSession(workspace.id), independentSession = await first.host.createSession(independent.id);
  return { root, project, data, home, ...first, open, children, calls, log, workspace, session, other, independent, independentSession, a, b, c };
}
type Env = Awaited<ReturnType<typeof fixture>>;
const markers = async (env: Env) => JSON.parse(await readFile(path.join(env.data, 'state', 'native-preparation.json'), 'utf8')) as { pending: DaemonPreparationBegin[] };
const admissions = (env: Env) => queryCore<{ payload: string }>(env.data, 'SELECT payload FROM preparation_admissions ORDER BY invocation_id').map(row => JSON.parse(row.payload) as DaemonPreparationAdmission);
const observations = (env: Env) => queryCore<{ payload: string }>(env.data, 'SELECT payload FROM preparation_observations ORDER BY invocation_id').map(row => JSON.parse(row.payload) as DaemonPreparationObservationRecord);
const idle = async (runtime: AgentHostRuntime) => vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { interval: 5, timeout: 3000 });
const mission = (env: Env) => ({ title: 'Review', tasks: [{ id: 'review', title: 'Review', instructions: 'Inspect read-only.', connectionId: env.a.id, model: 'model-a', dependsOn: [] }] });
const wait = async (check: () => void) => vi.waitFor(check, { interval: 5, timeout: 3000 });

describe.skipIf(!HAS_DAEMON)('saved native mission preparation on the real Rust daemon', () => {
  it('owns the future mission before credentials and hands off matching identities before provider execution', async () => {
    let credentialEntries = 0, providerEntries = 0;
    const boundaryErrors: unknown[] = [];
    const env = await fixture(async call => {
      providerEntries++;
      try {
        expect((await markers(env)).pending).toEqual([]);
        expect(observations(env)).toEqual([expect.objectContaining({ kind: 'local-preparation-settled' })]);
        expect(queryCore(env.data, 'SELECT mission_id FROM missions')).toHaveLength(1);
      } catch (error) { boundaryErrors.push(error); throw error; }
      return reply((JSON.parse(call.text) as { model: string }).model);
    });
    const original = credentials.resolveCredential;
    vi.spyOn(credentials, 'resolveCredential').mockImplementation(async (source, store, variables) => {
      credentialEntries++;
      const admission = admissions(env)[0]!;
      expect(admission).toMatchObject({ kind: 'native-mission-preparation', sessionId: env.session.id, workspaceId: env.workspace.id, connectionIds: [env.a.id, env.b.id].sort() });
      expect((await markers(env)).pending).toEqual([expect.objectContaining({ invocationId: admission.invocationId, missionId: admission.missionId, canonicalWorkspaceId: admission.canonicalWorkspaceId, supervisorId: admission.supervisorId })]);
      expect(queryCore(env.data, 'SELECT mission_id FROM missions')).toEqual([]);
      expect(observations(env)).toEqual([]); expect(env.calls).toEqual([]);
      return original(source, store, variables);
    });
    const request = mission(env);
    request.tasks.push({ ...request.tasks[0]!, id: 'second', connectionId: env.b.id, model: 'model-b' });
    const run = await env.host.startNativeMission(env.session.id, request);
    await idle(env.runtime);
    expect(boundaryErrors).toEqual([]);
    const completed = await env.host.nativeMissionRun(env.session.id, run.id);
    expect(completed.state, JSON.stringify(completed)).toBe('completed');
    expect(credentialEntries).toBe(2); expect(providerEntries).toBe(2);
    if (run.authority?.backend !== 'rust') throw new Error('Expected Rust mission authority.');
    const admission = admissions(env)[0]!;
    expect(admission).toMatchObject({ missionId: run.id, canonicalWorkspaceId: run.authority.workspaceId, supervisorId: run.authority.supervisorId });
    expect(observations(env)).toEqual([expect.objectContaining({ invocationId: admission.invocationId, admissionDigest: admission.admissionDigest, kind: 'local-preparation-settled' })]);
    expect(queryCore(env.data, 'SELECT mission_id,workspace_id FROM missions')).toEqual([{ mission_id: run.id, workspace_id: admission.canonicalWorkspaceId }]);
    expect(queryCore(env.data, 'SELECT DISTINCT supervisor_id FROM execution_admissions')).toEqual([{ supervisor_id: admission.supervisorId }]);
    expect((await markers(env)).pending).toEqual([]);
  });

  it.each(['capability', 'admission', 'marker-write'] as const)('refuses %s failure before any credential, worktree or provider effect', async failure => {
    const env = await fixture();
    if (failure === 'capability') {
      const getter = Object.getOwnPropertyDescriptor(DaemonClient.prototype, 'capabilities')!.get!;
      vi.spyOn(DaemonClient.prototype, 'capabilities', 'get').mockImplementation(function (this: DaemonClient) { return (getter.call(this) as readonly DaemonOp[]).filter(op => !op.startsWith('preparation.')); });
    }
    const original = DaemonClient.prototype.request;
    const requests = vi.spyOn(DaemonClient.prototype, 'request').mockImplementation(function (this: DaemonClient, ...args: Parameters<DaemonClient['request']>) {
      if (failure === 'admission' && args[0] === 'preparation.begin') return Promise.reject(new DaemonRequestError('storage_failure'));
      return original.apply(this, args);
    } as DaemonClient['request']);
    if (failure === 'marker-write') {
      const writeJson = jsonStore.writeJsonAtomic;
      vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementation(async (file, value, options) => {
        if (file === path.join(env.data, 'state', 'native-preparation.json')) throw new Error('Synthetic marker write failure.');
        await writeJson(file, value, options);
      });
    }
    const secret = vi.spyOn(credentials, 'resolveCredential'), worktree = vi.spyOn(WorktreeManager.prototype, 'create');
    await expect(env.host.startNativeMission(env.session.id, mission(env))).rejects.toThrow();
    expect(secret).not.toHaveBeenCalled(); expect(worktree).not.toHaveBeenCalled(); expect(env.calls).toEqual([]);
    expect(admissions(env)).toEqual([]); expect(observations(env)).toEqual([]);
    expect(requests.mock.calls.filter(([op]) => op === 'preparation.begin')).toHaveLength(failure === 'admission' ? 1 : 0);
    if (failure === 'admission') expect((await markers(env)).pending).toHaveLength(1);
    else await expect(markers(env)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('drains a delayed credential sibling after an early failure and guards planning, chat and configuration meanwhile', async () => {
    const env = await fixture(), gate = held<string | undefined>('opaque-plan-key-b');
    let siblingEntered = false, returned = false;
    const original = credentials.resolveCredential;
    const secret = vi.spyOn(credentials, 'resolveCredential').mockImplementation((source, store, variables) => {
      if (source.kind === 'env' && source.variable === 'PLAN_KEY_A') return Promise.reject(new Error('Synthetic credential failure.'));
      if (source.kind === 'env' && source.variable === 'PLAN_KEY_B') { siblingEntered = true; return gate.promise; }
      return original(source, store, variables);
    });
    const request = mission(env); request.tasks.push({ ...request.tasks[0]!, id: 'second', connectionId: env.b.id, model: 'model-b' });
    const pending = observed(env.host.startNativeMission(env.session.id, request)).then(result => { returned = true; return result; });
    await wait(() => expect(siblingEntered).toBe(true));
    expect(returned).toBe(false); expect(env.runtime.isBusy()).toBe(true); expect((await markers(env)).pending).toHaveLength(1); expect(observations(env)).toEqual([]);
    await expect(env.host.startNativeMission(env.session.id, request)).rejects.toThrow(/working|active|unresolved/);
    await expect(env.host.planNativeMission(env.other.id, { goal: 'Overlapping planning.' })).rejects.toThrow(/working|active|unresolved/);
    await expect(env.host.sendPrompt(env.other.id, 'Overlapping chat.')).rejects.toThrow(/working|active|unresolved/);
    await expect(env.host.saveConnection({ ...env.a, credential: { kind: 'none' } })).rejects.toThrow(/working|active|unresolved/);
    await expect(env.host.setWorkspaceMissionConnections(env.workspace.id, [])).rejects.toThrow(/working|active|unresolved/);
    expect(await env.host.testConnection(env.a)).toMatchObject({ ok: false, error: expect.stringMatching(/working|active|unresolved/) });
    expect(returned).toBe(false); expect(secret).toHaveBeenCalledTimes(2); expect(env.calls).toEqual([]);
    gate.resolve('opaque-plan-key-b'); expect((await pending).error).toBeInstanceOf(Error); await idle(env.runtime);
    expect(observations(env)).toEqual([expect.objectContaining({ kind: 'local-preparation-settled' })]); expect((await markers(env)).pending).toEqual([]);
    expect(queryCore(env.data, 'SELECT mission_id FROM missions')).toEqual([]); expect(env.calls).toEqual([]);
  });

  it.each(['cancel', 'daemon-loss'] as const)('stops worktree and provider entry after %s during an abort-ignoring credential call', async failure => {
    const env = await fixture(undefined, { git: true }), gate = held<string | undefined>('opaque-plan-key-a'); let entered = false;
    const secret = vi.spyOn(credentials, 'resolveCredential').mockImplementation(() => { entered = true; return gate.promise; });
    const worktree = vi.spyOn(WorktreeManager.prototype, 'create');
    const request = { ...mission(env), tasks: [{ ...mission(env).tasks[0]!, access: 'write' as const }] };
    const pending = observed(env.host.startNativeMission(env.session.id, request));
    await wait(() => expect(entered).toBe(true));
    if (failure === 'cancel') await env.host.cancel(env.session.id);
    else {
      expect(env.children).toHaveLength(1); env.children[0]!.kill('SIGKILL');
      await wait(() => expect(env.children[0]!.signalCode).toBe('SIGKILL'));
      await wait(() => expect(env.log.some(line => line.includes('unavailable'))).toBe(true));
    }
    expect(env.runtime.isBusy()).toBe(true); expect(observations(env)).toEqual([]); expect((await markers(env)).pending).toHaveLength(1);
    gate.resolve('opaque-plan-key-a'); expect((await pending).error).toBeInstanceOf(Error);
    expect(secret).toHaveBeenCalledTimes(1); expect(worktree).not.toHaveBeenCalled(); expect(env.calls).toEqual([]);
    expect(queryCore(env.data, 'SELECT mission_id FROM missions')).toEqual([]);
    if (failure === 'cancel') { await idle(env.runtime); expect((await markers(env)).pending).toEqual([]); expect(observations(env)).toHaveLength(1); }
    else { expect(observations(env)).toEqual([]); expect((await markers(env)).pending).toHaveLength(1); }
  });

  it.each(['mission-create-ack', 'observation'] as const)('retains an uncertain %s marker across restart and a TypeScript backend change without replay or invented settlement', async failure => {
    const env = await fixture();
    const original = DaemonClient.prototype.request;
    const requests = vi.spyOn(DaemonClient.prototype, 'request').mockImplementation(function (this: DaemonClient, ...args: Parameters<DaemonClient['request']>) {
      if (failure === 'observation' && args[0] === 'preparation.observe') return Promise.reject(new DaemonRequestError('storage_failure'));
      const pending = original.apply(this, args);
      if (failure === 'mission-create-ack' && args[0] === 'mission.create') return pending.then(() => { throw new DaemonUnavailableError('timeout'); });
      return pending;
    } as DaemonClient['request']);
    await expect(env.host.startNativeMission(env.session.id, mission(env))).rejects.toThrow();
    const admission = admissions(env)[0]!;
    expect((await markers(env)).pending).toEqual([expect.objectContaining({ invocationId: admission.invocationId })]);
    expect(observations(env)).toEqual([]); expect(env.calls).toEqual([]);
    expect(queryCore(env.data, 'SELECT mission_id FROM missions')).toEqual([{ mission_id: admission.missionId }]);
    expect(queryCore(env.data, 'SELECT lease_id FROM execution_admissions')).toEqual([]);
    await env.close(); requests.mockClear();
    const reopened = await env.open('typescript');
    const secret = vi.spyOn(credentials, 'resolveCredential');
    expect(requests.mock.calls.filter(([op]) => op.startsWith('preparation.')).map(([op]) => op)).toEqual(['preparation.inspect']);
    expect((await markers(env)).pending).toHaveLength(1); expect(observations(env)).toEqual([]);
    await expect(reopened.host.startNativeMission(env.session.id, mission(env))).rejects.toThrow(/unresolved/);
    await expect(reopened.host.planNativeMission(env.session.id, { goal: 'Blocked planning.' })).rejects.toThrow(/unresolved/);
    await expect(reopened.host.sendPrompt(env.other.id, 'Blocked shared connection.')).rejects.toThrow(/unresolved/);
    await expect(reopened.host.saveConnection({ ...env.a, credential: { kind: 'none' } })).rejects.toThrow(/unresolved/);
    await expect(reopened.host.deleteWorkspace(env.workspace.id)).rejects.toThrow(/unresolved/);
    expect(secret).not.toHaveBeenCalled(); expect(env.calls).toEqual([]);
    expect(requests.mock.calls.some(([op]) => op === 'preparation.begin' || op === 'preparation.observe' || op === 'mission.create')).toBe(false);
  });

  it('keeps failed cancellation recovering after the observation committed but marker retirement failed', async () => {
    const env = await fixture();
    const writeJson = jsonStore.writeJsonAtomic;
    const writes = vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementation(async (file, value, options) => {
      if (file === path.join(env.data, 'state', 'native-preparation.json') && (value as { pending: unknown[] }).pending.length === 0) {
        const db = new DatabaseSync(coreFile(env.data));
        try { db.exec("CREATE TRIGGER fail_preparation_cancel BEFORE INSERT ON events WHEN NEW.event_type='mission.state' BEGIN SELECT RAISE(ABORT,'synthetic cancellation failure'); END;"); } finally { db.close(); }
        throw new Error('Synthetic marker retirement failure.');
      }
      await writeJson(file, value, options);
    });
    await expect(env.host.startNativeMission(env.session.id, mission(env))).rejects.toThrow();
    const admission = admissions(env)[0]!;
    expect(observations(env)).toEqual([expect.objectContaining({ invocationId: admission.invocationId, admissionDigest: admission.admissionDigest, kind: 'local-preparation-settled' })]);
    expect((await markers(env)).pending).toHaveLength(1); expect(env.calls).toEqual([]);
    expect(await env.host.nativeMissionRun(env.session.id, admission.missionId)).toMatchObject({ state: 'recovering', recovery: { source: 'execution-uncertain' }, tasks: [expect.objectContaining({ state: 'queued' })] });
    await expect(env.host.sendPrompt(env.other.id, 'Blocked uncertain cancellation.')).rejects.toThrow(/active|unresolved/);
    await env.close(); writes.mockRestore();
    const db = new DatabaseSync(coreFile(env.data));
    try { db.exec('DROP TRIGGER fail_preparation_cancel'); } finally { db.close(); }
    const inspections = vi.spyOn(DaemonClient.prototype, 'request');
    const reopened = await env.open('typescript');
    // Inspection may retire the positively observed local preparation. The failed
    // canonical cancellation still keeps its separate execution scope unresolved.
    expect(inspections.mock.calls.filter(([op]) => op === 'preparation.inspect')).toHaveLength(1);
    expect((await markers(env)).pending).toEqual([]);
    expect(await reopened.host.nativeMissionRun(env.session.id, admission.missionId)).toMatchObject({ state: 'recovering' });
    const secret = vi.spyOn(credentials, 'resolveCredential');
    await expect(reopened.host.startNativeMission(env.session.id, mission(env))).rejects.toThrow(/active|unresolved/);
    await expect(reopened.host.sendPrompt(env.other.id, 'Still blocked.')).rejects.toThrow(/active|unresolved/);
    expect(secret).not.toHaveBeenCalled(); expect(env.calls).toEqual([]);
  });

  it('holds the profile lock beyond the close deadline while a real worktree creation still writes its registry', async () => {
    const env = await fixture(undefined, { git: true }), gate = held<void>(undefined);
    let entered = false;
    const registryFile = path.join(env.data, 'state', 'worktrees.json'), writeJson = jsonStore.writeJsonAtomic;
    const writes = vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementation(async (file, value, options) => {
      if (file === registryFile && !entered) { entered = true; await gate.promise; }
      await writeJson(file, value, options);
    });
    const requests = vi.spyOn(DaemonClient.prototype, 'request');
    const request = { ...mission(env), tasks: [{ ...mission(env).tasks[0]!, access: 'write' as const }] };
    const pending = observed(env.host.startNativeMission(env.session.id, request));
    await wait(() => expect(entered).toBe(true));
    const worktrees = await env.runtime.worktrees!.list(); expect(worktrees).toHaveLength(1);
    expect(await readFile(path.join(worktrees[0]!.path, 'README.md'), 'utf8')).toBe('Synthetic fixture.\n');
    expect((await markers(env)).pending).toHaveLength(1); expect(observations(env)).toEqual([]);
    const realTimeout = globalThis.setTimeout;
    let deadlineExpired = false, closed = false;
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => delay === 5_000
      ? realTimeout(() => { deadlineExpired = true; callback(...args); }, 25)
      : realTimeout(callback, delay, ...args));
    const closing = env.close().then(() => { closed = true; });
    try {
      await wait(() => expect(deadlineExpired).toBe(true)); expect(closed).toBe(false);
      await expect(env.open('typescript')).rejects.toThrow(/already running/);
      await expect(readFile(registryFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { timer.mockRestore(); }
    gate.resolve(undefined); await closing; expect((await pending).error).toBeInstanceOf(Error);
    expect(JSON.parse(await readFile(registryFile, 'utf8'))).toMatchObject({ worktrees: [expect.objectContaining({ state: 'active' })] });
    expect(env.calls).toEqual([]); expect(observations(env)).toEqual([]); expect((await markers(env)).pending).toHaveLength(1);
    expect(requests.mock.calls.some(([op]) => op === 'mission.create' || op === 'preparation.observe')).toBe(false);
    const writeCount = writes.mock.calls.filter(([file]) => file === registryFile).length;
    const reopened = await env.open('typescript');
    expect(await reopened.runtime.worktrees!.list()).toHaveLength(1);
    await expect(reopened.host.startNativeMission(env.session.id, request)).rejects.toThrow(/unresolved/);
    expect(writes.mock.calls.filter(([file]) => file === registryFile)).toHaveLength(writeCount);
  }, 15_000);

});
