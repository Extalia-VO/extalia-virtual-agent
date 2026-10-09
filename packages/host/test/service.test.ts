import type { ExtaliaEvent } from '@extalia/protocol';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';

/** A scripted OpenAI-compatible endpoint: write hello.txt, run `cat`, then answer. */
function scriptedFetch() {
  const bodies: { messages: { role: string; tool_calls?: { function: { name: string } }[] }[] }[] = [];
  const sse = (chunks: unknown[]) => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'mock-agent' }] });
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const messages = body.messages as { role: string; tool_calls?: { function: { name: string } }[] }[];
    const last = messages.at(-1);
    const lastCall = [...messages].reverse().find(message => message.tool_calls?.length)?.tool_calls?.[0]?.function.name;
    const call = (name: string, args: unknown) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${name}_${bodies.length}`, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
    if (last?.role !== 'tool') return sse([{ choices: [{ delta: { content: 'Creating the file.' } }] }, call('write_file', { path: 'hello.txt', content: 'Hello\n' })]);
    if (lastCall === 'write_file') return sse([call('run_command', { command: 'cat hello.txt' })]);
    return sse([{ choices: [{ delta: { content: 'Done: created hello.txt.' }, finish_reason: 'stop' }] }]);
  };
  return { fetch, bodies };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-host-'));
  const project = path.join(root, 'project');
  await import('node:fs/promises').then(fs => fs.mkdir(project));
  const scripted = scriptedFetch();
  const runtime = await createAgentHost({ kind: 'bridge', version: '0.0.0-test', dataDirectory: path.join(root, 'data'), env: { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH }, fetch: scripted.fetch });
  cleanups.push(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const events: ExtaliaEvent[] = [];
  runtime.host.subscribe(event => events.push(event));
  return { root, project, runtime, events, scripted };
}

async function waitFor(events: ExtaliaEvent[], predicate: (event: ExtaliaEvent) => boolean, from = 0): Promise<ExtaliaEvent> {
  for (let i = 0; i < 300; i++) {
    const found = events.slice(from).find(predicate);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out; saw ${events.map(event => event.body.type).join(', ')}`);
}

async function configure(runtime: AgentHostRuntime, project: string) {
  const { host } = runtime;
  const saved = await host.saveConnection({ name: 'Mock', preset: 'custom', api: 'openai-chat', baseUrl: 'http://mock.test/v1', model: 'mock-agent', credential: { kind: 'none' }, features: { memory: 'extalia', skills: 'extalia' } });
  const connection = saved.connections[0]!;
  await host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: connection.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
  const state = await host.completeSetup();
  return { state, workspace: state.workspaces[0]!, connection };
}

