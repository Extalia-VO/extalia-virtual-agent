import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentHost } from '../src/service.js';
import { workspaceForProject } from '../src/observedWorkspace.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const T = '2026-10-08T00:00:00.000Z';
const T1 = '2026-10-08T00:00:01.000Z';

describe('workspaceForProject', () => {
  const workspaces = [
    { id: 'site', projectLocation: '/work/site/' },
    { id: 'nested', projectLocation: '/work/site/packages/api' },
    { id: 'none' },
  ];

  it('matches equal and containing project locations, ignoring trailing slashes', () => {
    expect(workspaceForProject(workspaces, '/work/site')).toBe('site');
    expect(workspaceForProject(workspaces, '/work/site/')).toBe('site');
    expect(workspaceForProject(workspaces, '/work/site/src/ui')).toBe('site');
  });

  it('prefers the deepest workspace and never matches a sibling prefix', () => {
    expect(workspaceForProject(workspaces, '/work/site/packages/api/src')).toBe('nested');
    expect(workspaceForProject(workspaces, '/work/site-two')).toBeUndefined();
    expect(workspaceForProject(workspaces, '/work')).toBeUndefined();
  });

  it('is case-sensitive and tolerates missing paths', () => {
    expect(workspaceForProject(workspaces, '/Work/Site')).toBeUndefined();
    expect(workspaceForProject(workspaces, undefined)).toBeUndefined();
    expect(workspaceForProject(workspaces, '')).toBeUndefined();
  });
});

describe('observed sessions in host state', () => {
  it('maps an observed session to the workspace that contains its project path', async () => {
    const root = await temp();
    const project = path.join(root, 'site');
    await mkdir(path.join(project, 'src'), { recursive: true });
    const home = path.join(root, 'home');
    const sessions = path.join(home, '.codex', 'sessions', '2026', '10', '08');
    await mkdir(sessions, { recursive: true });
    const lines = [
      { type: 'session_meta', payload: { id: 'codex-9', cwd: path.join(project, 'src'), timestamp: T } },
      { timestamp: T, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add a footer' }] } },
      { timestamp: T1, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Footer added.' }] } },
    ];
    await writeFile(path.join(sessions, 'rollout-a.jsonl'), lines.map(line => JSON.stringify(line)).join('\n'));
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: path.join(root, 'data'), importHome: home, env: { EXTALIA_SECRET_STORE: 'memory' }, observationIntervalMs: 60_000 });
    try {
      const { host } = runtime;
      const scan = await host.scanImports(['codex']);
      let state = await host.observeImports(scan.scanId, scan.sessions.filter(session => session.supported).map(session => session.id));
      expect(state.sessions.find(session => session.control === 'observed')?.workspaceId).toBe('');

      state = await host.saveConnection({ name: 'Local', preset: 'custom', api: 'openai-chat', baseUrl: 'http://mock.test/v1', model: 'm', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
      state = await host.saveWorkspace({ name: 'Site', projectLocation: `${project}/`, connectionId: state.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
      const observed = state.sessions.find(session => session.control === 'observed');
      expect(observed?.workspaceId).toBe(state.workspaces[0]!.id);
      expect(observed?.observation?.projectPath).toBe(path.join(project, 'src'));
    } finally { await runtime.close(); }
  });
});
