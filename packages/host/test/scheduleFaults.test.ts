import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs(), runtimes = new Set<AgentHostRuntime>();
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...runtimes].map(runtime => runtime.close()));
  runtimes.clear();
});
const completion = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Project checked.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });

async function fixture() {
  const root = await temp('extalia-schedule-faults-'), home = `${root}/home`, project = `${root}/project`;
  await mkdir(home); await mkdir(project);
  let networkFailure = false, endpointUnavailable = false;
  const probes: string[] = [];
  const requests: string[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'HEAD') {
      probes.push(String(url));
      if (endpointUnavailable) throw new TypeError('fetch failed', { cause: Object.assign(new Error('No route'), { code: 'ENETUNREACH' }) });
      return new Response(null, { status: 204 });
    }
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'fixture-model' }] });
    requests.push(String(url));
    if (networkFailure) throw new TypeError('fetch failed');
    return completion();
  };
  const options = { kind: 'bridge' as const, version: 'test', dataDirectory: `${root}/data`, homeDirectory: home, importHome: home,
    env: { EXTALIA_SECRET_STORE: 'memory', PATH: '' }, observationIntervalMs: 60_000, fetch };
  let runtime = await createAgentHost(options); runtimes.add(runtime);
  const connection = (await runtime.host.saveConnection({ name: 'Local test model', preset: 'custom', api: 'openai-chat',
    baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } })).connections[0]!;
  const workspace = (await runtime.host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: connection.id,
    permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
  const session = await runtime.host.createSession(workspace.id);
  return {
    root, requests, probes, session, workspace, connection, setEndpointUnavailable: (value: boolean) => { endpointUnavailable = value; }, setNetworkFailure: () => { networkFailure = true; },
    get runtime() { return runtime; }, get host() { return runtime.host; },
    async save(missedPolicy: 'skip' | 'run-once' = 'run-once') {
      return (await runtime.host.saveSchedule!({ workspaceId: workspace.id, name: 'Project review', prompt: 'Review the project.',
        trigger: { kind: 'interval', intervalMinutes: 60 }, sessionTarget: { mode: 'existing', sessionId: session.id }, missedPolicy })).schedules[0]!;
    },
    async restart(edit?: (store: { schedules: Array<Record<string, unknown>>; recoveries?: Array<Record<string, unknown>> }) => void) {
      await runtime.close(); runtimes.delete(runtime);
      if (edit) {
        const file = `${root}/data/config/schedules.json`, stored = JSON.parse(await readFile(file, 'utf8'));
        edit(stored); await writeFile(file, JSON.stringify(stored));
      }
      runtime = await createAgentHost(options); runtimes.add(runtime);
    },
  };
}
const idle = async (runtime: AgentHostRuntime) => vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 5_000, interval: 10 });
const overdue = () => new Date(Math.floor(Date.now() / 60_000) * 60_000 - 3 * 86_400_000).toISOString();

