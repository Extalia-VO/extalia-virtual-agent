import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtaliaEvent } from '@extalia/protocol';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { SessionStore } from '../src/sessions.js';
import { UNASSIGNED_SESSION_BOUNDARY } from '../src/workspaceBoundary.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const runtimes = new Set<AgentHostRuntime>();
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...runtimes].map(runtime => runtime.close()));
  runtimes.clear();
});

type Call = { name: string; args: Record<string, unknown> };
type Body = {
  model: string;
  messages: { role: string; content: string }[];
  tools?: { function?: { name?: string }; name?: string }[];
};

function reply(calls: Call[] = [], text = 'Hello from unassigned Native'): Response {
  const delta = calls.length
    ? { tool_calls: calls.map((call, index) => ({ index, id: `call-${index}`, function: { name: call.name, arguments: JSON.stringify(call.args) } })) }
    : { content: text };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function settled(runtime: AgentHostRuntime) {
  await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 5_000, interval: 10 });
}

function currentToolResults(body: Body): string {
  return body.messages.slice(body.messages.map(message => message.role).lastIndexOf('user') + 1)
    .filter(message => message.role === 'tool').map(message => message.content).join('\n');
}

function toolNames(body: Body): string[] {
  return (body.tools ?? []).map(tool => tool.function?.name ?? tool.name ?? '').filter(Boolean);
}

async function setup({ script = () => reply(), skills = 'off', memory = 'off' }: {
  script?: (body: Body) => Response | Promise<Response>;
  skills?: 'off' | 'extalia';
  memory?: 'off' | 'extalia';
} = {}) {
  const root = await temp('extalia-unassigned-');
  const projectDir = path.join(root, 'project-alpha');
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, 'AGENTS.md'), 'SECRET_PROJECT_INSTRUCTION_TOKEN');
  const bodies: Body[] = [];
  const events: ExtaliaEvent[] = [];
  const open = async () => {
    const runtime = await createAgentHost({
      kind: 'bridge',
      version: 'test',
      dataDirectory: path.join(root, 'data'),
      homeDirectory: path.join(root, 'home'),
      importHome: path.join(root, 'home'),
      env: { EXTALIA_SECRET_STORE: 'memory', HERMES_MANAGED_DIR: path.join(root, 'managed-missing') },
      modelDiscovery: async () => ['model-a', 'model-b'],
      fetch: async (url, init) => {
        if (/\/models$/.test(url)) return Response.json({ data: [{ id: 'model-a' }, { id: 'model-b' }] });
        const body = JSON.parse(String(init?.body)) as Body;
        bodies.push(body);
        return script(body);
      },
    });
    runtimes.add(runtime);
    runtime.host.subscribe(event => { events.push(event); });
    return runtime;
  };
  let runtime = await open();
  const state = await runtime.host.saveConnection({
    name: 'Primary connection',
    preset: 'custom',
    api: 'openai-chat',
    baseUrl: 'http://mock.example/v1',
    model: 'model-a',
    credential: { kind: 'none' },
    features: { memory, skills, history: true },
  });
  const connectionId = state.connections[0]!.id;
  return {
    root,
    projectDir,
    connectionId,
    bodies,
    events,
    store: new SessionStore(path.join(root, 'data', 'sessions')),
    get runtime() { return runtime; },
    get host() { return runtime.host; },
    async restart() {
      await runtime.close();
      runtimes.delete(runtime);
      runtime = await open();
    },
  };
}

