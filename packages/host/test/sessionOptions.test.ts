import type { ExtaliaEvent } from '@extalia/protocol';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const tempDir = useTempDirs();
const runtimes: AgentHostRuntime[] = [];
afterEach(async () => { while (runtimes.length) await runtimes.pop()!.close(); });

/** An endpoint stand-in: lists two models and records every request body; turns answer "Done." (OpenAI) or fail with 400 (Anthropic). */
function recordingFetch() {
  const requests: { url: string; body?: Record<string, unknown> }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (/\/models(\?|$)/.test(url)) {
      requests.push({ url });
      return Response.json({ data: [{ id: 'mock-agent', type: 'model' }, { id: 'mock-large', type: 'model' }, { id: '--not-an-id', type: 'model' }], has_more: false });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, body });
    if (url.includes('/messages')) return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'recorded' } }, { status: 400 });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch: fetch as (input: string, init?: RequestInit) => Promise<Response>, requests };
}

async function setup(root?: string, scripted = recordingFetch()) {
  const base = root ?? await tempDir();
  const project = path.join(base, 'project');
  await mkdir(project, { recursive: true });
  const runtime = await createAgentHost({ kind: 'bridge', version: '0.0.0-test', dataDirectory: path.join(base, 'data'), importHome: path.join(base, 'home'), env: { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH }, fetch: scripted.fetch });
  runtimes.push(runtime);
  const events: ExtaliaEvent[] = [];
  runtime.host.subscribe(event => events.push(event));
  return { root: base, project, runtime, host: runtime.host, events, scripted };
}

async function nativeWorkspace(host: AgentHostRuntime['host'], project: string, api: 'openai-chat' | 'anthropic-messages' = 'openai-chat') {
  const saved = await host.saveConnection({
    name: 'Mock', preset: 'custom', api, baseUrl: api === 'openai-chat' ? 'http://mock.test/v1' : 'http://mock.test', model: 'mock-agent', credential: { kind: 'none' },
    features: { memory: 'off', skills: 'off' }, ...(api === 'anthropic-messages' ? { effort: 'medium' as const } : {}),
    orchestration: { enabled: false, maxDelegations: 0, tiers: {} },
  });
  const state = await host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: saved.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
  return state.workspaces[0]!;
}

