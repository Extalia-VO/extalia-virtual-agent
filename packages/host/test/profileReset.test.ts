import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { emptyProfile } from '../src/profile.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();

describe('profile deletion after host shutdown', () => {
  it.each(['bridge', 'desktop'] as const)('starts %s empty after deletion without restoring external history or old settings', async kind => {
    const home = await temp('extalia-profile-reset-');
    const dataDirectory = path.join(home, '.extalia-vo');
    const project = path.join(home, 'project');
    const transcripts = path.join(home, '.codex', 'sessions');
    await mkdir(project);
    await writeFile(path.join(project, 'work.txt'), 'Keep the project files.\n');
    await mkdir(transcripts, { recursive: true });
    const source = path.join(transcripts, 'rollout-example.jsonl');
    const stamp = new Date().toISOString();
    const transcript = [
      { type: 'session_meta', payload: { id: 'source-example', cwd: project, timestamp: stamp } },
      { timestamp: stamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the example project' }] } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n';
    await writeFile(source, transcript);
    const options = { kind, version: 'test', homeDirectory: home, importHome: home,
      env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_HERMES_BIN: path.join(home, 'not-installed') } };
    let runtime: AgentHostRuntime | undefined;
    try {
      runtime = await createAgentHost(options);
      const configured = await runtime.host.saveConnection({ name: 'Example', preset: 'custom', api: 'openai-chat', baseUrl: 'http://example.test/v1', model: 'example', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
      const state = await runtime.host.saveWorkspace({ name: 'Example', projectLocation: project, connectionId: configured.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
      await runtime.host.completeSetup();
      await runtime.host.createSession(state.workspaces[0]!.id);
      await runtime.host.saveProfile({ displayName: 'Example', preferences: { theme: 'dark', language: 'id' },
        clientState: { lastWorkspaceId: state.workspaces[0]!.id, officeLights: 'off', approvalNotifications: 'on', earlierOpen: '1' } });
      const locations = await runtime.host.importLocations();
      const codex = locations.find(location => location.sourceId === 'codex' && location.label === 'Codex')!;
      expect(codex).toBeDefined();
      const scan = await runtime.host.scanImports(['codex']);
      const candidates = scan.sessions.filter(item => item.supported).map(item => item.id);
      expect(candidates).toHaveLength(1);
      await runtime.host.commitImports(scan.scanId, candidates);
      await runtime.host.observeImports(scan.scanId, candidates);
      await runtime.host.setAutoWatch(codex.id, true);
      expect(await runtime.host.getState()).toMatchObject({ setupComplete: true,
        connections: [expect.anything()], workspaces: [expect.anything()], library: [expect.anything()] });
      expect((await runtime.host.getState()).sessions).toHaveLength(2);
      const previousInstance = (await runtime.host.getState()).host.instanceId;
      expect(previousInstance).toBeTruthy();
      expect((await runtime.host.getState()).host.instanceId).toBe(previousInstance);
      await runtime.close(); runtime = undefined;
      await rm(dataDirectory, { recursive: true });

      // Two separate boots prove the empty state is not only a first-load projection.
      for (let boot = 0; boot < 2; boot++) {
        runtime = await createAgentHost(options);
        expect(await runtime.host.getState()).toMatchObject({ dataDirectory, setupComplete: false,
          workflow: 'managed', connections: [], workspaces: [], sessions: [], library: [] });
        expect((await runtime.host.getState()).host.instanceId).not.toBe(previousInstance);
        expect(await runtime.host.getProfile()).toEqual(emptyProfile());
        expect((await runtime.host.importLocations()).every(location => !location.autoWatch)).toBe(true);
        expect(await readFile(source, 'utf8')).toBe(transcript);
        expect(await readFile(path.join(project, 'work.txt'), 'utf8')).toBe('Keep the project files.\n');
        await runtime.close(); runtime = undefined;
      }
    } finally { await runtime?.close(); }
  });
});
