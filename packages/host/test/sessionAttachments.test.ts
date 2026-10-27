import type { ExtaliaEvent } from '@extalia/protocol';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';

/** A scripted OpenAI-compatible endpoint: `reply(body, index)` answers each request with text or one tool call. */
type Reply = { text: string } | { call: string; args: Record<string, unknown> };
function endpoint(reply: (body: { tools?: { function: { name: string } }[]; messages: { role: string; content: unknown }[] }, index: number) => Reply) {
  const bodies: { tools?: { function: { name: string } }[]; messages: { role: string; content: unknown }[] }[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'mock-agent' }] });
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const answer = reply(body, bodies.length - 1);
    const delta = 'call' in answer
      ? { tool_calls: [{ index: 0, id: `call_${bodies.length}`, function: { name: answer.call, arguments: JSON.stringify(answer.args) } }] }
      : { content: answer.text };
    const chunk = { choices: [{ delta, finish_reason: 'call' in answer ? 'tool_calls' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch, bodies };
}

const tempDir = useTempDirs();
const runtimes: AgentHostRuntime[] = [];
afterEach(async () => { while (runtimes.length) await runtimes.pop()!.close(); });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const PNG_B64 = PNG.toString('base64');

async function setup(scripted: ReturnType<typeof endpoint>) {
  const root = await tempDir();
  const project = path.join(root, 'project');
  await mkdir(project, { recursive: true });
  const dataDirectory = path.join(root, 'data');
  const runtime = await createAgentHost({ kind: 'bridge', version: '0.0.0-test', dataDirectory, importHome: path.join(root, 'home'), env: { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH }, fetch: scripted.fetch });
  runtimes.push(runtime);
  const events: ExtaliaEvent[] = [];
  runtime.host.subscribe(event => events.push(event));
  return { root, project, dataDirectory, runtime, host: runtime.host, events, scripted };
}

async function configure(runtime: AgentHostRuntime, project: string, options: { history?: boolean; permissions?: { fileWrite: 'ask' | 'allow'; commands: 'ask' | 'allow' } } = {}) {
  const saved = await runtime.host.saveConnection({
    name: 'Mock', preset: 'custom', api: 'openai-chat', baseUrl: 'http://mock.test/v1', model: 'mock-agent', credential: { kind: 'none' },
    features: { memory: 'off', skills: 'off', ...(options.history === false ? { history: false } : {}) },
  });
  await runtime.host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: saved.connections[0]!.id, permissions: options.permissions ?? { fileWrite: 'ask', commands: 'ask' } });
  const state = await runtime.host.completeSetup();
  return state.workspaces[0]!;
}

