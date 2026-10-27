import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';

// ADR 0028: the workspace's integration test gate, stored with the workspace in `config/extalia.json`.
const tempDir = useTempDirs();
const runtimes: AgentHostRuntime[] = [];
afterEach(async () => { while (runtimes.length) await runtimes.pop()!.close(); });

async function open(root: string) {
  const runtime = await createAgentHost({
    kind: 'bridge', version: '0.0.0-test', dataDirectory: path.join(root, 'data'), importHome: path.join(root, 'home'),
    env: { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH }, fetch: async () => Response.json({ data: [] }),
  });
  runtimes.push(runtime);
  return runtime.host;
}

async function setup(root?: string) {
  const base = root ?? await tempDir('extalia-workspace-gate-');
  const project = path.join(base, 'project');
  await mkdir(project, { recursive: true });
  const host = await open(base);
  const connection = (await host.saveConnection({
    name: 'Mock', preset: 'custom', api: 'openai-chat', baseUrl: 'http://mock.test/v1', model: 'mock-agent', credential: { kind: 'none' },
    features: { memory: 'off', skills: 'off' },
  })).connections[0]!;
  const input = { name: 'Project', projectLocation: project, connectionId: connection.id, permissions: { fileWrite: 'ask' as const, commands: 'ask' as const } };
  return { base, project, host, input, configFile: path.join(base, 'data', 'config', 'extalia.json') };
}

describe('workspace integration test gate (ADR 0028)', () => {
  it('is absent until configured, validated like the proposal gate, kept on edits, removed with null, and survives a restart', async () => {
    const { base, host, input, configFile } = await setup();
    const created = (await host.saveWorkspace(input)).workspaces[0]!;
    expect(created.integrationGate).toBeUndefined();
    for (const integrationGate of [{ command: '   ' }, { command: 'x'.repeat(4_001) }, { command: 'a\0b' }, { command: 'ok', timeoutSeconds: 0 }, { command: 'ok', timeoutSeconds: 1_801 }, { command: 'ok', timeoutSeconds: 2.5 }, { command: 'ok', shell: true }]) {
      await expect(host.saveWorkspace({ ...input, id: created.id, integrationGate: integrationGate as never }), JSON.stringify(integrationGate).slice(0, 40)).rejects.toThrow(/test gate/);
    }
    expect((await host.getState()).workspaces[0]!.integrationGate).toBeUndefined();
    const saved = await host.saveWorkspace({ ...input, id: created.id, integrationGate: { command: '  pnpm test  ', timeoutSeconds: 120 } });
    expect(saved.workspaces[0]!.integrationGate).toEqual({ command: 'pnpm test', timeoutSeconds: 120 });
    // Editing other fields without mentioning the gate keeps it (older clients never send it).
    const renamed = await host.saveWorkspace({ ...input, id: created.id, name: 'Renamed' });
    expect(renamed.workspaces[0]).toMatchObject({ name: 'Renamed', integrationGate: { command: 'pnpm test', timeoutSeconds: 120 } });
    expect(JSON.parse(await readFile(configFile, 'utf8')).workspaces[0].integrationGate).toEqual({ command: 'pnpm test', timeoutSeconds: 120 });
    await runtimes.pop()!.close();

    const reopened = await open(base);
    expect((await reopened.getState()).workspaces[0]!.integrationGate).toEqual({ command: 'pnpm test', timeoutSeconds: 120 });
    const cleared = await reopened.saveWorkspace({ ...input, id: created.id, integrationGate: null });
    expect(cleared.workspaces[0]!.integrationGate).toBeUndefined();
    expect('integrationGate' in JSON.parse(await readFile(configFile, 'utf8')).workspaces[0]).toBe(false);
  });

  it('loads stored workspaces written before the setting existed, and drops only a damaged gate', async () => {
    const { base, host, input, configFile } = await setup();
    const [first] = (await host.saveWorkspace(input)).workspaces;
    await host.saveWorkspace({ ...input, name: 'Second' });
    await runtimes.pop()!.close();
    const config = JSON.parse(await readFile(configFile, 'utf8')) as { workspaces: Record<string, unknown>[] };
    expect(config.workspaces.every(workspace => !('integrationGate' in workspace))).toBe(true);
    config.workspaces[1]!.integrationGate = { command: 'ok', timeoutSeconds: 99_999 };
    await writeFile(configFile, JSON.stringify(config));

    const reopened = await open(base);
    const state = await reopened.getState();
    expect(state.workspaces.map(workspace => workspace.name)).toEqual(['Project', 'Second']);
    expect(state.workspaces.map(workspace => workspace.integrationGate)).toEqual([undefined, undefined]);
    expect(state.workspaces[0]!.id).toBe(first!.id);
  });
});
