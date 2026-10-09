import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentHost } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();

describe('project registration and session persistence', () => {
  it('validates two project folders and restores each project’s sessions independently after restart', async () => {
    const root = await temp(), alpha = path.join(root, 'alpha'), beta = path.join(root, 'beta');
    await mkdir(alpha); await mkdir(beta);
    await writeFile(path.join(alpha, 'example.txt'), 'Original project content');
    const options = { kind: 'bridge' as const, version: 'test', dataDirectory: path.join(root, 'data'), importHome: path.join(root, 'home'), env: { EXTALIA_SECRET_STORE: 'memory' } };
    let runtime = await createAgentHost(options);
    try {
      const checked = await runtime.host.checkFolder(alpha);
      expect(checked).toMatchObject({ ok: true, name: 'alpha' });
      expect(await runtime.host.checkFolder(path.join(root, 'missing'))).toMatchObject({ ok: false });
      const connected = await runtime.host.saveConnection({ name: 'Test model', preset: 'custom', api: 'openai-chat', baseUrl: 'http://mock.test/v1', model: 'test-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
      const connectionId = connected.connections[0]!.id;
      for (const [name, projectLocation] of [['Alpha', alpha], ['Beta', beta]]) await runtime.host.saveWorkspace({ name: name!, projectLocation: projectLocation!, connectionId, permissions: { fileWrite: 'ask', commands: 'ask' } });
      const configured = await runtime.host.completeSetup();
      const a = configured.workspaces.find(workspace => workspace.name === 'Alpha')!, b = configured.workspaces.find(workspace => workspace.name === 'Beta')!;
      expect(a.projectLocation).toBe(checked.path);
      const first = await runtime.host.createSession(a.id), second = await runtime.host.createSession(b.id);
      await runtime.host.renameSession(first.id, 'Alpha task'); await runtime.host.renameSession(second.id, 'Beta task');
      await expect(runtime.host.createSession('missing')).rejects.toThrow();
      await runtime.close();
      runtime = await createAgentHost(options);
      const restored = await runtime.host.getState();
      expect(restored.setupComplete).toBe(true);
      expect(restored.workspaces).toHaveLength(2);
      expect(restored.sessions.filter(session => session.workspaceId === a.id)).toMatchObject([{ id: first.id, title: 'Alpha task' }]);
      expect(restored.sessions.filter(session => session.workspaceId === b.id)).toMatchObject([{ id: second.id, title: 'Beta task' }]);
      expect((await runtime.host.sessionEvents(first.id))[0]?.body.type).toBe('session.started');
      expect(await readFile(path.join(alpha, 'example.txt'), 'utf8')).toBe('Original project content');
    } finally { await runtime.close(); }
  });
});
