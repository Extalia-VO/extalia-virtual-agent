import { createAgentHost } from '../src/service.js';
import type { AgentTeam } from '@extalia/core';
import type { ExtaliaEvent } from '@extalia/protocol';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentHostOptions, type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';

const tempDir = useTempDirs();
const runtimes: AgentHostRuntime[] = [];
afterEach(async () => { while (runtimes.length) await runtimes.pop()!.close(); });

type Body = { model: string; messages: { role: string; content: string | null; tool_calls?: unknown[] }[]; tools?: { function: { name: string; parameters: unknown } }[] };
type Script = (body: Body) => Response | { text?: string; tool?: { name: string; args: Record<string, unknown> } };

function sse(reply: { text?: string; tool?: { name: string; args: Record<string, unknown> } }): Response {
  const chunks = reply.tool
    ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] }, finish_reason: 'tool_calls' }] }]
    : [{ choices: [{ delta: { content: reply.text ?? '' }, finish_reason: 'stop' }] }];
  return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

/** An OpenAI-compatible endpoint stand-in driven by `script`; records the model and role (lead/worker) of every request. */
function scriptedFetch(script: Script) {
  const requests: { model: string; worker: boolean; system: string; tools: string[] }[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    if (/\/models$/.test(input)) return Response.json({ data: [{ id: 'mock-agent' }] });
    const body = JSON.parse(String(init?.body)) as Body;
    const system = body.messages[0]?.content ?? '';
    requests.push({ model: body.model, worker: system.startsWith('You are a worker agent'), system, tools: (body.tools ?? []).map(tool => tool.function.name) });
    const reply = script(body);
    return reply instanceof Response ? reply : sse(reply);
  };
  return { fetch, requests };
}

async function setup(script: Script, root?: string, onMeetingMinutes?: AgentHostOptions['onMeetingMinutes']) {
  const base = root ?? await tempDir();
  const project = path.join(base, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(path.join(base, 'home'), { recursive: true });
  const scripted = scriptedFetch(script);
  const runtime = await createAgentHost({
    kind: 'bridge', version: '0.0.0-test', dataDirectory: path.join(base, 'data'), homeDirectory: path.join(base, 'home'), importHome: path.join(base, 'home'),
    env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_DAEMON_PATH: DAEMON_BINARY, PATH: process.env.PATH, HERMES_MANAGED_DIR: path.join(base, 'no-managed-scope') }, fetch: scripted.fetch,
    ...(onMeetingMinutes ? { onMeetingMinutes } : {}),
  });
  runtimes.push(runtime);
  const events: ExtaliaEvent[] = [];
  runtime.host.subscribe(event => events.push(event));
  return { root: base, project, runtime, host: runtime.host, events, scripted };
}

async function nativeWorkspace(host: AgentHostRuntime['host'], project: string, history = true) {
  const saved = await host.saveConnection({
    name: 'Mock', preset: 'custom', api: 'openai-chat', baseUrl: 'http://mock.test/v1', model: 'mock-agent', credential: { kind: 'none' },
    features: { memory: 'off', skills: 'off', ...(history ? {} : { history: false }) }, orchestration: { enabled: false, maxDelegations: 0, tiers: {} },
  });
  const state = await host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: saved.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
  return state.workspaces.at(-1)!;
}

