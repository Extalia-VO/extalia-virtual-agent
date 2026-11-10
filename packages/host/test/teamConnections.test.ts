import { createAgentHost } from '../src/service.js';
import type { AgentTeam } from '@extalia/core';
import type { ConnectionInput } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import type { ManageTeamOptions } from '@extalia/runtime';
import type * as Runtime from '@extalia/runtime';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AgentHostRuntime } from '../src/service.js';
import { mockModelDiscovery } from './modelDiscoveryFixture.js';
import { useTempDirs } from './helpers.js';
import * as secretModule from '../src/secrets.js';

const intercepted = vi.hoisted(() => ({ saveTeam: undefined as ManageTeamOptions['saveTeam'] | undefined }));
vi.mock('@extalia/runtime', async importOriginal => {
  const original = await importOriginal<typeof Runtime>();
  return { ...original, createManageTeamTool: (options: ManageTeamOptions) => {
    intercepted.saveTeam = options.saveTeam;
    return original.createManageTeamTool(options);
  } };
});

const tempDir = useTempDirs();
const runtimes: AgentHostRuntime[] = [];
afterEach(async () => { while (runtimes.length) await runtimes.pop()!.close(); intercepted.saveTeam = undefined; vi.restoreAllMocks(); });

type Call = { name: string; args: Record<string, unknown> };
type Body = { model: string; messages: { role: string; content: string }[]; tools?: { function: { name: string } }[] };
type Request = { url: string; headers: Headers; body: Body };
function reply(text: string, calls: Call[] = []): Response {
  const delta = calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: `call-${index}`, function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : { content: text };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(condition: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Expected host state did not settle.');
}
const connection = (name: string, endpoint: string): ConnectionInput => ({
  name, preset: 'custom', api: 'openai-chat', baseUrl: endpoint, model: 'lead-model', credential: { kind: 'stored' },
  features: { memory: 'off', skills: 'off' }, orchestration: { enabled: false, maxDelegations: 0, tiers: {} },
});
async function setup(script: (request: Request, signal?: AbortSignal | null) => Response | Promise<Response> = () => reply('Done')) {
  const root = await tempDir(); const project = path.join(root, 'project'); await mkdir(project);
  const requests: Request[] = [];
  const runtime = await createAgentHost({ kind: 'bridge', version: '0.0.0-test', dataDirectory: path.join(root, 'data'),
    homeDirectory: path.join(root, 'home'), importHome: path.join(root, 'home'), env: { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH, HERMES_MANAGED_DIR: path.join(root, 'no-managed-scope') },
    fetch: async (url, init) => {
      if (/\/models$/.test(url)) return Response.json({ data: [{ id: 'worker-shared' }, { id: 'worker-backup' }, { id: 'bad model' }, { id: 'worker-shared' }] });
      const request = { url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Body };
      requests.push(request); return script(request, init?.signal);
    },
    modelDiscovery: mockModelDiscovery(async (url, init) => {
      if (/\/models$/.test(url)) return Response.json({ data: [{ id: 'worker-shared' }, { id: 'worker-backup' }, { id: 'bad model' }, { id: 'worker-shared' }] });
      return script({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Body }, init?.signal);
    }),
  });
  runtimes.push(runtime);
  const events: ExtaliaEvent[] = []; runtime.host.subscribe(event => { events.push(event); });
  const aInput = connection('First connection', 'http://first.example/v1');
  const bInput = connection('Second connection', 'http://second.example/v1');
  let state = await runtime.host.saveConnection(aInput, 'synthetic-first-token'); const a = state.connections[0]!.id;
  state = await runtime.host.saveConnection(bInput, 'synthetic-second-token'); const b = state.connections[1]!.id;
  state = await runtime.host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: a, permissions: { fileWrite: 'ask', commands: 'ask' } }); const workspace = state.workspaces[0]!;
  const team: AgentTeam = { enabled: true, allowedModels: [], connections: [
    { connectionId: a, allowedModels: ['worker-shared'] }, { connectionId: b, allowedModels: ['worker-shared', 'worker-backup'] },
  ], members: [
    { id: 'first-worker', name: 'First Worker', role: 'Reader', connectionId: a, models: ['worker-shared'] },
    { id: 'second-worker', name: 'Second Worker', role: 'Reviewer', connectionId: b, models: [] },
  ] };
  return { root, project, host: runtime.host, runtime, requests, events, a, b, aInput, bInput, workspace, team };
}
const delegateBoth = [{ name: 'delegate_task', args: { member: 'first-worker', task: 'Read note.txt and report its text.' } },
  { name: 'delegate_task', args: { member: 'second-worker', task: 'Read note.txt and review its text.' } }];

