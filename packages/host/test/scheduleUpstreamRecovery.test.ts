import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '@extalia/runtime';
import type { GeneralSchedule, ScheduleSessionTarget } from '@extalia/platform';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { SessionStore } from '../src/sessions.js';
import { useTempDirs } from './helpers.js';

type Mode = 'unavailable' | 'transport' | 'success' | 'partial' | 'tool-then-unavailable' | 'unauthorized' | 'held';
type RequestBody = { messages: Array<{ role: string; content?: string | null }> };
type Recovery = { scheduleId: string; dueAt: string; retryAt: string; attempt: number; retryContext?: { sessionId: string; historySha256: string } };
type StoredJobs = { schedules: GeneralSchedule[]; recoveries?: Recovery[] };
const task = 'Review the project and report its next useful step.';
function userTexts(messages: readonly unknown[]): string[] {
  return messages.flatMap(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return [];
    const value = message as Record<string, unknown>;
    return value.role === 'user' && typeof value.text === 'string' ? [value.text] : [];
  });
}

const temp = useTempDirs(), runtimes = new Set<AgentHostRuntime>(), releases = new Set<() => void>();
afterEach(async () => {
  for (const release of releases) release(); releases.clear();
  vi.restoreAllMocks();
  await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear();
});
const unavailable = () => Response.json({ error: { message: 'Fixture upstream unavailable.' } }, { status: 503 });
const sse = (delta: Record<string, unknown>, reason = 'stop') => new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
const success = () => sse({ content: 'Project review completed.' });
const overdue = () => new Date(Math.floor(Date.now() / 60_000) * 60_000 - 2 * 60_000).toISOString();
const wait = (assertion: () => unknown | Promise<unknown>) => vi.waitFor(assertion, { timeout: 5_000, interval: 10 });

