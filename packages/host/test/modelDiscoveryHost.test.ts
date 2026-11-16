import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentHost } from '../src/service.js';
import { DAEMON_BINARY, HAS_DAEMON, queryCore } from './daemonBackend.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void, rustPlanning = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-native-models-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), project = path.join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/models')) throw new Error('JavaScript discovery must not run');
    return Response.json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] });
  });
  const runtime = await createAgentHost({
    kind: 'bridge', version: 'test', dataDirectory: path.join(root, 'data'), homeDirectory: home, importHome: home,
    env: { EXTALIA_DAEMON_PATH: DAEMON_BINARY, EXTALIA_SECRET_STORE: 'memory', HOME: home, PATH: '', OPENAI_API_KEY: 'unused-environment-credential', ...(rustPlanning ? { EXTALIA_NATIVE_CORE: 'rust' } : {}) },
    fetch, observationIntervalMs: 60000,
  });
  cleanup.push(() => runtime.close());
  const input = { name: 'Synthetic endpoint', preset: 'omniroute' as const, api: 'openai-chat' as const,
    baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'model-a', credential: { kind: 'none' as const },
    features: { memory: 'extalia' as const, skills: 'extalia' as const } };
  return { runtime, host: runtime.host, input, fetch, project, data: path.join(root, 'data') };
}

describe.skipIf(!HAS_DAEMON)('Native host uses Rust model catalog HTTP', () => {
  it('tests credentials and supplies model selectors without the injected JavaScript fetch', async () => {
    const requests: { url: string | undefined; authorization: string | undefined; noMemory: string | string[] | undefined }[] = [];
    const env = await fixture((request, response) => {
      requests.push({ url: request.url, authorization: request.headers.authorization, noMemory: request.headers['x-omniroute-no-memory'] });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-b' }, { id: '--invalid' }] }));
    });
    expect(await env.host.testConnection(env.input, 'explicit-discovery-key')).toMatchObject({ ok: true, models: ['model-a', 'model-b'] });
    expect(requests[0]).toEqual({ url: '/v1/models', authorization: 'Bearer explicit-discovery-key', noMemory: 'true' });
    const connection = (await env.host.saveConnection(env.input)).connections[0]!;
    const workspace = (await env.host.saveWorkspace({ name: 'Project', projectLocation: env.project, connectionId: connection.id,
      permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
    expect(await env.host.modelChoices(workspace.id)).toMatchObject({ models: ['model-a', 'model-b'] });
    const count = requests.length;
    expect(await env.host.modelChoices(workspace.id)).toMatchObject({ models: ['model-a', 'model-b'] });
    expect(requests).toHaveLength(count);
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it.each([404, 405, 501])('retains the explicit inference fallback for HTTP %s only', async status => {
    const requests: string[] = [];
    const env = await fixture((request, response) => {
      requests.push(request.url ?? '');
      if (request.url?.endsWith('/chat/completions')) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
      } else { response.statusCode = status; response.end('Unsupported catalog'); }
    });
    expect(await env.host.testConnection(env.input)).toMatchObject({ ok: true });
    expect(requests).toEqual(['/v1/models']);
    expect(env.fetch).toHaveBeenCalledTimes(1);
    expect(env.fetch.mock.calls[0]![0]).toMatch(/\/chat\/completions$/);
  });

  it.each([401, 403, 500])('refuses HTTP %s without inference or echoed credentials', async status => {
    const env = await fixture((_request, response) => { response.statusCode = status; response.end('explicit-discovery-key'); });
    const result = await env.host.testConnection(env.input, 'explicit-discovery-key');
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('explicit-discovery-key');
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed provider JSON without using completion as a fallback', async () => {
    const env = await fixture((_request, response) => { response.end('{bad json'); });
    expect(await env.host.testConnection(env.input)).toMatchObject({ ok: false, error: expect.stringContaining('invalid_response') });
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it('does not start discovery or fallback inference after the host closes', async () => {
    let requests = 0;
    const env = await fixture((_request, response) => { requests++; response.statusCode = 404; response.end(); });
    await env.runtime.close();
    expect(await env.host.testConnection(env.input)).toMatchObject({ ok: false, error: expect.stringMatching(/closing|closed|shutting/) });
    expect(requests).toBe(0);
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it('keeps real planning admission through a delayed Rust catalog and cancels without inference', async () => {
    let entered!: () => void, disconnected!: () => void;
    const accepted = new Promise<void>(resolve => { entered = resolve; });
    const socketClosed = new Promise<void>(resolve => { disconnected = resolve; });
    const env = await fixture((request, _response) => {
      request.socket.once('close', disconnected);
      entered(); // Deliberately leave the HTTP response pending until the owned child is killed.
    }, true);
    const connection = (await env.host.saveConnection({ ...env.input, features: { memory: 'off', skills: 'off' } })).connections[0]!;
    const workspace = (await env.host.saveWorkspace({ name: 'Project', projectLocation: env.project,
      connectionId: connection.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
    const session = await env.host.createSession(workspace.id);
    const planning = env.host.planNativeMission(session.id, { goal: 'Inspect the project.', models: ['model-a'] })
      .then(value => ({ value }), (error: unknown) => ({ error }));
    await accepted;
    const marker = async () => JSON.parse(await readFile(path.join(env.data, 'state', 'native-planning.json'), 'utf8')) as { pending: unknown[] };
    expect(queryCore(env.data, 'SELECT invocation_id FROM planning_admissions')).toHaveLength(1);
    expect(queryCore(env.data, 'SELECT invocation_id FROM planning_observations')).toEqual([]);
    expect((await marker()).pending).toHaveLength(1);
    expect(env.runtime.isBusy()).toBe(true);
    await expect(env.host.planNativeMission(session.id, { goal: 'Overlap.' })).rejects.toThrow(/working|unresolved/);
    await env.host.cancel(session.id);
    await socketClosed;
    await planning;
    await vi.waitFor(() => expect(env.runtime.isBusy()).toBe(false));
    expect(queryCore(env.data, 'SELECT kind FROM planning_observations')).toEqual([{ kind: 'local-pipeline-settled' }]);
    expect((await marker()).pending).toEqual([]);
    expect(queryCore(env.data, 'SELECT mission_id FROM missions')).toEqual([]);
    expect(env.fetch).not.toHaveBeenCalled();
  });
});