async function turnEnded(events: ExtaliaEvent[], sessionId: string, from = 0) {
  for (let i = 0; i < 500; i++) {
    if (events.slice(from).some(event => event.sessionId === sessionId && event.body.type === 'agent.state' && event.body.state === 'idle')) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('The turn did not end.');
}

async function idle(runtime: AgentHostRuntime) {
  for (let i = 0; i < 300 && runtime.isBusy(); i++) await new Promise(resolve => setTimeout(resolve, 10));
}

describe('session model and effort options (Extalia Native)', () => {
  it('lists the endpoint models once (cached), never offers effort an OpenAI-compatible endpoint cannot honour', async () => {
    const { host, project, scripted } = await setup();
    const workspace = await nativeWorkspace(host, project);
    const choices = await host.modelChoices(workspace.id);
    expect(choices).toEqual({ runtime: 'extalia-native', defaultModel: 'mock-agent', models: ['mock-agent', 'mock-large'], efforts: [], permissionModes: ['workspace', 'ask', 'accept-edits', 'plan'] });
    expect(JSON.stringify(choices)).not.toMatch(/secret|apiKey|credential/i);
    await host.modelChoices(workspace.id);
    expect(scripted.requests.filter(request => request.url.endsWith('/models'))).toHaveLength(1);
    await expect(host.modelChoices('w_missing')).rejects.toThrow(/workspace/);
    await expect(host.createSession(workspace.id, { effort: 'high' })).rejects.toThrow(/effort/);
  });

  it('validates, persists and applies the model override per turn; empty options go back to the default', async () => {
    const { root, host, runtime, project, events, scripted } = await setup();
    const workspace = await nativeWorkspace(host, project);
    for (const model of ['--yolo', 'x'.repeat(201), 'has space', 'semi;colon']) await expect(host.createSession(workspace.id, { model })).rejects.toThrow(/model id/);
    await expect(host.createSession(workspace.id, { effort: 'extreme' as never })).rejects.toThrow(/effort/);

    const session = await host.createSession(workspace.id, { model: ' mock-large ' });
    expect(session.options).toEqual({ model: 'mock-large' });
    expect((await host.sessionEvents(session.id))[0]?.body).toMatchObject({ type: 'session.started', model: 'mock-large' });
    await host.sendPrompt(session.id, 'Hello');
    await turnEnded(events, session.id);
    await idle(runtime);
    expect(scripted.requests.filter(request => request.body).at(-1)?.body?.model).toBe('mock-large');

    expect((await host.setSessionOptions(session.id, { model: '' })).options).toBeUndefined();
    const mark = events.length;
    await host.sendPrompt(session.id, 'Again');
    await turnEnded(events, session.id, mark);
    await idle(runtime);
    expect(scripted.requests.filter(request => request.body).at(-1)?.body?.model).toBe('mock-agent');

    await host.setSessionOptions(session.id, { model: 'vendor/model-3:free' });
    await expect(host.setSessionOptions('s_doesnotexist', { model: 'a' })).rejects.toThrow(/no longer exists/);
    await expect(host.setSessionOptions(session.id, { model: '-x' })).rejects.toThrow(/model id/);
    await runtimes.pop()!.close();

    // The override is saved with the session.
    const reopened = await setup(root);
    expect((await reopened.host.getState()).sessions.find(item => item.id === session.id)?.options).toEqual({ model: 'vendor/model-3:free' });
  });

  it('passes the effort override to an Anthropic Messages endpoint instead of the connection effort', async () => {
    const { host, runtime, project, events, scripted } = await setup();
    const workspace = await nativeWorkspace(host, project, 'anthropic-messages');
    const choices = await host.modelChoices(workspace.id);
    expect(choices).toMatchObject({ runtime: 'extalia-native', defaultModel: 'mock-agent', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' });

    const session = await host.createSession(workspace.id, { model: 'mock-large', effort: 'max' });
    expect(session.options).toEqual({ model: 'mock-large', effort: 'max' });
    await host.sendPrompt(session.id, 'Hello');
    await turnEnded(events, session.id);
    await idle(runtime);
    const sent = scripted.requests.filter(request => request.url.includes('/messages') && request.body).at(-1)?.body;
    expect(sent).toMatchObject({ model: 'mock-large', output_config: { effort: 'max' } });

    await host.setSessionOptions(session.id, {});
    const mark = events.length;
    await host.sendPrompt(session.id, 'Again');
    await turnEnded(events, session.id, mark);
    await idle(runtime);
    expect(scripted.requests.filter(request => request.url.includes('/messages') && request.body).at(-1)?.body).toMatchObject({ model: 'mock-agent', output_config: { effort: 'medium' } });
  });
});

/** A stand-in `hermes`: `chat --help` prints a usage text (with `--reasoning` unless the name ends in `-old`); a turn records its arguments. */
const FAKE_HERMES = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write('usage: hermes chat [-m MODEL]' + (__filename.endsWith('-old') ? '' : ' [--reasoning LEVEL]') + '\\n');
  process.exit(0);
}
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(path.join(process.env.HERMES_HOME, 'calls.jsonl'), JSON.stringify({ args }) + '\\n');
  const out = record => process.stdout.write(JSON.stringify(record) + '\\n');
  out({ type: 'system', subtype: 'init', model: 'fake/model', session_id: 'fake_session_1' });
  out({ type: 'text', text: 'Done.' });
  out({ type: 'result', session_id: 'fake_session_1', exit_code: 0, text: 'Done.', tokens: { input: 1, output: 1, total: 2, cache_read: 0, cache_write: 0 }, duration_ms: 1 });
});
`;

async function hermesSetup(name: string) {
  const root = await tempDir();
  const home = path.join(root, 'home'), hermesHome = path.join(home, '.hermes'), project = path.join(root, 'project'), bin = path.join(root, 'bin');
  for (const directory of [project, path.join(hermesHome, 'profiles', 'work'), bin]) await mkdir(directory, { recursive: true });
  await writeFile(path.join(hermesHome, 'profiles', 'work', 'config.yaml'), 'model:\n  default: example/default-model\n  provider: openrouter\n');
  const executable = path.join(bin, name);
  await writeFile(executable, FAKE_HERMES);
  await chmod(executable, 0o755);
  const env = { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH, HOME: home, HERMES_HOME: hermesHome, EXTALIA_HERMES_BIN: executable };
  const runtime = await createAgentHost({ kind: 'bridge', version: '0.0.0-test', dataDirectory: path.join(root, 'data'), importHome: home, env });
  runtimes.push(runtime);
  const events: ExtaliaEvent[] = [];
  runtime.host.subscribe(event => events.push(event));
  const state = await runtime.host.saveWorkspace({ name: 'Project', projectLocation: project, runtimeId: 'hermes', runtimeProfileId: 'work', permissions: { fileWrite: 'ask', commands: 'ask' } });
  const calls = async () => (await readFile(path.join(hermesHome, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { args: string[] });
  return { runtime, host: runtime.host, events, workspace: state.workspaces[0]!, calls };
}

describe('session model and effort options (Hermes Agent)', { timeout: 30_000 }, () => {
  it('passes the model and, when Hermes supports it, the reasoning effort on the command line', async () => {
    const { runtime, host, events, workspace, calls } = await hermesSetup('hermes');
    expect(await host.modelChoices(workspace.id)).toEqual({ runtime: 'hermes', defaultModel: 'example/default-model', models: [], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], permissionModes: ['workspace'] });
    const session = await host.createSession(workspace.id, { model: 'example/model-x', effort: 'high' });
    expect(session.options).toEqual({ model: 'example/model-x', effort: 'high' });
    await host.sendPrompt(session.id, 'Hello');
    await turnEnded(events, session.id);
    await idle(runtime);
    const [first] = await calls();
    expect(first!.args).toEqual(expect.arrayContaining(['--model=example/model-x', '--reasoning=high']));
    expect(first!.args).not.toContain('--help');
  });

  it('offers no effort for a Hermes version without --reasoning and refuses one', async () => {
    const { runtime, host, events, workspace, calls } = await hermesSetup('hermes-old');
    expect((await host.modelChoices(workspace.id)).efforts).toEqual([]);
    await expect(host.createSession(workspace.id, { effort: 'low' })).rejects.toThrow(/Hermes Agent version/);
    const session = await host.createSession(workspace.id, { model: 'example/model-y' });
    await host.sendPrompt(session.id, 'Hello');
    await turnEnded(events, session.id);
    await idle(runtime);
    const [first] = await calls();
    expect(first!.args).toContain('--model=example/model-y');
    expect(first!.args.some(arg => arg.startsWith('--reasoning'))).toBe(false);
  });
});