async function fixture(initialMode: Mode = 'unavailable') {
  const root = await temp('extalia-upstream-recovery-'), home = `${root}/home`, project = `${root}/project`;
  await mkdir(home); await mkdir(project);
  let mode = initialMode, modeCalls = 0, afterPost: (() => void) | undefined, releaseHeld: (() => void) | undefined;
  const requests: RequestBody[] = [], probes: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    if (init?.method === 'HEAD') { probes.push(url); return new Response(null, { status: 204 }); }
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'fixture-model' }] });
    requests.push(JSON.parse(String(init?.body)) as RequestBody); modeCalls++; afterPost?.();
    if (mode === 'success') return success();
    if (mode === 'transport') throw new TypeError('fetch failed', { cause: Object.assign(new Error('Fixture network down'), { code: 'ENETUNREACH' }) });
    if (mode === 'unauthorized') return Response.json({ error: { message: 'Fixture credential rejected.' } }, { status: 401 });
    if (mode === 'tool-then-unavailable' && modeCalls === 1) return sse({ tool_calls: [{ index: 0, id: 'read-workspace', type: 'function', function: { name: 'workspace_folders', arguments: '{}' } }] }, 'tool_calls');
    if (mode === 'partial') {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Started responding.' }, finish_reason: null }] })}\n\n`));
        setTimeout(() => controller.error(new ProviderError('Fixture stream disconnected', 503, true)), 10);
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (mode === 'held') return new Promise<Response>(resolve => {
      releaseHeld = () => { releases.delete(releaseHeld!); resolve(unavailable()); };
      releases.add(releaseHeld);
    });
    return unavailable();
  };
  const options = { kind: 'bridge' as const, version: 'test', dataDirectory: `${root}/data`, homeDirectory: home, importHome: home,
    env: { EXTALIA_SECRET_STORE: 'memory', PATH: '' }, observationIntervalMs: 60_000, fetch };
  let runtime = await createAgentHost(options); runtimes.add(runtime);
  const connection = (await runtime.host.saveConnection({ name: 'Fixture router', preset: 'custom', api: 'openai-chat',
    baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } })).connections[0]!;
  const workspace = (await runtime.host.saveWorkspace({ name: 'Fixture project', projectLocation: project, connectionId: connection.id,
    permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
  const source = await runtime.host.createSession(workspace.id), store = new SessionStore(`${root}/data/sessions`), jobsFile = `${root}/data/config/schedules.json`;
  return {
    root, source, workspace, store, requests, probes, jobsFile,
    get runtime() { return runtime; }, get host() { return runtime.host; },
    setMode(next: Mode) { mode = next; modeCalls = 0; }, onPost(callback: () => void) { afterPost = callback; },
    release() { if (!releaseHeld) throw new Error('No held provider request.'); releaseHeld(); },
    async idle() { await wait(() => expect(runtime.isBusy()).toBe(false)); },
    async job() { return (await runtime.host.listSchedules!()).schedules[0]!; },
    async stored(): Promise<StoredJobs> { return JSON.parse(await readFile(jobsFile, 'utf8')) as StoredJobs; },
    async save(sessionTarget: ScheduleSessionTarget = { mode: 'new-each-run' }) {
      return (await runtime.host.saveSchedule!({ workspaceId: workspace.id, name: 'Upstream review', prompt: task,
        trigger: { kind: 'interval', intervalMinutes: 60 }, sessionTarget, missedPolicy: 'run-once' })).schedules[0]!;
    },
    async restart(edit?: (stored: StoredJobs) => void) {
      await runtime.close(); runtimes.delete(runtime);
      if (edit) { const stored = JSON.parse(await readFile(jobsFile, 'utf8')) as StoredJobs; edit(stored); await writeFile(jobsFile, JSON.stringify(stored)); }
      runtime = await createAgentHost(options); runtimes.add(runtime);
    },
    async dueAgain() {
      await this.restart(stored => {
        const date = overdue(); stored.schedules[0]!.nextRunAt = date;
        if (stored.recoveries?.[0]) stored.recoveries[0].retryAt = date;
      });
    },
    async close() { await runtime.close(); runtimes.delete(runtime); },
  };
}

async function expectPending(f: Awaited<ReturnType<typeof fixture>>) {
  await wait(async () => expect((await f.job()).recovery?.reason).toBe('connection-unavailable')); await f.idle();
  const job = await f.job(), stored = await f.stored(), receipt = stored.recoveries![0]!.retryContext;
  expect(job).toMatchObject({ runCount: 0, lastOutcome: 'deferred-connection' });
  expect(receipt).toEqual({ sessionId: job.lastSessionId, historySha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(userTexts(await f.store.readMessages(receipt!.sessionId)).filter(text => text === task)).toHaveLength(1);
  return receipt!;
}

describe('scheduled Native upstream failure recovery', () => {
  it('retains one new-session destination and one pending prompt across repeated 503s/restarts, then starts a fresh session for the next occurrence', async () => {
    const f = await fixture(); await f.save(); await f.dueAgain();
    const first = await expectPending(f);
    expect(f.probes).toHaveLength(1); expect(f.requests).toHaveLength(1);
    expect((await f.host.getState()).sessions.filter(session => session.workspaceId === f.workspace.id)).toHaveLength(2);
    await f.dueAgain();
    const second = await expectPending(f);
    expect(second).toEqual(first);
    expect((await f.host.getState()).sessions.filter(session => session.workspaceId === f.workspace.id)).toHaveLength(2);
    f.setMode('success'); await f.dueAgain();
    await wait(async () => expect((await f.job()).runCount).toBe(1)); await f.idle();
    expect((await f.job()).lastSessionId).toBe(first.sessionId); expect((await f.job()).recovery).toBeUndefined();
    expect((await f.stored()).recoveries ?? []).toEqual([]);
    expect(f.requests).toHaveLength(3);
    for (const request of f.requests) expect(request.messages.filter(message => message.role === 'user' && message.content === task)).toHaveLength(1);
    await f.dueAgain(); await wait(async () => expect((await f.job()).runCount).toBe(2)); await f.idle();
    expect((await f.job()).lastSessionId).not.toBe(first.sessionId);
    expect((await f.host.getState()).sessions.filter(session => session.workspaceId === f.workspace.id)).toHaveLength(3);
  });

  it('defers a verified transport failure even when the local router HEAD request succeeds', async () => {
    const f = await fixture('transport'); await f.save({ mode: 'existing', sessionId: f.source.id }); await f.dueAgain();
    const receipt = await expectPending(f);
    expect(receipt.sessionId).toBe(f.source.id); expect(f.probes).toHaveLength(1); expect(f.requests).toHaveLength(1);
  });

  it.each(['partial', 'tool-then-unavailable', 'unauthorized'] as const)('does not automatically repeat %s work or an unclassified authentication failure', async mode => {
    const f = await fixture(mode); await f.save(); await f.dueAgain();
    await wait(async () => expect((await f.job()).runCount).toBe(1)); await f.idle();
    const job = await f.job(); expect(job.recovery).toBeUndefined(); expect((await f.stored()).recoveries ?? []).toEqual([]);
    const events = await f.host.sessionEvents(job.lastSessionId!);
    expect(events.some(event => event.body.type === 'turn.failed')).toBe(true);
    if (mode === 'partial') expect(events.some(event => event.body.type === 'model.delta')).toBe(true);
    if (mode === 'tool-then-unavailable') expect(events.some(event => event.body.type === 'tool.completed' && event.body.tool === 'workspace_folders')).toBe(true);
    expect(f.requests).toHaveLength(mode === 'tool-then-unavailable' ? 2 : 1);
    await f.restart(); await f.idle(); expect(f.requests).toHaveLength(mode === 'tool-then-unavailable' ? 2 : 1);
  });

  it('retains intervening real user/assistant messages and refuses a stale pending history hash before another provider request', async () => {
    const f = await fixture(); await f.save(); await f.dueAgain(); const receipt = await expectPending(f);
    f.setMode('success'); await f.host.sendPrompt(receipt.sessionId, 'Change the project plan.'); await f.idle();
    const retained = await f.store.readMessages(receipt.sessionId), requests = f.requests.length;
    expect(userTexts(retained).includes('Change the project plan.')).toBe(true);
    await f.dueAgain(); await wait(async () => expect((await f.job()).lastOutcome).toBe('failed')); await f.idle();
    expect(f.requests).toHaveLength(requests); expect(await f.store.readMessages(receipt.sessionId)).toEqual(retained);
    expect((await f.job()).recovery).toBeUndefined();
  });

  it('refuses a workspace change completed after retry resolution without upgrading the retained boundary', async () => {
    const f = await fixture(); await f.save(); await f.dueAgain(); const receipt = await expectPending(f);
    const retained = await f.store.get(receipt.sessionId), history = await f.store.readMessages(receipt.sessionId);
    expect(retained?.workspaceBoundary).toBeDefined(); expect(userTexts(history)).toEqual([task]);
    const newProject = `${f.root}/changed-project`; await mkdir(newProject);
    let unblock!: () => void, intercepted = false;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const release = () => { releases.delete(release); unblock(); }; releases.add(release);
    const original = SessionStore.prototype.get;
    vi.spyOn(SessionStore.prototype, 'get').mockImplementation(async function (this: SessionStore, id) {
      // This narrow lookup is after resolveSession and before sendPrompt. Hold
      // only that dispatch-preparation boundary, not the resolver's read lock.
      const inDispatch = new Error().stack?.includes('dispatchPrompt') ?? false;
      const record = await original.call(this, id);
      if (id === receipt.sessionId && inDispatch && !intercepted) { intercepted = true; await blocked; }
      return record;
    });
    f.setMode('success'); const requests = f.requests.length;
    try {
      await f.dueAgain(); await wait(() => expect(intercepted).toBe(true));
      await f.host.saveWorkspace({ id: f.workspace.id, name: f.workspace.name, projectLocation: newProject,
        connectionId: f.workspace.providerProfileId!, permissions: { fileWrite: 'ask', commands: 'ask' } });
    } finally { release(); }
    await f.idle();
    expect(f.requests).toHaveLength(requests);
    expect((await f.job()).lastOutcome).toBe('failed');
    expect((await f.job()).lastError).toContain('Workspace folders or access boundaries changed');
    expect((await f.store.get(receipt.sessionId))?.workspaceBoundary).toBe(retained!.workspaceBoundary);
    expect((await f.store.get(receipt.sessionId))?.workspaceFileRoot).toBe(retained!.workspaceFileRoot);
    expect(await f.store.readMessages(receipt.sessionId)).toEqual(history);
    expect((await f.job()).recovery).toBeUndefined();
  });

  it('does not mint retry evidence after steering changes the first in-flight request', async () => {
    const f = await fixture('held'); await f.save({ mode: 'existing', sessionId: f.source.id }); await f.dueAgain();
    await wait(() => expect(f.requests).toHaveLength(1));
    let queue = await f.host.promptQueueStatus!(f.source.id);
    expect(queue.canSteer).toBe(true);
    queue = await f.host.changePromptQueue!(f.source.id, { revision: queue.revision, action: 'add', text: 'Follow the corrected project plan.' });
    await f.host.changePromptQueue!(f.source.id, { revision: queue.revision, action: 'steer', itemId: queue.items[0]!.id });
    f.release(); await wait(async () => expect((await f.job()).runCount).toBe(1)); await f.idle();
    expect((await f.job()).recovery).toBeUndefined();
    expect(userTexts(await f.store.readMessages(f.source.id)).includes('Follow the corrected project plan.')).toBe(true);
  });

  it.each(['write', 'readback'] as const)('does not grant recovery when failed-turn %s persistence cannot be confirmed', async failure => {
    const f = await fixture(); await f.save({ mode: 'existing', sessionId: f.source.id });
    let fail = false;
    f.onPost(() => { fail = true; });
    if (failure === 'write') {
      const original = SessionStore.prototype.writeMessages;
      vi.spyOn(SessionStore.prototype, 'writeMessages').mockImplementation(function (this: SessionStore, id, messages) {
        if (fail && id === f.source.id) { fail = false; return Promise.reject(new Error('Fixture failed write')); }
        return original.call(this, id, messages);
      });
    } else {
      const original = SessionStore.prototype.readMessages;
      vi.spyOn(SessionStore.prototype, 'readMessages').mockImplementation(function (this: SessionStore, id) {
        if (fail && id === f.source.id) { fail = false; return Promise.reject(new Error('Fixture failed readback')); }
        return original.call(this, id);
      });
    }
    await f.dueAgain(); await wait(async () => expect((await f.job()).runCount).toBe(1)); await f.idle();
    expect((await f.job()).recovery).toBeUndefined(); expect((await f.stored()).recoveries ?? []).toEqual([]);
    expect(f.requests).toHaveLength(1);
  });

  it('does not grant retry when the terminal failed-turn event was not durably appended', async () => {
    const f = await fixture(); await f.save({ mode: 'existing', sessionId: f.source.id });
    const original = SessionStore.prototype.appendEvent;
    let rejected = 0;
    vi.spyOn(SessionStore.prototype, 'appendEvent').mockImplementation(function (this: SessionStore, id, event) {
      if (id === f.source.id && event.body.type === 'turn.failed') {
        rejected++; return Promise.reject(new Error('Fixture terminal event append failed'));
      }
      return original.call(this, id, event);
    });
    await f.dueAgain(); await wait(async () => expect((await f.job()).runCount).toBe(1)); await f.idle();
    expect(rejected).toBe(1);
    expect((await f.job()).recovery).toBeUndefined(); expect((await f.stored()).recoveries ?? []).toEqual([]);
    const history = await f.store.readMessages(f.source.id);
    expect(userTexts(history)).toEqual([task]); expect(f.requests).toHaveLength(1);
    await f.restart(); await f.idle();
    expect(await f.store.readMessages(f.source.id)).toEqual(history);
    expect((await f.stored()).recoveries ?? []).toEqual([]); expect(f.requests).toHaveLength(1);
  });

  it('bounds shutdown while an abort-ignoring first provider request remains unresolved and never grants a late retry', async () => {
    const f = await fixture('held'); await f.save(); await f.dueAgain();
    await wait(() => expect(f.requests).toHaveLength(1));
    const started = Date.now(); await f.close();
    expect(Date.now() - started).toBeLessThan(7_000);
    f.release(); await wait(() => expect(f.runtime.isBusy()).toBe(false));
    expect((await f.stored()).recoveries ?? []).toEqual([]);
    expect(f.requests).toHaveLength(1);
  }, 10_000);
});
