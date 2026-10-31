import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonOp, DaemonPlanningAdmission, DaemonPlanningBegin } from '@extalia/protocol';
import type { AgentHostRuntime } from '../src/service.js';
import { createAgentHost } from '../src/service.js';
import { DaemonClient } from '../src/daemon/client.js';
import * as credentials from '../src/secrets.js';
import * as jsonStore from '../src/jsonStore.js';
import { DAEMON_BINARY, HAS_DAEMON, coreFile, queryCore } from './daemonBackend.js';

// Real Rust planning storage with synthetic providers and isolated temporary homes only.
if (!HAS_DAEMON) console.warn('planningDaemon.test.ts skipped: build with cargo build -p extalia-daemon.');
const roots: string[] = [], closes: (() => Promise<void>)[] = [], releases: (() => void)[] = [];
afterEach(async () => {
  while (releases.length) releases.pop()!();
  while (closes.length) await closes.pop()!();
  vi.restoreAllMocks();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});
const reply = () => Response.json({ model: 'model-a', choices: [{ message: { content: JSON.stringify({ title: 'Review', tasks: [{ id: 'review', title: 'Review', role: 'Reviewer', instructions: 'Inspect read-only.', worker: 1, dependsOn: [] }] }) }, finish_reason: 'stop' }] });
const catalog = () => Response.json({ data: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }] });
const observed = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
function held<T>(fallback: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  releases.push(() => resolve(fallback));
  return { promise, resolve };
}
interface Call { url: string; signal?: AbortSignal | null; text: string }
async function fixture(handler: (call: Call) => Response | Promise<Response> = call => call.url.endsWith('/models') ? catalog() : reply()) {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-planning-daemon-')); roots.push(root);
  const project = path.join(root, 'project'), home = path.join(root, 'home'), data = path.join(root, 'data');
  await Promise.all([mkdir(project, { recursive: true }), mkdir(home, { recursive: true })]);
  await writeFile(path.join(project, 'README.md'), 'Synthetic fixture.\n');
  const children: ChildProcess[] = [], calls: Call[] = [], log: string[] = [];
  const open = async (core: 'rust' | 'typescript' = 'rust') => {
    const runtime = await createAgentHost({
      kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 60_000,
      env: { EXTALIA_NATIVE_CORE: core, EXTALIA_DAEMON_PATH: DAEMON_BINARY, EXTALIA_SECRET_STORE: 'memory', HOME: home, PATH: '', PLAN_KEY_A: 'opaque-plan-key-a', PLAN_KEY_B: 'opaque-plan-key-b', PLAN_KEY_C: 'opaque-plan-key-c' },
      fetch: async (url, init) => { const call = { url: String(url), signal: init?.signal, text: typeof init?.body === 'string' ? init.body : '' }; calls.push(call); return handler(call); },
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
  const independent = (await first.host.saveWorkspace({ name: 'Independent', projectLocation: project, connectionId: c.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces.find(item => item.name === 'Independent')!;
  const session = await first.host.createSession(workspace.id), other = await first.host.createSession(workspace.id), independentSession = await first.host.createSession(independent.id);
  return { root, data, home, ...first, open, children, calls, log, workspace, session, other, independent, independentSession, a, b, c };
}
type Env = Awaited<ReturnType<typeof fixture>>;
const markers = async (env: Env) => JSON.parse(await readFile(path.join(env.data, 'state', 'native-planning.json'), 'utf8')) as { pending: DaemonPlanningBegin[] };
const admissions = (env: Env) => queryCore<{ payload: string }>(env.data, 'SELECT payload FROM planning_admissions ORDER BY invocation_id').map(row => JSON.parse(row.payload) as DaemonPlanningAdmission);
const observations = (env: Env) => queryCore(env.data, 'SELECT invocation_id,kind FROM planning_observations ORDER BY invocation_id');
const idle = async (runtime: AgentHostRuntime) => vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { interval: 5, timeout: 3000 });
const mission = (env: Env) => ({ title: 'Review', tasks: [{ id: 'review', title: 'Review', instructions: 'Inspect read-only.', connectionId: env.a.id, model: 'model-a', dependsOn: [] }] });
const wait = async (check: () => void) => vi.waitFor(check, { interval: 5, timeout: 3000 });

describe.skipIf(!HAS_DAEMON)('saved native planning on the real Rust daemon', () => {
  it('durably owns selected plus lead connections before credential, catalog or inference, then records only weak settlement', async () => {
    const boundaries: string[] = [];
    const verify = async (stage: string) => {
      const rows = admissions(env); expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'native-planning', sessionId: env.session.id, workspaceId: env.workspace.id, connectionIds: [env.a.id, env.b.id].sort() });
      expect((await markers(env)).pending).toEqual([expect.objectContaining({ invocationId: rows[0]!.invocationId, connectionIds: [env.a.id, env.b.id].sort() })]);
      expect(observations(env)).toEqual([]); boundaries.push(stage);
    };
    const env: Env = await fixture(async call => { await verify(call.url.endsWith('/models') ? 'catalog' : 'inference'); return call.url.endsWith('/models') ? catalog() : reply(); });
    const original = credentials.resolveCredential;
    vi.spyOn(credentials, 'resolveCredential').mockImplementation(async (source, store, variables) => { await verify('credential'); return original(source, store, variables); });
    const before = await env.host.sessionEvents(env.session.id);
    const plan = await env.host.planNativeMission(env.session.id, { goal: 'Review.', connectionIds: [env.b.id], models: ['model-b'] });
    expect(plan.source).toBe('model'); expect(boundaries[0]).toBe('credential'); expect(boundaries).toContain('catalog'); expect(boundaries).toContain('inference');
    expect(env.calls.map(call => new URL(call.url).hostname)).toEqual(['b.example.com', 'a.example.com']);
    expect(observations(env)).toEqual([{ invocation_id: admissions(env)[0]!.invocationId, kind: 'local-pipeline-settled' }]);
    expect((await markers(env)).pending).toEqual([]); await idle(env.runtime);
    expect(queryCore(env.data, 'SELECT mission_id FROM missions')).toEqual([]); expect(queryCore(env.data, 'SELECT lease_id FROM execution_admissions')).toEqual([]);
    expect(await env.host.listNativeMissions(env.session.id)).toEqual([]); expect(await env.host.sessionEvents(env.session.id)).toEqual(before);
  });

  it('makes no credential or provider call when planning admission storage fails', async () => {
    const env = await fixture(); await env.host.planNativeMission(env.session.id, { goal: 'Warm the daemon.' }); env.calls.length = 0;
    const secret = vi.spyOn(credentials, 'resolveCredential');
    const db = new DatabaseSync(coreFile(env.data)); try { db.exec("CREATE TRIGGER fail_planning_begin BEFORE INSERT ON planning_admissions BEGIN SELECT RAISE(ABORT,'synthetic admission failure'); END;"); } finally { db.close(); }
    await expect(env.host.planNativeMission(env.session.id, { goal: 'Must not enter provider.' })).rejects.toThrow(/core.*refused|storage_failure/);
    expect(secret).not.toHaveBeenCalled(); expect(env.calls).toEqual([]); expect(admissions(env)).toHaveLength(1); expect(observations(env)).toHaveLength(1); expect((await markers(env)).pending).toHaveLength(1);
  });

  it('refuses missing optional capabilities before saving a marker or calling credentials/providers', async () => {
    const getter = Object.getOwnPropertyDescriptor(DaemonClient.prototype, 'capabilities')!.get!;
    vi.spyOn(DaemonClient.prototype, 'capabilities', 'get').mockImplementation(function (this: DaemonClient) { return (getter.call(this) as readonly DaemonOp[]).filter(op => !op.startsWith('planning.')); });
    const env = await fixture(); const secret = vi.spyOn(credentials, 'resolveCredential'), requests = vi.spyOn(DaemonClient.prototype, 'request');
    await expect(env.host.planNativeMission(env.session.id, { goal: 'Must fail closed.' })).rejects.toThrow(/missing_capability/);
    expect(secret).not.toHaveBeenCalled(); expect(env.calls).toEqual([]); expect(admissions(env)).toEqual([]);
    expect(requests.mock.calls.some(([op]) => op === 'planning.begin')).toBe(false);
    await expect(markers(env)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['inference', 'catalog'] as const)('retains marker and busy scope while abort-ignoring %s remains live', async stage => {
    const gate = held<Response>(stage === 'catalog' ? catalog() : reply()); let entered = false;
    const env = await fixture(call => { const selected = stage === 'catalog' ? call.url.endsWith('/models') : !call.url.endsWith('/models'); if (selected) { entered = true; return gate.promise; } return catalog(); });
    const pending = observed(env.host.planNativeMission(env.session.id, { goal: 'Review.', ...(stage === 'catalog' ? { models: ['model-a'] } : {}) }));
    await wait(() => expect(entered).toBe(true)); await env.host.cancel(env.session.id);
    expect(env.calls[0]!.signal?.aborted).toBe(true);
    expect(env.runtime.isBusy()).toBe(true); expect((await markers(env)).pending).toHaveLength(1); expect(observations(env)).toEqual([]);
    await expect(env.host.planNativeMission(env.session.id, { goal: 'Overlap.' })).rejects.toThrow(/still working|unresolved/);
    await expect(env.host.sendPrompt(env.other.id, 'Overlap.')).rejects.toThrow(/active|working|unresolved/);
    gate.resolve(stage === 'catalog' ? catalog() : reply()); await pending; await idle(env.runtime);
    expect(observations(env)).toHaveLength(1); expect((await markers(env)).pending).toEqual([]);
    if (stage === 'catalog') expect(env.calls.every(call => call.url.endsWith('/models'))).toBe(true);
  });

  it('withholds settlement while an aborted inference response body still owns local work', async () => {
    const body = held<unknown>(await reply().json()); let entered = false;
    const response = reply(); vi.spyOn(response, 'json').mockImplementation(async () => { entered = true; return body.promise; });
    const env = await fixture(() => response);
    const pending = observed(env.host.planNativeMission(env.session.id, { goal: 'Review.' }));
    await wait(() => expect(entered).toBe(true)); await env.host.cancel(env.session.id); await pending;
    expect(env.runtime.isBusy()).toBe(true); expect(observations(env)).toEqual([]); expect((await markers(env)).pending).toHaveLength(1);
    body.resolve(await reply().json()); await idle(env.runtime);
    expect(observations(env)).toHaveLength(1); expect((await markers(env)).pending).toEqual([]);
    expect(queryCore(env.data, 'SELECT mission_id FROM missions')).toEqual([]);
  });

  it.each(['credential', 'catalog'] as const)('never enters the next provider step after daemon loss during delayed %s', async stage => {
    const secretGate = held<string | undefined>('opaque-plan-key-a'), catalogGate = held<Response>(catalog()); let entered = false;
    const env = await fixture(call => { if (stage === 'catalog' && call.url.endsWith('/models')) { entered = true; return catalogGate.promise; } return reply(); });
    const original = credentials.resolveCredential;
    const secret = vi.spyOn(credentials, 'resolveCredential').mockImplementation((source, store, variables) => { if (stage === 'credential') { entered = true; return secretGate.promise; } return original(source, store, variables); });
    const pending = observed(env.host.planNativeMission(env.session.id, { goal: 'Review.', ...(stage === 'catalog' ? { models: ['model-a'] } : {}) }));
    await wait(() => expect(entered).toBe(true)); expect(env.children).toHaveLength(1); env.children[0]!.kill('SIGKILL');
    await wait(() => expect(env.children[0]!.signalCode).toBe('SIGKILL'));
    await wait(() => expect(env.log.some(line => line.includes('unavailable'))).toBe(true));
    expect(observations(env)).toEqual([]); expect((await markers(env)).pending).toHaveLength(1);
    secretGate.resolve('opaque-plan-key-a'); catalogGate.resolve(catalog()); await pending; await idle(env.runtime);
    expect(env.calls).toHaveLength(stage === 'catalog' ? 1 : 0); expect(secret).toHaveBeenCalledTimes(1); expect(env.children).toHaveLength(1);
    expect(observations(env)).toEqual([]); expect((await markers(env)).pending).toHaveLength(1);
  });

  it('keeps closed pending scopes blocked after a TypeScript reopen without replay, and only inspected existing evidence clears the marker', async () => {
    const gate = held<Response>(reply()); let entered = false, delaying = true;
    const env = await fixture(call => { if (delaying) { entered = true; return gate.promise; } return call.url.endsWith('/models') ? catalog() : reply(); });
    const pending = observed(env.host.planNativeMission(env.session.id, { goal: 'Review.' })); await wait(() => expect(entered).toBe(true));
    const invocation = admissions(env)[0]!;
    await env.close(); await pending; expect((await markers(env)).pending).toHaveLength(1); expect(observations(env)).toEqual([]);
    delaying = false; gate.resolve(reply()); await idle(env.runtime); env.calls.length = 0;
    const requests = vi.spyOn(DaemonClient.prototype, 'request'); const reopened = await env.open('typescript');
    const secretReads = vi.spyOn(credentials, 'resolveCredential'), secretWrites = vi.spyOn(credentials.MemorySecretStore.prototype, 'set');
    expect(env.calls).toEqual([]); expect((await markers(env)).pending).toHaveLength(1); expect(observations(env)).toEqual([]);
    await expect(reopened.host.planNativeMission(env.session.id, { goal: 'Blocked.' })).rejects.toThrow(/unresolved/);
    await expect(reopened.host.sendPrompt(env.session.id, 'Blocked.')).rejects.toThrow(/unresolved/);
    await expect(reopened.host.startNativeMission(env.session.id, mission(env))).rejects.toThrow(/unresolved/);
    await expect(reopened.host.deleteSession(env.session.id)).rejects.toThrow(/unresolved/);
    await expect(reopened.host.deleteWorkspace(env.workspace.id)).rejects.toThrow(/unresolved/);
    await expect(reopened.host.setWorkspaceMissionConnections(env.workspace.id, [])).rejects.toThrow(/unresolved/);
    await expect(reopened.host.saveWorkspace({ id: env.workspace.id, name: env.workspace.name, projectLocation: env.workspace.projectLocation!, connectionId: env.c.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).rejects.toThrow(/unresolved/);
    await expect(reopened.host.deleteConnection(env.a.id)).rejects.toThrow(/unresolved/);
    await expect(reopened.host.saveConnection({ ...env.a, credential: { kind: 'stored' } }, 'opaque-plan-key-updated')).rejects.toThrow(/unresolved/);
    expect(await reopened.host.testConnection(env.a)).toMatchObject({ ok: false, error: expect.stringMatching(/unresolved/) });
    await expect(reopened.host.planTeam(env.workspace.id, { goal: 'Must not use the guarded provider.', count: 1, allowedModels: ['model-a'] })).rejects.toThrow(/unresolved/);
    expect(secretReads).not.toHaveBeenCalled(); expect(secretWrites).not.toHaveBeenCalled();
    expect(env.calls).toEqual([]); expect(requests.mock.calls.filter(([op]) => op.startsWith('planning.')).map(([op]) => op)).toEqual(['planning.inspect']);
    expect((await reopened.host.planNativeMission(env.independentSession.id, { goal: 'Unrelated scope remains usable.' })).source).toBe('model');
    await reopened.close();
    // The old raw pipeline has genuinely settled. Record its receipt through the real
    // daemon, then verify startup only inspects it instead of inventing a new observation.
    const child = spawn(DAEMON_BINARY, ['--data-dir', env.data, '--profile', 'default'], { env: { HOME: env.home, PATH: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new DaemonClient(child, { clientVersion: 'test', log: () => undefined }); closes.push(() => client.close());
    await client.handshake(); await client.request('planning.observe', { invocationId: invocation.invocationId, admissionDigest: invocation.admissionDigest, kind: 'local-pipeline-settled' }); await client.close();
    requests.mockClear(); const cleared = await env.open('typescript');
    expect((await markers(env)).pending).toEqual([]); expect(observations(env)).toHaveLength(1);
    expect(requests.mock.calls.filter(([op]) => op.startsWith('planning.')).map(([op]) => op)).toEqual(['planning.inspect']);
    expect((await cleared.host.planNativeMission(env.session.id, { goal: 'Now usable.' })).source).toBe('model');
    expect(requests.mock.calls.some(([op]) => op === 'planning.observe')).toBe(false);
  }, 30_000);

  it('holds the profile lock past the run shutdown deadline until an old marker write drains', async () => {
    const gate = held<void>(undefined), provider = held<Response>(reply());
    let entered = false, providerEntered = false;
    const env = await fixture(() => { providerEntered = true; return provider.promise; });
    const markerFile = path.join(env.data, 'state', 'native-planning.json');
    const writeJson = jsonStore.writeJsonAtomic;
    const writes = vi.spyOn(jsonStore, 'writeJsonAtomic').mockImplementation(async (file, value, options) => {
      if (file === markerFile && !entered) { entered = true; await gate.promise; }
      await writeJson(file, value, options);
    });
    const requests = vi.spyOn(DaemonClient.prototype, 'request'), secret = vi.spyOn(credentials, 'resolveCredential');
    const pending = observed(env.host.planNativeMission(env.session.id, { goal: 'Hold the write-ahead marker.' }));
    await wait(() => expect(entered).toBe(true));
    expect(admissions(env)).toEqual([]); expect(env.calls).toEqual([]);
    // Advance only the host's 5 s run-drain deadline; daemon handshake is already done.
    const realTimeout = globalThis.setTimeout;
    let runDeadlineExpired = false;
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => delay === 5_000
      ? realTimeout(() => { runDeadlineExpired = true; callback(...args); }, 25)
      : realTimeout(callback, delay, ...args));
    let closed = false;
    const closing = env.close().then(() => { closed = true; });
    try {
      await wait(() => expect(runDeadlineExpired).toBe(true));
      expect(closed).toBe(false);
      await expect(env.open('typescript')).rejects.toThrow(/already running/);
      await expect(readFile(markerFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { timer.mockRestore(); }
    gate.resolve(undefined);
    await closing; await pending;
    expect(secret).not.toHaveBeenCalled(); expect(env.calls).toEqual([]);
    expect(requests.mock.calls.some(([op]) => op === 'planning.begin' || op === 'planning.observe')).toBe(false);
    const retained = (await markers(env)).pending;
    expect(retained).toHaveLength(1); expect(admissions(env)).toEqual([]); expect(observations(env)).toEqual([]);
    // A new lock owner can now update its own registry without an old delayed rename
    // clearing or overwriting its pending entry.
    const reopened = await env.open('rust');
    const fresh = observed(reopened.host.planNativeMission(env.independentSession.id, { goal: 'Independent new owner.' }));
    await wait(() => expect(providerEntered).toBe(true));
    expect((await markers(env)).pending).toEqual(expect.arrayContaining(retained));
    expect((await markers(env)).pending).toHaveLength(2);
    provider.resolve(reply()); await fresh; await idle(reopened.runtime);
    expect((await markers(env)).pending).toEqual(retained);
    expect(writes.mock.calls.filter(([file]) => file === markerFile)).toHaveLength(3);
    expect(admissions(env)).toHaveLength(1); expect(observations(env)).toHaveLength(1);
  }, 15_000);
});
