import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentHostApi, KnowledgeOverview, KnowledgeSearchResult, KnowledgeVaultSettings, KnowledgeWriteResult, WorkspaceKnowledgeMethod } from '@extalia/platform';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentHost, type AgentHostOptions, type AgentHostRuntime } from '../src/service.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';

const roots: string[] = [];
const runtimes: AgentHostRuntime[] = [];
afterEach(async () => {
  while (runtimes.length) await runtimes.pop()!.close();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'extalia-workspace-knowledge-'))); roots.push(root);
  const home = path.join(root, 'home'), data = path.join(root, 'data');
  await mkdir(home);
  const requests: string[] = [];
  const options: AgentHostOptions = {
    kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 60_000,
    env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_NATIVE_CORE: 'typescript', EXTALIA_DAEMON_PATH: DAEMON_BINARY,
      EXTALIA_HERMES_BIN: path.join(root, 'missing-runtime'), PATH: '' },
    knowledge: { watcher: false, autoSyncAfterMs: Number.POSITIVE_INFINITY },
    daemon: { log: () => undefined },
    fetch: async url => {
      requests.push(url);
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'fixture-model' }] });
      throw new Error('Knowledge indexing must not request a model.');
    },
  };
  const runtime = await createAgentHost(options); runtimes.push(runtime);
  const host = runtime.host;
  const connection = (await host.saveConnection({ name: 'Fixture', preset: 'custom', api: 'openai-chat',
    baseUrl: 'https://example.com/v1', model: 'fixture-model', credential: { kind: 'none' },
    features: { memory: 'off', skills: 'off', history: true }, orchestration: { enabled: false, maxDelegations: 0, tiers: {} } })).connections[0]!;
  const add = async (name: string, isolated = true) => {
    const project = path.join(root, name); await mkdir(project);
    const state = await host.saveWorkspace({ name, projectLocation: project, connectionId: connection.id,
      crossWorkspaceAccess: isolated ? 'isolated' : 'read-only', permissions: { fileWrite: 'ask', commands: 'ask' } });
    return state.workspaces.find(workspace => workspace.name === name)!;
  };
  return { root, data, options, runtime, host, add, requests };
}
async function scoped<T = unknown>(host: AgentHostApi, workspaceId: string, method: WorkspaceKnowledgeMethod, args: unknown[] = []): Promise<T> {
  return await host.workspaceKnowledge!(workspaceId, method, args) as T;
}
async function paths(host: AgentHostApi, workspaceId: string): Promise<string[]> {
  return (await scoped<KnowledgeOverview>(host, workspaceId, 'knowledgeOverview')).nodes.map(node => node.path).sort();
}

