import { createAgentHost, type AgentHostRuntime } from '@extalia/host';
import type { HostMissionRun } from '@extalia/platform';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startBridgeServer, TOKEN_HEADER, type BridgeServer } from '../src/bridge/server.js';

describe('native missions through the authenticated Bridge', () => {
  it('starts, reads and cancels a session-scoped mission without exposing it to foreign callers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'extalia-mission-rpc-'));
    let runtime: AgentHostRuntime | undefined, server: BridgeServer | undefined;
    let requests = 0;
    try {
      const project = path.join(root, 'project'), home = path.join(root, 'home'), webRoot = path.join(root, 'web');
      await Promise.all([project, home, webRoot].map(folder => mkdir(folder, { recursive: true })));
      runtime = await createAgentHost({
        kind: 'bridge', version: 'test', dataDirectory: path.join(root, 'data'), homeDirectory: home, importHome: home,
        env: { EXTALIA_SECRET_STORE: 'memory' },
        fetch: async (_input, init) => {
          requests++;
          return new Promise<Response>((_resolve, reject) => {
            if (init?.signal?.aborted) reject(new Error('Request cancelled.'));
            else init?.signal?.addEventListener('abort', () => reject(new Error('Request cancelled.')), { once: true });
          });
        },
      });
      const host = runtime.host;
      let state = await host.saveConnection({
        name: 'Provider', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'model-a', credential: { kind: 'none' },
        features: { memory: 'off', skills: 'off' }, orchestration: { enabled: false, maxDelegations: 0, tiers: {} },
      });
      const connectionId = state.connections[0]!.id;
      state = await host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId, permissions: { fileWrite: 'ask', commands: 'ask' } });
      const workspaceId = state.workspaces[0]!.id;
      const session = await host.createSession(workspaceId), other = await host.createSession(workspaceId);
      server = await startBridgeServer({
        port: 0, webRoot, agents: async () => host,
        updates: {
          status: () => ({ current: 'test', state: 'idle', channel: 'stable' }),
          check: async () => ({ current: 'test', state: 'idle', channel: 'stable' }),
          install: async () => ({ current: 'test', state: 'idle', channel: 'stable' }),
        },
      });
      const bridge = server;
      const call = (method: string, args: unknown[], extraHeaders: Record<string, string> = {}) => fetch(new URL('/api/call', bridge.url), {
        method: 'POST', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: bridge.token, ...extraHeaders },
        body: JSON.stringify({ method, args }),
      });
      const request = { title: 'Inspect project', tasks: [{ id: 'inspect', title: 'Inspect', instructions: 'Read the project structure.', connectionId, model: 'model-a', dependsOn: [], timeoutMs: 10_000 }] };
      expect((await call('startNativeMission', [session.id, request], { [TOKEN_HEADER]: 'incorrect' })).status).toBe(401);
      expect((await call('startNativeMission', [session.id, request], { origin: 'https://example.com' })).status).toBe(403);
      expect(requests).toBe(0);

      const permitted = await call('setWorkspaceMissionConnections', [workspaceId, []]);
      expect(permitted.status).toBe(200);
      const started = await call('startNativeMission', [session.id, request]);
      expect(started.status).toBe(200);
      const run = (await started.json() as { result: HostMissionRun }).result;
      expect(run).toMatchObject({ sessionId: session.id, workspaceId, state: 'running' });
      await vi.waitFor(() => expect(requests).toBe(1), { timeout: 5000 });
      expect((await call('nativeMissionRun', [other.id, run.id])).status).toBe(500);
      const inspection = await call('refreshNativeMissionRecovery', [session.id, run.id]);
      expect(inspection.status).toBe(200);
      expect(await inspection.json()).toMatchObject({ result: { status: 'quarantined', reason: 'local-active', run: { id: run.id } } });
      expect((await call('refreshNativeMissionRecovery', [other.id, run.id])).status).toBe(500);
      const known = await call('listNativeMissions', [session.id]);
      expect((await known.json() as { result: HostMissionRun[] }).result.map(value => value.id)).toContain(run.id);
      expect((await call('cancel', [session.id])).status).toBe(200);
      await vi.waitFor(async () => {
        const response = await call('nativeMissionRun', [session.id, run.id]);
        expect(response.status).toBe(200);
        expect((await response.json() as { result: HostMissionRun }).result.state).toBe('cancelled');
      }, { timeout: 5000 });
      // The run reports cancelled before the session reservation is released (terminal metadata is flushed first).
      await vi.waitFor(() => expect(runtime!.isBusy()).toBe(false), { timeout: 5000 });
    } finally {
      await server?.close();
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
