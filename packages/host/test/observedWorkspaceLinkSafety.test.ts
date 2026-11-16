import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const active = new Set<AgentHostRuntime>();
afterEach(async () => { await Promise.all([...active].map(runtime => runtime.close())); active.clear(); });

async function fixture(suffix: string) {
  const root = await temp('extalia-workspace-link-safety-');
  const owned = path.join(root, 'project'), project = owned + suffix, home = path.join(root, 'home');
  await mkdir(owned); if (project !== owned) await mkdir(project);
  const transcript = path.join(home, '.codex', 'sessions', 'rollout.jsonl');
  await mkdir(path.dirname(transcript), { recursive: true });
  const nativeSessionId = '22222222-2222-4222-8222-222222222222';
  await writeFile(transcript, [
    { type: 'session_meta', payload: { id: nativeSessionId, cwd: project, timestamp: '2026-01-01T00:00:00.000Z' } },
    { type: 'response_item', timestamp: '2026-01-01T00:00:01.000Z', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Project association safety fixture' }],
    } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: path.join(root, 'data'),
    homeDirectory: home, importHome: home, env: { EXTALIA_SECRET_STORE: 'memory', PATH: '' }, observationIntervalMs: 60_000 });
  active.add(runtime);
  const { host } = runtime;
  const connections = await host.saveConnection({ name: 'Fixture', preset: 'custom', api: 'openai-chat',
    baseUrl: 'http://fixture.example/v1', model: 'fixture', credential: { kind: 'none' },
    features: { memory: 'off', skills: 'off', history: true } });
  const workspaces = await host.saveWorkspace({ name: 'Owned project', projectLocation: owned,
    connectionId: connections.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
  const workspaceId = workspaces.workspaces[0]!.id;
  const scan = await host.scanImports(['codex']);
  const state = await host.observeImports(scan.scanId, scan.sessions.filter(item => item.supported).map(item => item.id));
  const observed = state.sessions.find(item => item.observation?.nativeSessionId === nativeSessionId)!;
  expect(observed).toBeDefined();
  return { runtime, host, observed, workspaceId, project, nativeSessionId };
}

describe('observed workspace association safety through the imported transcript', () => {
  it.skipIf(process.platform === 'win32').each([' ', '\\outside'])('keeps a physical sibling with suffix %j outside registered roots', async suffix => {
    const f = await fixture(suffix);
    expect(f.observed.observation?.projectPath).toBe(f.project);
    expect(f.observed.workspaceId).toBe('');
    const link = await f.host.observedWorkspaceLink!(f.observed.id);
    expect(link).toMatchObject({ mode: 'unbound', candidates: [], projectPath: f.project });
    expect(link.workspaceId).toBeUndefined();
    await expect(f.host.setObservedWorkspaceLink!(f.observed.id, { revision: link.revision, workspaceId: f.workspaceId }))
      .rejects.toThrow(/workspace|project/i);
    const unchanged = (await f.host.getState()).sessions.find(item => item.id === f.observed.id)!;
    expect(unchanged.workspaceId).toBe('');
    expect(unchanged.observation).toMatchObject({ nativeSessionId: f.nativeSessionId, projectPath: f.project });
    expect(unchanged.observation?.workspaceLink).toBeUndefined();
  });

  it('notifies idle only after the association finishes, without revisiting replacement listeners', async () => {
    const f = await fixture('');
    const link = await f.host.observedWorkspaceLink!(f.observed.id);
    expect(link).toMatchObject({ mode: 'automatic', workspaceId: f.workspaceId });
    // Initial observed-memory baseline work owns its own asynchronous lifetime.
    await vi.waitFor(() => expect(f.runtime.isBusy()).toBe(false));
    const callbacks: boolean[] = [];
    let unsubscribe: () => void = () => undefined;
    const listen = () => {
      const busy = f.runtime.isBusy(); callbacks.push(busy);
      // Mirrors the desktop restart waiter without letting a broken live-Set
      // iteration hang this regression test indefinitely.
      if (busy && callbacks.length < 3) { unsubscribe(); unsubscribe = f.runtime.onIdle(listen); }
    };
    unsubscribe = f.runtime.onIdle(listen);
    try {
      const applied = f.host.setObservedWorkspaceLink!(f.observed.id, { revision: link.revision, workspaceId: f.workspaceId });
      expect(f.runtime.isBusy()).toBe(true);
      await applied;
      // Association and the observed-memory baseline can settle independently.
      await vi.waitFor(() => expect(callbacks.length).toBeGreaterThan(0));
      expect(callbacks).not.toContain(true);
      expect(f.runtime.isBusy()).toBe(false);
      const after = await f.host.observedWorkspaceLink!(f.observed.id);
      expect(after).toMatchObject({ sessionId: f.observed.id, mode: 'explicit', workspaceId: f.workspaceId });
      expect((await f.host.getState()).sessions.find(item => item.id === f.observed.id)?.observation?.nativeSessionId).toBe(f.nativeSessionId);
    } finally { unsubscribe(); }
  });
});