async function waitFor(events: ExtaliaEvent[], predicate: (event: ExtaliaEvent) => boolean, from = 0): Promise<ExtaliaEvent> {
  for (let i = 0; i < 400; i++) {
    const found = events.slice(from).find(predicate);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out; saw ${events.slice(from).map(event => event.body.type).join(', ')}`);
}

/** Waits for the session's turn to report idle and for the host to finish its bookkeeping. */
async function turnDone(runtime: AgentHostRuntime, events: ExtaliaEvent[], sessionId: string, from = 0) {
  await waitFor(events, event => event.sessionId === sessionId && event.body.type === 'agent.state' && (event.body as { state: string }).state === 'idle', from);
  for (let i = 0; i < 300 && runtime.isBusy(); i++) await new Promise(resolve => setTimeout(resolve, 5));
}

const toolNames = (body: { tools?: { function: { name: string } }[] }) => (body.tools ?? []).map(tool => tool.function.name);

describe('attachments through the agent host', () => {
  it('sends an uploaded image with the next prompt, and keeps no file contents in the stored events or history', async () => {
    const scripted = endpoint(() => ({ text: 'It is a cat.' }));
    const { host, runtime, project, dataDirectory, events } = await setup(scripted);
    const workspace = await configure(runtime, project);
    const session = await host.createSession(workspace.id);
    const file = await host.uploadAttachment(session.id, { name: 'shot.png', mimeType: 'image/png', data: PNG_B64 });
    expect(file).toEqual({ id: file.id, name: 'shot.png', mimeType: 'image/png', size: PNG.length, kind: 'image' });

    await host.sendPrompt(session.id, 'What is this?', { attachmentIds: [file.id] });
    await turnDone(runtime, events, session.id);

    const last = scripted.bodies[0]!.messages.at(-1)!;
    expect(last).toEqual({ role: 'user', content: [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
      { type: 'text', text: expect.stringContaining('What is this?') },
    ] });
    const prompt = events.find(event => event.body.type === 'prompt.submitted')!;
    expect(prompt.body).toMatchObject({ attachments: [{ name: 'shot.png', kind: 'image', size: PNG.length }] });
    expect(JSON.stringify(events)).not.toContain(PNG_B64);
    // Stored events are validated when read back; the prompt with its file list must survive that.
    const stored = await host.sessionEvents(session.id);
    expect(stored.find(event => event.body.type === 'prompt.submitted')?.body).toMatchObject({ attachments: [{ name: 'shot.png', kind: 'image', size: PNG.length }] });
    const history = await readFile(path.join(dataDirectory, 'sessions', `${session.id}.messages.json`), 'utf8');
    expect(history).not.toContain(PNG_B64);
    expect(history).toContain('shot.png');
    // Consumed: the file is gone and the id cannot be sent twice.
    expect(existsSync(path.join(dataDirectory, 'attachments', session.id, `${file.id}.bin`))).toBe(false);
    await expect(host.sendPrompt(session.id, 'again', { attachmentIds: [file.id] })).rejects.toThrow(/no longer available/);
  });

  it('refuses unknown, foreign and malformed ids before anything starts, and keeps the files of the owner', async () => {
    const scripted = endpoint(() => ({ text: 'Noted.' }));
    const { host, runtime, project, events } = await setup(scripted);
    const workspace = await configure(runtime, project);
    const mine = await host.createSession(workspace.id);
    const theirs = await host.createSession(workspace.id);
    const file = await host.uploadAttachment(mine.id, { name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('hello').toString('base64') });

    await expect(host.sendPrompt(theirs.id, 'x', { attachmentIds: [file.id] })).rejects.toThrow(/no longer available/);
    await expect(host.sendPrompt(mine.id, 'x', { attachmentIds: ['att_000000000000000000000000'] })).rejects.toThrow(/no longer available/);
    await expect(host.sendPrompt(mine.id, 'x', { attachmentIds: ['../../etc/passwd'] })).rejects.toThrow(/not valid/);
    await expect(host.sendPrompt(mine.id, 'x', { attachmentIds: Array.from({ length: 11 }, () => file.id) })).rejects.toThrow(/up to 10/);
    await expect(host.sendPrompt(mine.id, '')).rejects.toThrow(/Write a prompt first/);
    expect(runtime.isBusy()).toBe(false);
    expect(scripted.bodies).toHaveLength(0);

    // The owner still has the file: it is sent with her own session's prompt.
    await host.sendPrompt(mine.id, 'Read it', { attachmentIds: [file.id] });
    await turnDone(runtime, events, mine.id);
    expect(JSON.stringify(scripted.bodies[0]!.messages.at(-1))).toContain('hello');
  });

  it('keeps files of sessions with history off in memory only, and still sends them', async () => {
    const scripted = endpoint(() => ({ text: 'Done.' }));
    const { host, runtime, project, dataDirectory, events } = await setup(scripted);
    const workspace = await configure(runtime, project, { history: false });
    const session = await host.createSession(workspace.id);
    const file = await host.uploadAttachment(session.id, { name: 'shot.png', mimeType: 'image/png', data: PNG_B64 });
    expect(existsSync(path.join(dataDirectory, 'attachments'))).toBe(false);
    await host.sendPrompt(session.id, 'Look', { attachmentIds: [file.id] });
    await turnDone(runtime, events, session.id);
    expect(JSON.stringify(scripted.bodies[0]!.messages.at(-1))).toContain(PNG_B64);
    expect(existsSync(path.join(dataDirectory, 'attachments'))).toBe(false);
    const names = await readdir(path.join(dataDirectory, 'sessions')).catch(() => [] as string[]);
    expect(names.some(name => name.includes(session.id))).toBe(false);
  });

  it('removes a waiting file on request', async () => {
    const { host, runtime, project, dataDirectory } = await setup(endpoint(() => ({ text: 'x' })));
    const workspace = await configure(runtime, project);
    const session = await host.createSession(workspace.id);
    const file = await host.uploadAttachment(session.id, { name: 'a.txt', mimeType: 'text/plain', data: Buffer.from('a').toString('base64') });
    await host.removeAttachment(session.id, file.id);
    await expect(host.sendPrompt(session.id, 'x', { attachmentIds: [file.id] })).rejects.toThrow(/no longer available/);
    expect(existsSync(path.join(dataDirectory, 'attachments', session.id, `${file.id}.bin`))).toBe(false);
  });
});

describe('session permission modes (Extalia Native)', () => {
  it('plan mode is stored, offers no edit or command tools, and refuses an edit the model asks for anyway', async () => {
    const scripted = endpoint((_body, index) => (index === 0 ? { call: 'write_file', args: { path: 'hello.txt', content: 'Hi\n' } } : { text: 'I would create hello.txt.' }));
    const { host, runtime, project, events } = await setup(scripted);
    const workspace = await configure(runtime, project, { permissions: { fileWrite: 'allow', commands: 'allow' } });
    const session = await host.createSession(workspace.id, { permissionMode: 'plan' });
    expect(session.options).toEqual({ permissionMode: 'plan' });
    await host.sendPrompt(session.id, 'Create hello.txt');
    await turnDone(runtime, events, session.id);

    const names = toolNames(scripted.bodies[0]!);
    expect(names).toContain('read_file');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('run_command');
    expect(scripted.bodies[0]!.messages[0]!).toMatchObject({ role: 'system', content: expect.stringContaining('Permission mode is plan') });
    expect(existsSync(path.join(project, 'hello.txt'))).toBe(false);
    expect(events.some(event => event.body.type === 'approval.requested')).toBe(false);
    expect(events.find(event => event.body.type === 'tool.completed')?.body).toMatchObject({ ok: false, tool: 'write_file', output: expect.stringContaining('Plan mode is on') });
    const after = (await host.getState()).sessions.find(item => item.id === session.id);
    expect(after?.options).toEqual({ permissionMode: 'plan' });
  });

  it('accept-edits writes files without asking, and still asks before a command', async () => {
    const scripted = endpoint((_body, index) => [
      { call: 'write_file', args: { path: 'hello.txt', content: 'Hi\n' } },
      { call: 'run_command', args: { command: 'cat hello.txt' } },
      { text: 'Done.' },
    ][index] ?? { text: 'Done.' });
    const { host, runtime, project, events } = await setup(scripted);
    const workspace = await configure(runtime, project);
    const session = await host.createSession(workspace.id);
    await host.setSessionOptions(session.id, { permissionMode: 'accept-edits' });
    await host.sendPrompt(session.id, 'Create hello.txt');
    const asked = await waitFor(events, event => event.body.type === 'approval.requested');
    expect(asked.body).toMatchObject({ action: expect.stringContaining('cat hello.txt') });
    expect(events.filter(event => event.body.type === 'approval.requested')).toHaveLength(1);
    expect(await readFile(path.join(project, 'hello.txt'), 'utf8')).toBe('Hi\n');
    await host.resolveApproval(session.id, (asked.body as { approvalId: string }).approvalId, 'reject');
    await turnDone(runtime, events, session.id);
  });

  it('ask mode asks before an edit even where the workspace allows edits, and the choice is saved with the session', async () => {
    const scripted = endpoint((_body, index) => (index === 0 ? { call: 'write_file', args: { path: 'hello.txt', content: 'Hi\n' } } : { text: 'Stopped.' }));
    const { host, runtime, project, events } = await setup(scripted);
    const workspace = await configure(runtime, project, { permissions: { fileWrite: 'allow', commands: 'allow' } });
    const session = await host.createSession(workspace.id);
    const changed = await host.setSessionOptions(session.id, { permissionMode: 'ask' });
    expect(changed.options).toEqual({ permissionMode: 'ask' });
    await host.sendPrompt(session.id, 'Create hello.txt');
    const asked = await waitFor(events, event => event.body.type === 'approval.requested');
    expect(asked.body).toMatchObject({ action: expect.stringContaining('hello.txt') });
    await host.resolveApproval(session.id, (asked.body as { approvalId: string }).approvalId, 'reject');
    await turnDone(runtime, events, session.id);
    expect(existsSync(path.join(project, 'hello.txt'))).toBe(false);
    expect((await host.getState()).sessions.find(item => item.id === session.id)?.options).toEqual({ permissionMode: 'ask' });
  });

  it('refuses unknown modes, and Hermes sessions accept only the workspace mode', async () => {
    const { host, runtime, project } = await setup(endpoint(() => ({ text: 'x' })));
    const workspace = await configure(runtime, project);
    const session = await host.createSession(workspace.id);
    await expect(host.setSessionOptions(session.id, { permissionMode: 'yolo' as never })).rejects.toThrow(/permission mode/);
    await expect(host.createSession(workspace.id, { permissionMode: 'allow' as never })).rejects.toThrow(/permission mode/);

    await host.saveWorkspace({ name: 'Hermes', projectLocation: project, runtimeId: 'hermes', runtimeProfileId: 'default', permissions: { fileWrite: 'ask', commands: 'ask' } });
    const hermes = (await host.getState()).workspaces.find(item => item.runtimeId === 'hermes')!;
    await expect(host.createSession(hermes.id, { permissionMode: 'plan' })).rejects.toThrow(/Hermes Agent manages its own approvals/);
    const plain = await host.createSession(hermes.id, { permissionMode: 'workspace' });
    await expect(host.setSessionOptions(plain.id, { permissionMode: 'accept-edits' })).rejects.toThrow(/Hermes Agent manages its own approvals/);
  });
});
