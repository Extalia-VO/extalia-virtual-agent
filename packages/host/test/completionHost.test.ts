import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ExtaliaEvent, type EventBody } from '@extalia/protocol';
import { createProvider, ProviderError, runTurn, type AnyTool } from '@extalia/runtime';
import { createAgentHost } from '../src/service.js';
import { RustCompletion } from '../src/daemon/completion.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function serverFixture(handler: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => void) {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-native-complete-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => handler(request, response, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
  const baseUrl = `http://127.0.0.1:${address.port}/custom/v1`;
  return { root, server, baseUrl };
}
function sse(response: ServerResponse, chunks: unknown[]) {
  response.setHeader('content-type', 'text/event-stream');
  response.end(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
}

describe.skipIf(!HAS_DAEMON)('Explicit Rust completion HTTP experiment', () => {
  it('uses an explicit Rust port for Chat and discovery fallback despite an injected fetch', async () => {
    const received: { url: string; authorization?: string; memory?: string | string[]; body: Record<string, unknown> }[] = [];
    const { root, baseUrl } = await serverFixture((request, response, body) => {
      received.push({ url: request.url!, authorization: request.headers.authorization, memory: request.headers['x-omniroute-no-memory'], body });
      if (request.url?.endsWith('/models')) { response.statusCode = 404; response.end(); }
      else sse(response, [{ choices: [{ delta: { content: 'Hello from Rust.' }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } }]);
    });
    const home = path.join(root, 'home'), project = path.join(root, 'project'); await Promise.all([mkdir(home), mkdir(project)]);
    const fetch = vi.fn(async () => { throw new Error('JavaScript provider HTTP must never run'); });
    const completion = new RustCompletion({ binary: () => DAEMON_BINARY, directory: root, clientVersion: 'test' });
    cleanup.push(() => completion.close());
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: path.join(root, 'data'), homeDirectory: home, importHome: home,
      env: { EXTALIA_DAEMON_PATH: DAEMON_BINARY, EXTALIA_SECRET_STORE: 'memory', HOME: home, PATH: '' }, fetch, completion: completion.complete });
    cleanup.push(() => runtime.close());
    const input = { name: 'Synthetic endpoint', preset: 'omniroute' as const, api: 'openai-chat' as const, baseUrl, model: 'model-a', credential: { kind: 'none' as const }, features: { memory: 'extalia' as const, skills: 'extalia' as const } };
    expect(await runtime.host.testConnection(input, 'synthetic-provider-key')).toMatchObject({ ok: true });
    expect(received.slice(0, 2).map(item => item.url)).toEqual(['/custom/v1/models', '/custom/v1/chat/completions']);
    expect(received[1]).toMatchObject({ authorization: 'Bearer synthetic-provider-key', memory: 'true' });
    const connection = (await runtime.host.saveConnection(input)).connections[0]!;
    const workspace = (await runtime.host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: connection.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
    const session = await runtime.host.createSession(workspace.id);
    const events: ExtaliaEvent[] = []; runtime.host.subscribe(event => events.push(event));
    await runtime.host.sendPrompt(session.id, 'Say hello.');
    await vi.waitFor(() => expect(events.some(event => event.body.type === 'turn.completed')).toBe(true));
    expect(events.some(event => event.body.type === 'model.delta' && event.body.text === 'Hello from Rust.')).toBe(true);
    expect(received.at(-1)?.body).toMatchObject({ model: 'model-a', stream: true, stream_options: { include_usage: true } });
    expect(received.at(-1)?.authorization).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves real HTTP tools, images, usage negotiation and secret-safe errors without profile initialization', async () => {
    const bodies: Record<string, unknown>[] = [];
    const { root, baseUrl } = await serverFixture((_request, response, body) => {
      bodies.push(body);
      if (body.stream_options) { response.statusCode = 400; response.end(JSON.stringify({ error: { message: 'stream_options unsupported' } })); return; }
      sse(response, [
        { model: 'reported-model', choices: [{ delta: { content: 'Checking ' } }] },
        { choices: [{ delta: { content: 'now.', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } } },
      ]);
    });
    const client = new RustCompletion({ binary: () => DAEMON_BINARY, directory: root, clientVersion: 'test' }); cleanup.push(() => client.close());
    const provider = createProvider({ preset: 'custom', api: 'openai-chat', baseUrl, model: 'requested-model', features: { memory: 'off', skills: 'off' } }, 'fixture-key', undefined, undefined, client.complete);
    const request = { system: 'sys', messages: [{ role: 'user' as const, text: '', images: [{ mimeType: 'image/png' as const, data: 'aW1hZ2U=' }] }], tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' as const, properties: {} } }] };
    const deltas: string[] = [];
    const result = await provider.complete({ ...request, onText: delta => deltas.push(delta) });
    expect(result).toMatchObject({ text: 'Checking now.', model: 'reported-model', stop: 'tool_use', toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }], usage: { inputTokens: 12, outputTokens: 5, cachedInputTokens: 4 }, promptTokens: 12 });
    expect(deltas.join('')).toBe(result.text);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }, { type: 'text', text: 'Attached image.' }] }]);
    await provider.complete(request); expect(bodies).toHaveLength(3); expect(bodies[2]?.stream_options).toBeUndefined();
    expect(await readdir(root)).toEqual([]); expect(client.pendingCount).toBe(0);
  });

  it('cancels a real delayed stream and drains local children before shutdown returns', async () => {
    let entered!: () => void; const accepted = new Promise<void>(resolve => { entered = resolve; });
    const { root, baseUrl } = await serverFixture((_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); entered(); });
    const client = new RustCompletion({ binary: () => DAEMON_BINARY, directory: root, clientVersion: 'test' }); cleanup.push(() => client.close());
    const pending = client.complete({ baseUrl, model: 'model-a' }, { system: '', messages: [], tools: [] }, true).catch(error => error);
    await accepted; expect(client.pendingCount).toBe(1); await client.close();
    expect(await pending).toBeInstanceOf(ProviderError); expect(await pending).toMatchObject({ retryable: false }); expect(client.pendingCount).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });

  it('never executes a valid tool call from a provider-filtered response', async () => {
    const { root, baseUrl } = await serverFixture((_request, response) => sse(response, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'filtered-call', function: {
        name: 'write_file', arguments: '{"path":"fixture.txt","content":"filtered"}',
      } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'content_filter' }] },
    ]));
    const client = new RustCompletion({ binary: () => DAEMON_BINARY, directory: root, clientVersion: 'test' }); cleanup.push(() => client.close());
    const provider = createProvider({ preset: 'custom', api: 'openai-chat', baseUrl, model: 'filtered-model',
      features: { memory: 'off', skills: 'off' } }, undefined, undefined, undefined, client.complete);
    const execute = vi.fn(async () => ({ ok: true, output: 'Unexpected execution' }));
    const tool: AnyTool = { name: 'write_file', description: 'Synthetic write', access: 'write', kind: 'edit',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      describe: () => ({ label: 'Synthetic write' }), run: execute };
    const events: EventBody[] = [];
    const turn = await runTurn({ provider, system: 'Synthetic test', history: [], prompt: 'Write the fixture.', tools: [tool],
      permissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: new Set(), requestApproval: async () => 'once',
      signal: new AbortController().signal, emit: event => events.push(event) });
    expect(turn.outcome).toBe('refused');
    expect(execute).not.toHaveBeenCalled();
    expect(events.some(event => event.type === 'tool.started')).toBe(false);
  });
});

