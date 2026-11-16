import type { ExtaliaEvent } from '@extalia/protocol';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { GeneralScheduleManager } from '../src/schedules.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from './helpers.js';

type ToolCall = { name: string; args: Record<string, unknown>; id?: string };
type RequestBody = {
  model: string;
  tools?: { function: { name: string; description: string } }[];
  messages: { role: string; content?: string | null; tool_call_id?: string }[];
};

const temp = useTempDirs();
const runtimes = new Set<AgentHostRuntime>();
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...runtimes].map(runtime => runtime.close()));
  runtimes.clear();
});

function completion(reply: { text: string } | { calls: ToolCall[] }): Response {
  const calls = 'calls' in reply ? reply.calls : [];
  const delta = calls.length
    ? { tool_calls: calls.map((call, index) => ({ index, id: call.id ?? `schedule-call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }
    : { content: 'text' in reply ? reply.text : '' };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function fixture(script: (body: RequestBody, index: number) => Response, fixtureOptions: { history?: boolean } = {}) {
  const root = await temp('extalia-schedule-from-prompt-');
  const home = `${root}/home`, project = `${root}/project`;
  const { mkdir } = await import('node:fs/promises');
  await mkdir(home); await mkdir(project);
  const requests: RequestBody[] = [], events: ExtaliaEvent[] = [];
  const options = {
    kind: 'bridge' as const, version: 'test', dataDirectory: `${root}/data`, homeDirectory: home, importHome: home,
    observationIntervalMs: 60_000,
    env: { EXTALIA_SECRET_STORE: 'memory', HOME: home, USERPROFILE: home, PATH: '', EXTALIA_HERMES_BIN: `${root}/no-hermes` },
    fetch: async (url: string | URL | globalThis.Request, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 204 });
      if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'schedule-test-model' }] });
      const body = JSON.parse(String(init?.body)) as RequestBody;
      requests.push(body);
      return script(body, requests.length - 1);
    },
  };
  let runtime = await createAgentHost(options);
  runtimes.add(runtime);
  const host = runtime.host;
  host.subscribe(event => events.push(event));
  const connection = (await host.saveConnection({ name: 'Schedule test', preset: 'custom', api: 'openai-chat',
    baseUrl: 'https://example.com/v1', model: 'schedule-test-model', credential: { kind: 'none' },
    features: { memory: 'off', skills: 'off', ...(fixtureOptions.history === false ? { history: false } : {}) } })).connections[0]!;
  const workspace = (await host.saveWorkspace({ name: 'Schedule project', projectLocation: project, connectionId: connection.id,
    permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
  const session = await host.createSession(workspace.id);
  return {
    root, host, requests, events, workspace, session, connection,
    get runtime() { return runtime; },
    async restart() {
      await runtime.close(); runtimes.delete(runtime);
      runtime = await createAgentHost(options); runtimes.add(runtime);
      return runtime.host;
    },
    async createForeignWorkspace() {
      const foreignProject = `${root}/foreign-project`;
      await mkdir(foreignProject);
      const state = await host.saveWorkspace({ name: 'Foreign schedule project', projectLocation: foreignProject, connectionId: connection.id,
        permissions: { fileWrite: 'ask', commands: 'ask' } });
      return state.workspaces.find(item => item.name === 'Foreign schedule project')!;
    },
  };
}

async function idle(runtime: AgentHostRuntime) {
  await viWaitFor(() => expect(runtime.isBusy()).toBe(false));
}

async function viWaitFor(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 5_000, interval: 10 });
}

const call = (action: 'list' | 'create', args: Record<string, unknown> = {}, id?: string): ToolCall => ({
  name: 'schedule_jobs', args: { action, ...args }, ...(id ? { id } : {}),
});

describe('creating schedule jobs from ordinary Native prompts', () => {
  it('lists host context first, saves the exact current session, acknowledges the receipt and survives restart', async () => {
    const f = await fixture((_body, index) => index === 0
      ? completion({ calls: [call('list')] })
      : index === 1 ? completion({ calls: [call('create', {
        name: 'Friday project review', prompt: 'Review progress and blockers.', triggerKind: 'cron', cron: '0 9 * * 5',
      })] })
        : completion({ text: 'The schedule was saved.' }));

    await f.host.sendPrompt(f.session.id, 'Every Friday at 9 in the morning, review project progress.');
    await idle(f.runtime);

    expect(f.requests[0]!.tools?.map(tool => tool.function.name)).toContain('schedule_jobs');
    const listResult = JSON.parse([...f.requests[1]!.messages].reverse().find(message => message.role === 'tool')!.content!);
    expect(listResult).toMatchObject({ workspaceId: f.workspace.id, currentSessionId: f.session.id, timeZone: expect.any(String), now: expect.any(String), jobs: [] });
    const createdResult = JSON.parse([...f.requests[2]!.messages].reverse().find(message => message.role === 'tool')!.content!);
    expect(createdResult).toMatchObject({ status: 'saved', job: { sessionTarget: { mode: 'existing', sessionId: f.session.id } } });
    expect(createdResult.job.id).toMatch(/^sch_/);
    expect(f.events.some(event => event.body.type === 'tool.completed' && event.body.tool === 'schedule_jobs' && event.body.ok
      && event.body.output?.includes(createdResult.job.id))).toBe(true);

    const saved = (await f.host.listSchedules!()).schedules;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: createdResult.job.id, workspaceId: f.workspace.id, sessionTarget: { mode: 'existing', sessionId: f.session.id } });
    const reopened = await f.restart();
    expect((await reopened.listSchedules!()).schedules).toEqual(saved);
  });

  it('supports an explicitly requested fresh session policy and keeps scheduled prompts from scheduling recursively', async () => {
    const f = await fixture((_body, index) => index === 0
      ? completion({ calls: [call('list')] })
      : index === 1 ? completion({ calls: [call('create', {
        name: 'Daily fresh review', prompt: 'Review the project.', triggerKind: 'interval', intervalMinutes: 10080,
        sessionMode: 'new-each-run',
      })] }) : completion({ text: 'Saved.' }));
    await f.host.sendPrompt(f.session.id, 'Schedule a project review every week in a new conversation each time.');
    await idle(f.runtime);
    const job = (await f.host.listSchedules!()).schedules[0]!;
    expect(job.sessionTarget.mode).toBe('new-each-run');

    await f.host.runScheduleNow!(job.id, job.revision);
    await idle(f.runtime);
    expect(f.requests.at(-1)!.tools?.map(tool => tool.function.name)).not.toContain('schedule_jobs');
  });

  it('reuses a persisted acknowledgement for duplicate tool-call identities without adding a second job', async () => {
    const create = call('create', {
      name: 'Duplicate-safe review', prompt: 'Review the project.', triggerKind: 'interval', intervalMinutes: 10080,
    }, 'same-model-tool-call-id');
    const f = await fixture((_body, index) => index === 0
      ? completion({ calls: [call('list')] })
      : index === 1 ? completion({ calls: [create, create] }) : completion({ text: 'Saved once.' }));
    await f.host.sendPrompt(f.session.id, 'Review this project weekly.');
    await idle(f.runtime);

    expect((await f.host.listSchedules!()).schedules).toHaveLength(1);
    const results = f.requests[2]!.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content!))
      .filter(result => result.status === 'saved');
    expect(results).toHaveLength(2);
    expect(results[0].job.id).toBe(results[1].job.id);
    expect(results.every(result => result.status === 'saved')).toBe(true);
  });

  it('does not create from an unbound session id or accept ambiguous local one-off time', async () => {
    const f = await fixture((_body, index) => {
      if (index === 0) return completion({ calls: [call('list')] });
      if (index === 1) return completion({ calls: [call('create', {
        name: 'Invalid session', prompt: 'Do work.', triggerKind: 'cron', cron: '0 9 * * *', sessionId: 'foreign-session',
      })] });
      if (index === 2) return completion({ calls: [call('create', {
        name: 'Ambiguous one-off', prompt: 'Do work.', triggerKind: 'once', runAt: '2027-02-03T09:00',
      })] });
      return completion({ text: 'No schedule was saved.' });
    });
    await f.host.sendPrompt(f.session.id, 'Schedule this work later.');
    await idle(f.runtime);
    expect((await f.host.listSchedules!()).schedules).toEqual([]);
    const toolResults = f.requests.flatMap(request => request.messages.filter(message => message.role === 'tool').map(message => message.content ?? ''));
    expect(toolResults.some(result => /Unknown argument|session id|sessionId/i.test(result))).toBe(true);
    expect(toolResults.some(result => /explicit UTC offset|ISO date|date.time/i.test(result))).toBe(true);
  });

  it('shows only jobs from the prompt workspace in list metadata', async () => {
    const f = await fixture((_body, index) => index === 0
      ? completion({ calls: [call('list')] }) : completion({ text: 'Listed this project’s schedules.' }));
    const foreign = await f.createForeignWorkspace();
    await f.host.saveSchedule!({ workspaceId: foreign.id, name: 'Foreign weekly job', prompt: 'Private foreign task.', enabled: false,
      trigger: { kind: 'interval', intervalMinutes: 10080 }, sessionTarget: { mode: 'create-and-reuse' }, assignment: { teamMode: 'workspace' } });

    await f.host.sendPrompt(f.session.id, 'List my scheduled jobs.');
    await idle(f.runtime);

    const listed = JSON.parse([...f.requests[1]!.messages].reverse().find(message => message.role === 'tool')!.content!);
    expect(listed).toMatchObject({ workspaceId: f.workspace.id, total: 0, jobs: [] });
    expect(JSON.stringify(listed)).not.toContain('Foreign weekly job');
  });

  it('allows a Plan turn to inspect schedules but prevents job creation', async () => {
    const f = await fixture((_body, index) => index === 0
      ? completion({ calls: [call('list')] })
      : index === 1 ? completion({ calls: [call('create', {
        name: 'Plan-only job', prompt: 'Do work later.', triggerKind: 'interval', intervalMinutes: 10080,
      })] }) : completion({ text: 'I can describe the proposed schedule, but Plan mode did not save it.' }));
    await f.host.setSessionOptions(f.session.id, { permissionMode: 'plan' });

    await f.host.sendPrompt(f.session.id, 'Schedule this review weekly.');
    await idle(f.runtime);

    expect(f.requests[0]!.tools?.map(tool => tool.function.name)).toContain('schedule_jobs');
    expect((await f.host.listSchedules!()).schedules).toEqual([]);
    expect(f.events.some(event => event.body.type === 'tool.completed' && event.body.tool === 'schedule_jobs' && !event.body.ok
      && /read-only|Plan/i.test(event.body.output ?? ''))).toBe(true);
  });

  it('reports a schedule storage failure without claiming success or retaining a job', async () => {
    const persistFailure = vi.spyOn(GeneralScheduleManager.prototype, 'createFromPrompt').mockRejectedValue(new Error('Synthetic schedule storage failure.'));
    const f = await fixture((_body, index) => index === 0
      ? completion({ calls: [call('list')] })
      : index === 1 ? completion({ calls: [call('create', {
        name: 'Unstored job', prompt: 'Do work later.', triggerKind: 'interval', intervalMinutes: 10080,
      })] }) : completion({ text: 'The schedule could not be saved.' }));

    await f.host.sendPrompt(f.session.id, 'Schedule this review weekly.');
    await idle(f.runtime);

    expect(persistFailure).toHaveBeenCalledOnce();
    expect((await f.host.listSchedules!()).schedules).toEqual([]);
    expect(f.events.some(event => event.body.type === 'tool.completed' && event.body.tool === 'schedule_jobs' && !event.body.ok
      && event.body.output?.includes('Synthetic schedule storage failure'))).toBe(true);
    expect(f.events.some(event => event.body.type === 'tool.completed' && event.body.tool === 'schedule_jobs' && event.body.ok
      && event.body.output?.includes('Unstored job'))).toBe(false);
  });

  it('refuses ephemeral current/reusable conversations but accepts an explicit fresh conversation per run', async () => {
    const f = await fixture((_body, index) => {
      if (index === 0) return completion({ calls: [call('list')] });
      if (index === 1) return completion({ calls: [call('create', {
        name: 'Transient current', prompt: 'Review the project.', triggerKind: 'interval', intervalMinutes: 10080,
      })] });
      if (index === 2) return completion({ calls: [call('create', {
        name: 'Transient reusable', prompt: 'Review the project.', triggerKind: 'interval', intervalMinutes: 10080,
        sessionMode: 'create-and-reuse',
      })] });
      if (index === 3) return completion({ calls: [call('create', {
        name: 'Fresh transient review', prompt: 'Review the project.', triggerKind: 'interval', intervalMinutes: 10080,
        sessionMode: 'new-each-run',
      })] });
      return completion({ text: 'Only the fresh-session schedule was saved.' });
    }, { history: false });

    await f.host.sendPrompt(f.session.id, 'Schedule a weekly project review.');
    await idle(f.runtime);

    const saved = (await f.host.listSchedules!()).schedules;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'Fresh transient review', sessionTarget: { mode: 'new-each-run' } });
    const toolResults = f.requests.flatMap(request => request.messages.filter(message => message.role === 'tool').map(message => message.content ?? ''));
    expect(toolResults.some(result => result.includes('does not retain history'))).toBe(true);
    expect(toolResults.some(result => result.includes('new sessions do not retain history'))).toBe(true);
  });

  it('does not replace a deleted bound reusable session with a different conversation', async () => {
    const f = await fixture(() => completion({ text: 'Scheduled work accepted.' }));
    const created = await f.host.saveSchedule!({ workspaceId: f.workspace.id, name: 'Bound reusable review', prompt: 'Review the project.', enabled: false,
      trigger: { kind: 'interval', intervalMinutes: 10080 }, sessionTarget: { mode: 'create-and-reuse' }, assignment: { teamMode: 'workspace' } });
    const initial = created.schedules[0]!;
    await f.host.runScheduleNow!(initial.id, initial.revision);
    await idle(f.runtime);
    const bound = (await f.host.listSchedules!()).schedules[0]!;
    expect(bound.boundSessionId).toBeTruthy();
    expect(bound.lastSessionId).toBe(bound.boundSessionId);
    await f.host.deleteSession(bound.boundSessionId!);
    const before = (await f.host.getState()).sessions.map(session => session.id);
    const requestsBefore = f.requests.length;

    await expect(f.host.runScheduleNow!(bound.id, bound.revision)).rejects.toThrow(/conversation is unavailable/i);
    await idle(f.runtime);

    expect(f.requests).toHaveLength(requestsBefore);
    expect((await f.host.getState()).sessions.map(session => session.id)).toEqual(before);
  });

  it('rechecks the destination history policy before the first create-and-reuse run', async () => {
    const f = await fixture(() => completion({ text: 'This must not be sent.' }));
    const created = await f.host.saveSchedule!({ workspaceId: f.workspace.id, name: 'Reusable policy review', prompt: 'Review the project.', enabled: false,
      trigger: { kind: 'interval', intervalMinutes: 10080 }, sessionTarget: { mode: 'create-and-reuse' }, assignment: { teamMode: 'workspace' } });
    const schedule = created.schedules[0]!;
    await f.host.saveConnection({ id: f.connection.id, name: f.connection.name, preset: f.connection.preset, api: f.connection.api,
      baseUrl: f.connection.baseUrl, model: f.connection.model, credential: { kind: 'none' },
      features: { memory: 'off', skills: 'off', history: false } });
    const sessionsBefore = (await f.host.getState()).sessions.map(session => session.id);
    const requestsBefore = f.requests.length;

    await expect(f.host.runScheduleNow!(schedule.id, schedule.revision)).rejects.toThrow(/retained history/i);
    await idle(f.runtime);

    expect(f.requests).toHaveLength(requestsBefore);
    expect((await f.host.getState()).sessions.map(session => session.id)).toEqual(sessionsBefore);
  });
});
