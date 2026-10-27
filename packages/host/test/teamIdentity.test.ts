import { generateFullName, type AgentTeam } from '@extalia/core';
import type { ExtaliaEvent } from '@extalia/protocol';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';

/**
 * v0.0.30: lead names, prompt-defined teams, manage_team and write-capable members (through the real host and a scripted endpoint).
 */
const tempDir = useTempDirs();
const runtimes: AgentHostRuntime[] = [];
afterEach(async () => { while (runtimes.length) await runtimes.pop()!.close(); });

const OTP_SPEC = new URL('../../core/test/fixtures/team-spec-otp.txt', import.meta.url);

type Body = { model: string; messages: { role: string; content: string | null }[]; tools?: { function: { name: string } }[] };
type Reply = Response | { text?: string; tool?: { name: string; args: Record<string, unknown> } };

function sse(reply: Exclude<Reply, Response>): Response {
  const chunks = reply.tool
    ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${Math.random().toString(36).slice(2, 8)}`, function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] }, finish_reason: 'tool_calls' }] }]
    : [{ choices: [{ delta: { content: reply.text ?? '' }, finish_reason: 'stop' }] }];
  return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

async function setup(script: (body: Body, system: string) => Reply, root?: string) {
  const base = root ?? await tempDir();
  const project = path.join(base, 'project');
  await mkdir(project, { recursive: true });
  const requests: { model: string; system: string; tools: string[] }[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    if (/\/models$/.test(input)) return Response.json({ data: [{ id: 'mock-agent' }] });
    const body = JSON.parse(String(init?.body)) as Body;
    const system = body.messages[0]?.content ?? '';
    requests.push({ model: body.model, system, tools: (body.tools ?? []).map(tool => tool.function.name) });
    const reply = script(body, system);
    return reply instanceof Response ? reply : sse(reply);
  };
  const runtime = await createAgentHost({
    kind: 'bridge', version: '0.0.0-test', dataDirectory: path.join(base, 'data'), importHome: path.join(base, 'home'),
    env: { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH }, fetch,
  });
  runtimes.push(runtime);
  const events: ExtaliaEvent[] = [];
  runtime.host.subscribe(event => events.push(event));
  return { root: base, project, runtime, host: runtime.host, events, requests };
}

type Context = Awaited<ReturnType<typeof setup>>;

async function nativeWorkspace(host: Context['host'], project: string, permissions = { fileWrite: 'ask' as const, commands: 'ask' as const }) {
  const state = await host.getState();
  const connection = state.connections[0] ?? (await host.saveConnection({
    name: 'Mock', preset: 'custom', api: 'openai-chat', baseUrl: 'http://mock.test/v1', model: 'mock-agent', credential: { kind: 'none' },
    features: { memory: 'off', skills: 'off' }, orchestration: { enabled: false, maxDelegations: 0, tiers: {} },
  })).connections[0]!;
  return (await host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: connection.id, permissions })).workspaces.at(-1)!;
}

async function waitFor<T>(find: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const found = find();
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

async function turn(context: Context, sessionId: string, text: string, onApproval?: (event: ExtaliaEvent) => Promise<void>) {
  const from = context.events.length;
  await context.host.sendPrompt(sessionId, text);
  const answered = new Set<string>();
  return waitFor(() => {
    const events = context.events.slice(from);
    for (const event of events) {
      if (event.body.type === 'approval.requested' && onApproval && !answered.has(event.body.approvalId)) { answered.add(event.body.approvalId); void onApproval(event); }
    }
    const ended = events.find(event => event.sessionId === sessionId && event.agentId === 'primary' && (event.body.type === 'turn.completed' || event.body.type === 'turn.failed'));
    return ended && !context.runtime.isBusy() ? { events, ended } : undefined;
  }, 'the turn to end');
}

const isWorker = (system: string) => system.startsWith('You are a worker agent');

describe('lead agent names', () => {
  it('assigns each new session a unique full name and gender, kept across a restart', async () => {
    const first = await setup(() => ({ text: 'ok' }));
    const workspace = await nativeWorkspace(first.host, first.project);
    const created = await Promise.all(Array.from({ length: 6 }, () => first.host.createSession(workspace.id)));
    for (const session of created) {
      expect(session.agentName).toMatch(/^\S+ \S+$/);
      expect(['female', 'male']).toContain(session.agentGender);
    }
    expect(new Set(created.map(session => session.agentName!.toLowerCase())).size).toBe(6);
    await runtimes.pop()!.close();

    const second = await setup(() => ({ text: 'ok' }), first.root);
    const sessions = (await second.host.getState()).sessions;
    for (const session of created) expect(sessions.find(item => item.id === session.id)).toMatchObject({ agentName: session.agentName, agentGender: session.agentGender });
  });

  it('names sessions saved before v0.0.30 on first load (from the session id, oldest first) and saves the names', async () => {
    const first = await setup(() => ({ text: 'ok' }));
    const workspace = await nativeWorkspace(first.host, first.project);
    const a = await first.host.createSession(workspace.id);
    const b = await first.host.createSession(workspace.id);
    await runtimes.pop()!.close();
    const index = path.join(first.root, 'data', 'sessions', 'index.json');
    const records = JSON.parse(await readFile(index, 'utf8')) as Record<string, unknown>[];
    for (const record of records) { delete record.agentName; delete record.agentGender; }
    await writeFile(index, JSON.stringify(records));

    const second = await setup(() => ({ text: 'ok' }), first.root);
    const state = await second.host.getState();
    const [older, newer] = [a, b].map(session => state.sessions.find(item => item.id === session.id)!);
    const expectedOlder = generateFullName(a.id, new Set());
    expect(older).toMatchObject({ agentName: expectedOlder.name, agentGender: expectedOlder.gender });
    expect(newer).toMatchObject({ agentName: generateFullName(b.id, new Set([expectedOlder.name.toLowerCase()])).name });
    const saved = JSON.parse(await readFile(index, 'utf8')) as { id: string; agentName?: string }[];
    expect(saved.find(record => record.id === a.id)?.agentName).toBe(expectedOlder.name);
    await runtimes.pop()!.close();
    const third = await setup(() => ({ text: 'ok' }), first.root);
    expect((await third.host.getState()).sessions.find(item => item.id === a.id)?.agentName).toBe(expectedOlder.name);
  });
});

describe('teams from prompts and manage_team', () => {
  it('applies a team spec in the prompt before the turn, tells the lead, shows the members and keeps the team', async () => {
    const context = await setup(() => ({ text: 'Team ready.' }));
    const workspace = await nativeWorkspace(context.host, context.project);
    const session = await context.host.createSession(workspace.id);
    const prompt = await readFile(OTP_SPEC, 'utf8');
    const { events, ended } = await turn(context, session.id, prompt);
    expect(ended.body.type).toBe('turn.completed');

    const team = (await context.host.getSessionTeam(session.id))!;
    expect(team).toMatchObject({ enabled: true, goal: 'Eksekusi fitur OTP Login Endpoint', allowedModels: ['ag/claude-sonnet-4-6', 'ag/claude-opus-4-6-thinking', 'ag/gemini-4-argon-high'] });
    expect(team.members.map(member => [member.name, member.gender, member.access, member.models])).toEqual([
      ['Elena Mark', 'female', 'write', ['ag/claude-sonnet-4-6']],
      ['Kaelen Vael', 'male', 'write', ['ag/claude-opus-4-6-thinking', 'ag/gemini-4-argon-high']],
    ]);
    expect(team.members[1]!.forbidden).toEqual(['migrations', '.env', 'package.json']);
    expect(events.filter(event => event.body.type === 'subagent.spawned').map(event => event.body.type === 'subagent.spawned' && event.body.label)).toEqual(['Elena Mark', 'Kaelen Vael']);
    const lead = context.requests[0]!;
    expect(lead.system).toContain('The user\'s latest message defined this team');
    expect(lead.system).toContain('- Kaelen Vael (Backend Engineer) [can edit; never: migrations, .env, package.json]');
    expect(lead.tools).toEqual(expect.arrayContaining(['delegate_task', 'manage_team']));
    expect((await context.host.getState()).sessions.find(item => item.id === session.id)?.team).toEqual({ enabled: true, size: 2 });

    // The same spec again updates the members by name (no duplicates); an invalid spec is refused before the turn.
    await turn(context, session.id, prompt.replace('Role: Backend Engineer', 'Role: API Engineer'));
    const again = (await context.host.getSessionTeam(session.id))!;
    expect(again.members.map(member => [member.id, member.role])).toEqual([[team.members[0]!.id, 'API Engineer'], [team.members[1]!.id, 'Backend Engineer']]);
    const tooMany = Array.from({ length: 21 }, (_, index) => `Subagent ${index + 1}:\n- Role: R${index}`).join('\n');
    await expect(context.host.sendPrompt(session.id, tooMany)).rejects.toThrow(/at most 20/);

    await runtimes.pop()!.close();
    const restarted = await setup(() => ({ text: 'ok' }), context.root);
    expect((await restarted.host.getSessionTeam(session.id))?.members.map(member => member.name)).toEqual(['Elena Mark', 'Kaelen Vael']);
  });

  it('lets the lead create members with manage_team, then delegate to them in the same turn', async () => {
    let lead = 0;
    const context = await setup((_body, system) => {
      if (isWorker(system)) return { text: 'Found the auth module.' };
      lead++;
      if (lead === 1) return { tool: { name: 'manage_team', args: { action: 'add', role: 'Researcher', task: 'Map the auth module', models: ['mock-fast'] } } };
      if (lead === 2) return { tool: { name: 'delegate_task', args: { task: 'Map the auth module', member: 'Researcher' } } };
      return { text: 'Done.' };
    });
    const workspace = await nativeWorkspace(context.host, context.project);
    const session = await context.host.createSession(workspace.id);
    const { events } = await turn(context, session.id, 'buat 1 subagent researcher untuk auth');
    const team = (await context.host.getSessionTeam(session.id))!;
    expect(team.enabled).toBe(true);
    const member = team.members[0]!;
    expect(member.name).toMatch(/^\S+ \S+$/);
    expect(member.name).not.toBe(session.agentName);
    expect(events.find(event => event.body.type === 'subagent.spawned')?.body).toEqual({ type: 'subagent.spawned', subagentId: member.id, role: 'Researcher', label: member.name });
    // No orchestration on the connection: delegate_task is offered from the step after the first member was added.
    expect(context.requests[0]!.tools).not.toContain('delegate_task');
    expect(context.requests[1]!.tools).toContain('delegate_task');
    // "Researcher" is not a member name: the lead gets a clear error listing the members.
    expect(events.find(event => event.body.type === 'tool.completed' && event.body.tool === 'delegate_task')?.body).toMatchObject({ ok: false, output: expect.stringContaining(member.name) });
    expect((await context.host.getState()).sessions.find(item => item.id === session.id)?.team).toEqual({ enabled: true, size: 1 });
  });
});

describe('write-capable members', () => {
  const TEAM: AgentTeam = {
    enabled: true, allowedModels: ['mock-fast'], rules: ['Run the tests before reporting.'],
    members: [{ id: 'm-elena', name: 'Elena Mark', gender: 'female', role: 'Backend Engineer', models: ['mock-fast'], access: 'write', scope: ['src'], forbidden: ['src/secret'], soul: 'Pragmatic.' }],
  };

  it('edits inside its scope after the user approves under the member id; forbidden and outside paths are refused without asking', async () => {
    let worker = 0, lead = 0;
    const context = await setup((_body, system) => {
      if (isWorker(system)) {
        worker++;
        if (worker === 1) return { tool: { name: 'write_file', args: { path: 'src/secret/key.ts', content: 'x' } } };
        if (worker === 2) return { tool: { name: 'write_file', args: { path: '../outside.ts', content: 'x' } } };
        if (worker === 3) return { tool: { name: 'write_file', args: { path: 'src/otp.ts', content: 'export const otp = 1;\n' } } };
        return { text: 'Wrote src/otp.ts.' };
      }
      return lead++ === 0 ? { tool: { name: 'delegate_task', args: { task: 'Create src/otp.ts', member: 'Elena Mark' } } } : { text: 'Merged.' };
    });
    const workspace = await nativeWorkspace(context.host, context.project);
    const session = await context.host.createSession(workspace.id, { team: TEAM });
    const approvals: ExtaliaEvent[] = [];
    const { events, ended } = await turn(context, session.id, 'Build OTP', async event => {
      approvals.push(event);
      await waitFor(() => (context.runtime.isBusy() ? true : undefined), 'run');
      await context.host.resolveApproval(session.id, (event.body as { approvalId: string }).approvalId, 'once');
    });
    expect(ended.body.type).toBe('turn.completed');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ agentId: 'm-elena', body: { action: 'Writing src/otp.ts' } });
    expect(await readFile(path.join(context.project, 'src', 'otp.ts'), 'utf8')).toBe('export const otp = 1;\n');
    const failures = events.filter(event => event.agentId === 'm-elena' && event.body.type === 'tool.completed' && !event.body.ok).map(event => (event.body as { output?: string }).output);
    expect(failures[0]).toMatch(/forbidden for Elena Mark/);
    expect(failures[1]).toMatch(/uses "\.\."/);
    expect(events.find(event => event.body.type === 'file.written')).toMatchObject({ agentId: 'm-elena', body: { path: 'src/otp.ts' } });
    const memberSystem = context.requests.find(request => isWorker(request.system))!;
    expect(memberSystem.system).toContain('Edit only inside your scope: src.');
    expect(memberSystem.system).toContain('- Run the tests before reporting.');
    expect(memberSystem.tools).toEqual(expect.arrayContaining(['write_file', 'edit_file', 'run_command']));
  });
});