// The current Rust learning/artifact path is Unix-only. These tests never touch an actual user profile.
describe.skipIf(!HAS_DAEMON || process.platform === 'win32')('workspace-scoped Knowledge through the actual host and Rust index', () => {
  it('creates dedicated isolated profiles and indexes user CAS writes only in their own profile', async () => {
    const f = await fixture(), first = await f.add('Alpha'), second = await f.add('Beta');
    expect(first.profileId).toMatch(/^vp-[a-f0-9-]{36}$/);
    expect(second.profileId).toMatch(/^vp-[a-f0-9-]{36}$/);
    expect(second.profileId).not.toBe(first.profileId);
    const catalog = await f.host.listVaultProfiles!();
    expect(catalog.profiles.find(profile => profile.id === first.profileId)).toMatchObject({
      workspaceIds: [first.id], root: path.join(f.data, 'vaults', first.profileId), automaticLearning: { enabled: true, skills: true, notes: true },
    });
    expect(catalog.profiles.find(profile => profile.id === second.profileId)?.automaticLearning.notes).toBe(true);
    await scoped(f.host, first.id, 'syncKnowledge', ['incremental']);
    await scoped(f.host, second.id, 'syncKnowledge', ['incremental']);
    expect(await scoped<KnowledgeWriteResult>(f.host, first.id, 'writeKnowledgeNote', [{
      path: 'Alpha.md', content: '# Alpha\n\nAlphaterm knowledge.\n', expectedSha256: null,
    }])).toMatchObject({ outcome: 'written', path: 'Alpha.md' });
    expect(await scoped<KnowledgeWriteResult>(f.host, second.id, 'writeKnowledgeNote', [{
      path: 'Beta.md', content: '# Beta\n\nBetaterm knowledge.\n', expectedSha256: null,
    }])).toMatchObject({ outcome: 'written', path: 'Beta.md' });
    await scoped(f.host, first.id, 'syncKnowledge', ['incremental']);
    await scoped(f.host, second.id, 'syncKnowledge', ['incremental']);
    expect(await paths(f.host, first.id)).toEqual(['Alpha.md']);
    expect(await paths(f.host, second.id)).toEqual(['Beta.md']);
    expect((await scoped<KnowledgeSearchResult>(f.host, first.id, 'searchKnowledge', ['Alphaterm'])).hits).toHaveLength(1);
    expect((await scoped<KnowledgeSearchResult>(f.host, first.id, 'searchKnowledge', ['Betaterm'])).hits).toEqual([]);
    expect((await scoped<KnowledgeSearchResult>(f.host, second.id, 'searchKnowledge', ['Alphaterm'])).hits).toEqual([]);
    expect(await scoped(f.host, first.id, 'readKnowledgeNote', ['Beta.md'])).toBeNull();
    await f.host.syncKnowledge!('incremental');
    expect((await f.host.knowledgeOverview!()).nodes).toEqual([]);
    expect((await f.host.searchKnowledge!('Alphaterm')).hits).toEqual([]);
    expect(await readFile(path.join(f.data, 'vaults', first.profileId, 'Alpha.md'), 'utf8')).toContain('Alphaterm');
    expect(f.requests).toEqual([]);
  });

  it('routes real reads to each saved folder immediately, survives repeated switching and refuses symlink replacement without fallback', async () => {
    const f = await fixture(), workspace = await f.add('Alpha');
    await scoped(f.host, workspace.id, 'syncKnowledge', ['incremental']);
    await scoped(f.host, workspace.id, 'writeKnowledgeNote', [{ path: 'Managed.md', content: '# Managed\n\nOriginalterm\n', expectedSha256: null }]);
    await scoped(f.host, workspace.id, 'syncKnowledge', ['incremental']);
    expect(await paths(f.host, workspace.id)).toEqual(['Managed.md']);
    const first = path.join(f.root, 'custom-one'), second = path.join(f.root, 'custom-two');
    await mkdir(first); await mkdir(second);
    await writeFile(path.join(first, 'First.md'), '# First\n\nFirstterm.\n');
    await writeFile(path.join(second, 'Second.md'), '# Second\n\nSecondterm.\n');
    for (const [root, expected] of [[first, 'First.md'], [second, 'Second.md'], [first, 'First.md']] as const) {
      const saved = await scoped<KnowledgeVaultSettings>(f.host, workspace.id, 'setKnowledgeVaultRoot', [root]);
      expect(saved).toMatchObject({ kind: 'custom', path: root, available: true });
      expect(await scoped<KnowledgeVaultSettings>(f.host, workspace.id, 'knowledgeSettings')).toMatchObject({ kind: 'custom', path: root });
      await scoped(f.host, workspace.id, 'syncKnowledge', ['incremental']);
      expect(await paths(f.host, workspace.id)).toEqual([expected]);
      expect((await scoped<KnowledgeSearchResult>(f.host, workspace.id, 'searchKnowledge', ['Originalterm'])).hits).toEqual([]);
    }
    const alias = path.join(f.root, 'symlink-vault'); await symlink(second, alias);
    await expect(scoped(f.host, workspace.id, 'setKnowledgeVaultRoot', [alias])).rejects.toThrow(/symbolic link/);
    expect(await paths(f.host, workspace.id)).toEqual(['First.md']);
    await rename(first, `${first}-retained`); await symlink(second, first);
    await expect(scoped(f.host, workspace.id, 'knowledgeOverview')).rejects.toThrow(/symbolic link/);
    expect(await readFile(path.join(f.data, 'vaults', workspace.profileId, 'Managed.md'), 'utf8')).toContain('Originalterm');
    await f.host.syncKnowledge!('incremental');
    expect((await f.host.knowledgeOverview!()).nodes).toEqual([]);
  });

  it('refuses isolated-profile sharing and rejects unknown methods or workspace identities at the host boundary', async () => {
    const f = await fixture(), isolated = await f.add('Alpha'), shared = await f.add('Shared', false);
    const catalog = await f.host.listVaultProfiles!();
    const profile = catalog.profiles.find(item => item.id === isolated.profileId)!;
    await expect(f.host.saveVaultProfile!({ id: profile.id, name: profile.name, vaultRoot: null,
      workspaceIds: [isolated.id, shared.id], minutesEnabled: true, expectedRevision: catalog.revision })).rejects.toThrow(/isolated.*only workspace/i);
    expect((await f.host.getState()).workspaces.find(item => item.id === shared.id)?.profileId).toBe(catalog.defaultProfileId);
    await expect(f.host.workspaceKnowledge!(isolated.id, 'saveConnection' as never, [])).rejects.toThrow(/supported Knowledge action/);
    await expect(f.host.workspaceKnowledge!('../outside', 'knowledgeOverview', [])).rejects.toThrow(/workspace/);
    await expect(f.host.workspaceKnowledge!('missing-workspace', 'knowledgeOverview', [])).rejects.toThrow(/workspace.*no longer|workspace.*not found/i);
    await expect(f.host.workspaceKnowledge!(isolated.id, 'knowledgeOverview', 'bad' as never)).rejects.toThrow(/supported Knowledge action/);
  });

  it('reopens the same workspace-to-vault binding and preserves an explicitly disabled learning policy', async () => {
    const f = await fixture(), workspace = await f.add('Alpha');
    const custom = path.join(f.root, 'selected-vault'); await mkdir(custom);
    await writeFile(path.join(custom, 'Remember.md'), '# Remember\n\nPersistterm\n');
    await scoped(f.host, workspace.id, 'setKnowledgeVaultRoot', [custom]);
    const catalog = await f.host.listVaultProfiles!(), profile = catalog.profiles.find(item => item.id === workspace.profileId)!;
    await f.host.saveVaultProfile!({ id: profile.id, name: profile.name, vaultRoot: custom, workspaceIds: [workspace.id],
      minutesEnabled: false, automaticLearning: { enabled: false, skills: false, notes: false }, expectedRevision: catalog.revision });
    await f.runtime.close();
    const reopened = await createAgentHost(f.options); runtimes.push(reopened);
    expect((await reopened.host.getState()).workspaces.find(item => item.id === workspace.id)?.profileId).toBe(workspace.profileId);
    expect((await reopened.host.listVaultProfiles!()).profiles.find(item => item.id === profile.id)).toMatchObject({
      root: custom, automaticLearning: { enabled: false, skills: false, notes: false },
    });
    await scoped(reopened.host, workspace.id, 'syncKnowledge', ['incremental']);
    expect(await paths(reopened.host, workspace.id)).toEqual(['Remember.md']);
  });
});
