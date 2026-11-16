import { createServer, type Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { GeneralSchedule } from '@extalia/platform';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { SessionStore } from '../src/sessions.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs(), servers = new Set<Server>(), runtimes = new Set<AgentHostRuntime>();
const task = 'Review this local project once the upstream model is available.';
async function closeServer(server: Server): Promise<void> {
  if (!server.listening) { servers.delete(server); return; }
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  servers.delete(server);
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear();
  await Promise.all([...servers].map(closeServer));
});
async function listen(server: Server, port = 0): Promise<number> {
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback listener did not expose a TCP port.');
  return address.port;
}
function refusedConnection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ((error as Error & { code?: unknown }).code === 'ECONNREFUSED') return true;
  if (error instanceof AggregateError) return error.errors.some(refusedConnection);
  return error.cause !== undefined && refusedConnection(error.cause);
}
function userTexts(messages: readonly unknown[]): string[] {
  return messages.flatMap(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return [];
    const value = message as Record<string, unknown>;
    return value.role === 'user' && typeof value.text === 'string' ? [value.text] : [];
  });
}

it('recovers through a real loopback router after its upstream TCP listener stops and returns', async () => {
  // Keep both HTTP hops local even in environments that enable proxy routing.
  vi.stubEnv('NO_PROXY', '127.0.0.1,localhost,::1');
  let upstreamRequests = 0;
  const makeUpstream = () => createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume this local fixture request */ }
    upstreamRequests++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Local upstream review completed.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  let upstream = makeUpstream(); const upstreamPort = await listen(upstream);
  const failures: unknown[] = [], bodies: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
  let headRequests = 0;
  const router = createServer(async (request, response) => {
    if (request.method === 'HEAD') { headRequests++; response.writeHead(204); response.end(); return; }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    let body = ''; for await (const chunk of request) body += String(chunk);
    bodies.push(JSON.parse(body) as { messages: Array<{ role: string; content?: string }> });
    try {
      const result = await fetch(`http://127.0.0.1:${upstreamPort}/completion`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(2_000),
      });
      response.writeHead(result.status, { 'content-type': 'text/event-stream' }); response.end(await result.text());
    } catch (error) {
      failures.push(error); response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'The local fixture upstream is unavailable.' } }));
    }
  });
  const routerPort = await listen(router);
  await closeServer(upstream);

  const root = await temp('extalia-upstream-http-'), home = `${root}/home`, project = `${root}/project`;
  await mkdir(home); await mkdir(project);
  // No injected fetch: both the schedule HEAD and model POST use the real Node HTTP transport.
  const options = { kind: 'bridge' as const, version: 'test', dataDirectory: `${root}/data`, homeDirectory: home, importHome: home,
    env: { EXTALIA_SECRET_STORE: 'memory', PATH: '' }, observationIntervalMs: 60_000 };
  let runtime = await createAgentHost(options); runtimes.add(runtime);
  const connection = (await runtime.host.saveConnection({ name: 'Loopback router', preset: 'custom', api: 'openai-chat',
    baseUrl: `http://127.0.0.1:${routerPort}/v1`, model: 'fixture-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } })).connections[0]!;
  const workspace = (await runtime.host.saveWorkspace({ name: 'Loopback project', projectLocation: project, connectionId: connection.id,
    permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
  await runtime.host.createSession(workspace.id);
  await runtime.host.saveSchedule!({ workspaceId: workspace.id, name: 'Upstream review', prompt: task, trigger: { kind: 'interval', intervalMinutes: 60 },
    sessionTarget: { mode: 'new-each-run' }, missedPolicy: 'run-once' });
  const file = `${root}/data/config/schedules.json`, store = new SessionStore(`${root}/data/sessions`);
  type Jobs = { schedules: GeneralSchedule[]; recoveries?: Array<{ retryAt: string; retryContext?: { sessionId: string; historySha256: string } }> };
  const readJobs = async () => JSON.parse(await readFile(file, 'utf8')) as Jobs;
  const restartDue = async (retry = false) => {
    await runtime.close(); runtimes.delete(runtime);
    const saved = await readJobs(), due = new Date(Date.now() - (retry ? 1_000 : 2 * 60_000)).toISOString();
    saved.schedules[0]!.nextRunAt = due; if (retry) saved.recoveries![0]!.retryAt = due;
    await writeFile(file, JSON.stringify(saved));
    runtime = await createAgentHost(options); runtimes.add(runtime);
  };
  await restartDue();
  await vi.waitFor(async () => expect((await runtime.host.listSchedules!()).schedules[0]!.recovery?.reason).toBe('connection-unavailable'), { timeout: 5_000, interval: 10 });
  await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 5_000, interval: 10 });
  const queued = await readJobs(), retained = queued.recoveries![0]!.retryContext!;
  expect(failures).toHaveLength(1); expect(refusedConnection(failures[0])).toBe(true);
  expect(queued.schedules[0]!.runCount).toBe(0); expect(retained.sessionId).toBe(queued.schedules[0]!.lastSessionId);
  expect(userTexts(await store.readMessages(retained.sessionId))).toEqual([task]);
  expect((await runtime.host.getState()).sessions.filter(session => session.workspaceId === workspace.id)).toHaveLength(2);

  upstream = makeUpstream(); await listen(upstream, upstreamPort);
  await restartDue(true);
  await vi.waitFor(async () => expect((await runtime.host.listSchedules!()).schedules[0]!.runCount).toBe(1), { timeout: 5_000, interval: 10 });
  await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 5_000, interval: 10 });
  const restored = await readJobs();
  expect(restored.recoveries ?? []).toEqual([]); expect(restored.schedules[0]!.lastSessionId).toBe(retained.sessionId);
  expect(Date.parse(restored.schedules[0]!.nextRunAt!)).toBeGreaterThan(Date.now());
  expect(userTexts(await store.readMessages(retained.sessionId))).toEqual([task]);
  expect((await runtime.host.getState()).sessions.filter(session => session.workspaceId === workspace.id)).toHaveLength(2);
  expect(headRequests).toBe(2); expect(bodies).toHaveLength(2); expect(upstreamRequests).toBe(1);
  for (const body of bodies) expect(body.messages.filter(message => message.role === 'user' && message.content === task)).toHaveLength(1);
}, 20_000);