describe('agent host service', () => {
  it('runs an agent turn end to end with approvals and persists the session', async () => {
    const { project, runtime, events, scripted } = await setup();
    const { host } = runtime;
    expect((await host.getState()).setupComplete).toBe(false);
    await expect(host.completeSetup()).rejects.toThrow(/connection/);

    const test = await host.testConnection({ name: 'Mock', preset: 'custom', api: 'openai-chat', baseUrl: 'http://mock.test/v1', model: 'mock-agent', credential: { kind: 'none' }, features: { memory: 'extalia', skills: 'extalia' } });
    expect(test).toMatchObject({ ok: true, models: ['mock-agent'] });

    const { state, workspace } = await configure(runtime, project);
    expect(state.setupComplete).toBe(true);
    const session = await host.createSession(workspace.id);

    await host.sendPrompt(session.id, 'Create hello.txt');
    expect(runtime.isBusy()).toBe(true);
    await expect(host.sendPrompt(session.id, 'again')).rejects.toThrow(/still working/);

    const first = await waitFor(events, event => event.body.type === 'approval.requested');
    expect((await host.getState()).sessions[0]?.pendingApprovalId).toBe((first.body as { approvalId: string }).approvalId);
    await host.resolveApproval(session.id, (first.body as { approvalId: string }).approvalId, 'once');
    const second = await waitFor(events, event => event.body.type === 'approval.requested' && event.id !== first.id);
    await host.resolveApproval(session.id, (second.body as { approvalId: string }).approvalId, 'once');
    await waitFor(events, event => event.body.type === 'turn.completed');
    await waitFor(events, event => event.body.type === 'agent.state' && (event.body as { state: string }).state === 'idle');

    expect(await readFile(path.join(project, 'hello.txt'), 'utf8')).toBe('Hello\n');
    expect(runtime.isBusy()).toBe(false);
    const stored = await host.sessionEvents(session.id);
    expect(stored.map(event => event.body.type)).toEqual(expect.arrayContaining(['session.started', 'prompt.submitted', 'tool.started', 'file.written', 'command.completed', 'turn.completed']));
    expect(stored.every((event, index) => event.seq === index)).toBe(true);
    const after = await host.getState();
    expect(after.sessions[0]).toMatchObject({ title: 'Create hello.txt', running: false });

    // Memory and skills are offered because the connection uses Extalia's.
    const system = (scripted.bodies[0] as unknown as { messages: { role: string; content: string }[] }).messages[0]!.content;
    expect(system).toContain('memory_write');
    expect(system).toContain('code-review');
  });

  it('continues a session with its history and can be cancelled while waiting for approval', async () => {
    const { project, runtime, events, scripted } = await setup();
    const { host } = runtime;
    const { workspace } = await configure(runtime, project);
    const session = await host.createSession(workspace.id);
    await host.sendPrompt(session.id, 'first');
    await waitFor(events, event => event.body.type === 'approval.requested');
    const mark = events.length;
    await host.cancel(session.id);
    await waitFor(events, event => event.body.type === 'turn.failed', mark);
    expect(events.slice(mark).some(event => event.body.type === 'user.intervention')).toBe(true);
    await waitFor(events, event => event.body.type === 'agent.state' && (event.body as { state: string }).state === 'idle', mark);
    for (let i = 0; i < 50 && runtime.isBusy(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(runtime.isBusy()).toBe(false);

    await host.sendPrompt(session.id, 'second');
    await waitFor(events, event => event.body.type === 'approval.requested', mark + 1);
    const messages = scripted.bodies.at(-1)!.messages.map(message => message.role);
    // system, first prompt, assistant tool call, declined tool result, second prompt
    expect(messages).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    await host.cancel(session.id);
  });

  it('keeps secrets out of state and refuses missing keys', async () => {
    const { runtime } = await setup();
    const { host } = runtime;
    const input = { name: 'Router', preset: '9router' as const, api: 'openai-chat' as const, baseUrl: 'http://localhost:20128/v1', model: 'auto', credential: { kind: 'stored' as const }, features: { memory: 'extalia' as const, skills: 'off' as const } };
    await expect(host.saveConnection(input)).rejects.toThrow(/API key/);
    const state = await host.saveConnection(input, 'sk-test-0123456789abcdef'); // extalia-allow-secret
    expect(state.connections[0]?.credentialStatus).toBe('ok');
    expect(JSON.stringify(state)).not.toContain('0123456789abcdef');
    expect(JSON.stringify(await host.getState())).not.toContain('0123456789abcdef');
    await expect(host.saveConnection({ ...input, features: { memory: 'provider', skills: 'off' } }, 'x')).rejects.toThrow(/does not manage memory/);
  });

  it('validates folders and refuses a second host on the same data', async () => {
    const { root, project, runtime } = await setup();
    expect(await runtime.host.checkFolder(project)).toMatchObject({ ok: true, name: 'project' });
    expect(await runtime.host.checkFolder('relative/path')).toMatchObject({ ok: false });
    expect(await runtime.host.checkFolder(path.join(project, 'missing'))).toMatchObject({ ok: false });
    await expect(createAgentHost({ kind: 'desktop', version: 'x', dataDirectory: path.join(root, 'data'), env: { EXTALIA_SECRET_STORE: 'memory' } })).rejects.toThrow(/already running/i);
  });
});
