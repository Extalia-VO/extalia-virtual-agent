import { mkdir, readFile, rm, writeFile, symlink, link } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Workspace, WorkspaceCrossAccess } from '@extalia/core';
import type { ExtaliaEvent } from '@extalia/protocol';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { SessionStore } from '../src/sessions.js';
import { MemoryStore } from '../src/memory.js';
import { workspaceSessionBoundaryKey, workspaceMemoryDirectory } from '../src/workspaceBoundary.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const runtimes = new Set<AgentHostRuntime>();
afterEach(async () => { vi.restoreAllMocks(); await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear(); });
type Call = { name: string; args: Record<string, unknown> };
type Body = { model: string; messages: { role: string; content: string }[] };
function reply(calls: Call[] = []): Response {
  const delta = calls.length
    ? { tool_calls: calls.map((call, index) => ({ index, id: `call-${index}`, function: { name: call.name, arguments: JSON.stringify(call.args) } })) }
    : { content: 'Done' };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
async function settled(runtime: AgentHostRuntime) {
  await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 5_000, interval: 10 });
}
function currentToolResults(body: Body): string {
  return body.messages.slice(body.messages.map(message => message.role).lastIndexOf('user') + 1)
    .filter(message => message.role === 'tool').map(message => message.content).join('\n');
}
async function setup({ script = () => reply(), modes = ['read-only', 'read-only'], history = true }: {
  script?: (body: Body) => Response | Promise<Response>;
  modes?: [WorkspaceCrossAccess, WorkspaceCrossAccess];
  history?: boolean;
} = {}) {
  const root = await temp('extalia-session-move-');
  const folders = [path.join(root, 'alpha'), path.join(root, 'extra'), path.join(root, 'beta')];
  await Promise.all(folders.map(folder => mkdir(folder)));
  const bodies: Body[] = [], requests: string[] = [], events: ExtaliaEvent[] = [];
  const open = async () => {
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: path.join(root, 'data'),
      homeDirectory: path.join(root, 'home'), importHome: path.join(root, 'home'),
      env: { EXTALIA_SECRET_STORE: 'memory', HERMES_MANAGED_DIR: path.join(root, 'managed-missing') },
      fetch: async (url, init) => {
        requests.push(String(url));
        if (/\/models$/.test(url)) return Response.json({ data: [{ id: 'model' }, { id: 'alternate-model' }] });
        const body = JSON.parse(String(init?.body)) as Body;
        bodies.push(body); return script(body);
      } });
    runtimes.add(runtime); runtime.host.subscribe(event => { events.push(event); });
    return runtime;
  };
  let runtime = await open();
  let state = await runtime.host.saveConnection({ name: 'Original connection', preset: 'custom', api: 'openai-chat',
    baseUrl: 'http://mock.example/v1', model: 'model', credential: { kind: 'none' },
    features: { memory: 'off', skills: 'off', history } });
  const connectionId = state.connections[0]!.id;
  state = await runtime.host.saveWorkspace({ name: 'Alpha', projectLocation: folders[0]!, additionalProjectLocations: [folders[1]!],
    connectionId, crossWorkspaceAccess: modes[0], permissions: { fileWrite: 'allow', commands: 'allow' } });
  const alpha = state.workspaces.find(workspace => workspace.name === 'Alpha')!;
  state = await runtime.host.saveWorkspace({ name: 'Beta', projectLocation: folders[2]!, connectionId,
    crossWorkspaceAccess: modes[1], permissions: { fileWrite: 'allow', commands: 'allow' } });
  const beta = state.workspaces.find(workspace => workspace.name === 'Beta')!;
  const save = (workspace: Workspace, patch: Partial<Workspace> = {}) => runtime.host.saveWorkspace({ id: workspace.id, name: workspace.name,
    projectLocation: workspace.projectLocation!, additionalProjectLocations: workspace.additionalProjectLocations, connectionId,
    permissions: workspace.permissions ?? { fileWrite: 'ask', commands: 'ask' }, crossWorkspaceAccess: workspace.crossWorkspaceAccess, ...patch });
  return { root, alpha, beta, connectionId, bodies, requests, events, save,
    store: new SessionStore(path.join(root, 'data', 'sessions')),
    get runtime() { return runtime; }, get host() { return runtime.host; },
    async restart(beforeOpen?: () => Promise<void>) {
      await runtime.close(); runtimes.delete(runtime); await beforeOpen?.(); runtime = await open();
    },
  };
}

