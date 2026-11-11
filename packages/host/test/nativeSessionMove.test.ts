import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTeam, Workspace, WorkspaceCrossAccess } from '@extalia/core';
import type { ExtaliaEvent } from '@extalia/protocol';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { SessionStore } from '../src/sessions.js';
import { workspaceBoundaryKey, workspaceSessionBoundaryKey } from '../src/workspaceBoundary.js';
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

describe('reviewed Native session moves', () => {
  it('keeps the same saved conversation and connection while tools use the reviewed isolated destination', async () => {
    let calls: Call[] = [{ name: 'read_file', args: { path: 'marker.txt' } },
      { name: 'write_file', args: { path: 'before.txt', content: 'Source write' } }];
    const ctx = await setup({ modes: ['isolated', 'isolated'], script: body => currentToolResults(body) ? reply() : reply(calls) });
    await writeFile(path.join(ctx.alpha.projectLocation!, 'marker.txt'), 'Source folder evidence');
    await writeFile(path.join(ctx.beta.projectLocation!, 'marker.txt'), 'Destination folder evidence');
    const other = await ctx.host.saveConnection({ name: 'Destination default', preset: 'custom', api: 'openai-chat',
      baseUrl: 'http://destination.example/v1', model: 'destination-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
    await ctx.host.saveWorkspace({ id: ctx.beta.id, name: ctx.beta.name, projectLocation: ctx.beta.projectLocation!,
      connectionId: other.connections.find(connection => connection.name === 'Destination default')!.id,
      crossWorkspaceAccess: 'isolated', permissions: { fileWrite: 'allow', commands: 'allow' } });
    const session = await ctx.host.createSession(ctx.alpha.id);
    const team: AgentTeam = { enabled: false, allowedModels: ['model', 'alternate-model'], goal: 'Keep this team goal',
      members: [{ id: 'reviewer', name: 'Example Reviewer', role: 'Reviewer', models: ['model'], soul: 'Preserve this personality' }] };
    await ctx.host.saveSessionTeam(session.id, team);
    await ctx.host.setSessionOptions(session.id, { model: 'alternate-model' });
    await ctx.host.sendPrompt(session.id, 'Original conversation marker'); await settled(ctx.runtime);
    expect(currentToolResults(ctx.bodies.at(-1)!)).toContain('Source folder evidence');
    const original = (await ctx.store.get(session.id))!;
    const messages = await ctx.store.readMessages(session.id), events = await ctx.host.sessionEvents(session.id);
    const requestCount = ctx.requests.length;
    const preview = await ctx.host.previewSessionMove!(session.id, ctx.beta.id);
    expect(preview).toMatchObject({ sessionId: session.id, transfersHistory: true,
      source: { id: ctx.alpha.id, folders: [ctx.alpha.projectLocation, ...ctx.alpha.additionalProjectLocations!] },
      destination: { id: ctx.beta.id, folders: [ctx.beta.projectLocation], crossWorkspaceAccess: 'isolated', permissions: { fileWrite: 'allow' } },
      accessibleFolders: [{ workspaceId: ctx.beta.id, path: ctx.beta.projectLocation, access: 'read-write' }] });
    expect(Date.parse(preview.expiresAt)).toBeGreaterThan(Date.now());
    expect((await ctx.store.get(session.id))!.workspaceId).toBe(ctx.alpha.id);
    const state = await ctx.host.moveSession!(session.id, { workspaceId: ctx.beta.id, reviewId: preview.reviewId });
    expect(state.sessions.filter(item => item.id === session.id)).toHaveLength(1);
    expect(state.sessions.find(item => item.id === session.id)).toMatchObject({ workspaceId: ctx.beta.id, connectionId: ctx.connectionId });
    const boundary = workspaceSessionBoundaryKey(ctx.beta.id, state.workspaces);
    expect(await ctx.store.get(session.id)).toEqual({ ...original, workspaceId: ctx.beta.id,
      workspaceBoundary: boundary, reviewedContextBoundary: boundary, workspaceFileRoot: ctx.beta.projectLocation,
      workspaceFileScopes: [{ throughEventId: events.at(-1)!.id, workspaceId: ctx.alpha.id, projectLocation: ctx.alpha.projectLocation }] });
    expect(await ctx.store.readMessages(session.id)).toEqual(messages);
    expect(await ctx.host.sessionEvents(session.id)).toEqual(events);
    expect(ctx.requests).toHaveLength(requestCount);
    await expect(ctx.host.moveSession!(session.id, { workspaceId: ctx.beta.id, reviewId: preview.reviewId })).rejects.toThrow(/Review the destination again/);

    await ctx.restart();
    calls = [{ name: 'read_file', args: { path: 'marker.txt' } },
      { name: 'read_file', args: { path: path.join(ctx.alpha.projectLocation!, 'marker.txt') } },
      { name: 'write_file', args: { path: 'after.txt', content: 'Destination write' } }, { name: 'workspace_folders', args: {} }];
    await ctx.host.sendPrompt(session.id, 'Continue after the move'); await settled(ctx.runtime);
    expect(ctx.bodies.at(-1)!.model).toBe('alternate-model');
    expect(ctx.requests.at(-1)).toContain('mock.example');
    expect(ctx.bodies.at(-1)!.messages.some(message => message.content === 'Original conversation marker')).toBe(true);
    const results = currentToolResults(ctx.bodies.at(-1)!);
    expect(results).toContain('Destination folder evidence');
    expect(results).toContain('workspace access policy');
    expect(results).not.toContain('Source folder evidence');
    expect(results).toContain(ctx.beta.projectLocation);
    expect(await readFile(path.join(ctx.alpha.projectLocation!, 'before.txt'), 'utf8')).toBe('Source write');
    expect(await readFile(path.join(ctx.beta.projectLocation!, 'after.txt'), 'utf8')).toBe('Destination write');
    await expect(readFile(path.join(ctx.alpha.projectLocation!, 'after.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await ctx.store.readMessages(session.id)).slice(0, messages.length)).toEqual(messages);
    expect(await ctx.host.getSessionTeam(session.id)).toEqual(original.team);
  });

  it('previews effective read-only access to both source folders without transferring files', async () => {
    const ctx = await setup();
    const session = await ctx.host.createSession(ctx.alpha.id);
    const preview = await ctx.host.previewSessionMove!(session.id, ctx.beta.id);
    expect(preview.transfersHistory).toBe(false);
    expect(preview.accessibleFolders).toEqual(expect.arrayContaining([
      { workspaceId: ctx.alpha.id, path: ctx.alpha.projectLocation, access: 'read-only' },
      { workspaceId: ctx.alpha.id, path: ctx.alpha.additionalProjectLocations![0], access: 'read-only' },
      { workspaceId: ctx.beta.id, path: ctx.beta.projectLocation, access: 'read-write' },
    ]));
    expect(preview.accessibleFolders).toHaveLength(3);
    expect(ctx.requests).toEqual([]);
  });

  it('recovers legacy history in its current workspace only after an explicit review', async () => {
    const ctx = await setup();
    const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.sendPrompt(session.id, 'Legacy history marker'); await settled(ctx.runtime);
    await ctx.store.update(session.id, { workspaceBoundary: 'unverifiable-legacy-grants' });
    await expect(ctx.host.sendPrompt(session.id, 'Unreviewed continuation')).rejects.toThrow(/new Native session/);
    const messages = await ctx.store.readMessages(session.id), count = ctx.bodies.length;
    const review = await ctx.host.previewSessionMove!(session.id, ctx.alpha.id);
    await ctx.host.moveSession!(session.id, { workspaceId: ctx.alpha.id, reviewId: review.reviewId });
    expect(ctx.bodies).toHaveLength(count);
    expect(await ctx.store.readMessages(session.id)).toEqual(messages);
    await ctx.host.sendPrompt(session.id, 'Reviewed continuation'); await settled(ctx.runtime);
    expect(ctx.bodies.at(-1)!.messages.some(message => message.content === 'Legacy history marker')).toBe(true);
    expect((await ctx.store.get(session.id))!.reviewedContextBoundary).toBe(workspaceSessionBoundaryKey(ctx.alpha.id, (await ctx.host.getState()).workspaces));
  });

  it('keeps historical file scopes at the old root after reviewing a folder change in the same workspace', async () => {
    const ctx = await setup({ modes: ['isolated', 'isolated'], script: body => currentToolResults(body) ? reply()
      : reply([{ name: 'write_file', args: { path: 'result.txt', content: 'Workspace file evidence' } }]) });
    const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.sendPrompt(session.id, 'Work in the original folder'); await settled(ctx.runtime);
    const original = (await ctx.store.get(session.id))!;
    const events = await ctx.host.sessionEvents(session.id), messages = await ctx.store.readMessages(session.id);
    expect(original.workspaceFileRoot).toBe(ctx.alpha.projectLocation);
    const nextRoot = path.join(ctx.root, 'replacement'); await mkdir(nextRoot);
    const state = await ctx.save(ctx.alpha, { projectLocation: nextRoot });
    const canonicalRoot = state.workspaces.find(workspace => workspace.id === ctx.alpha.id)!.projectLocation;
    await expect(ctx.host.sendPrompt(session.id, 'Unreviewed folder change')).rejects.toThrow(/new Native session/);
    const review = await ctx.host.previewSessionMove!(session.id, ctx.alpha.id);
    expect(review.source.folders[0]).toBe(canonicalRoot);
    const requestCount = ctx.requests.length;
    await ctx.host.moveSession!(session.id, { workspaceId: ctx.alpha.id, reviewId: review.reviewId });
    expect(await ctx.store.get(session.id)).toMatchObject({ workspaceId: ctx.alpha.id, workspaceFileRoot: canonicalRoot,
      workspaceFileScopes: [{ throughEventId: events.at(-1)!.id, workspaceId: ctx.alpha.id, projectLocation: ctx.alpha.projectLocation }] });
    expect(await ctx.host.sessionEvents(session.id)).toEqual(events);
    expect(await ctx.store.readMessages(session.id)).toEqual(messages);
    expect(ctx.requests).toHaveLength(requestCount);
    await ctx.host.sendPrompt(session.id, 'Continue in the reviewed folder'); await settled(ctx.runtime);
    expect(await readFile(path.join(canonicalRoot!, 'result.txt'), 'utf8')).toBe('Workspace file evidence');
    expect(await readFile(path.join(ctx.alpha.projectLocation!, 'result.txt'), 'utf8')).toBe('Workspace file evidence');
    expect((await ctx.store.get(session.id))!.workspaceFileScopes![0]!.projectLocation).toBe(ctx.alpha.projectLocation);
  });

  it.each(['team', 'options', 'title', 'source-settings', 'destination-settings', 'destination-folder', 'history', 'history-only'] as const)(
    'rejects a review made before a %s change without mutating the newer conversation', async change => {
      const ctx = await setup();
      const session = await ctx.host.createSession(ctx.alpha.id);
      await ctx.host.sendPrompt(session.id, 'Original history'); await settled(ctx.runtime);
      const review = await ctx.host.previewSessionMove!(session.id, ctx.beta.id);
      if (change === 'team') await ctx.host.saveSessionTeam(session.id, { enabled: false, allowedModels: ['model'], members: [], goal: 'New team settings' });
      if (change === 'options') await ctx.host.setSessionOptions(session.id, { model: 'alternate-model' });
      if (change === 'title') await ctx.host.renameSession(session.id, 'New title');
      if (change === 'source-settings') await ctx.save(ctx.alpha, { permissions: { fileWrite: 'ask', commands: 'ask' } });
      if (change === 'destination-settings') await ctx.save(ctx.beta, { crossWorkspaceAccess: 'isolated' });
      if (change === 'destination-folder') {
        const folder = path.join(ctx.root, 'replacement'); await mkdir(folder); await ctx.save(ctx.beta, { projectLocation: folder });
      }
      if (change === 'history') { await ctx.host.sendPrompt(session.id, 'New history'); await settled(ctx.runtime); }
      if (change === 'history-only') await ctx.store.writeMessages(session.id, [...await ctx.store.readMessages(session.id), { role: 'user', text: 'History changed without a metadata edit' }]);
      const record = await ctx.store.get(session.id), messages = await ctx.store.readMessages(session.id), requestCount = ctx.requests.length;
      await expect(ctx.host.moveSession!(session.id, { workspaceId: ctx.beta.id, reviewId: review.reviewId })).rejects.toThrow(/Review the destination again/);
      expect(await ctx.store.get(session.id)).toEqual(record);
      expect(await ctx.store.readMessages(session.id)).toEqual(messages);
      expect(ctx.requests).toHaveLength(requestCount);
    });

  it.each(['unknown', 'expired', 'other-session', 'other-destination'] as const)('rejects %s review tokens', async kind => {
    const ctx = await setup();
    const session = await ctx.host.createSession(ctx.alpha.id);
    const review = await ctx.host.previewSessionMove!(session.id, ctx.beta.id);
    let id = session.id, workspaceId = ctx.beta.id;
    if (kind === 'other-session') id = (await ctx.host.createSession(ctx.alpha.id)).id;
    if (kind === 'other-destination') workspaceId = ctx.alpha.id;
    if (kind === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.parse(review.expiresAt) + 1);
    await expect(ctx.host.moveSession!(id, { workspaceId, reviewId: kind === 'unknown' ? 'unknown-review' : review.reviewId })).rejects.toThrow(/Review the destination again/);
    expect((await ctx.store.get(session.id))!.workspaceId).toBe(ctx.alpha.id);
    expect(ctx.requests).toEqual([]);
  });

  it('refuses preview and commit while a provider still owns the session', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ctx = await setup({ script: async () => { await held; return reply(); } });
    const session = await ctx.host.createSession(ctx.alpha.id);
    const review = await ctx.host.previewSessionMove!(session.id, ctx.beta.id);
    await ctx.host.sendPrompt(session.id, 'Hold this turn');
    try {
      await expect(ctx.host.previewSessionMove!(session.id, ctx.beta.id)).rejects.toThrow(/finish|stop/i);
      await expect(ctx.host.moveSession!(session.id, { workspaceId: ctx.beta.id, reviewId: review.reviewId })).rejects.toThrow(/finish|stop/i);
      expect((await ctx.store.get(session.id))!.workspaceId).toBe(ctx.alpha.id);
    } finally { release(); }
    await settled(ctx.runtime);
  });

  it('keeps malformed saved file provenance passive while an explicit move remains usable', async () => {
    const ctx = await setup();
    const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.sendPrompt(session.id, 'Existing history'); await settled(ctx.runtime);
    const indexFile = path.join(ctx.root, 'data', 'sessions', 'index.json');
    const records = JSON.parse(await readFile(indexFile, 'utf8'));
    const record = records.find((item: { id: string }) => item.id === session.id);
    record.workspaceFileScopes = {}; record.workspaceFileRoot = 42;
    await writeFile(indexFile, JSON.stringify(records));
    const preview = await ctx.host.previewSessionMove!(session.id, ctx.beta.id);
    const state = await ctx.host.moveSession!(session.id, { workspaceId: ctx.beta.id, reviewId: preview.reviewId });
    expect(state.sessions.find(item => item.id === session.id)).toMatchObject({ workspaceId: ctx.beta.id,
      workspaceFileScopes: [{ projectLocation: '' }] });
    await ctx.host.sendPrompt(session.id, 'Continue in the destination'); await settled(ctx.runtime);
    expect(ctx.bodies.at(-1)!.messages.some(message => message.content === 'Existing history')).toBe(true);
  });

  it('upgrades an existing Native prompt queue only when its original complete grants still match', async () => {
    const ctx = await setup();
    const session = await ctx.host.createSession(ctx.alpha.id);
    await ctx.host.sendPrompt(session.id, 'Preserve this earlier conversation'); await settled(ctx.runtime);
    const initial = await ctx.host.promptQueueStatus!(session.id);
    await ctx.host.changePromptQueue!(session.id, { revision: initial.revision, action: 'add', text: 'Preserve this queued follow-up' });
    const state = await ctx.host.getState(), record = (await ctx.store.get(session.id))!;
    const legacyBoundary = workspaceBoundaryKey(state.workspaces);
    const legacyIdentity = createHash('sha256').update(JSON.stringify(['managed', record.id, record.workspaceId,
      record.createdAt, record.connectionId, record.runtime?.id, record.runtime?.profile, legacyBoundary])).digest('hex');
    await ctx.restart(async () => {
      await ctx.store.update(session.id, { workspaceBoundary: legacyBoundary });
      const file = path.join(ctx.root, 'data', 'state', 'prompt-queues.json');
      const data = JSON.parse(await readFile(file, 'utf8'));
      data.queues[0].identity = legacyIdentity;
      await writeFile(file, JSON.stringify(data));
    });
    const queue = await ctx.host.promptQueueStatus!(session.id);
    expect(queue).toMatchObject({ supported: true, paused: true, items: [{ state: 'pending', text: 'Preserve this queued follow-up' }] });
    expect(ctx.bodies).toHaveLength(1);
    await ctx.host.changePromptQueue!(session.id, { revision: queue.revision, action: 'pause', paused: false });
    await vi.waitFor(async () => expect((await ctx.host.promptQueueStatus!(session.id)).items[0]!.state).toBe('sent'), { timeout: 5_000, interval: 10 });
    await settled(ctx.runtime);
    expect(ctx.bodies.at(-1)!.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'Preserve this earlier conversation' }),
      expect.objectContaining({ role: 'user', content: 'Preserve this queued follow-up' }),
    ]));
    expect((await ctx.store.get(session.id))!.workspaceBoundary).toBe(workspaceSessionBoundaryKey(ctx.alpha.id, state.workspaces));
  });

  it('rejects a prompt whose asynchronous admission straddles a completed workspace move', async () => {
    const ctx = await setup();
    const session = await ctx.host.createSession(ctx.alpha.id);
    const review = await ctx.host.previewSessionMove!(session.id, ctx.beta.id);
    let release!: () => void, enter!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const original = SessionStore.prototype.get;
    let armed = true;
    vi.spyOn(SessionStore.prototype, 'get').mockImplementation(async function(this: SessionStore, id: string) {
      const record = await original.call(this, id);
      if (id === session.id && armed) { armed = false; enter(); await held; }
      return record;
    });
    const prompt = ctx.host.sendPrompt(session.id, 'Never admit this stale source prompt');
    await entered;
    try {
      await ctx.host.moveSession!(session.id, { workspaceId: ctx.beta.id, reviewId: review.reviewId });
    } finally { release(); }
    await expect(prompt).rejects.toThrow(/Workspace settings changed/);
    expect((await ctx.store.get(session.id))!.workspaceId).toBe(ctx.beta.id);
    expect(await ctx.store.readMessages(session.id)).toEqual([]);
    expect(ctx.requests).toEqual([]);
    await settled(ctx.runtime);
  });

  it('serializes enqueue behind a move and rejects the queue revision from the source workspace', async () => {
    const ctx = await setup();
    const session = await ctx.host.createSession(ctx.alpha.id);
    const review = await ctx.host.previewSessionMove!(session.id, ctx.beta.id);
    const queue = await ctx.host.promptQueueStatus!(session.id);
    let release!: () => void, enter!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const original = SessionStore.prototype.readMessages;
    let armed = true;
    vi.spyOn(SessionStore.prototype, 'readMessages').mockImplementation(async function(this: SessionStore, id: string) {
      const messages = await original.call(this, id);
      if (id === session.id && armed) { armed = false; enter(); await held; }
      return messages;
    });
    const move = ctx.host.moveSession!(session.id, { workspaceId: ctx.beta.id, reviewId: review.reviewId });
    await entered;
    const enqueue = expect(ctx.host.changePromptQueue!(session.id, { revision: queue.revision, action: 'add', text: 'Keep this source draft in the composer' })).rejects.toThrow(/changed/);
    release();
    await move;
    await enqueue;
    expect((await ctx.host.promptQueueStatus!(session.id)).items).toEqual([]);
    expect((await ctx.store.get(session.id))!.workspaceId).toBe(ctx.beta.id);
    expect(ctx.requests).toEqual([]);
  });

  it.each(['pending', 'unknown'] as const)('refuses preview and commit with %s queued prompts', async queueState => {
    const ctx = await setup();
    const session = await ctx.host.createSession(ctx.alpha.id);
    const review = await ctx.host.previewSessionMove!(session.id, ctx.beta.id);
    const initial = await ctx.host.promptQueueStatus!(session.id);
    await ctx.host.changePromptQueue!(session.id, { revision: initial.revision, action: 'add', text: 'Never retarget this prompt' });
    if (queueState === 'unknown') {
      // A persisted sending reservation becomes unknown after restart, without replay.
      await ctx.restart(async () => {
        const file = path.join(ctx.root, 'data', 'state', 'prompt-queues.json');
        const saved = JSON.parse(await readFile(file, 'utf8')) as { queues: { items: { state: string }[] }[] };
        saved.queues[0]!.items[0]!.state = 'sending';
        await writeFile(file, JSON.stringify(saved), { mode: 0o600 });
      });
    }
    expect((await ctx.host.promptQueueStatus!(session.id)).items[0]!.state).toBe(queueState);
    await expect(ctx.host.previewSessionMove!(session.id, ctx.beta.id)).rejects.toThrow(/pending prompts|uncertain deliveries/);
    await expect(ctx.host.moveSession!(session.id, { workspaceId: ctx.beta.id, reviewId: review.reviewId })).rejects.toThrow(/pending prompts|uncertain deliveries/);
    expect((await ctx.store.get(session.id))!.workspaceId).toBe(ctx.alpha.id);
    expect((await ctx.host.promptQueueStatus!(session.id)).items[0]).toMatchObject({ state: queueState, text: 'Never retarget this prompt' });
    expect(ctx.bodies).toEqual([]);
  });

  it('keeps an unsaved conversation transient after moving into a workspace that saves history', async () => {
    const ctx = await setup({ history: false, modes: ['isolated', 'isolated'] });
    const session = await ctx.host.createSession(ctx.alpha.id);
    const saved = await ctx.host.saveConnection({ name: 'Saved history connection', preset: 'custom', api: 'openai-chat',
      baseUrl: 'http://saved.example/v1', model: 'model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off', history: true } });
    await ctx.host.saveWorkspace({ id: ctx.beta.id, name: ctx.beta.name, projectLocation: ctx.beta.projectLocation!,
      connectionId: saved.connections.find(connection => connection.name === 'Saved history connection')!.id,
      crossWorkspaceAccess: 'isolated', permissions: { fileWrite: 'allow', commands: 'allow' } });
    await ctx.host.sendPrompt(session.id, 'TRANSIENT_MOVE_HISTORY_MARKER'); await settled(ctx.runtime);
    const preview = await ctx.host.previewSessionMove!(session.id, ctx.beta.id);
    expect(preview.transfersHistory).toBe(true);
    const state = await ctx.host.moveSession!(session.id, { workspaceId: ctx.beta.id, reviewId: preview.reviewId });
    expect(state.sessions.find(item => item.id === session.id)).toMatchObject({ transient: true, connectionId: ctx.connectionId, workspaceId: ctx.beta.id });
    expect(await ctx.store.get(session.id)).toBeUndefined();
    await ctx.host.sendPrompt(session.id, 'Continue transient history'); await settled(ctx.runtime);
    expect(ctx.bodies.at(-1)!.messages.some(message => message.content === 'TRANSIENT_MOVE_HISTORY_MARKER')).toBe(true);
    for (const file of await readdir(path.join(ctx.root, 'data'), { recursive: true, withFileTypes: true })) {
      if (file.isFile()) expect(await readFile(path.join(file.parentPath, file.name), 'utf8').catch(() => '')).not.toContain('TRANSIENT_MOVE_HISTORY_MARKER');
    }
    await ctx.restart();
    expect((await ctx.host.getState()).sessions.some(item => item.id === session.id)).toBe(false);
  });

  it('allows imported context in isolation only for the exact reviewed boundary', async () => {
    const ctx = await setup({ modes: ['read-only', 'isolated'] });
    const at = '2026-11-11T00:00:00Z';
    const imported = await ctx.host.importPortable(JSON.stringify({ format: 'extalia.session.v1', title: 'Imported conversation', importMode: 'imported',
      provenance: { sourceId: 'codex', sourceSessionId: 'example-thread', exportedAt: at },
      messages: [{ index: 0, role: 'user', content: 'Imported context marker', createdAt: at }], startedAt: at, lastMessageAt: at }));
    const session = await ctx.host.continueSession({ kind: 'library', id: imported.state.library[0]!.id }, ctx.alpha.id);
    const preview = await ctx.host.previewSessionMove!(session.id, ctx.beta.id);
    await ctx.host.moveSession!(session.id, { workspaceId: ctx.beta.id, reviewId: preview.reviewId });
    await ctx.store.update(session.id, { reviewedContextBoundary: undefined });
    await expect(ctx.host.sendPrompt(session.id, 'Imported history without its review')).rejects.toThrow(/fresh session|explicit review/);
    expect(ctx.bodies).toEqual([]);
    const reviewedAgain = await ctx.host.previewSessionMove!(session.id, ctx.beta.id);
    await ctx.host.moveSession!(session.id, { workspaceId: ctx.beta.id, reviewId: reviewedAgain.reviewId });
    await ctx.host.sendPrompt(session.id, 'Use explicitly reviewed context'); await settled(ctx.runtime);
    expect(ctx.bodies.at(-1)!.messages.some(message => message.content === 'Imported context marker')).toBe(true);
    expect((await ctx.store.get(session.id))!.continuedFrom).toEqual(session.continuedFrom);
    const newFolder = path.join(ctx.root, 'new-isolated-folder'); await mkdir(newFolder);
    await ctx.save(ctx.beta, { projectLocation: newFolder });
    const count = ctx.bodies.length;
    await expect(ctx.host.sendPrompt(session.id, 'Do not widen the review')).rejects.toThrow(/fresh session|new Native session|explicit review/);
    expect(ctx.bodies).toHaveLength(count);
  });
});
