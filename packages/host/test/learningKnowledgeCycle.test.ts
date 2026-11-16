import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelProvider, ModelRequest, ModelResult } from '@extalia/runtime';
import type { EventBody, ObservedMemoryScope } from '@extalia/protocol';
import { DaemonSidecar } from '../src/daemon/index.js';
import { KnowledgeService } from '../src/knowledge.js';
import { createNativeKnowledgeTools } from '../src/nativeKnowledgeTools.js';
import { pinLearningNotes } from '../src/learningNotes.js';
import { RustLearningBackend } from '../src/rustLearning.js';
import { runAutomaticLearning, runObservedAutomaticLearning, type AutomaticLearningOptions } from '../src/automaticLearning.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const owned: DaemonSidecar[] = [];
afterEach(async () => { await Promise.all(owned.splice(0).map(sidecar => sidecar.stop())); });
const sourcePath = 'Knowledge/Validation Policy.md';
const evidenceId = 'validation-result';
const hash = 'a'.repeat(64);
const response = (name: string, input: Record<string, unknown>, call: number): ModelResult => ({
  text: '', stop: 'tool_use', toolCalls: [{ id: `call-${call}`, name, input }], usage: { inputTokens: 100, outputTokens: 80 },
});
const sourceBody = '# Validation Policy\n\n## Procedure\nRun the validator after saving.\n\n' + 'Historical context for the policy. '.repeat(140);
const modes = [
  { name: 'Native default', profileId: 'default', workspaceId: 'workspace-default', observed: false },
  { name: 'Native isolated', profileId: 'profile-isolated', workspaceId: 'workspace-isolated', observed: false },
  { name: 'Observe bound', profileId: 'profile-observed', workspaceId: 'workspace-observed', observed: true },
  { name: 'Observe global default', profileId: 'default', workspaceId: 'global-observe', observed: true },
] as const;

async function fixture(mode: typeof modes[number]) {
  const root = await temp(), data = path.join(root, 'data'), vault = path.join(root, 'vault');
  await mkdir(data); await mkdir(path.join(vault, 'Knowledge'), { recursive: true });
  await writeFile(path.join(vault, sourcePath), sourceBody);
  await writeFile(path.join(vault, 'Knowledge', 'Foreign.md'), '---\nprofile: another-profile\n---\nForeign-only marker.');
  const daemon = new DaemonSidecar({ binary: () => DAEMON_BINARY, dataDirectory: data, profile: mode.profileId,
    vaultRoot: () => vault, clientVersion: 'test', env: {}, log: () => undefined });
  owned.push(daemon);
  const backend = new RustLearningBackend(() => daemon.connect());
  const knowledge = new KnowledgeService({ daemon, autoSyncAfterMs: Number.POSITIVE_INFINITY });
  await knowledge.sync();
  const destination = { root: vault, profileId: mode.profileId, revision: 'binding-one' };
  const tools = await createNativeKnowledgeTools({ workspaceId: mode.workspaceId, resolve: async () => destination,
    read: notePath => knowledge.node({ path: notePath }), search: query => knowledge.search(query) });
  const events: EventBody[] = [], requests: ModelRequest[] = [];
  const run = async (runId: string, next: (request: ModelRequest, call: number) => Promise<ModelResult> | ModelResult,
    beforePublication?: () => Promise<void>) => {
    const sessionId = `session-${runId}`;
    const provider: ModelProvider = { api: 'openai-chat', listModels: async () => [], complete: async request => {
      requests.push(request);
      return next(request, requests.length);
    } };
    const writer = await pinLearningNotes({ backend, context: { workspaceId: mode.workspaceId, sessionId }, resolve: async () => destination });
    const write = vi.fn(async (...args: Parameters<typeof writer>) => {
      await beforePublication?.();
      return writer(...args);
    });
    const common: Omit<AutomaticLearningOptions, 'result' | 'currentTurnEvidence'> = {
      backend, profileId: mode.profileId, revision: destination.revision, workspaceId: mode.workspaceId,
      sessionId, runId, promptSha256: hash, policy: { enabled: true, skills: false, notes: true },
      provider, tools, signal: new AbortController().signal, assertCurrent: async () => undefined,
      emit: event => { events.push(event); }, writeNote: write,
    };
    try {
      if (mode.observed) {
        const scope: ObservedMemoryScope = { profileId: mode.profileId, workspaceId: mode.workspaceId, sessionId,
          sourceId: 'codex', nativeSessionId: `native-${runId}`, boundary: 'b'.repeat(64) };
        const { episode } = await backend.process('observed.capture', { scope, episodeId: `episode-${runId}`, sourceRevision: 'source-one',
          entries: [{ id: evidenceId, kind: 'user', text: 'Correction: validate input before saving; the old note states the reverse.' }],
          coverage: { mode: 'partial', omittedEntries: 0, truncated: false, limits: [] } });
        return { result: await runObservedAutomaticLearning({ ...common, observed: { scope, episodeId: episode.id, revision: episode.revision } }), write };
      }
      return { result: await runAutomaticLearning({ ...common, result: { outcome: 'completed', history: [], usage: {} },
        currentTurnEvidence: [{ toolCallId: evidenceId, name: 'read_file', content: 'Verified procedure: validation runs before the write.', isError: false }] }), write };
    } finally { await writer.close(); }
  };
  return { root, vault, knowledge, tools, events, requests, run };
}