// This production-route test deliberately has no native completion binary or injected completion port.
describe('Measured TypeScript completion default', () => {
  it('uses the host fetch adapter for a real Chat request without launching a native completion worker', async () => {
    const received: string[] = [];
    const { root, baseUrl } = await serverFixture((request, response) => {
      received.push(request.url!);
      sse(response, [{ choices: [{ delta: { content: 'Hello from TypeScript.' }, finish_reason: 'stop' }] }]);
    });
    const home = path.join(root, 'home'), project = path.join(root, 'project'); await Promise.all([mkdir(home), mkdir(project)]);
    const fetch = vi.fn(async (url: string, init?: RequestInit) => globalThis.fetch(url, init));
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: path.join(root, 'data'), homeDirectory: home, importHome: home,
      env: { EXTALIA_DAEMON_PATH: path.join(root, 'missing-native-binary'), EXTALIA_SECRET_STORE: 'memory', HOME: home, PATH: '' }, fetch });
    cleanup.push(() => runtime.close());
    const connection = (await runtime.host.saveConnection({ name: 'Synthetic endpoint', preset: 'custom', api: 'openai-chat', baseUrl, model: 'model-a',
      credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } })).connections[0]!;
    const workspace = (await runtime.host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: connection.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
    const session = await runtime.host.createSession(workspace.id);
    const events: ExtaliaEvent[] = []; runtime.host.subscribe(event => events.push(event));
    await runtime.host.sendPrompt(session.id, 'Say hello.');
    await vi.waitFor(() => expect(events.some(event => event.body.type === 'turn.completed')).toBe(true));
    expect(events.some(event => event.body.type === 'model.delta' && event.body.text === 'Hello from TypeScript.')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1); expect(received).toEqual(['/custom/v1/chat/completions']);
  });
});