describe('saved Native session project roots', () => {
  it('retains conversation identity and history while relative tools and instructions use the selected registered root after restart', async () => {
    const calls: Call[] = [{ name: 'read_file', args: { path: 'marker.txt' } }, { name: 'write_file', args: { path: 'written.txt', content: 'Folder write' } }];
    const ctx = await setup({ modes: ['isolated', 'isolated'], script: body => currentToolResults(body) ? reply() : reply(calls) });
    const secondary = ctx.alpha.additionalProjectLocations![0]!;
    await writeFile(path.join(ctx.alpha.projectLocation!, 'marker.txt'), 'Primary evidence');
    await writeFile(path.join(secondary, 'marker.txt'), 'Secondary evidence');
    await writeFile(path.join(secondary, 'AGENTS.md'), 'Project instruction: selected secondary context.');
    const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.sendPrompt(session.id, 'Keep this earlier context'); await settled(ctx.runtime);
    expect(currentToolResults(ctx.bodies.at(-1)!)).toContain('Primary evidence');
    const before = (await ctx.store.get(session.id))!, events = await ctx.host.sessionEvents(session.id), messages = await ctx.store.readMessages(session.id);
    const queue = await ctx.host.promptQueueStatus!(session.id);
    const state = await ctx.host.setSessionProjectRoot!(session.id, { workspaceId: ctx.alpha.id, projectLocation: secondary });
    expect(state.sessions.find(item => item.id === session.id)).toMatchObject({ id: session.id, workspaceId: ctx.alpha.id, connectionId: session.connectionId, projectLocation: secondary });
    expect(await ctx.store.get(session.id)).toEqual({ ...before, projectLocation: secondary, workspaceFileRoot: secondary,
      workspaceFileScopes: [{ throughEventId: events.at(-1)!.id, workspaceId: ctx.alpha.id, projectLocation: ctx.alpha.projectLocation }] });
    expect(await ctx.host.sessionEvents(session.id)).toEqual(events);
    expect(await ctx.store.readMessages(session.id)).toEqual(messages);
    expect(state.workspaces.find(item => item.id === ctx.alpha.id)).toEqual(ctx.alpha);
    await expect(ctx.host.changePromptQueue!(session.id, { revision: queue.revision, action: 'add', text: 'Stale folder draft' })).rejects.toThrow(/changed/);
    await ctx.restart();
    expect((await ctx.host.getState()).sessions.find(item => item.id === session.id)?.projectLocation).toBe(secondary);
    await ctx.host.sendPrompt(session.id, 'Read in the newly selected folder'); await settled(ctx.runtime);
    expect(currentToolResults(ctx.bodies.at(-1)!)).toContain('Secondary evidence');
    expect(JSON.stringify(ctx.bodies.at(-1)!.messages)).toContain('Keep this earlier context');
    expect(JSON.stringify(ctx.bodies.at(-1)!.messages)).toContain('selected secondary context');
    expect(await readFile(path.join(secondary, 'written.txt'), 'utf8')).toBe('Folder write');
    expect(await readFile(path.join(ctx.alpha.projectLocation!, 'written.txt'), 'utf8')).toBe('Folder write');
    const history = await ctx.host.sessionEvents(session.id);
    expect(history.slice(0, events.length)).toEqual(events);
    expect(history.every(event => event.sessionId === session.id)).toBe(true);
    const review = await ctx.host.previewSessionMove!(session.id, ctx.beta.id);
    await ctx.host.moveSession!(session.id, { workspaceId: ctx.beta.id, reviewId: review.reviewId });
    expect((await ctx.store.get(session.id))!.projectLocation).toBeUndefined();
    expect((await ctx.store.get(session.id))!.workspaceFileScopes!.at(-1)).toEqual({ throughEventId: history.at(-1)!.id, workspaceId: ctx.alpha.id, projectLocation: secondary });
  });

  it.each(['cross-workspace', 'foreign-root', 'subdirectory', 'relative'] as const)('rejects %s choices without changing the session or grants', async kind => {
    const ctx = await setup(); const session = await ctx.host.createSession(ctx.alpha.id);
    const before = await ctx.store.get(session.id);
    await expect(ctx.host.setSessionProjectRoot!(session.id, {
      workspaceId: kind === 'cross-workspace' ? ctx.beta.id : ctx.alpha.id,
      projectLocation: kind === 'foreign-root' || kind === 'cross-workspace' ? ctx.beta.projectLocation! : kind === 'relative' ? '.' : path.join(ctx.alpha.projectLocation!, 'subdirectory'),
    })).rejects.toThrow(/another workspace|no longer registered/);
    expect(await ctx.store.get(session.id)).toEqual(before); expect(ctx.bodies).toEqual([]);
  });

  it('requires a saved Native session', async () => {
    const ctx = await setup({ history: false }); const session = await ctx.host.createSession(ctx.alpha.id);
    expect(session.transient).toBe(true);
    await expect(ctx.host.setSessionProjectRoot!(session.id, { workspaceId: ctx.alpha.id, projectLocation: ctx.alpha.additionalProjectLocations![0]! })).rejects.toThrow(/saved Extalia Native/);
  });

  it('uses Native session ownership after the workspace default changes to Hermes', async () => {
    const ctx = await setup(); const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.save(ctx.alpha, { runtimeId: 'hermes' });
    const secondary = ctx.alpha.additionalProjectLocations![0]!;
    const state = await ctx.host.setSessionProjectRoot!(session.id, { workspaceId: ctx.alpha.id, projectLocation: secondary });
    expect(state.sessions.find(item => item.id === session.id)?.projectLocation).toBe(secondary);
    await ctx.host.sendPrompt(session.id, 'Still Native'); await settled(ctx.runtime);
    expect(ctx.bodies.length).toBeGreaterThan(0);
  });

  it('rejects execution if a selected root is removed or unavailable without falling back to primary', async () => {
    const ctx = await setup(); const session = await ctx.host.createSession(ctx.alpha.id), secondary = ctx.alpha.additionalProjectLocations![0]!;
    await ctx.host.setSessionProjectRoot!(session.id, { workspaceId: ctx.alpha.id, projectLocation: secondary });
    await ctx.save(ctx.alpha, { additionalProjectLocations: [] });
    await expect(ctx.host.sendPrompt(session.id, 'Do not run elsewhere')).rejects.toThrow(/selected project folder is no longer registered/);
    await ctx.save(ctx.alpha);
    await rm(secondary, { recursive: true });
    await expect(ctx.host.sendPrompt(session.id, 'Do not run elsewhere either')).rejects.toThrow(/registered workspace folder is not available/);
    expect(await ctx.store.readMessages(session.id)).toEqual([]); expect(ctx.bodies).toEqual([]);
  });

  it('does not approve changed workspace history access when choosing an own folder', async () => {
    const ctx = await setup(); const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.sendPrompt(session.id, 'Existing history'); await settled(ctx.runtime);
    const before = (await ctx.store.get(session.id))!;
    await ctx.save(ctx.alpha, { crossWorkspaceAccess: 'isolated' });
    await ctx.host.setSessionProjectRoot!(session.id, { workspaceId: ctx.alpha.id, projectLocation: ctx.alpha.additionalProjectLocations![0]! });
    const record = (await ctx.store.get(session.id))!;
    expect(record.workspaceBoundary).toBe(before.workspaceBoundary);
    expect(record.reviewedContextBoundary).toBe(before.reviewedContextBoundary);
    expect(record.workspaceBoundary).not.toBe(workspaceSessionBoundaryKey(ctx.alpha.id, (await ctx.host.getState()).workspaces));
    await expect(ctx.host.sendPrompt(session.id, 'Do not transfer old access')).rejects.toThrow(/access boundaries changed/);
  });

  it('rejects an active turn', async () => {
    let release!: () => void, enter!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
    const ctx = await setup({ script: async () => { enter(); await held; return reply(); } });
    const session = await ctx.host.createSession(ctx.alpha.id);
    const prompt = ctx.host.sendPrompt(session.id, 'Wait for a provider'); await entered;
    try { await expect(ctx.host.setSessionProjectRoot!(session.id, { workspaceId: ctx.alpha.id, projectLocation: ctx.alpha.additionalProjectLocations![0]! })).rejects.toThrow(/finish|stop/); }
    finally { release(); }
    await prompt; await settled(ctx.runtime);
  });

  it.each(['pending', 'unknown'] as const)('rejects %s queued deliveries', async kind => {
    const ctx = await setup(); const session = await ctx.host.createSession(ctx.alpha.id);
    const queue = await ctx.host.promptQueueStatus!(session.id);
    await ctx.host.changePromptQueue!(session.id, { revision: queue.revision, action: 'add', text: 'Keep original folder' });
    if (kind === 'unknown') await ctx.restart(async () => {
      const file = path.join(ctx.root, 'data/state/prompt-queues.json');
      const saved = JSON.parse(await readFile(file, 'utf8')) as { queues: { items: { state: string }[] }[] };
      saved.queues[0]!.items[0]!.state = 'sending'; await writeFile(file, JSON.stringify(saved));
    });
    await expect(ctx.host.setSessionProjectRoot!(session.id, { workspaceId: ctx.alpha.id, projectLocation: ctx.alpha.additionalProjectLocations![0]! })).rejects.toThrow(/pending prompts|uncertain deliveries/);
    expect((await ctx.store.get(session.id))?.projectLocation).toBeUndefined(); expect(ctx.bodies).toEqual([]);
  });

  it('rejects concurrent workspace settings changes before committing a folder choice', async () => {
    const ctx = await setup(); const session = await ctx.host.createSession(ctx.alpha.id);
    let release!: () => void, enter!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
    const original = SessionStore.prototype.readEvents; let armed = true;
    vi.spyOn(SessionStore.prototype, 'readEvents').mockImplementation(async function(this: SessionStore, id: string) {
      const events = await original.call(this, id);
      if (id === session.id && armed) { armed = false; enter(); await held; } return events;
    });
    const change = expect(ctx.host.setSessionProjectRoot!(session.id, { workspaceId: ctx.alpha.id, projectLocation: ctx.alpha.additionalProjectLocations![0]! })).rejects.toThrow(/Workspace settings changed/);
    await entered;
    const settings = ctx.save(ctx.alpha, { name: 'New workspace name' }); release();
    await change; await settings;
    expect((await ctx.store.get(session.id))?.projectLocation).toBeUndefined();
  });

  it('rejects a folder choice if session settings changed during its admission', async () => {
    const ctx = await setup(); const session = await ctx.host.createSession(ctx.alpha.id);
    let release!: () => void, enter!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
    const original = SessionStore.prototype.readEvents; let armed = true;
    vi.spyOn(SessionStore.prototype, 'readEvents').mockImplementation(async function(this: SessionStore, id: string) {
      const events = await original.call(this, id);
      if (id === session.id && armed) { armed = false; enter(); await held; } return events;
    });
    const change = expect(ctx.host.setSessionProjectRoot!(session.id, { workspaceId: ctx.alpha.id, projectLocation: ctx.alpha.additionalProjectLocations![0]! })).rejects.toThrow(/Session settings changed/);
    await entered; await ctx.store.update(session.id, { title: 'Concurrent rename' }); release(); await change;
    expect((await ctx.store.get(session.id))?.title).toBe('Concurrent rename');
    expect((await ctx.store.get(session.id))?.projectLocation).toBeUndefined();
  });

  it('rejects a prompt whose asynchronous admission straddles a folder change', async () => {
    const ctx = await setup(); const session = await ctx.host.createSession(ctx.alpha.id);
    let release!: () => void, enter!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
    const original = SessionStore.prototype.get; let armed = true;
    vi.spyOn(SessionStore.prototype, 'get').mockImplementation(async function(this: SessionStore, id: string) {
      const record = await original.call(this, id);
      if (id === session.id && armed) { armed = false; enter(); await held; } return record;
    });
    const prompt = ctx.host.sendPrompt(session.id, 'Stale folder prompt'); await entered;
    try { await ctx.host.setSessionProjectRoot!(session.id, { workspaceId: ctx.alpha.id, projectLocation: ctx.alpha.additionalProjectLocations![0]! }); }
    finally { release(); }
    await expect(prompt).rejects.toThrow(/Workspace settings changed/);
    expect(await ctx.store.readMessages(session.id)).toEqual([]); expect(ctx.bodies).toEqual([]);
  });
  it('keeps protected host data closed when it is registered as a project folder', async () => {
    const ctx = await setup(); const session = await ctx.host.createSession(ctx.alpha.id);
    const protectedFolder = path.join(ctx.root, 'data', 'private-folder'); await mkdir(protectedFolder);
    const state = await ctx.save(ctx.alpha, { additionalProjectLocations: [protectedFolder] });
    const registered = state.workspaces.find(item => item.id === ctx.alpha.id)!.additionalProjectLocations![0]!;
    await expect(ctx.host.setSessionProjectRoot!(session.id, { workspaceId: ctx.alpha.id, projectLocation: registered })).rejects.toThrow(/protected host data/);
    expect((await ctx.store.get(session.id))?.projectLocation).toBeUndefined(); expect(ctx.bodies).toEqual([]);
  });

  it('roots a read-only mission worker in the selected folder and blocks folder changes during mission ownership', async () => {
    let release!: () => void, enter!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
    const results: string[] = [];
    const ctx = await setup({ script: async body => {
      const output = currentToolResults(body);
      if (output) { results.push(output); return Response.json({ model: 'model', choices: [{ message: { content: 'Worker complete' }, finish_reason: 'stop' }] }); }
      enter(); await held;
      return Response.json({ model: 'model', choices: [{ message: { tool_calls: [{ id: 'read-marker', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'marker.txt' }) } }] }, finish_reason: 'tool_calls' }] });
    } });
    const secondary = ctx.alpha.additionalProjectLocations![0]!;
    await writeFile(path.join(ctx.alpha.projectLocation!, 'marker.txt'), 'Wrong primary mission root');
    await writeFile(path.join(secondary, 'marker.txt'), 'Selected mission root evidence');
    const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.setSessionProjectRoot!(session.id, { workspaceId: ctx.alpha.id, projectLocation: secondary });
    const mission = await ctx.host.startNativeMission(session.id, { title: 'Project root inspection', tasks: [{ id: 'inspect', title: 'Inspect', instructions: 'Read marker.txt', connectionId: ctx.connectionId, model: 'model', dependsOn: [] }] });
    await entered;
    try { await expect(ctx.host.setSessionProjectRoot!(session.id, { workspaceId: ctx.alpha.id, projectLocation: ctx.alpha.projectLocation! })).rejects.toThrow(/finish|stop|active/); }
    finally { release(); }
    await vi.waitFor(async () => expect((await ctx.host.nativeMissionRun(session.id, mission.id)).state).toBe('completed'), { timeout: 5_000, interval: 10 });
    await settled(ctx.runtime);
    expect(results.join('\n')).toContain('Selected mission root evidence');
    expect(results.join('\n')).not.toContain('Wrong primary mission root');
  });

  it('retains unresolved Native planning ownership across restart', async () => {
    const ctx = await setup(); const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.restart(async () => {
      await writeFile(path.join(ctx.root, 'data/state/native-planning.json'), JSON.stringify({ schema: 'extalia.native-planning.v1', pending: [{
        invocationId: '00000000-0000-4000-8000-000000000010', supervisorId: '00000000-0000-4000-8000-000000000011',
        sessionId: session.id, workspaceId: ctx.alpha.id, connectionIds: [ctx.connectionId],
      }] }));
    });
    await expect(ctx.host.setSessionProjectRoot!(session.id, { workspaceId: ctx.alpha.id, projectLocation: ctx.alpha.additionalProjectLocations![0]! })).rejects.toThrow(/unresolved native planning/);
    expect((await ctx.store.get(session.id))?.projectLocation).toBeUndefined(); expect(ctx.bodies).toEqual([]);
  });

  it('gives a delegated team worker the same selected root as the lead', async () => {
    const workerOutputs: string[] = [];
    const ctx = await setup({ script: body => {
      if (body.messages[0]?.content.startsWith('You are a worker agent')) {
        const result = currentToolResults(body);
        if (result) { workerOutputs.push(result); return reply(); }
        return reply([{ name: 'read_file', args: { path: 'marker.txt' } }]);
      }
      return currentToolResults(body) ? reply() : reply([{ name: 'delegate_task', args: { task: 'Read marker.txt', member: 'Example Reader' } }]);
    } });
    const secondary = ctx.alpha.additionalProjectLocations![0]!;
    await writeFile(path.join(ctx.alpha.projectLocation!, 'marker.txt'), 'Wrong primary delegation root');
    await writeFile(path.join(secondary, 'marker.txt'), 'Selected delegation evidence');
    const session = await ctx.host.createSession(ctx.alpha.id, { team: { enabled: true, allowedModels: ['model'], members: [{ id: 'example-reader', name: 'Example Reader', role: 'Researcher', models: ['model'] }] } });
    await ctx.host.setSessionProjectRoot!(session.id, { workspaceId: ctx.alpha.id, projectLocation: secondary });
    await ctx.host.sendPrompt(session.id, 'Use the reader to inspect marker.txt'); await settled(ctx.runtime);
    expect(workerOutputs.join('\n')).toContain('Selected delegation evidence');
    expect(workerOutputs.join('\n')).not.toContain('Wrong primary delegation root');
    expect((await ctx.host.sessionEvents(session.id)).some(event => event.body.type === 'subagent.spawned')).toBe(true);
  });

  it('previews absolute secondary-root files while retaining relative primary paths and refusing foreign grants, symlinks, hardlinks and credentials', async () => {
    const ctx = await setup(); const secondary = ctx.alpha.additionalProjectLocations![0]!;
    await writeFile(path.join(ctx.alpha.projectLocation!, 'marker.txt'), 'Primary preview');
    const selectedFile = path.join(secondary, 'marker.txt'); await writeFile(selectedFile, 'Secondary preview');
    await writeFile(path.join(ctx.beta.projectLocation!, 'marker.txt'), 'Foreign preview');
    expect((await ctx.host.readFile(ctx.alpha.id, 'marker.txt')).content).toBe('Primary preview');
    expect((await ctx.host.readFile(ctx.alpha.id, selectedFile)).content).toBe('Secondary preview');
    await expect(ctx.host.readFile(ctx.alpha.id, path.join(ctx.beta.projectLocation!, 'marker.txt'))).rejects.toThrow(/this workspace/);
    await writeFile(path.join(secondary, '.env'), 'EXAMPLE_KEY=opaque');
    await expect(ctx.host.readFile(ctx.alpha.id, path.join(secondary, '.env'))).rejects.toThrow(/credential/);
    await symlink(path.join(ctx.beta.projectLocation!, 'marker.txt'), path.join(secondary, 'foreign-link.txt'));
    await expect(ctx.host.readFile(ctx.alpha.id, path.join(secondary, 'foreign-link.txt'))).rejects.toThrow(/outside.*symbolic link/);
    await link(selectedFile, path.join(secondary, 'hardlink.txt'));
    await expect(ctx.host.readFile(ctx.alpha.id, path.join(secondary, 'hardlink.txt'))).rejects.toThrow(/hard-linked/);
    await mkdir(path.join(secondary, '.git')); await writeFile(path.join(secondary, '.git', 'HEAD'), 'ref: refs/heads/main');
    await expect(ctx.host.readFile(ctx.alpha.id, path.join(secondary, '.git', 'HEAD'))).rejects.toThrow(/inside .git/);
    await ctx.save(ctx.alpha, { additionalProjectLocations: [] });
    await expect(ctx.host.readFile(ctx.alpha.id, selectedFile)).rejects.toThrow(/registered project folders/);
  });

  it('refuses protected host-data file previews through a registered additional root', async () => {
    const ctx = await setup(); const privateFolder = path.join(ctx.root, 'data', 'private-preview'); await mkdir(privateFolder);
    await writeFile(path.join(privateFolder, 'private.txt'), 'Private host content');
    const state = await ctx.save(ctx.alpha, { additionalProjectLocations: [privateFolder] });
    const registered = state.workspaces.find(item => item.id === ctx.alpha.id)!.additionalProjectLocations![0]!;
    await expect(ctx.host.readFile(ctx.alpha.id, path.join(registered, 'private.txt'))).rejects.toThrow(/protected host data/);
  });

  it('keeps isolated workspace memory in the same namespace when changing the working folder', async () => {
    const ctx = await setup({ modes: ['isolated', 'isolated'], script: body => currentToolResults(body) ? reply() : reply([{ name: 'memory_read', args: { name: 'durable-context' } }]) });
    await ctx.host.saveConnection({ id: ctx.connectionId, name: 'Original connection', preset: 'custom', api: 'openai-chat', baseUrl: 'http://mock.example/v1', model: 'model', credential: { kind: 'none' }, features: { memory: 'extalia', skills: 'off', history: true } });
    const memory = new MemoryStore(workspaceMemoryDirectory(path.join(ctx.root, 'data', 'workspaces'), ctx.alpha));
    await memory.write('durable-context', 'Preserved workspace memory evidence');
    const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.sendPrompt(session.id, 'Read the durable context'); await settled(ctx.runtime);
    expect(currentToolResults(ctx.bodies.at(-1)!)).toContain('Preserved workspace memory evidence');
    await ctx.host.setSessionProjectRoot!(session.id, { workspaceId: ctx.alpha.id, projectLocation: ctx.alpha.additionalProjectLocations![0]! });
    await ctx.host.sendPrompt(session.id, 'Read the same durable context in this folder'); await settled(ctx.runtime);
    expect(currentToolResults(ctx.bodies.at(-1)!)).toContain('Preserved workspace memory evidence');
  });

  it('preserves the selected folder during an explicit same-workspace history-boundary review', async () => {
    const ctx = await setup({ script: body => currentToolResults(body) ? reply() : reply([{ name: 'read_file', args: { path: 'marker.txt' } }]) });
    const secondary = ctx.alpha.additionalProjectLocations![0]!;
    await writeFile(path.join(ctx.alpha.projectLocation!, 'marker.txt'), 'Wrong primary after review');
    await writeFile(path.join(secondary, 'marker.txt'), 'Secondary preserved after review');
    const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.setSessionProjectRoot!(session.id, { workspaceId: ctx.alpha.id, projectLocation: secondary });
    await ctx.host.sendPrompt(session.id, 'Start selected conversation'); await settled(ctx.runtime);
    const messages = await ctx.store.readMessages(session.id);
    await ctx.save(ctx.alpha, { crossWorkspaceAccess: 'isolated' });
    const preview = await ctx.host.previewSessionMove!(session.id, ctx.alpha.id);
    await ctx.host.moveSession!(session.id, { workspaceId: ctx.alpha.id, reviewId: preview.reviewId });
    expect(await ctx.store.get(session.id)).toMatchObject({ workspaceId: ctx.alpha.id, projectLocation: secondary, workspaceFileRoot: secondary });
    expect(await ctx.store.readMessages(session.id)).toEqual(messages);
    await ctx.host.sendPrompt(session.id, 'Continue in the same selected folder'); await settled(ctx.runtime);
    expect(currentToolResults(ctx.bodies.at(-1)!)).toContain('Secondary preserved after review');
    expect(currentToolResults(ctx.bodies.at(-1)!)).not.toContain('Wrong primary after review');
  });

});