/** Real daemon, real notes and real index; the provider is deliberately scripted, not an intelligence benchmark. */
describe.skipIf(!HAS_DAEMON || process.platform === 'win32')('grounded learning across sessions and destination modes', () => {
  it.each(modes)('$name publishes a grounded edge and supplies its correction to a later curator', async mode => {
    const f = await fixture(mode);
    let firstCalls = 0;
    const relation = mode.observed ? 'contradicts' : 'updates';
    const first = await f.run('first', (_request, call) => {
      if (++firstCalls === 1) return response('knowledge_read', { path: sourcePath }, call);
      return response('submit_learning', { title: 'Validate before saving', lesson: 'Validate inputs before saving generated files.',
        evidenceIds: [evidenceId], relatedNotes: [{ path: sourcePath, relation,
          reason: mode.observed ? 'The observed user correction disputes the ordering; verify before relying on it.' : 'The current procedure checks validation before the write.',
          evidenceIds: [evidenceId] }] }, call);
    });
    expect(first.result).toMatchObject({ outcome: 'completed', note: { status: 'saved' }, skill: { status: 'skipped' } });
    const relative = first.result.note.path!;
    const saved = await readFile(path.join(f.vault, relative), 'utf8');
    expect(saved).toContain('[[Knowledge/Validation Policy');
    expect(await readFile(path.join(f.vault, sourcePath), 'utf8')).toBe(sourceBody);
    await f.knowledge.sync();
    const old = await f.knowledge.node({ path: sourcePath });
    expect(old?.relatedUpdates).toEqual(expect.arrayContaining([expect.objectContaining({ path: relative, relation, trustStatus: 'untrusted' })]));
    const graph = await f.knowledge.graph(old!.node.nodeId, 1);
    expect(graph.edges).toEqual(expect.arrayContaining([expect.objectContaining({ source: `path:${relative}`, target: old!.node.nodeId, edgeType: relation })]));
    expect((await f.knowledge.search('Foreign-only')).hits).toEqual([]);
    let secondCalls = 0;
    const second = await f.run('second', (request, call) => {
      if (++secondCalls === 1) return response('knowledge_read', { path: sourcePath }, call);
      const last = request.messages.at(-1)!;
      expect(last.role).toBe('tool');
      if (last.role !== 'tool') throw new Error('Expected actual read evidence.');
      // Long source content must not truncate away correction metadata or break the JSON receipt.
      const content = JSON.parse(last.results[0]!.content) as { relatedUpdates?: { path: string; relation: string }[] };
      expect(content.relatedUpdates).toEqual(expect.arrayContaining([expect.objectContaining({ path: relative, relation })]));
      return response('submit_learning', { skipReason: 'The indexed amendment already preserves this lesson; no new finding.' }, call);
    });
    expect(second.result.outcome).toBe('skipped');
    expect(second.write).not.toHaveBeenCalled();
    expect(await readdir(path.join(f.vault, 'Learning', mode.workspaceId))).toEqual(['first.md']);
    expect(f.requests).toHaveLength(4);
    expect(f.events.filter(event => event.type === 'tool.started' && event.label === 'Confirming the linked note is current')).toHaveLength(1);
  });

  it('refuses publication when the referenced file changes after the host revalidation', async () => {
    const f = await fixture(modes[0]);
    let calls = 0;
    const outcome = await f.run('raced', (_request, call) => {
      if (++calls === 1) return response('knowledge_read', { path: sourcePath }, call);
      return response('submit_learning', { title: 'Grounded update', lesson: 'Validate before writing.', evidenceIds: [evidenceId],
        relatedNotes: [{ path: sourcePath, relation: 'updates', reason: 'Current verification changes the order.', evidenceIds: [evidenceId] }] }, call);
    }, () => writeFile(path.join(f.vault, sourcePath), '# Manually changed\nDo not overwrite this edit.\n'));
    expect(outcome.result).toMatchObject({ outcome: 'failed', note: { status: 'failed' } });
    expect(await readFile(path.join(f.vault, sourcePath), 'utf8')).toContain('Do not overwrite this edit');
    const files = await readdir(path.join(f.vault, 'Learning', modes[0].workspaceId)).catch(() => []);
    expect(files).toEqual([]);
  });

  it('rejects a search-only or foreign-profile link after one bounded repair opportunity', async () => {
    const f = await fixture(modes[1]);
    const outcome = await f.run('unread', (_request, call) => response('submit_learning', {
      title: 'Ungrounded link', lesson: 'Use [[Knowledge/Foreign]] for this procedure.', evidenceIds: [evidenceId],
    }, call));
    expect(outcome.result.outcome).toBe('failed');
    expect(outcome.write).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(2);
  });
});