describe('unassigned Extalia Native sessions (ADR 0095)', () => {
  it('creates an unassigned session with zero workspaces configured and enforces zero filesystem, command, memory, or schedule grants', async () => {
    const ctx = await setup({ memory: 'extalia', skills: 'extalia' });
    expect((await ctx.host.getState()).workspaces).toEqual([]);

    const choices = await ctx.host.modelChoices(null);
    expect(choices.runtime).toBe('extalia-native');
    expect(choices.defaultModel).toBe('model-a');
    expect(choices.models).toEqual(['model-a', 'model-b']);

    const session = await ctx.host.createSession(null);
    expect(session.workspaceId).toBeNull();
    expect(session.connectionId).toBe(ctx.connectionId);
    expect(session.team).toBeUndefined();
    expect(session.agentName).toBeTruthy();

    const started = (await ctx.host.sessionEvents(session.id)).find(event => event.body.type === 'session.started');
    expect(started?.body).toMatchObject({ type: 'session.started', control: 'managed', title: 'New session' });
    expect((started?.body as { cwd?: string }).cwd).toBeUndefined();

    await ctx.host.sendPrompt(session.id, 'Summarize recursion in two sentences.');
    await settled(ctx.runtime);

    expect(ctx.bodies).toHaveLength(1);
    const offeredTools = toolNames(ctx.bodies[0]!);
    for (const forbidden of [
      'list_files', 'read_file', 'search_files', 'write_file', 'edit_file', 'workspace_folders',
      'run_command', 'schedule_jobs', 'memory_list', 'memory_search', 'memory_read', 'memory_write',
      'work_memory_search', 'work_memory_read', 'observed_memory_search', 'observed_memory_read',
      'knowledge_search', 'knowledge_read', 'context_archive_read', 'skill_propose', 'skill_source_read',
    ]) {
      expect(offeredTools).not.toContain(forbidden);
    }
    // Global built-in skill tools remain available when skills are enabled.
    expect(offeredTools).toEqual(expect.arrayContaining(['skill_list', 'skill_search', 'skill_read']));

    const systemMessage = ctx.bodies[0]!.messages.find(message => message.role === 'system')?.content ?? '';
    expect(systemMessage).toContain('unassigned conversation with no attached project workspace');
    expect(systemMessage).not.toContain(ctx.projectDir);
    expect(systemMessage).not.toContain(ctx.root);
    expect(systemMessage).not.toContain('SECRET_PROJECT_INSTRUCTION_TOKEN');

    await expect(ctx.host.sendPrompt(session.id, '/learn-skill how to write tests')).rejects.toThrow(/requires a workspace session/i);
  });

  it('keeps delegated team workers on unassigned sessions strictly zero-grant even when configured with write access', async () => {
    let turn = 0;
    const ctx = await setup({
      script: body => {
        turn++;
        if (turn === 1 && !currentToolResults(body)) {
          return reply([{ name: 'delegate_task', args: { member: 'Builder', task: 'Analyze the design trade-offs' } }]);
        }
        return reply([], 'Completed analysis');
      },
    });
    const session = await ctx.host.createSession(null, {
      team: {
        enabled: true,
        allowedModels: ['model-a'],
        members: [{ id: 'm_builder', name: 'Builder', role: 'Engineer', models: ['model-a'], access: 'write', scope: ['src'] }],
      },
    });
    expect(session.team).toMatchObject({ enabled: true, size: 1 });

    await ctx.host.sendPrompt(session.id, 'Ask Builder to review the architecture.');
    await settled(ctx.runtime);

    expect(ctx.bodies.length).toBeGreaterThanOrEqual(2);
    const workerRequest = ctx.bodies[1]!;
    const workerTools = toolNames(workerRequest);
    expect(workerTools).toEqual([]);
    const workerSystem = workerRequest.messages.find(message => message.role === 'system')?.content ?? '';
    expect(workerSystem).toContain('unassigned conversation with no attached project workspace');
    expect(workerSystem).toContain('You have no workspace access');
    expect(workerSystem).not.toContain('edit and create files');
  });

  it('requires an explicit connection when multiple connections exist and snapshots an Operating Profile preset when selected', async () => {
    const ctx = await setup();
    const secondState = await ctx.host.saveConnection({
      name: 'Secondary connection',
      preset: 'custom',
      api: 'openai-chat',
      baseUrl: 'http://mock.example/v1',
      model: 'model-b',
      credential: { kind: 'none' },
      features: { memory: 'off', skills: 'off', history: true },
    });
    const secondId = secondState.connections.find(item => item.id !== ctx.connectionId)!.id;

    await expect(ctx.host.createSession(null)).rejects.toThrow(/Choose a model connection/i);
    await expect(ctx.host.modelChoices(null)).rejects.toThrow(/Choose a model connection/i);

    const choices = await ctx.host.modelChoices(null, undefined, secondId);
    expect(choices.defaultModel).toBe('model-b');

    const profile = await ctx.host.saveOperatingProfile!({
      name: 'Security Reviewer',
      purpose: 'Audit protocol boundaries',
      personality: 'Precise and direct',
      defaults: { connectionId: secondId, model: 'model-b' },
    });

    const session = await ctx.host.createSession(null, { operatingProfileId: profile.id });
    expect(session.workspaceId).toBeNull();
    expect(session.connectionId).toBe(secondId);
    expect(session.options?.model).toBe('model-b');
    expect(session.operatingProfile).toMatchObject({ id: profile.id, name: 'Security Reviewer' });

    await ctx.host.sendPrompt(session.id, 'Check our assumptions.');
    await settled(ctx.runtime);
    const systemMessage = ctx.bodies.at(-1)!.messages.find(message => message.role === 'system')?.content ?? '';
    expect(systemMessage).toContain('Audit protocol boundaries');
    expect(systemMessage).toContain('Precise and direct');
  });

  it('enforces idempotent createSession and sendPrompt retries by clientRequestId and fails closed on parameter mismatch', async () => {
    const ctx = await setup();
    const createRequestId = '00000000-0000-4000-8000-000000000001';

    const [first, second] = await Promise.all([
      ctx.host.createSession(null, { connectionId: ctx.connectionId, clientRequestId: createRequestId }),
      ctx.host.createSession(null, { connectionId: ctx.connectionId, clientRequestId: createRequestId }),
    ]);
    expect(first.id).toBe(second.id);

    const third = await ctx.host.createSession(null, { connectionId: ctx.connectionId, clientRequestId: createRequestId });
    expect(third.id).toBe(first.id);
    expect((await ctx.host.getState()).sessions.filter(item => item.id === first.id)).toHaveLength(1);
    const startedEvents = (await ctx.host.sessionEvents(first.id)).filter(event => event.body.type === 'session.started');
    expect(startedEvents).toHaveLength(1);

    await expect(
      ctx.host.createSession(null, { connectionId: ctx.connectionId, model: 'model-b', clientRequestId: createRequestId }),
    ).rejects.toThrow(/already used with different session parameters/i);

    const promptRequestId = '00000000-0000-4000-8000-000000000002';
    await Promise.all([
      ctx.host.sendPrompt(first.id, 'First idempotent prompt', { clientRequestId: promptRequestId }),
      ctx.host.sendPrompt(first.id, 'First idempotent prompt', { clientRequestId: promptRequestId }),
    ]);
    await settled(ctx.runtime);
    expect(ctx.bodies).toHaveLength(1);

    // Sequential retry after completion is a no-op and does not invoke the provider again.
    await ctx.host.sendPrompt(first.id, 'First idempotent prompt', { clientRequestId: promptRequestId });
    expect(ctx.bodies).toHaveLength(1);

    // Reusing the same clientRequestId with different prompt text fails closed.
    await expect(
      ctx.host.sendPrompt(first.id, 'Mutated prompt text', { clientRequestId: promptRequestId }),
    ).rejects.toThrow(/already used for a different prompt/i);
  });

  it('supports one-way reviewed attach (null -> workspace), records empty-root historical file cutoff, and unlocks workspace tools on subsequent turns', async () => {
    const ctx = await setup({
      script: body => currentToolResults(body)
        ? reply([], 'Wrote file after attach')
        : (toolNames(body).includes('write_file')
          ? reply([{ name: 'write_file', args: { path: 'attached.txt', content: 'Attached workspace write' } }])
          : reply([], 'Unassigned reply before attach')),
    });
    const session = await ctx.host.createSession(null);
    await ctx.host.sendPrompt(session.id, 'Draft a plan before choosing a folder.');
    await settled(ctx.runtime);
    expect(toolNames(ctx.bodies[0]!)).toEqual([]);

    const preAttachEvents = await ctx.host.sessionEvents(session.id);
    const lastPreAttachEventId = preAttachEvents.at(-1)!.id;

    const stateWithWorkspace = await ctx.host.saveWorkspace({
      name: 'Alpha Project',
      projectLocation: ctx.projectDir,
      connectionId: ctx.connectionId,
      permissions: { fileWrite: 'allow', commands: 'allow' },
    });
    const workspace = stateWithWorkspace.workspaces[0]!;

    const preview = await ctx.host.previewSessionMove!(session.id, workspace.id);
    expect(preview.kind).toBe('attach');
    expect(preview.source).toBeNull();
    expect(preview.destination).toMatchObject({ id: workspace.id, name: 'Alpha Project' });

    await expect(
      ctx.host.moveSession!(session.id, { workspaceId: workspace.id, reviewId: '00000000-0000-4000-8000-000000000099' }),
    ).rejects.toThrow(/Review the destination again/i);

    const movedState = await ctx.host.moveSession!(session.id, { workspaceId: workspace.id, reviewId: preview.reviewId });
    const attachedSummary = movedState.sessions.find(item => item.id === session.id)!;
    expect(attachedSummary.workspaceId).toBe(workspace.id);

    const storedRecord = (await ctx.store.get(session.id))!;
    expect(storedRecord.workspaceId).toBe(workspace.id);
    expect(storedRecord.workspaceFileScopes).toEqual([
      { throughEventId: lastPreAttachEventId, workspaceId: '', projectLocation: '' },
    ]);

    await ctx.host.sendPrompt(session.id, 'Now write attached.txt in the project.');
    await settled(ctx.runtime);

    expect(toolNames(ctx.bodies[1]!)).toEqual(expect.arrayContaining(['read_file', 'write_file', 'run_command']));
    expect(await readFile(path.join(ctx.projectDir, 'attached.txt'), 'utf8')).toBe('Attached workspace write');
  });

  it('writes a one-time atomic index.pre-unassigned.json backup before the first unassigned session and survives host restart', async () => {
    const ctx = await setup();
    const wsState = await ctx.host.saveWorkspace({
      name: 'Existing Workspace',
      projectLocation: ctx.projectDir,
      connectionId: ctx.connectionId,
      permissions: { fileWrite: 'ask', commands: 'ask' },
    });
    const workspaceId = wsState.workspaces[0]!.id;
    const preExisting = await ctx.host.createSession(workspaceId);

    const backupFile = path.join(ctx.root, 'data', 'sessions', 'index.pre-unassigned.json');
    await expect(stat(backupFile)).rejects.toThrow();

    const unassignedOne = await ctx.host.createSession(null);
    const backupStat = await stat(backupFile);
    if (process.platform !== 'win32') {
      expect(backupStat.mode & 0o777).toBe(0o600);
    }
    const backupRecords = JSON.parse(await readFile(backupFile, 'utf8')) as { id: string; workspaceId: string | null }[];
    expect(backupRecords.map(item => item.id)).toEqual([preExisting.id]);
    expect(backupRecords.every(item => item.workspaceId !== null)).toBe(true);

    // Creating a second unassigned session must not overwrite the original pre-unassigned backup.
    const unassignedTwo = await ctx.host.createSession(null);
    await ctx.host.sendPrompt(unassignedOne.id, 'Persist across restart');
    await settled(ctx.runtime);

    const backupAfterSecond = JSON.parse(await readFile(backupFile, 'utf8')) as { id: string }[];
    expect(backupAfterSecond.map(item => item.id)).toEqual([preExisting.id]);

    await ctx.restart();
    const afterRestart = await ctx.host.getState();
    const reloadedOne = afterRestart.sessions.find(item => item.id === unassignedOne.id);
    const reloadedTwo = afterRestart.sessions.find(item => item.id === unassignedTwo.id);
    expect(reloadedOne?.workspaceId).toBeNull();
    expect(reloadedTwo?.workspaceId).toBeNull();
    expect((await ctx.store.get(unassignedOne.id))?.workspaceBoundary).toBe(UNASSIGNED_SESSION_BOUNDARY);

    await ctx.host.sendPrompt(unassignedOne.id, 'Continue after restart');
    await settled(ctx.runtime);
    const lastRequestMessages = ctx.bodies.at(-1)!.messages;
    expect(lastRequestMessages.some(message => message.content.includes('Persist across restart'))).toBe(true);
  });
});