describe('scheduled host recovery and uncertain provider failures', () => {
  it('coalesces several offline days into one accepted prompt and does not catch it up again after restart', async () => {
    const f = await fixture(); await f.save();
    const due = overdue();
    await f.restart(store => { store.schedules[0]!.nextRunAt = due; });
    await vi.waitFor(async () => expect((await f.host.listSchedules!()).schedules[0]!.runCount).toBe(1), { timeout: 5_000, interval: 10 });
    await idle(f.runtime);
    const job = (await f.host.listSchedules!()).schedules[0]!;
    expect(f.requests).toHaveLength(1);
    expect(job.lastSessionId).toBe(f.session.id);
    expect(Date.parse(job.nextRunAt!)).toBeGreaterThan(Date.now());
    expect((Date.parse(job.nextRunAt!) - Date.parse(due)) % 3_600_000).toBe(0);
    await f.restart(); await idle(f.runtime);
    expect(f.requests).toHaveLength(1);
    expect((await f.host.listSchedules!()).schedules[0]!.runCount).toBe(1);
  });

  it('queues an unreachable endpoint before creating a destination, then catches up once when it returns', async () => {
    const f = await fixture();
    await f.host.saveSchedule!({ workspaceId: f.workspace.id, name: 'Fresh review', prompt: 'Review once available.',
      trigger: { kind: 'interval', intervalMinutes: 60 }, sessionTarget: { mode: 'new-each-run' } });
    f.setEndpointUnavailable(true);
    await f.restart(store => { store.schedules[0]!.nextRunAt = overdue(); });
    await vi.waitFor(async () => expect((await f.host.listSchedules!()).schedules[0]!.recovery?.reason).toBe('connection-unavailable'), { timeout: 5_000, interval: 10 });
    expect(f.requests).toHaveLength(0);
    expect(f.probes).toHaveLength(1);
    expect((await f.host.getState()).sessions.filter(session => session.workspaceId === f.workspace.id)).toHaveLength(1);
    f.setEndpointUnavailable(false);
    await f.restart(store => {
      const retryAt = new Date(Date.now() - 1_000).toISOString();
      store.schedules[0]!.nextRunAt = retryAt;
      store.recoveries![0]!.retryAt = retryAt;
    });
    await vi.waitFor(async () => expect((await f.host.listSchedules!()).schedules[0]!.runCount).toBe(1), { timeout: 5_000, interval: 10 });
    await idle(f.runtime);
    const job = (await f.host.listSchedules!()).schedules[0]!;
    expect(job.recovery).toBeUndefined();
    expect(job.lastSessionId).not.toBe(f.session.id);
    expect(f.requests).toHaveLength(1);
    expect(f.probes).toHaveLength(2);
    expect((await f.host.getState()).sessions.filter(session => session.workspaceId === f.workspace.id)).toHaveLength(2);
  });

  it('honors explicit skip after offline time without submitting an overdue prompt', async () => {
    const f = await fixture(); await f.save('skip');
    await f.restart(store => { store.schedules[0]!.nextRunAt = overdue(); });
    await idle(f.runtime);
    const job = (await f.host.listSchedules!()).schedules[0]!;
    expect(job).toMatchObject({ runCount: 0, lastOutcome: 'missed', state: 'scheduled' });
    expect(Date.parse(job.nextRunAt!)).toBeGreaterThan(Date.now());
    expect(f.requests).toHaveLength(0);
  });

  it('does not replay a run whose dispatch may have happened before an interrupted host', async () => {
    const f = await fixture(); await f.save();
    await f.restart(store => { Object.assign(store.schedules[0]!, { state: 'running', nextRunAt: overdue(), lastSessionId: f.session.id }); });
    await idle(f.runtime);
    const job = (await f.host.listSchedules!()).schedules[0]!;
    expect(job).toMatchObject({ runCount: 0, lastOutcome: 'failed', lastSessionId: f.session.id });
    expect(job.lastError).toContain('host restarted');
    expect(Date.parse(job.nextRunAt!)).toBeGreaterThan(Date.now());
    expect(f.requests).toHaveLength(0);
  });

  it('retains a linked failed turn after provider connectivity loss without replaying an accepted prompt', async () => {
    const f = await fixture(), job = await f.save(); f.setNetworkFailure();
    await f.host.runScheduleNow!(job.id, job.revision); await idle(f.runtime);
    const result = (await f.host.listSchedules!()).schedules[0]!;
    expect(result.lastSessionId).toBe(f.session.id);
    // succeeded means prompt accepted, not successful model work.
    expect(result.lastOutcome).toBe('succeeded');
    expect((await f.host.sessionEvents(f.session.id)).some(event => event.body.type === 'turn.failed')).toBe(true);
    expect(Date.parse(result.nextRunAt!)).toBeGreaterThan(Date.now());
    expect(f.requests).toHaveLength(1);
    await f.restart(); await idle(f.runtime);
    expect(f.requests).toHaveLength(1);
  });

  it('refuses a removed derived conversation instead of silently copying its source into a replacement', async () => {
    const f = await fixture();
    await f.host.sendPrompt(f.session.id, 'Keep this source conversation.'); await idle(f.runtime);
    const job = (await f.host.saveSchedule!({ workspaceId: f.workspace.id, name: 'Derived review', prompt: 'Review source context.',
      trigger: { kind: 'interval', intervalMinutes: 60 }, sessionTarget: { mode: 'derive-from-session', sourceSessionId: f.session.id } })).schedules[0]!;
    const started = (await f.host.runScheduleNow!(job.id, job.revision)).schedules[0]!; await idle(f.runtime);
    expect(started.boundSessionId).toBeDefined(); expect(started.boundSessionId).not.toBe(f.session.id);
    await f.host.deleteSession(started.boundSessionId!);
    const before = f.requests.length;
    await expect(f.host.runScheduleNow!(job.id, started.revision)).rejects.toThrow('derived scheduled conversation is unavailable');
    expect(f.requests).toHaveLength(before);
    expect((await f.host.listSchedules!()).schedules[0]!.boundSessionId).toBe(started.boundSessionId);
  });

  it('refuses a reusable derived destination with history disabled', async () => {
    const f = await fixture();
    const job = (await f.host.saveSchedule!({ workspaceId: f.workspace.id, name: 'Derived review', prompt: 'Review source context.',
      trigger: { kind: 'interval', intervalMinutes: 60 }, sessionTarget: { mode: 'derive-from-session', sourceSessionId: f.session.id } })).schedules[0]!;
    await f.host.saveConnection({ id: f.connection.id, name: 'Local test model', preset: 'custom', api: 'openai-chat',
      baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off', history: false } });
    await expect(f.host.runScheduleNow!(job.id, job.revision)).rejects.toThrow('require retained history');
    expect(f.requests).toHaveLength(0);
  });

  it('allows the configured local model without a global internet connectivity probe', async () => {
    const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Internet unavailable'));
    const f = await fixture(), job = await f.save();
    await f.host.runScheduleNow!(job.id, job.revision); await idle(f.runtime);
    expect(f.requests).toEqual(['http://127.0.0.1:9/v1/chat/completions']);
    expect((await f.host.sessionEvents(f.session.id)).some(event => event.body.type === 'turn.completed')).toBe(true);
    expect(external).not.toHaveBeenCalled();
  });
});
