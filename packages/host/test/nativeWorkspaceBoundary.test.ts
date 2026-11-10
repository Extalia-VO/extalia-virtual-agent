import { createAgentHost } from '../src/service.js';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Workspace, WorkspaceCrossAccess } from '@extalia/core';
import type { ExtaliaEvent } from '@extalia/protocol';
import { type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';
import { SessionStore } from '../src/sessions.js';

const temp = useTempDirs();
const runtimes: AgentHostRuntime[] = [];
afterEach(async () => { vi.restoreAllMocks(); while (runtimes.length) await runtimes.pop()!.close(); });
type Call = { name: string; args: Record<string, unknown> };
type Body = { messages: { role: string; content: string; tool_call_id?: string }[]; tools?: { function: { name: string } }[] };
function reply(calls: Call[] = []): Response {
  const delta = calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: `call-${index}`, function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : { content: 'Done' };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
async function settled(runtime: AgentHostRuntime) {
  for (let i = 0; i < 500 && runtime.isBusy(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(runtime.isBusy()).toBe(false);
}
async function setup(script: (body: Body) => Response | Promise<Response> = () => reply(), modes: [WorkspaceCrossAccess, WorkspaceCrossAccess] = ['read-only', 'read-only']) {
  const root = await temp();
  const primary = path.join(root, 'alpha'), extra = path.join(root, 'extra'), foreign = path.join(root, 'beta');
  await Promise.all([primary, extra, foreign].map(folder => mkdir(folder)));
  const bodies: Body[] = [], events: ExtaliaEvent[] = [];
  const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: path.join(root, 'data'),
    homeDirectory: path.join(root, 'home'), importHome: path.join(root, 'home'), env: { EXTALIA_SECRET_STORE: 'memory', HERMES_MANAGED_DIR: path.join(root, 'managed-missing') },
    fetch: async (url, init) => {
      if (/\/models$/.test(url)) return Response.json({ data: [{ id: 'model' }] });
      const body = JSON.parse(String(init?.body)) as Body; bodies.push(body); return script(body);
    } });
  runtimes.push(runtime); runtime.host.subscribe(event => { events.push(event); });
  let state = await runtime.host.saveConnection({ name: 'Test connection', preset: 'custom', api: 'openai-chat', baseUrl: 'http://mock.example/v1', model: 'model', credential: { kind: 'none' }, features: { memory: 'extalia', skills: 'off' } });
  const connectionId = state.connections[0]!.id;
  state = await runtime.host.saveWorkspace({ name: 'Alpha', projectLocation: primary, additionalProjectLocations: [extra], connectionId, crossWorkspaceAccess: modes[0], permissions: { fileWrite: 'allow', commands: 'allow' } });
  const alpha = state.workspaces.find(workspace => workspace.name === 'Alpha')!;
  state = await runtime.host.saveWorkspace({ name: 'Beta', projectLocation: foreign, connectionId, crossWorkspaceAccess: modes[1], permissions: { fileWrite: 'allow', commands: 'allow' } });
  const beta = state.workspaces.find(workspace => workspace.name === 'Beta')!;
  const save = (workspace: Workspace, patch: Partial<Workspace> = {}) => runtime.host.saveWorkspace({ id: workspace.id, name: workspace.name, projectLocation: workspace.projectLocation!, additionalProjectLocations: workspace.additionalProjectLocations,
    connectionId, permissions: workspace.permissions ?? { fileWrite: 'ask', commands: 'ask' }, crossWorkspaceAccess: workspace.crossWorkspaceAccess, ...patch });
  return { root, primary: alpha.projectLocation!, extra: alpha.additionalProjectLocations![0]!, foreign: beta.projectLocation!, runtime, host: runtime.host, bodies, events, alpha, beta, connectionId, save };
}

describe('Native host workspace boundary composition', () => {
  it('persists multiple folders and rejects canonical duplicates without changing the saved workspace', async () => {
    const ctx = await setup();
    expect(ctx.alpha.additionalProjectLocations).toEqual([await realpath(ctx.extra)]);
    const alias = path.join(ctx.root, 'extra-alias'); await symlink(ctx.extra, alias, 'dir');
    await expect(ctx.save(ctx.alpha, { additionalProjectLocations: [ctx.extra, alias] })).rejects.toThrow(/same folder/);
    expect((await ctx.host.getState()).workspaces.find(item => item.id === ctx.alpha.id)?.additionalProjectLocations).toEqual(ctx.alpha.additionalProjectLocations);
  });

  it('allows selected-folder writes and foreign reads by default, while refusing foreign writes and arbitrary commands', async () => {
    let calls: Call[] = [];
    const ctx = await setup(body => body.messages.some(message => message.role === 'tool') ? reply() : reply(calls));
    await writeFile(path.join(ctx.foreign, 'note.txt'), 'Foreign read evidence');
    calls = [
      { name: 'read_file', args: { path: path.join(ctx.foreign, 'note.txt') } },
      { name: 'write_file', args: { path: path.join(ctx.foreign, 'note.txt'), content: 'Forbidden overwrite' } },
      { name: 'write_file', args: { path: path.join(ctx.extra, 'created.txt'), content: 'Selected folder write' } },
      { name: 'run_command', args: { command: `node -e "process.exit(0)"` } },
    ];
    const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.sendPrompt(session.id, 'Inspect the authorized folders.'); await settled(ctx.runtime);
    expect(await readFile(path.join(ctx.foreign, 'note.txt'), 'utf8')).toBe('Foreign read evidence');
    expect(await readFile(path.join(ctx.extra, 'created.txt'), 'utf8')).toBe('Selected folder write');
    const results = ctx.bodies.at(-1)!.messages.filter(message => message.role === 'tool').map(message => message.content).join('\n');
    expect(results).toContain('Foreign read evidence'); expect(results).toContain('workspace access policy');
    expect(results).toContain('no verified workspace-isolated');
    expect(ctx.events.some(event => event.body.type === 'command.started')).toBe(false);
  });

  it.each([['isolated', 'read-write'], ['read-write', 'isolated']] as const)('denies foreign file reads with source %s / destination %s', async (source, destination) => {
    let calls: Call[] = [];
    const ctx = await setup(body => body.messages.some(message => message.role === 'tool') ? reply() : reply(calls), [source, destination]);
    await writeFile(path.join(ctx.foreign, 'note.txt'), 'Private foreign marker');
    calls = [{ name: 'read_file', args: { path: path.join(ctx.foreign, 'note.txt') } }, { name: 'workspace_folders', args: {} }];
    const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.sendPrompt(session.id, 'Read only permitted files.'); await settled(ctx.runtime);
    const results = ctx.bodies.at(-1)!.messages.filter(message => message.role === 'tool').map(message => message.content).join('\n');
    expect(results).not.toContain('Private foreign marker'); expect(results).not.toContain(ctx.beta.id);
    expect(results).toContain('workspace access policy');
  });

  it('permits a cross-workspace edit only when both workspaces allow it', async () => {
    let calls: Call[] = [];
    const ctx = await setup(body => body.messages.some(message => message.role === 'tool') ? reply() : reply(calls), ['read-write', 'read-write']);
    calls = [{ name: 'write_file', args: { path: path.join(ctx.foreign, 'result.txt'), content: 'Authorized cross edit' } }];
    const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.sendPrompt(session.id, 'Write the approved result.'); await settled(ctx.runtime);
    expect(await readFile(path.join(ctx.foreign, 'result.txt'), 'utf8')).toBe('Authorized cross edit');
  });

  it('never automatically imports another workspace instruction through a readable symlink', async () => {
    const ctx = await setup();
    await writeFile(path.join(ctx.foreign, 'AGENTS.md'), 'Private instruction marker');
    await symlink(path.join(ctx.foreign, 'AGENTS.md'), path.join(ctx.primary, 'AGENTS.md'));
    const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.sendPrompt(session.id, 'Summarize this workspace.'); await settled(ctx.runtime);
    expect(ctx.bodies[0]!.messages[0]!.content).not.toContain('Private instruction marker');
  });

  it('requires fresh history and separate memory after switching to isolation', async () => {
    const ctx = await setup();
    await ctx.host.nativeMemoryWrite!(ctx.alpha.id, { name: 'shared-note', content: 'Earlier shared context', expectedRevision: null });
    const old = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.sendPrompt(old.id, 'Earlier shared question'); await settled(ctx.runtime);
    await ctx.save(ctx.alpha, { crossWorkspaceAccess: 'isolated' });
    const requestCount = ctx.bodies.length;
    await expect(ctx.host.sendPrompt(old.id, 'Continue with old context')).rejects.toThrow(/new Native session/);
    expect(ctx.bodies).toHaveLength(requestCount);
    expect((await ctx.host.nativeMemoryList!(ctx.alpha.id)).notes).toEqual([]);
    const fresh = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.sendPrompt(fresh.id, 'Start fresh.'); await settled(ctx.runtime);
    const system = ctx.bodies.at(-1)!.messages[0]!.content;
    expect(system).not.toContain('Earlier shared context'); expect(system).not.toContain('Earlier shared question');
  });

  it('refuses a boundary update while a provider still owns a Native turn', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const ctx = await setup(async () => { await pending; return reply(); });
    const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.sendPrompt(session.id, 'Hold this turn.');
    try { await expect(ctx.save(ctx.beta, { crossWorkspaceAccess: 'isolated' })).rejects.toThrow(/Stop|working/); }
    finally { release(); }
    await settled(ctx.runtime);
    await ctx.save(ctx.beta, { crossWorkspaceAccess: 'isolated' });
  });
  it('reserves the asynchronous settings mutation before new Native and memory admission', async () => {
    const ctx = await setup();
    const session = await ctx.host.createSession(ctx.alpha.id);
    let release!: () => void, enter!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const original = SessionStore.prototype.list;
    let armed = true;
    vi.spyOn(SessionStore.prototype, 'list').mockImplementation(async function(this: SessionStore) {
      if (armed) { armed = false; enter(); await held; }
      return original.call(this);
    });
    const change = ctx.save(ctx.beta, { crossWorkspaceAccess: 'isolated' });
    await entered;
    try {
      await expect(ctx.host.sendPrompt(session.id, 'Do not enter old grants.')).rejects.toThrow(/settings are changing/);
      await expect(ctx.host.nativeMemoryList!(ctx.alpha.id)).rejects.toThrow(/settings are changing/);
      await expect(ctx.host.planNativeMission!(session.id, { goal: 'Plan' })).rejects.toThrow(/settings are changing/);
      expect(ctx.bodies).toEqual([]);
    } finally { release(); }
    await change;
    await ctx.host.sendPrompt(session.id, 'Use the new grants.'); await settled(ctx.runtime);
  });

  it('holds the context boundary while team planning is waiting for the provider', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ctx = await setup(async () => { await held; return reply(); });
    const planning = ctx.host.planTeam(ctx.alpha.id, { count: 1, goal: 'Plan this workspace', allowedModels: ['model'] });
    for (let i = 0; i < 200 && !ctx.bodies.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(ctx.bodies.length).toBeGreaterThan(0);
    try { await expect(ctx.save(ctx.beta, { crossWorkspaceAccess: 'isolated' })).rejects.toThrow(/Stop.*Native work/); }
    finally { release(); }
    await planning;
    await ctx.save(ctx.beta, { crossWorkspaceAccess: 'isolated' });
  });

  it('rejects write-mission checkout before copying an isolated nested workspace', async () => {
    const ctx = await setup();
    await mkdir(path.join(ctx.primary, '.git'));
    const nested = path.join(ctx.primary, 'private-project'); await mkdir(nested);
    await writeFile(path.join(nested, 'private.txt'), 'Never copied');
    await ctx.save(ctx.beta, { projectLocation: nested, crossWorkspaceAccess: 'isolated' });
    const session = await ctx.host.createSession(ctx.alpha.id);
    await expect(ctx.host.startNativeMission!(session.id, { title: 'Do not copy protected files', tasks: [{
      id: 'writer', title: 'Writer', instructions: 'Write only permitted files', connectionId: ctx.connectionId, model: 'model', dependsOn: [], access: 'write',
    }] })).rejects.toThrow(/cannot copy/);
    expect(ctx.bodies).toEqual([]);
    expect(await ctx.host.listWorktrees!()).toEqual([]);
    expect(await readFile(path.join(nested, 'private.txt'), 'utf8')).toBe('Never copied');
  });

});