describe('Native team saved connection grants', () => {
  it('runs two connections concurrently, keeps credentials and fallback local, runs worker tools and forwards findings', async () => {
    const bothEntered = deferred(); let entered = 0;
    const ctx = await setup(async ({ url, body }) => {
      const worker = body.messages[0]!.content.startsWith('You are a worker agent');
      if (!worker) return body.messages.some(message => message.role === 'tool') ? reply('Combined the two reports.') : reply('', delegateBoth);
      if (body.model === 'worker-shared' && url.includes('second.example')) return Response.json({ error: { message: 'Quota exceeded', code: 'insufficient_quota' } }, { status: 402 });
      if (body.messages.some(message => message.role === 'tool')) return reply(`Report from ${url}: note verified.`);
      if (++entered === 2) bothEntered.resolve(); await bothEntered.promise;
      return reply('', [{ name: 'read_file', args: { path: 'note.txt' } }]);
    });
    await writeFile(path.join(ctx.project, 'note.txt'), 'Shared workspace evidence');
    const session = await ctx.host.createSession(ctx.workspace.id, { team: ctx.team });
    await ctx.host.sendPrompt(session.id, 'Have both members examine the note.');
    await until(() => !ctx.runtime.isBusy());
    expect(entered).toBe(2);
    expect(ctx.events.some(event => event.agentId === 'primary' && event.body.type === 'turn.completed')).toBe(true);
    const workers = ctx.requests.filter(request => request.body.messages[0]!.content.startsWith('You are a worker agent'));
    expect(workers.some(request => request.url.includes('second.example') && request.body.model === 'worker-backup')).toBe(true);
    for (const request of ctx.requests) {
      expect(request.headers.get('authorization')).toBe(request.url.includes('first.example') ? 'Bearer synthetic-first-token' : 'Bearer synthetic-second-token');
      expect(request.body.messages[0]!.content).not.toContain('synthetic-');
    }
    for (const id of ['first-worker', 'second-worker']) expect(ctx.events.some(event => event.agentId === id && event.body.type === 'tool.completed' && event.body.tool === 'read_file' && event.body.ok)).toBe(true);
    const finalLead = ctx.requests.filter(request => !request.body.messages[0]!.content.startsWith('You are a worker agent')).at(-1)!;
    expect(JSON.stringify(finalLead.body.messages)).toContain('Report from http://first.example');
    expect(JSON.stringify(finalLead.body.messages)).toContain('Report from http://second.example');
    expect(JSON.stringify(ctx.events)).not.toContain('synthetic-');
  });

  it('lists the explicitly selected saved catalog without granting it or running inference; respects effective session runtime', async () => {
    const ctx = await setup(); const session = await ctx.host.createSession(ctx.workspace.id);
    const choices = await ctx.host.teamModelChoices(ctx.workspace.id, ctx.b, session.id);
    expect(choices.models).toEqual(['worker-backup', 'worker-shared']); expect(choices.defaultModel).toBe('lead-model');
    expect(JSON.stringify(choices)).not.toMatch(/synthetic-|baseUrl|credential/); expect(ctx.requests).toHaveLength(0);
    expect(await ctx.host.getSessionTeam(session.id)).toBeUndefined();
    const foreign = await ctx.host.saveWorkspace({ name: 'Other', projectLocation: ctx.project, runtimeId: 'hermes', permissions: { fileWrite: 'ask', commands: 'ask' } });
    const other = foreign.workspaces.at(-1)!;
    await expect(ctx.host.teamModelChoices(other.id, ctx.b, session.id)).rejects.toThrow(/another workspace/);
    await expect(ctx.host.teamModelChoices(other.id, ctx.b)).rejects.toThrow(/Native/);
    await ctx.host.saveWorkspace({ id: ctx.workspace.id, name: 'Changed default', projectLocation: ctx.project, runtimeId: 'hermes', permissions: { fileWrite: 'ask', commands: 'ask' } });
    expect((await ctx.host.teamModelChoices(ctx.workspace.id, ctx.b, session.id)).runtime).toBe('extalia-native');
  });

  it('rejects invalid grants on save/create and missing saved references before any inference', async () => {
    const ctx = await setup();
    const missing = { ...ctx.team, connections: [{ connectionId: 'missing-connection', allowedModels: ['worker-shared'] }], members: [] };
    await expect(ctx.host.saveWorkspaceTeam(ctx.workspace.id, missing)).rejects.toThrow(/no longer exists/);
    await expect(ctx.host.createSession(ctx.workspace.id, { team: missing })).rejects.toThrow(/no longer exists/);
    await expect(ctx.host.createSession(ctx.workspace.id, { team: { ...ctx.team, connections: [] } })).rejects.toThrow(/connection|approved/);
    const session = await ctx.host.createSession(ctx.workspace.id, { team: ctx.team });
    await ctx.host.deleteConnection(ctx.b);
    await expect(ctx.host.sendPrompt(session.id, 'Check')).rejects.toThrow(/no longer exists/);
    expect(ctx.requests).toHaveLength(0); expect(ctx.runtime.isBusy()).toBe(false);
    const state = await ctx.host.saveWorkspace({ name: 'Hermes', projectLocation: ctx.project, runtimeId: 'hermes', permissions: { fileWrite: 'ask', commands: 'ask' } });
    await expect(ctx.host.createSession(state.workspaces.at(-1)!.id, { team: ctx.team })).rejects.toThrow(/Hermes/);
  });

  it('holds all connection guards through delegated cancellation settlement and applies saved edits only on the next turn', async () => {
    const entered = deferred(); const release = deferred();
    const ctx = await setup(async ({ body }, signal) => {
      if (!body.messages[0]!.content.startsWith('You are a worker agent')) return body.messages.some(message => message.role === 'tool') ? reply('Combined') : reply('', [delegateBoth[1]!]);
      entered.resolve(); await release.promise;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return reply('Worker finished');
    });
    const session = await ctx.host.createSession(ctx.workspace.id, { team: ctx.team });
    await ctx.host.sendPrompt(session.id, 'Review'); await entered.promise;
    const next = { ...ctx.team, connections: [], members: [] };
    await ctx.host.saveSessionTeam(session.id, next);
    await expect(ctx.host.saveConnection({ ...ctx.bInput, id: ctx.b }, 'synthetic-new-token')).rejects.toThrow(/still working/);
    await expect(ctx.host.deleteConnection(ctx.b)).rejects.toThrow(/still working/);
    await expect(intercepted.saveTeam!({ ...ctx.team, connections: [...ctx.team.connections!, { connectionId: 'unapproved', allowedModels: ['worker-shared'] }] })).rejects.toThrow(/Only the user/);
    await expect(intercepted.saveTeam!({ ...ctx.team, connections: ctx.team.connections!.map(grant => ({ ...grant, allowedModels: [...grant.allowedModels, 'unapproved-model'] })) })).rejects.toThrow(/Only the user/);
    await expect(intercepted.saveTeam!({ ...ctx.team, allowedModels: ['unapproved-lead-model'] })).rejects.toThrow(/Only the user/);
    await ctx.host.cancel(session.id);
    expect(ctx.runtime.isBusy()).toBe(true);
    await expect(ctx.host.deleteConnection(ctx.b)).rejects.toThrow(/still working/);
    release.resolve(); await until(() => !ctx.runtime.isBusy());
    await ctx.host.deleteConnection(ctx.b);
    expect((await ctx.host.getSessionTeam(session.id))?.members).toHaveLength(0);
  });

  it.each(['unusable', 'failed'])('keeps remote models out of heuristic lead choices after an %s planning reply', async mode => {
    const ctx = await setup(() => mode === 'unusable' ? reply('No JSON plan') : Response.json({ error: { message: 'Unavailable', type: 'invalid_request_error' } }, { status: 401 }));
    const remote = { ...ctx.team.members[1]!, models: ['remote-only'] };
    const plan = await ctx.host.planTeam(ctx.workspace.id, { goal: 'Review', count: 2, allowedModels: [],
      connections: [{ connectionId: ctx.b, allowedModels: ['remote-only'] }], members: [remote] });
    expect(plan.source).toBe('heuristic');
    expect(plan.members[0]).toMatchObject({ connectionId: ctx.b, models: ['remote-only'] });
    expect(plan.allowedModels).not.toContain('remote-only');
    expect(plan.allowedModels?.length).toBeGreaterThan(0);
    expect(plan.members[1]?.connectionId).toBeUndefined();
  });

  it('keeps disabled connection grants inactive without reading their credentials, including after deletion', async () => {
    const ctx = await setup();
    const session = await ctx.host.createSession(ctx.workspace.id, { team: { ...ctx.team, enabled: false } });
    const secrets = vi.spyOn(secretModule, 'resolveCredential');
    await ctx.host.sendPrompt(session.id, 'Hello'); await until(() => !ctx.runtime.isBusy());
    expect(secrets).toHaveBeenCalledTimes(1);
    expect(secrets.mock.calls[0]?.[0]).toMatchObject({ kind: 'stored', ref: `connection-${ctx.a}` });
    expect(ctx.requests.every(request => request.url.includes('first.example'))).toBe(true);
    await ctx.host.deleteConnection(ctx.b);
    secrets.mockClear();
    await ctx.host.sendPrompt(session.id, 'Hello again'); await until(() => !ctx.runtime.isBusy());
    expect(secrets).toHaveBeenCalledTimes(1);
    expect(ctx.requests.every(request => request.url.includes('first.example'))).toBe(true);
    expect(ctx.events.filter(event => event.body.type === 'turn.completed')).toHaveLength(2);
    expect(intercepted.saveTeam).toBeUndefined();
    expect(ctx.requests.every(request => !request.body.tools?.some(tool => ['manage_team', 'delegate_task'].includes(tool.function.name)))).toBe(true);
  });

  it('keeps team grants separate from mission candidates and mission connection approval', async () => {
    const ctx = await setup(() => reply('Unusable mission plan'));
    const session = await ctx.host.createSession(ctx.workspace.id, { team: ctx.team });
    await ctx.host.planNativeMission(session.id, { goal: 'Review the project', maxTasks: 2 });
    const request = ctx.requests.at(-1)!;
    expect(request.url).toContain('first.example');
    expect(JSON.stringify(request.body)).not.toContain('worker-shared');
    expect(JSON.stringify(request.body)).not.toContain('worker-backup');
    await expect(ctx.host.planNativeMission(session.id, { goal: 'Review', connectionIds: [ctx.b] })).rejects.toThrow(/allowed|workspace/);
  });

  it('preserves existing connection grants when a prompt adds a lead-connection member', async () => {
    const ctx = await setup(); const session = await ctx.host.createSession(ctx.workspace.id, { team: ctx.team });
    await ctx.host.sendPrompt(session.id, 'Build it:\nSubagent A:\n- Name: New Worker\n- Role: Tester\n- Tugas: Review the tests');
    await until(() => !ctx.runtime.isBusy());
    const saved = (await ctx.host.getSessionTeam(session.id))!;
    expect(saved.connections).toEqual(ctx.team.connections);
    expect(saved.members.slice(0, 2)).toMatchObject(ctx.team.members);
    expect(saved.members[2]?.connectionId).toBeUndefined();
    expect(saved.members).toHaveLength(3);
  });

  it('offers memory only to an external member whose selected connection enables it', async () => {
    const ctx = await setup(({ body }) => body.messages[0]!.content.startsWith('You are a worker agent') ? reply('Done') : body.messages.some(message => message.role === 'tool') ? reply('Done') : reply('', [delegateBoth[1]!]));
    await ctx.host.saveConnection({ ...ctx.bInput, id: ctx.b, features: { memory: 'extalia', skills: 'off' } });
    const session = await ctx.host.createSession(ctx.workspace.id, { team: ctx.team });
    await ctx.host.sendPrompt(session.id, 'Review'); await until(() => !ctx.runtime.isBusy());
    const lead = ctx.requests.find(request => !request.body.messages[0]!.content.startsWith('You are a worker agent'))!;
    const worker = ctx.requests.find(request => request.body.messages[0]!.content.startsWith('You are a worker agent'))!;
    expect(lead.body.tools?.some(tool => tool.function.name === 'memory_read')).toBe(false);
    expect(worker.body.tools?.some(tool => tool.function.name === 'memory_read')).toBe(true);
    expect(worker.body.tools?.some(tool => tool.function.name === 'memory_write')).toBe(false);
  });

  it('refuses unnamed workers instead of bypassing the configured team', async () => {
    const ctx = await setup(({ body }) => body.messages[0]!.content.startsWith('You are a worker agent') ? reply('Done') : body.messages.some(message => message.role === 'tool') ? reply('Done') : reply('', [{ name: 'delegate_task', args: { tier: 'standard', task: 'Review the project.' } }]));
    await ctx.host.saveConnection({ ...ctx.bInput, id: ctx.b, features: { memory: 'extalia', skills: 'extalia' } });
    const session = await ctx.host.createSession(ctx.workspace.id, { team: ctx.team });
    await ctx.host.sendPrompt(session.id, 'Review'); await until(() => !ctx.runtime.isBusy());
    expect(ctx.requests.some(request => request.body.messages[0]!.content.startsWith('You are a worker agent'))).toBe(false);
    expect(ctx.requests.at(-1)!.body.messages.filter(message => message.role === 'tool').map(message => message.content).join(' ')).toContain('Missing "member"');
    expect(ctx.events.some(event => event.body.type === 'subagent.spawned')).toBe(false);
  });

  it.each([true, false])('keeps an empty explicit roster solo until the user configures members (enabled=%s)', async enabled => {
    let leadCalls = 0;
    const ctx = await setup(({ body }) => {
      if (body.messages[0]!.content.startsWith('You are a worker agent')) return reply('Approved alternate model completed the work.');
      switch (leadCalls++) {
        case 0: return reply('', [{ name: 'manage_team', args: { action: 'add', name: 'New Lead Worker', role: 'Reviewer', models: ['approved-alt'] } }]);
        case 1: return reply('', [{ name: 'delegate_task', args: { member: 'New Lead Worker', task: 'Review the project.' } }]);
        default: return reply('Combined the approved result.');
      }
    });
    const empty: AgentTeam = { enabled, connections: [], allowedModels: ['approved-alt'], members: [] };
    const session = await ctx.host.createSession(ctx.workspace.id, { team: empty });
    await ctx.host.sendPrompt(session.id, 'Create a reviewer and have them review the project.');
    await until(() => !ctx.runtime.isBusy());
    const workers = ctx.requests.filter(request => request.body.messages[0]!.content.startsWith('You are a worker agent'));
    expect(workers).toHaveLength(0);
    expect(intercepted.saveTeam).toBeUndefined();
    expect(await ctx.host.getSessionTeam(session.id)).toMatchObject({ ...empty, members: [] });
    expect(ctx.events.some(event => event.body.type === 'tool.completed' && event.body.tool === 'delegate_task' && event.body.ok)).toBe(false);
  });

  it('uses the selected connection feature switches and input ceiling for the worker', async () => {
    const ctx = await setup(({ body }) => body.messages[0]!.content.startsWith('You are a worker agent') ? reply('Worker completed') : body.messages.some(message => message.role === 'tool') ? reply('Done') : reply('', [{ ...delegateBoth[1]!, args: { ...delegateBoth[1]!.args, task: 'Review these details. '.repeat(500) } }]));
    await ctx.host.saveConnection({ ...ctx.aInput, id: ctx.a, features: { memory: 'extalia', skills: 'extalia' } });
    const session = await ctx.host.createSession(ctx.workspace.id, { team: ctx.team });
    await ctx.host.sendPrompt(session.id, 'Review'); await until(() => !ctx.runtime.isBusy());
    const lead = ctx.requests.find(request => !request.body.messages[0]!.content.startsWith('You are a worker agent'))!;
    const worker = ctx.requests.find(request => request.body.messages[0]!.content.startsWith('You are a worker agent'))!;
    expect(lead.body.tools?.some(tool => tool.function.name === 'memory_read')).toBe(true);
    expect(worker.body.tools?.some(tool => tool.function.name.startsWith('memory_') || tool.function.name.startsWith('skill_'))).toBe(false);
    await ctx.host.saveConnection({ ...ctx.bInput, id: ctx.b, inputTokenLimit: 1024 });
    const bounded = await ctx.host.createSession(ctx.workspace.id, { team: ctx.team });
    ctx.requests.splice(0); await ctx.host.sendPrompt(bounded.id, 'Review with a bounded worker'); await until(() => !ctx.runtime.isBusy());
    expect(ctx.requests.every(request => request.url.includes('first.example'))).toBe(true);
    expect(ctx.events.some(event => event.body.type === 'tool.completed' && event.body.tool === 'delegate_task' && !event.body.ok)).toBe(true);
  });
  it('keeps solo tool admission when a connection enables tiers but the saved team is absent, empty or paused', async () => {
    const ctx = await setup();
    await ctx.host.saveConnection({ ...ctx.aInput, id: ctx.a, orchestration: { enabled: true, maxDelegations: 4, tiers: {} } });
    const variants: (AgentTeam | null)[] = [null, { enabled: true, allowedModels: [], members: [] }, { ...ctx.team, enabled: false }];
    for (const team of variants) {
      const session = await ctx.host.createSession(ctx.workspace.id, { team });
      const before = ctx.requests.length;
      await ctx.host.sendPrompt(session.id, 'Answer directly.'); await until(() => !ctx.runtime.isBusy());
      const calls = ctx.requests.slice(before);
      expect(calls).toHaveLength(1);
      const offered = calls[0]!.body.tools?.map(tool => tool.function.name) ?? [];
      expect(offered).not.toContain('delegate_task'); expect(offered).not.toContain('manage_team');
      expect(calls[0]!.body.messages[0]!.content).toMatch(/Work solo|Handle this request yourself/);
    }
  });

  it('does not let an admitted model roster edit overwrite a newer user pause', async () => {
    const entered = deferred(), release = deferred();
    const ctx = await setup(async ({ body }) => {
      if (body.messages.some(message => message.role === 'tool')) return reply('Kept the newer user settings.');
      entered.resolve(); await release.promise;
      return reply('', [{ name: 'manage_team', args: { action: 'add', name: 'Next Reviewer', role: 'Reviewer' } }]);
    });
    const session = await ctx.host.createSession(ctx.workspace.id, { team: ctx.team });
    await ctx.host.sendPrompt(session.id, 'Review this request.');
    await entered.promise;
    const paused = await ctx.host.saveSessionTeam(session.id, { ...(await ctx.host.getSessionTeam(session.id))!, enabled: false });
    release.resolve(); await until(() => !ctx.runtime.isBusy());
    expect(await ctx.host.getSessionTeam(session.id)).toEqual(paused);
    expect(ctx.events.some(event => event.body.type === 'tool.completed' && event.body.tool === 'manage_team' && !event.body.ok && event.body.output?.includes('newer user settings'))).toBe(true);
    expect(ctx.events.some(event => event.body.type === 'subagent.spawned')).toBe(false);
  });

});
