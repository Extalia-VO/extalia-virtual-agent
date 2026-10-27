import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KNOWLEDGE_HOST_METHODS, type AgentHostApi } from '@extalia/platform';
import { createAgentHost, type AgentHostOptions } from '../src/service.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';

// W5 Knowledge over the Rust core daemon (real binary): the host offers the knowledge methods only with
// the native core flag on, forwards the daemon's results, and reports an unavailable daemon as a status.
if (!HAS_DAEMON) console.warn('knowledgeDaemon.test.ts: daemon cases skipped: build the daemon with `cargo build -p extalia-daemon`.');

const roots: string[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

type Knowledge = AgentHostApi & Required<Pick<AgentHostApi, (typeof KNOWLEDGE_HOST_METHODS)[number]>>;

async function fixture(options: { core?: 'rust' | 'typescript'; binary?: string; knowledge?: AgentHostOptions['knowledge'] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-knowledge-')); roots.push(root);
  const home = path.join(root, 'home'), data = path.join(root, 'data');
  await mkdir(home, { recursive: true });
  const log: string[] = [];
  const runtime = await createAgentHost({
    kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 60_000,
    env: { EXTALIA_SECRET_STORE: 'memory', HOME: home, PATH: '', EXTALIA_NATIVE_CORE: options.core ?? 'rust', EXTALIA_DAEMON_PATH: options.binary ?? DAEMON_BINARY },
    daemon: { log: line => { log.push(line); } },
    knowledge: options.knowledge ?? { autoSyncAfterMs: Number.POSITIVE_INFINITY },
  });
  closes.push(() => runtime.close());
  const vault = path.join(data, 'vaults', 'default');
  const note = async (file: string, text: string) => {
    await mkdir(path.dirname(path.join(vault, file)), { recursive: true });
    await writeFile(path.join(vault, file), text);
  };
  return { root, data, vault, note, log, host: runtime.host as Knowledge };
}

describe('Knowledge host methods', () => {
  it('are absent with the TypeScript core, so the Knowledge page stays hidden', async () => {
    const { host } = await fixture({ core: 'typescript' });
    for (const method of KNOWLEDGE_HOST_METHODS) expect(host[method]).toBeUndefined();
  });

  it('report an unavailable daemon as a status and fail other calls with a user-safe message', async () => {
    const { root, host } = await fixture({ binary: path.join(tmpdir(), 'extalia-no-such-daemon', 'extalia-daemon') });
    for (const method of KNOWLEDGE_HOST_METHODS) expect(typeof host[method]).toBe('function');
    const status = await host.knowledgeStatus();
    expect(status).toEqual({ state: 'unavailable', reason: 'native_core_binary_missing', vaultRoot: 'vaults/default', vaultPresent: false, generation: 0, skipped: [] });
    for (const call of [() => host.searchKnowledge('anything'), () => host.syncKnowledge(), () => host.knowledgeOverview(), () => host.knowledgeNode({ path: 'A.md' })]) {
      const error = await call().then(() => undefined, (failure: unknown) => failure as Error);
      expect(error?.name).toBe('UserError');
      expect(error?.message).toMatch(/native core is unavailable \(binary_missing\)/);
      expect(error?.message).not.toContain(root);
    }
    // Client values are validated before the daemon is asked.
    await expect(host.knowledgeGraph('Bad Id', 1)).rejects.toThrow(/Invalid note id/);
    await expect(host.syncKnowledge('full' as never)).rejects.toThrow(/Invalid knowledge sync mode/);
    await expect(host.knowledgeOverview({ nodeLimit: 0 })).rejects.toThrow(/from 1 to 2000/);
  });
});

describe.skipIf(!HAS_DAEMON)('Knowledge over the Rust core daemon', () => {
  it('creates the vault on the first sync, then indexes, searches, links and graphs its notes', async () => {
    const { vault, note, host, root } = await fixture();
    const before = await host.knowledgeStatus();
    expect(before).toMatchObject({ state: 'ready', vaultRoot: 'vaults/default', vaultPresent: false, skipped: [] });
    const first = await host.syncKnowledge();
    expect(first.report).toMatchObject({ mode: 'incremental', notes: 0, vaultCreated: true });
    expect((await stat(vault)).isDirectory()).toBe(true);
    expect(first.status).toMatchObject({ state: 'ready', vaultPresent: true, lastSync: { mode: 'incremental' } });

    await note('Knowledge/Eager Loading.md', '---\nid: know.eager-loading\ntags: [laravel, performance]\naliases: [N+1]\n---\n# Eager Loading\nRelated: [[Query Plans]]\nDepends on: [[Missing Note]]\n\nLoad relations up front with eager loading.\n');
    await note('Knowledge/Query Plans.md', '# Query Plans\n\nRead EXPLAIN output; see [[N+1]].\n');
    await note('Inbox.md', 'Loose notes about [[Eager Loading]] and [[Secret Plan]].\n');
    // Profile isolation: a note of another profile is never indexed and links to it read missing.
    await note('Private/Secret Plan.md', '---\nprofile: personal\n---\n# Secret Plan\nhushword\n');
    await note('Broken.md', '---\nid: [unclosed\n---\nbody\n');

    const synced = await host.syncKnowledge('incremental');
    // Added counts newly seen paths, including the two skipped files; only three become indexed notes.
    expect(synced.report).toMatchObject({ notes: 3, added: 5, skippedTotal: 2, vaultCreated: false });
    expect(synced.status.counts).toMatchObject({ notes: 3 });
    expect(synced.status.skipped).toEqual(expect.arrayContaining([
      { path: 'Private/Secret Plan.md', reason: 'profile_mismatch' }, { path: 'Broken.md', reason: 'invalid_front_matter' },
    ]));
    // The host keeps the skipped list of its latest sync for later status requests.
    expect((await host.knowledgeStatus()).skipped).toEqual(synced.status.skipped);

    const hits = await host.searchKnowledge('eager loading');
    expect(hits.hits[0]).toMatchObject({ nodeId: 'know.eager-loading', path: 'Knowledge/Eager Loading.md', title: 'Eager Loading' });
    expect((await host.searchKnowledge('hushword')).hits).toEqual([]);

    const note1 = await host.knowledgeNode({ path: 'Knowledge/Eager Loading.md' });
    expect(note1).toMatchObject({ node: { nodeId: 'know.eager-loading', trustStatus: 'untrusted', origin: 'vault', tags: ['laravel', 'performance'] }, bodyStatus: 'current' });
    expect(note1!.body).toContain('Load relations up front');
    expect(await host.knowledgeNode({ nodeId: 'gone.note' })).toBeNull();
    expect(await host.knowledgeNode({ path: 'Private/Secret Plan.md' })).toBeNull();

    const links = await host.knowledgeLinks('know.eager-loading');
    expect(links.links.map(link => [link.target, link.edgeType, link.status])).toEqual([['Query Plans', 'related_to', 'resolved'], ['Missing Note', 'depends_on', 'missing']]);
    const inbox = await host.knowledgeLinks('path:Inbox.md');
    expect(inbox.links.find(link => link.target === 'Secret Plan')).toMatchObject({ status: 'missing' });
    expect(inbox.links.find(link => link.target === 'Secret Plan')?.candidates).toBeUndefined();
    const backlinks = await host.knowledgeBacklinks('know.eager-loading');
    expect(backlinks.links.map(link => link.sourceNodeId).sort()).toEqual(['path:Inbox.md', 'path:Knowledge/Query Plans.md']);

    const graph = await host.knowledgeGraph('know.eager-loading', 2);
    expect(graph).toMatchObject({ rootNodeId: 'know.eager-loading', depth: 2, truncated: false });
    expect(graph.nodes.map(node => node.nodeId).sort()).toEqual(['know.eager-loading', 'path:Inbox.md', 'path:Knowledge/Query Plans.md']);
    expect(graph.edges).toEqual(expect.arrayContaining([{ source: 'know.eager-loading', target: 'path:Knowledge/Query Plans.md', edgeType: 'related_to' }]));
    await expect(host.knowledgeGraph('know.eager-loading', 9)).rejects.toThrow(/Invalid graph depth/);
    // Nothing absolute leaves the host.
    expect(JSON.stringify([synced, hits, note1, links, backlinks, graph])).not.toContain(root);
  });

  it('serves the vault overview when the daemon advertises it', async () => {
    const { note, host } = await fixture();
    await host.syncKnowledge();
    await note('Hub.md', '# Hub\n[[A]] [[B]] [[C]]\n');
    for (const name of ['A', 'B', 'C']) await note(`Topics/${name}.md`, `---\ntags: [topic]\n---\n# ${name}\nRelated: [[Hub]]\n`);
    await host.syncKnowledge();
    const overview = await host.knowledgeOverview().then(value => ({ value }), (error: Error) => ({ error }));
    if ('error' in overview) {
      // A daemon built before `knowledge.overview` existed.
      expect(overview.error.message).toMatch(/does not serve the knowledge graph overview yet/);
      return;
    }
    expect(overview.value).toMatchObject({ totalNodes: 4, truncated: false });
    const hub = overview.value.nodes.find(node => node.path === 'Hub.md')!;
    expect(hub).toMatchObject({ folder: '', outDegree: 3, inDegree: 3, degree: 6 });
    expect(overview.value.nodes.find(node => node.path === 'Topics/A.md')).toMatchObject({ folder: 'Topics', tags: ['topic'] });
    const limited = await host.knowledgeOverview({ nodeLimit: 1 });
    expect(limited).toMatchObject({ truncated: true, totalNodes: 4 });
    expect(limited.nodes).toHaveLength(1);
  });

  it('refreshes a stale index when the page asks for status, never creating the vault', async () => {
    const { vault, note, host } = await fixture({ knowledge: { autoSyncAfterMs: 0, autoSyncWaitMs: 10_000 } });
    // No vault yet: status alone does not create it.
    expect(await host.knowledgeStatus()).toMatchObject({ state: 'ready', vaultPresent: false });
    await expect(stat(vault)).rejects.toThrow();
    await host.syncKnowledge();
    await note('Later.md', '# Later\nWritten in another editor.\n');
    const status = await host.knowledgeStatus();
    expect(status.counts).toMatchObject({ notes: 1 });
    expect(status.lastSync).toMatchObject({ mode: 'incremental', notes: 1 });
  });
});