async function turn(setupResult: Awaited<ReturnType<typeof setup>>, sessionId: string, text: string) {
  const from = setupResult.events.length;
  await setupResult.host.sendPrompt(sessionId, text);
  for (let i = 0; i < 500; i++) {
    const ended = setupResult.events.slice(from).find(event => event.sessionId === sessionId && event.agentId === 'primary' && (event.body.type === 'turn.completed' || event.body.type === 'turn.failed'));
    if (ended && !setupResult.runtime.isBusy()) return { events: setupResult.events.slice(from), ended };
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('The turn did not end.');
}

const TEAM: AgentTeam = {
  enabled: true,
  allowedModels: ['mock-large', 'mock-fast'],
  goal: 'Refactor the login flow',
  members: [
    { id: 'm-ava', name: 'Ava', role: 'Researcher', task: 'Find the login call sites', models: ['mock-fast', 'mock-large'] },
    { id: 'm-milo', name: 'Milo', role: 'Reviewer', models: ['mock-large'] },
  ],
};

const done = () => ({ text: 'Done.' });

describe('subagent teams (Extalia Native)', () => {
  it('saves, validates and removes a team; it persists with the session across a restart', async () => {
    const first = await setup(done);
    const workspace = await nativeWorkspace(first.host, first.project);
    const session = await first.host.createSession(workspace.id);
    expect(await first.host.getSessionTeam(session.id)).toBeUndefined();
    await expect(first.host.saveSessionTeam(session.id, { ...TEAM, members: [{ ...TEAM.members[0]!, models: ['not-allowed'] }] })).rejects.toThrow(/not one of the team's allowed models/);
    await expect(first.host.saveSessionTeam('s_doesnotexist', TEAM)).rejects.toThrow(/no longer exists/);

    const saved = await first.host.saveSessionTeam(session.id, TEAM);
    expect(saved).toMatchObject({ ...TEAM, updatedAt: expect.any(String) });
    expect((await first.host.getState()).sessions.find(item => item.id === session.id)?.team).toEqual({ enabled: true, size: 2, updatedAt: saved!.updatedAt });
    await runtimes.pop()!.close();

    const second = await setup(done, first.root);
    expect(await second.host.getSessionTeam(session.id)).toEqual(saved);
    expect((await second.host.getState()).sessions.find(item => item.id === session.id)?.team).toEqual({ enabled: true, size: 2, updatedAt: saved!.updatedAt });
    // The model override never carries the team.
    expect((await second.host.setSessionOptions(session.id, { model: 'mock-large', team: { ...TEAM, enabled: false } })).team).toEqual({ enabled: true, size: 2, updatedAt: saved!.updatedAt });
    expect(await second.host.saveSessionTeam(session.id, null)).toBeUndefined();
    expect((await second.host.getState()).sessions.find(item => item.id === session.id)?.team).toBeUndefined();

    const withTeam = await second.host.createSession(workspace.id, { team: TEAM });
    expect(withTeam.team).toEqual({ enabled: true, size: 2, updatedAt: (await second.host.getSessionTeam(withTeam.id))!.updatedAt });
    expect((await second.host.getSessionTeam(withTeam.id))?.members.map(member => member.name)).toEqual(['Ava', 'Milo']);
  });

  it('projects the persisted revision when an edit keeps the team enabled and the same size', async () => {
    const context = await setup(done);
    const workspace = await nativeWorkspace(context.host, context.project);
    const session = await context.host.createSession(workspace.id, { team: TEAM });
    const initial = (await context.host.getSessionTeam(session.id))!;
    expect(session.team).toEqual({ enabled: true, size: 2, updatedAt: initial.updatedAt });
    await new Promise(resolve => setTimeout(resolve, 5));
    const edited = (await context.host.saveSessionTeam(session.id, { ...initial, members: initial.members.map((member, index) => index === 0 ? { ...member, role: 'Architect' } : member) }))!;
    expect(edited.updatedAt).toEqual(expect.any(String));
    expect(edited.updatedAt).not.toBe(initial.updatedAt);
    expect((await context.host.getState()).sessions.find(item => item.id === session.id)?.team).toEqual({ enabled: true, size: 2, updatedAt: edited.updatedAt });
    expect((await context.host.getSessionTeam(session.id))!.updatedAt).toBe(edited.updatedAt);
  });

  it('keeps teams for Hermes Agent sessions (create, save, load)', async () => {
    const { host, project } = await setup(done);
    const state = await host.saveWorkspace({ name: 'Hermes', projectLocation: project, runtimeId: 'hermes', permissions: { fileWrite: 'ask', commands: 'ask' } });
    const workspace = state.workspaces[0]!;
    const created = await host.createSession(workspace.id, { team: TEAM });
    expect(created).toMatchObject({ runtime: { id: 'hermes' }, team: { enabled: true, size: 2 } });
    const session = await host.createSession(workspace.id);
    expect(await host.saveSessionTeam(session.id, TEAM)).toMatchObject({ enabled: true, members: [{ name: 'Ava' }, { name: 'Milo' }] });
    expect((await host.getSessionTeam(session.id))?.allowedModels).toEqual(TEAM.allowedModels);
    const beforeRejectedPrompt = await host.getSessionTeam(session.id);
    const oversizedPrompt = Array.from({ length: 3 }, (_, index) => `Subagent ${index + 1}:\nRole: R${index}`).join('\n');
    await expect(host.sendPrompt(session.id, oversizedPrompt)).rejects.toThrow(/at most 2/);
    expect(await host.getSessionTeam(session.id)).toEqual(beforeRejectedPrompt);
    const oversized = { ...TEAM, members: [...TEAM.members, { ...TEAM.members[0]!, id: 'extra-member', name: 'Extra Member' }] };
    await expect(host.saveSessionTeam(session.id, oversized)).rejects.toThrow(/at most 2/);
    await expect(host.createSession(workspace.id, { team: oversized })).rejects.toThrow(/at most 2/);
    expect(await host.saveSessionTeam(session.id, null)).toBeUndefined();
  });

  it('gives the lead its team: instructions, delegate_task with member on the member\'s model, a subagent named after the member', async () => {
    let leadCalls = 0;
    const context = await setup(body => {
      const system = body.messages[0]?.content ?? '';
      if (system.startsWith('You are a worker agent')) return { text: `${body.model}: login is in src/auth.ts:12` };
      return leadCalls++ === 0 ? { tool: { name: 'delegate_task', args: { task: 'Find the login call sites', member: 'Ava' } } } : { text: 'Merged.' };
    });
    const workspace = await nativeWorkspace(context.host, context.project);
    const session = await context.host.createSession(workspace.id, { team: TEAM });
    const { events, ended } = await turn(context, session.id, 'Refactor login');
    expect(ended.body.type).toBe('turn.completed');

    const lead = context.scripted.requests.filter(request => !request.worker);
    expect(lead[0]?.system).toContain('You lead a team of subagents');
    expect(lead[0]?.system).toContain('- Ava (Researcher): Find the login call sites');
    // Orchestration is off on the connection, yet an enabled team always gets the delegation tool.
    expect(lead[0]?.tools).toContain('delegate_task');
    const workers = context.scripted.requests.filter(request => request.worker);
    expect(workers.map(request => request.model)).toEqual(['mock-fast']);
    expect(workers[0]?.system).toContain('You are Ava, the team\'s Researcher.');
    expect(events.find(event => event.body.type === 'subagent.spawned')?.body).toEqual({ type: 'subagent.spawned', subagentId: 'm-ava', role: 'Researcher', label: 'Ava' });
    expect(events.some(event => event.agentId === 'm-ava' && event.body.type === 'agent.state')).toBe(false);
    expect(events.find(event => event.body.type === 'tool.completed' && event.body.tool === 'delegate_task')?.body).toMatchObject({ ok: true, output: 'mock-fast: login is in src/auth.ts:12' });
  });

  it('falls back through the lead\'s chain (session model, then the team\'s allowed models) on a quota error', async () => {
    const context = await setup(body => body.model === 'mock-agent'
      ? Response.json({ error: { message: 'You exceeded your current quota.', code: 'insufficient_quota' } }, { status: 429 })
      : { text: `${body.model} here.` });
    const workspace = await nativeWorkspace(context.host, context.project);
    const session = await context.host.createSession(workspace.id, { team: TEAM });
    const { events, ended } = await turn(context, session.id, 'Hello');
    expect(ended.body.type).toBe('turn.completed');
    expect(context.scripted.requests.map(request => request.model)).toEqual(['mock-agent', 'mock-large']);
    expect(events.some(event => event.body.type === 'agent.state' && event.body.summary === 'Switched to mock-large (mock-agent hit a limit)')).toBe(true);
    expect(events.find(event => event.body.type === 'model.completed')?.body).toMatchObject({ text: 'mock-large here.' });

    // Without a team there is no fallback: the quota error ends the turn.
    const plain = await context.host.createSession(workspace.id);
    const failed = await turn(context, plain.id, 'Hello');
    expect(failed.ended.body).toMatchObject({ type: 'turn.failed', error: expect.stringContaining('quota') });
  });

  it('plans a team with the connection\'s model (strict JSON) and falls back to the heuristic plan', async () => {
    let reply: Response | { text: string } = { text: '{"members":[{"role":"Architect","task":"Design the new flow","model":"mock-large"},{"role":"Scout","task":"Find call sites","model":"mock-fast"}]}' };
    const context = await setup(() => reply);
    const workspace = await nativeWorkspace(context.host, context.project);
    const request = { goal: 'Refactor the login flow', count: 2, allowedModels: ['mock-large', 'mock-fast'] };

    const planned = await context.host.planTeam(workspace.id, request);
    expect(planned.source).toBe('model');
    expect(planned.members.map(member => [member.name, member.role, member.models])).toEqual([['Aurel Juniver', 'Architect', ['mock-large']], ['Calla Elveth', 'Scout', ['mock-fast']]]);
    // v0.0.39: members get only the models the plan gave them, and a soul.
    expect(planned.members.every(member => member.soul)).toBe(true);
    const asked = context.scripted.requests.at(-1)!;
    expect(asked.model).toBe('mock-agent');
    expect(asked.tools).toEqual([]);

    // A re-plan keeps current members' ids and names even when their models are no longer allowed.
    const replanned = await context.host.planTeam(workspace.id, { ...request, members: [{ ...TEAM.members[0]!, models: ['retired-model'] }] });
    expect(replanned.members[0]).toMatchObject({ id: 'm-ava', name: 'Ava', role: 'Architect' });

    reply = { text: 'Sure! A researcher and a reviewer would be good.' };
    const fallback = await context.host.planTeam(workspace.id, request);
    expect(fallback).toMatchObject({ source: 'heuristic', note: expect.stringContaining('not a usable plan') });
    expect(fallback.members.map(member => member.role)).toEqual(['Researcher', 'Reviewer']);

    reply = Response.json({ error: { message: 'upstream down' } }, { status: 500 });
    expect(await context.host.planTeam(workspace.id, request)).toMatchObject({ source: 'heuristic', note: expect.stringContaining('could not be asked') });

    await expect(context.host.planTeam(workspace.id, { ...request, count: 33 })).rejects.toThrow(/1 to 32/);
    await expect(context.host.planTeam(workspace.id, { ...request, goal: 42 } as never)).rejects.toThrow(/goal/);
    await expect(context.host.planTeam(workspace.id, { ...request, allowedModels: ['--bad'] })).rejects.toThrow(/model id/);
  });
});

describe('Native team meetings', () => {
  it.skipIf(!HAS_DAEMON || process.platform === 'win32')('uses an assigned profile vault for actual meeting minutes without retargeting the default vault', async () => {
    let calls = 0;
    const context = await setup(body => body.messages[0]?.content?.startsWith('You are a worker agent')
      ? { text: 'This is the actual profile-scoped discussion.' }
      : calls++ === 0 ? { tool: { name: 'conduct_team_meeting', args: { topic: 'Plan the next draft', members: ['m-ava'] } } } : { text: 'Discussion summarized.' });
    const workspace = await nativeWorkspace(context.host, context.project);
    const before = await context.host.listVaultProfiles!();
    const catalog = await context.host.saveVaultProfile!({ name: 'Writing', vaultRoot: null, workspaceIds: [workspace.id], minutesEnabled: true, expectedRevision: before.revision });
    const assigned = catalog.profiles.find(profile => profile.workspaceIds.includes(workspace.id))!;
    expect(assigned.id).not.toBe(catalog.defaultProfileId);
    const session = await context.host.createSession(workspace.id, { team: TEAM });
    const { events } = await turn(context, session.id, 'Discuss the next draft.');
    const complete = events.find(event => event.body.type === 'meeting.completed');
    const relative = complete?.body.type === 'meeting.completed' ? complete.body.notePath : undefined;
    expect(relative).toBeTruthy();
    const note = await readFile(path.join(assigned.root, relative!), 'utf8');
    expect(note).toContain(`profile: "${assigned.id}"`);
    expect(note).toContain('This is the actual profile-scoped discussion.');
  });
  it.skipIf(!HAS_DAEMON || process.platform === 'win32')('saves default minutes into the workspace profile vault with actual discussion evidence', async () => {
    let calls = 0;
    const context = await setup(body => body.messages[0]?.content?.startsWith('You are a worker agent')
      ? { text: 'Use the current source evidence before implementation.' }
      : calls++ === 0 ? { tool: { name: 'conduct_team_meeting', args: { topic: 'Review the implementation', members: ['m-ava'] } } } : { text: 'Discussion summarized.' });
    const workspace = await nativeWorkspace(context.host, context.project);
    const session = await context.host.createSession(workspace.id, { team: TEAM });
    const { events } = await turn(context, session.id, 'Discuss the implementation before working.');
    const complete = events.find(event => event.body.type === 'meeting.completed');
    expect(complete?.body).toMatchObject({ outcome: 'completed' });
    const relative = complete?.body.type === 'meeting.completed' ? complete.body.notePath : undefined;
    expect(relative).toMatch(new RegExp(`^Meetings/${workspace.id}/meeting-`));
    const content = await readFile(path.join(context.root, 'data', 'vaults', 'default', relative!), 'utf8');
    expect(content).toContain(`workspace: "${workspace.id}"`);
    expect(content.match(/Use the current source evidence before implementation\./g)).toHaveLength(2);
    expect(content).toContain('### Round 2');
  });
  it('persists real meeting rounds under stable member ids and exports saved-session minutes', async () => {
    let leadCalls = 0;
    const workerCalls = new Map<string, number>();
    const exported: { sessionId: string; workspaceId: string; contributions: number }[] = [];
    const context = await setup(body => {
      if (body.messages[0]?.content?.startsWith('You are a worker agent')) {
        expect(context.events.some(event => event.body.type === 'meeting.started')).toBe(true);
        workerCalls.set(body.model, (workerCalls.get(body.model) ?? 0) + 1);
        if (workerCalls.get(body.model) === 2) expect(body.messages.at(-1)?.content).toContain('mock-fast observed round 1');
        return { text: `${body.model} observed round ${workerCalls.get(body.model)}` };
      }
      return leadCalls++ === 0 ? { tool: { name: 'conduct_team_meeting', args: { topic: 'Compare design options', members: ['m-ava', 'm-milo'], roomId: 'meeting-a' } } } : { text: 'Synthesized the real discussion.' };
    }, undefined, async (record, source) => {
      exported.push({ ...source, contributions: record.contributions.length });
      return 'meetings/example.md';
    });
    const workspace = await nativeWorkspace(context.host, context.project);
    const session = await context.host.createSession(workspace.id, { team: { ...TEAM, members: TEAM.members.map(member => ({ ...member, access: 'write' })) } });
    const { events } = await turn(context, session.id, 'Meet to compare design options.');
    const meetings = events.filter(event => event.body.type.startsWith('meeting.'));
    expect(meetings.map(event => event.body.type)).toEqual(['meeting.started', 'meeting.contribution', 'meeting.contribution', 'meeting.contribution', 'meeting.contribution', 'meeting.completed']);
    expect(meetings[0]?.body).toMatchObject({ participants: ['primary', 'm-ava', 'm-milo'], roomId: 'meeting-a' });
    expect(meetings.filter(event => event.body.type === 'meeting.contribution').map(event => event.agentId)).toEqual(['m-ava', 'm-milo', 'm-ava', 'm-milo']);
    expect(meetings.every(event => event.sessionId === session.id)).toBe(true);
    expect(meetings.at(-1)?.body).toMatchObject({ outcome: 'completed', notePath: 'meetings/example.md' });
    expect(exported).toEqual([{ sessionId: session.id, workspaceId: workspace.id, contributions: 4 }]);
    const workerRequests = context.scripted.requests.filter(request => request.worker);
    expect(workerRequests).toHaveLength(4);
    expect(workerRequests.every(request => !request.tools.includes('write_file') && !request.tools.includes('run_command') && !request.tools.includes('conduct_team_meeting'))).toBe(true);
    expect(context.scripted.requests.find(request => !request.worker)?.system).toContain('Use conduct_team_meeting');
    const replay = (await context.host.sessionEvents(session.id)).filter(event => event.body.type.startsWith('meeting.'));
    expect(replay).toEqual(meetings);
  });

  it('keeps history-off meetings in session memory and never invokes the durable minutes exporter', async () => {
    let leadCalls = 0;
    let exports = 0;
    const context = await setup(body => body.messages[0]?.content?.startsWith('You are a worker agent')
      ? { text: 'Ephemeral findings' }
      : leadCalls++ === 0 ? { tool: { name: 'conduct_team_meeting', args: { topic: 'Private temporary plan', members: ['m-ava'] } } } : { text: 'Done.' },
    undefined, async () => { exports++; return 'meetings/should-not-exist.md'; });
    const workspace = await nativeWorkspace(context.host, context.project, false);
    const session = await context.host.createSession(workspace.id, { team: TEAM });
    expect(session.transient).toBe(true);
    const { events } = await turn(context, session.id, 'Meet temporarily.');
    expect(events.find(event => event.body.type === 'meeting.completed')?.body).toMatchObject({ outcome: 'completed' });
    expect(events.find(event => event.body.type === 'meeting.completed')?.body).not.toHaveProperty('notePath');
    expect(exports).toBe(0);
    expect((await context.host.sessionEvents(session.id)).filter(event => event.body.type === 'meeting.contribution')).toHaveLength(2);
  });

  it('uses a member added by manage_team in the same turn', async () => {
    let leadCalls = 0;
    const context = await setup(body => {
      if (body.messages[0]?.content?.startsWith('You are a worker agent')) return { text: 'New member contribution' };
      switch (leadCalls++) {
        case 0: return { tool: { name: 'manage_team', args: { action: 'add', role: 'Planner', name: 'Discussion Member', models: ['mock-fast'] } } };
        case 1: return { tool: { name: 'conduct_team_meeting', args: { topic: 'Consider the new role', members: ['Discussion Member'] } } };
        default: return { text: 'Done.' };
      }
    });
    const workspace = await nativeWorkspace(context.host, context.project);
    const session = await context.host.createSession(workspace.id, { team: TEAM });
    const { events } = await turn(context, session.id, 'Add a planner then hold a meeting.');
    const member = (await context.host.getSessionTeam(session.id))!.members.find(item => item.name === 'Discussion Member')!;
    expect(member).toBeDefined();
    expect(events.find(event => event.body.type === 'meeting.started')?.body).toMatchObject({ participants: ['primary', member.id] });
    expect(events.filter(event => event.body.type === 'meeting.contribution').map(event => event.agentId)).toEqual([member.id, member.id]);
  });

  it('does not invent meetings from plain assistant text or offer meeting tools to disabled teams', async () => {
    const context = await setup(() => ({ text: 'We should have a meeting.' }));
    const workspace = await nativeWorkspace(context.host, context.project);
    const session = await context.host.createSession(workspace.id, { team: { ...TEAM, enabled: false } });
    const { events } = await turn(context, session.id, 'Consider a discussion.');
    expect(events.some(event => event.body.type.startsWith('meeting.'))).toBe(false);
    expect(context.scripted.requests[0]?.tools).not.toContain('conduct_team_meeting');
  });
});

describe('planning a team without a goal or models', () => {
  it('Extalia Native: the plan chooses from the connection\'s models and the prompt says there is no goal', async () => {
    let asked = '';
    const context = await setup(body => {
      asked = String(body.messages.at(-1)?.content ?? '');
      return { text: '{"members":[{"role":"Architect","task":"Shape the work","model":"mock-agent"}],"models":["mock-agent"]}' };
    });
    const workspace = await nativeWorkspace(context.host, context.project);
    const plan = await context.host.planTeam(workspace.id, { goal: '', count: 1, allowedModels: [] });
    expect(plan).toMatchObject({ source: 'model', allowedModels: ['mock-agent'], members: [{ role: 'Architect', models: ['mock-agent'] }] });
    expect(asked).toContain('No goal was given: plan a general-purpose team for ongoing work in the Project project');
    expect(asked).toContain('No model was chosen by the user. The team may use these models of the workspace');
  });
});

describe('planning a team for a Hermes Agent workspace', () => {
  async function hermesSetup(baseUrl: string, reply: (body: { model: string; messages: { role: string; content: string }[] }) => Response, key: { apiKey?: string; dotenv?: string; env?: Record<string, string> } = {}) {
    const base = await tempDir();
    const project = path.join(base, 'project'), home = path.join(base, 'home');
    await mkdir(project, { recursive: true });
    await mkdir(path.join(home, '.hermes', 'profiles', 'lab'), { recursive: true });
    await writeFile(path.join(home, '.hermes', 'profiles', 'lab', 'config.yaml'),
      `model:\n  default: ag/claude-sonnet\n  provider: custom\n  base_url: ${baseUrl}\n  api_key: ${key.apiKey ?? 'sk-local-only'}\ndelegation:\n  model: ''\n`);
    if (key.dotenv) await writeFile(path.join(home, '.hermes', 'profiles', 'lab', '.env'), key.dotenv);
    const requests: { url: string; method: string; auth?: string; body?: string }[] = [];
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      requests.push({ url: String(input), method: init?.method ?? 'GET', ...(headers.get('authorization') ? { auth: headers.get('authorization')! } : {}), ...(init?.body ? { body: String(init.body) } : {}) });
      if (/\/models$/.test(String(input))) {
        return Response.json({ data: ['ag/claude-sonnet', 'ag/claude-opus-thinking', 'ag/gemini-flash', 'ag/text-embedding-3', 'or/qwen3-coder'].map(id => ({ id })) });
      }
      return reply(JSON.parse(String(init?.body)));
    };
    const runtime = await createAgentHost({ kind: 'bridge', version: '0.0.0-test', dataDirectory: path.join(base, 'data'), importHome: home, env: { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH, HERMES_MANAGED_DIR: path.join(base, 'no-managed-scope'), ...key.env }, fetch });
    runtimes.push(runtime);
    const state = await runtime.host.saveWorkspace({ name: 'Lab', projectLocation: project, runtimeId: 'hermes', runtimeProfileId: 'lab', permissions: { fileWrite: 'ask', commands: 'ask' } });
    return { host: runtime.host, workspace: state.workspaces[0]!, requests };
  }

  it('asks the profile\'s local router with its key (loopback only) and plans roles without promising per-member model routing', async () => {
    const plan = '{"members":[{"role":"Architect","task":"Design it","soul":"Calm.","models":["ag/claude-opus-thinking","ag/gemini-flash"],"why":"Design needs depth."},{"role":"Scout","task":"Look things up","model":"ag/gemini-flash"}],"models":["ag/claude-opus-thinking","ag/gemini-flash"]}';
    const { host, workspace, requests } = await hermesSetup('http://127.0.0.1:20128/v1', () => Response.json({ choices: [{ message: { role: 'assistant', content: `<think>{draft}</think>\n${plan}` } }] }));
    const result = await host.planTeam(workspace.id, { goal: '', count: 2, allowedModels: [] });
    expect(result.source).toBe('model');
    expect(result.allowedModels).toBeUndefined();
    expect(result.members.map(member => [member.role, member.models])).toEqual([
      ['Architect', []], ['Scout', []],
    ]);
    expect(result.members[0]!.soul).toBe('Calm.');
    expect(result.modelReasons).toBeUndefined();
    expect(result.members.every(member => /^\S+ \S+$/.test(member.name))).toBe(true);
    const chat = requests.find(request => request.method === 'POST')!;
    expect(chat.url).toBe('http://127.0.0.1:20128/v1/chat/completions');
    expect(chat.auth).toBe('Bearer sk-local-only');
    const body = JSON.parse(chat.body!) as { model: string; max_tokens: number; messages: { content: string }[] };
    expect(body.max_tokens).toBeGreaterThanOrEqual(8_000);
    // The profile's default model plans; non-chat models are never offered.
    expect(body.model).toBe('ag/claude-sonnet');
    expect(body.messages[1]!.content).toContain('ongoing work in the Lab project');
    expect(body.messages[1]!.content).not.toContain('embedding');
    expect(requests.every(request => new URL(request.url).hostname === '127.0.0.1')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('sk-local-only');

    // Legacy model picks do not become unsupported Hermes worker routes.
    const ticked = await host.planTeam(workspace.id, { goal: 'Ship it', count: 2, allowedModels: ['ag/claude-opus-thinking', 'ag/gemini-flash'] });
    expect(ticked).toMatchObject({ source: 'model' });
    expect(ticked.allowedModels).toBeUndefined();
    expect(ticked.members.every(member => member.models.length === 0)).toBe(true);
    expect(body.messages[1]!.content).toContain('shared delegation model');
    await expect(host.planTeam(workspace.id, { goal: 'Too many', count: 3, allowedModels: [] })).rejects.toThrow(/at most 2/);
  });

  it('resolves a ${VAR} key from the profile\'s .env (then the environment), as Hermes does', async () => {
    const reply = () => Response.json({ choices: [{ message: { content: '{"members":[{"role":"Scout","task":"Look","model":"ag/gemini-flash"}],"models":["ag/gemini-flash"]}' } }] });
    const fromFile = await hermesSetup('http://localhost:20128/v1', reply, { apiKey: '"${ROUTER_KEY}"', dotenv: '# comment\nexport ROUTER_KEY="sk-from-dotenv"\n', env: { ROUTER_KEY: 'sk-from-env' } });
    expect(await fromFile.host.planTeam(fromFile.workspace.id, { goal: 'x', count: 1, allowedModels: [] })).toMatchObject({ source: 'model' });
    expect(fromFile.requests.every(request => request.auth === 'Bearer sk-from-dotenv')).toBe(true);
    const fromEnv = await hermesSetup('http://localhost:20128/v1', reply, { apiKey: '${env:ROUTER_KEY}', env: { ROUTER_KEY: 'sk-from-env' } });
    await fromEnv.host.planTeam(fromEnv.workspace.id, { goal: 'x', count: 1, allowedModels: [] });
    expect(fromEnv.requests.find(request => request.method === 'POST')?.auth).toBe('Bearer sk-from-env');
    const missing = await hermesSetup('http://localhost:20128/v1', reply, { apiKey: '${NOT_SET}' });
    await missing.host.planTeam(missing.workspace.id, { goal: 'x', count: 1, allowedModels: [] });
    expect(missing.requests.every(request => request.auth === undefined)).toBe(true);
  });

  it('never calls a remote provider and does not invent Hermes member models', async () => {
    const { host, workspace, requests } = await hermesSetup('https://api.example.com/v1', () => Response.json({}));
    const result = await host.planTeam(workspace.id, { goal: 'Refactor login', count: 2, allowedModels: [] });
    expect(result).toMatchObject({ source: 'heuristic', note: expect.stringContaining('not on this computer') });
    expect(result.members).toHaveLength(2);
    expect(result.allowedModels).toBeUndefined();
    expect(result.members.every(member => member.models.length === 0)).toBe(true);
    expect(requests).toEqual([]);
  });

  it('falls back to the heuristic plan when the local router fails or answers nonsense', async () => {
    let status = 500;
    const { host, workspace } = await hermesSetup('http://localhost:20128/v1', () => status === 200
      ? Response.json({ choices: [{ message: { content: 'I would suggest a researcher.' } }] })
      : Response.json({ error: 'down' }, { status }));
    const failed = await host.planTeam(workspace.id, { goal: 'x', count: 2, allowedModels: [] });
    expect(failed).toMatchObject({ source: 'heuristic', note: expect.stringContaining('HTTP 500') });
    expect(failed.members.every(member => member.models.length === 0)).toBe(true);
    expect(failed.allowedModels).toBeUndefined();
    status = 200;
    expect(await host.planTeam(workspace.id, { goal: 'x', count: 2, allowedModels: [] })).toMatchObject({ source: 'heuristic', note: expect.stringContaining('not a usable plan') });
  });
});

describe('v0.0.47 workspace default team', () => {
  it('saves, validates and removes the default team; it persists across a restart and editing the workspace keeps it', async () => {
    const first = await setup(done);
    const workspace = await nativeWorkspace(first.host, first.project);
    await expect(first.host.saveWorkspaceTeam(workspace.id, { ...TEAM, members: [{ ...TEAM.members[0]!, models: ['nope'] }] })).rejects.toThrow(/not one of the team's allowed models/);
    await expect(first.host.saveWorkspaceTeam('w_missing', TEAM)).rejects.toThrow(/no longer exists/);
    const state = await first.host.saveWorkspaceTeam(workspace.id, TEAM);
    expect(state.workspaces[0]!.team).toMatchObject({ ...TEAM, updatedAt: expect.any(String) });
    // Editing the workspace (name, permissions …) keeps its default team.
    const edited = await first.host.saveWorkspace({ id: workspace.id, name: 'Renamed', projectLocation: first.project, connectionId: workspace.providerProfileId!, permissions: { fileWrite: 'ask', commands: 'ask' } });
    expect(edited.workspaces[0]!.team?.members.map(member => member.name)).toEqual(['Ava', 'Milo']);
    const session = await first.host.createSession(workspace.id);
    await runtimes.pop()!.close();

    const second = await setup(done, first.root);
    const reloaded = await second.host.getState();
    expect(reloaded.workspaces[0]!.team?.members.map(member => member.id)).toEqual(['m-ava', 'm-milo']);
    expect(reloaded.sessions.find(item => item.id === session.id)?.team).toEqual({ enabled: true, size: 2, updatedAt: (await second.host.getSessionTeam(session.id))!.updatedAt });
    expect((await second.host.saveWorkspaceTeam(workspace.id, null)).workspaces[0]!.team).toBeUndefined();
    // Removing the default leaves existing sessions' teams alone; new sessions start without one.
    expect(await second.host.getSessionTeam(session.id)).toMatchObject({ enabled: true });
    expect((await second.host.createSession(workspace.id)).team).toBeUndefined();
  });

  it('new sessions copy the default: an explicit team wins, null starts without one, and the copies are independent', async () => {
    const context = await setup(done);
    const workspace = await nativeWorkspace(context.host, context.project);
    await context.host.saveWorkspaceTeam(workspace.id, TEAM);

    const inherited = await context.host.createSession(workspace.id);
    expect(inherited.team).toEqual({ enabled: true, size: 2, updatedAt: (await context.host.getSessionTeam(inherited.id))!.updatedAt });
    const copy = (await context.host.getSessionTeam(inherited.id))!;
    expect(copy.members.map(member => member.name)).toEqual(['Ava', 'Milo']);

    const explicit = await context.host.createSession(workspace.id, { team: { ...TEAM, members: [{ ...TEAM.members[1]!, name: 'Rex' }] } });
    expect(explicit.team).toEqual({ enabled: true, size: 1, updatedAt: (await context.host.getSessionTeam(explicit.id))!.updatedAt });
    const none = await context.host.createSession(workspace.id, { team: null });
    expect(none.team).toBeUndefined();
    expect(await context.host.getSessionTeam(none.id)).toBeUndefined();

    // A second copy keeps roles and ids but takes free names: names stay unique in the Office.
    const second = (await context.host.getSessionTeam((await context.host.createSession(workspace.id)).id))!;
    expect(second.members.map(member => member.id)).toEqual(['m-ava', 'm-milo']);
    expect(second.members.map(member => member.role)).toEqual(['Researcher', 'Reviewer']);
    expect(second.members.some(member => ['Ava', 'Milo'].includes(member.name))).toBe(false);

    // Editing a session's team never changes the default, and vice versa.
    await context.host.saveSessionTeam(inherited.id, { ...copy, members: [copy.members[0]!] });
    expect((await context.host.getState()).workspaces[0]!.team?.members).toHaveLength(2);
    await context.host.saveWorkspaceTeam(workspace.id, { ...TEAM, enabled: false });
    expect((await context.host.getSessionTeam(inherited.id))?.members).toHaveLength(1);
    expect((await context.host.getSessionTeam(inherited.id))?.enabled).toBe(true);
  });

  it('every turn of a session with an enabled team carries it (team block + delegate_task); a disabled team is never applied', async () => {
    const context = await setup(done);
    const workspace = await nativeWorkspace(context.host, context.project);
    await context.host.saveWorkspaceTeam(workspace.id, TEAM);
    const session = await context.host.createSession(workspace.id);
    for (const text of ['First request', 'Second request', 'Third request']) expect((await turn(context, session.id, text)).ended.body.type).toBe('turn.completed');
    const leads = context.scripted.requests.filter(request => !request.worker);
    expect(leads).toHaveLength(3);
    for (const lead of leads) {
      expect(lead.system).toContain('You lead a team of subagents');
      expect(lead.system).toContain('- Ava (Researcher): Find the login call sites');
      expect(lead.tools).toContain('delegate_task');
    }

    await context.host.saveSessionTeam(session.id, { ...(await context.host.getSessionTeam(session.id))!, enabled: false });
    const from = context.scripted.requests.length;
    await turn(context, session.id, 'Fourth request');
    const off = context.scripted.requests.slice(from).filter(request => !request.worker);
    expect(off[0]?.system).not.toContain('You lead a team of subagents');
    // Orchestration is off on the connection: without an enabled team there is no delegation tool.
    expect(off[0]?.tools).not.toContain('delegate_task');

    // A disabled default is copied disabled and not applied either.
    await context.host.saveWorkspaceTeam(workspace.id, { ...TEAM, enabled: false });
    const disabled = await context.host.createSession(workspace.id);
    expect(disabled.team).toEqual({ enabled: false, size: 2, updatedAt: (await context.host.getSessionTeam(disabled.id))!.updatedAt });
    const mark = context.scripted.requests.length;
    await turn(context, disabled.id, 'Hello');
    expect(context.scripted.requests.slice(mark)[0]?.system).not.toContain('You lead a team of subagents');
  });

  it('a team written into a prompt merges into the inherited team', async () => {
    const context = await setup(done);
    const workspace = await nativeWorkspace(context.host, context.project);
    await context.host.saveWorkspaceTeam(workspace.id, TEAM);
    const session = await context.host.createSession(workspace.id);
    await turn(context, session.id, 'Build it:\nSubagent A:\n- Name: Zara Quinn\n- Role: Tester\n- Tugas: Write the tests');
    const team = (await context.host.getSessionTeam(session.id))!;
    expect(team.members.map(member => member.name)).toEqual(['Ava', 'Milo', 'Zara Quinn']);
    await turn(context, session.id, 'Next');
    const leads = context.scripted.requests.filter(request => !request.worker);
    expect(leads.at(-1)?.system).toContain('Zara Quinn');
    expect(leads.at(-1)?.system).toContain('- Ava (Researcher)');
    // The default stays as saved.
    expect((await context.host.getState()).workspaces[0]!.team?.members).toHaveLength(2);
  });
});
