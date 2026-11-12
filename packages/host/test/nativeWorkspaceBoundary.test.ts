import { createAgentHost } from '../src/service.js';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTeam, Workspace, WorkspaceCrossAccess } from '@extalia/core';
import type { ExtaliaEvent } from '@extalia/protocol';
import { type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';
import { SessionStore } from '../src/sessions.js';
import { workspaceBoundaryKey, workspaceSessionBoundaryKey } from '../src/workspaceBoundary.js';

const temp = useTempDirs();
const runtimes: AgentHostRuntime[] = [];
afterEach(async () => { vi.restoreAllMocks(); while (runtimes.length) await runtimes.pop()!.close(); });
type Call = { name: string; args: Record<string, unknown> };
type Body = { model: string; messages: { role: string; content: string; tool_call_id?: string }[]; tools?: { function: { name: string } }[] };
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
  it('continues the same conversation after saving and editing its team and presentation settings', async () => {
    const ctx = await setup();
    const session = await ctx.host.createSession(ctx.alpha.id);
    const store = new SessionStore(path.join(ctx.root, 'data', 'sessions'));
    await ctx.host.sendPrompt(session.id, 'Original conversation marker'); await settled(ctx.runtime);
    const original = await store.get(session.id);
    let team: AgentTeam = { enabled: true, allowedModels: ['model', 'alternate-model'], goal: 'Initial goal',
      members: [{ id: 'member-one', name: 'Test Member', role: 'Reviewer', models: ['model'], soul: 'Be precise' }] };
    await ctx.host.saveWorkspaceTeam(ctx.alpha.id, team);
    expect(await ctx.host.getSessionTeam(session.id)).toBeUndefined();
    const edits = [
      () => ctx.host.saveSessionTeam(session.id, team),
      () => ctx.host.saveSessionTeam(session.id, team = { ...team, members: [...team.members, { id: 'member-two', name: 'Second Member', role: 'Researcher', models: ['model'] }] }),
      () => ctx.host.saveSessionTeam(session.id, team = { ...team, goal: 'Updated goal', members: [{ ...team.members[0]!, name: 'Renamed Member', soul: 'Check every assumption', models: ['alternate-model'] }] }),
      () => ctx.host.setSessionOptions(session.id, { model: 'alternate-model' }),
      () => ctx.host.renameSession(session.id, 'Renamed conversation'),
      () => ctx.save(ctx.alpha, { name: 'Renamed workspace' }),
    ];
    for (const [index, edit] of edits.entries()) {
      await edit();
      await ctx.host.sendPrompt(session.id, `Continue after edit ${index}`); await settled(ctx.runtime);
      expect(ctx.bodies.at(-1)!.messages.some(message => message.content === 'Original conversation marker')).toBe(true);
    }
    expect(ctx.bodies).toHaveLength(edits.length + 1);
    expect(ctx.bodies.at(-1)!.model).toBe('alternate-model');
    expect(ctx.bodies.at(-1)!.messages[0]!.content).toContain('Updated goal');
    expect(ctx.bodies.at(-1)!.messages[0]!.content).toContain('Renamed Member');
    expect((await ctx.host.getSessionTeam(session.id))?.members[0]).toMatchObject({ soul: 'Check every assumption', models: ['alternate-model'] });
    expect(ctx.events.filter(event => event.sessionId === session.id && event.body.type === 'turn.completed')).toHaveLength(edits.length + 1);
    expect(await store.get(session.id)).toMatchObject({ id: session.id, createdAt: original!.createdAt, workspaceBoundary: original!.workspaceBoundary });
    expect(await store.readMessages(session.id)).toHaveLength((edits.length + 1) * 2);
  });

  it.each([['read-only', 'isolated'], ['isolated', 'read-only']] as const)(
    'keeps history after inaccessible workspace creation, folder edits and deletion with source %s / destination %s', async (source, destination) => {
    const ctx = await setup(undefined, [source, destination]);
    const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.sendPrompt(session.id, 'Preserve this history'); await settled(ctx.runtime);
    const folder = path.join(ctx.root, 'gamma'); await mkdir(folder);
    const created = await ctx.host.saveWorkspace({ name: 'Gamma', projectLocation: folder, connectionId: ctx.connectionId,
      crossWorkspaceAccess: 'isolated', permissions: { fileWrite: 'ask', commands: 'ask' } });
    const gamma = created.workspaces.find(workspace => workspace.name === 'Gamma')!;
    await ctx.host.sendPrompt(session.id, 'After creation'); await settled(ctx.runtime);
    const moved = path.join(ctx.root, 'beta-moved'); await mkdir(moved);
    await ctx.save(ctx.beta, { projectLocation: moved });
    await ctx.host.sendPrompt(session.id, 'After unrelated folder edit'); await settled(ctx.runtime);
    await ctx.host.deleteWorkspace(gamma.id);
    await ctx.host.sendPrompt(session.id, 'After deletion'); await settled(ctx.runtime);
    expect(ctx.bodies).toHaveLength(4);
    expect(ctx.bodies.at(-1)!.messages.some(message => message.content === 'Preserve this history')).toBe(true);
  });

  it('canonicalizes registered folder aliases without invalidating conversation history', async () => {
    const ctx = await setup();
    const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.sendPrompt(session.id, 'Canonical history'); await settled(ctx.runtime);
    const alias = path.join(ctx.root, 'beta-alias'); await symlink(ctx.foreign, alias, 'dir');
    await ctx.save(ctx.beta, { projectLocation: alias });
    await ctx.host.sendPrompt(session.id, 'Continue through the alias'); await settled(ctx.runtime);
    expect(ctx.bodies).toHaveLength(2);
  });

  it.each(['own-root', 'own-additional-root', 'readable-root', 'readable-policy', 'denied-descendant', 'denied-ancestor'] as const)(
    'refuses history replay after an effective %s change before provider admission', async kind => {
      const ctx = await setup(undefined, ['read-only', kind.startsWith('denied') ? 'isolated' : 'read-only']);
      const session = await ctx.host.createSession(ctx.alpha.id);
      await ctx.host.sendPrompt(session.id, 'Earlier permitted context'); await settled(ctx.runtime);
      const store = new SessionStore(path.join(ctx.root, 'data', 'sessions'));
      const history = await store.readMessages(session.id);
      const folder = path.join(ctx.root, 'new-folder'); await mkdir(folder);
      if (kind === 'own-root') await ctx.save(ctx.alpha, { projectLocation: folder });
      if (kind === 'own-additional-root') await ctx.save(ctx.alpha, { additionalProjectLocations: [folder] });
      if (kind === 'readable-root') await ctx.save(ctx.beta, { projectLocation: folder });
      if (kind === 'readable-policy') await ctx.save(ctx.beta, { crossWorkspaceAccess: 'read-write' });
      if (kind === 'denied-descendant') {
        const nested = path.join(ctx.primary, 'private'); await mkdir(nested);
        await ctx.save(ctx.beta, { projectLocation: nested });
      }
      if (kind === 'denied-ancestor') await ctx.save(ctx.beta, { projectLocation: ctx.root });
      await expect(ctx.host.sendPrompt(session.id, 'Never replay older grants')).rejects.toThrow(/new Native session/);
      expect(ctx.bodies).toHaveLength(1);
      expect(await store.readMessages(session.id)).toEqual(history);
    });

  it('migrates a legacy global history fingerprint only when its current complete grants match', async () => {
    const ctx = await setup();
    const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.sendPrompt(session.id, 'Legacy conversation'); await settled(ctx.runtime);
    const store = new SessionStore(path.join(ctx.root, 'data', 'sessions'));
    const workspaces = (await ctx.host.getState()).workspaces;
    await store.update(session.id, { workspaceBoundary: workspaceBoundaryKey(workspaces) });
    await ctx.host.sendPrompt(session.id, 'Migrate matching grants'); await settled(ctx.runtime);
    expect((await store.get(session.id))?.workspaceBoundary).toBe(workspaceSessionBoundaryKey(ctx.alpha.id, workspaces));
    expect(ctx.bodies.at(-1)!.messages.some(message => message.content === 'Legacy conversation')).toBe(true);
  });

  it('refuses mismatching legacy history even when only a disjoint isolated workspace changed', async () => {
    const ctx = await setup(undefined, ['read-only', 'isolated']);
    const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.sendPrompt(session.id, 'Legacy conversation'); await settled(ctx.runtime);
    const store = new SessionStore(path.join(ctx.root, 'data', 'sessions'));
    const legacy = workspaceBoundaryKey((await ctx.host.getState()).workspaces);
    await store.update(session.id, { workspaceBoundary: legacy });
    const folder = path.join(ctx.root, 'beta-moved'); await mkdir(folder);
    await ctx.save(ctx.beta, { projectLocation: folder });
    await expect(ctx.host.sendPrompt(session.id, 'Cannot prove historical grants')).rejects.toThrow(/new Native session/);
    expect(ctx.bodies).toHaveLength(1);
    expect((await store.get(session.id))?.workspaceBoundary).toBe(legacy);
  });

  it('adopts current grants for an empty legacy session without replaying history', async () => {
    const ctx = await setup();
    const session = await ctx.host.createSession(ctx.alpha.id);
    const store = new SessionStore(path.join(ctx.root, 'data', 'sessions'));
    await store.update(session.id, { workspaceBoundary: 'old-global-fingerprint' });
    await ctx.host.sendPrompt(session.id, 'First conversation'); await settled(ctx.runtime);
    expect((await store.get(session.id))?.workspaceBoundary).toBe(workspaceSessionBoundaryKey(ctx.alpha.id, (await ctx.host.getState()).workspaces));
    expect(ctx.bodies).toHaveLength(1);
  });

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
