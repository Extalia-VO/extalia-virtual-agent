import { createHash } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rename, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WorkMemoryActions, WorkMemoryRecord, WorkMemoryScope } from '@extalia/protocol';
import { HostPersistenceGate } from '../src/hostPersistenceGate.js';
import { WorkMemory, createNativeWorkMemoryCapture, createObservedWorkMemoryCapture, createWorkMemoryTools, normalizeWorkMemoryCapture, workMemoryQuery,
  type WorkMemoryAuthority, type WorkMemoryCaptureInput } from '../src/workMemory.js';
import { WorkMemoryOutbox, workMemoryPendingKey, type WorkMemoryCapture } from '../src/workMemoryOutbox.js';
import type { RustLearningPort } from '../src/rustLearning.js';
import { runTool, useTempDirs } from './helpers.js';

const temp = useTempDirs();
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scope: WorkMemoryScope = { profileId: 'profile-one', workspaceId: 'workspace-one', boundary: hash('workspace-boundary') };
const sourceKey = (input: WorkMemoryCapture) => hash([input.scope, input.source.kind, input.source.sourceId, input.source.sessionId, input.source.episodeId, input.source.accessKey]);
const waitGate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const native = (runId = 'run-one', prompt = 'Fix the parser batch limit'): WorkMemoryCaptureInput => createNativeWorkMemoryCapture({
  sessionId: 'session-one', runId, sourceId: 'connection-one', prompt,
  assistant: 'Keep the parser batch limit at 73. Verification is pending.', outcome: 'completed',
  evidence: [{ toolCallId: 'tool-one', name: 'read_file', content: 'Parser uses a batch limit of 73.', isError: false }],
});

async function fixture() {
  const root = await temp(), directory = path.join(root, 'work-memory-outbox');
  let authority: WorkMemoryAuthority | undefined = { scope, revision: 'consent-one', observedSourceKeys: [] };
  let authorize = true, unavailable = false, loseAcknowledgement = false, failRevocation = false;
  let captureGate: Promise<void> | undefined, readGate: Promise<void> | undefined;
  const store = new Map<string, { record: WorkMemoryRecord; input: WorkMemoryCapture }>();
  const process = vi.fn(async (action: string, raw: unknown): Promise<unknown> => {
    const input = raw as WorkMemoryCapture;
    if (action === 'memory.capture') {
      if (unavailable) throw new Error('private transport detail');
      const id = sourceKey(input), prior = store.get(id), revision = hash(input);
      if (prior && prior.record.revision !== revision) throw new Error('immutable conflict');
      const record: WorkMemoryRecord = { id, revision, scope: { ...input.scope },
        // Real Rust objects need not preserve the caller's JSON key order.
        source: { revision: input.source.revision, sessionId: input.source.sessionId, sourceId: input.source.sourceId,
          kind: input.source.kind, episodeId: input.source.episodeId, ...(input.source.accessKey ? { accessKey: input.source.accessKey } : {}) },
        outcome: input.outcome, title: input.title, summary: input.summary, capturedAt: '2026-01-01T00:00:00.000Z',
        entries: input.entries.length, trust: 'attributed-evidence', coverage: input.coverage };
      store.set(id, { record, input: structuredClone(input) }); await captureGate;
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('acknowledgement lost'); }
      return { action, record, created: !prior };
    }
    if (action === 'memory.revoke') {
      if (failRevocation) throw new Error('revoke unavailable');
      const request = raw as WorkMemoryActions['memory.revoke']['input']; let removed = 0;
      for (const [id, value] of store) if (hash(value.record.scope) === hash(request.scope)
        && (!request.sourceKind || value.record.source.kind === request.sourceKind)
        && (!request.sessionId || value.record.source.sessionId === request.sessionId)
        && (!request.episodeId || value.record.source.episodeId === request.episodeId)
        && (!request.accessKey || value.record.source.accessKey === request.accessKey)) { store.delete(id); removed++; }
      return { action, removed };
    }
    if (action === 'memory.search') {
      const request = raw as WorkMemoryActions['memory.search']['input']; await readGate;
      const terms = request.query.toLowerCase().split(/\s+/);
      const matched = [...store.values()].filter(value => hash(value.record.scope) === hash(request.scope)
        && (value.record.source.kind !== 'observed' || request.observedSourceKeys?.includes(value.record.source.accessKey!))
        && terms.some(term => JSON.stringify(value.input).toLowerCase().includes(term)));
      const selected = matched.slice(0, request.limit ?? 6);
      return { action, hits: selected.map(value => ({ record: value.record, excerpt: value.input.entries.map(entry => entry.text).join('\n').slice(0, 1000) })), omitted: matched.length - selected.length };
    }
    if (action === 'memory.read') {
      const request = raw as WorkMemoryActions['memory.read']['input']; await readGate;
      const value = store.get(request.id);
      if (!value || value.record.revision !== request.revision || hash(value.record.scope) !== hash(request.scope)
        || value.record.source.kind === 'observed' && !request.observedSourceKeys?.includes(value.record.source.accessKey!)) throw new Error('record unavailable');
      const offset = request.offset ?? 0, entries = value.input.entries.slice(offset, offset + (request.limit ?? 4));
      return { action, record: value.record, entries, offset, total: value.input.entries.length,
        ...(offset + entries.length < value.input.entries.length ? { nextOffset: offset + entries.length } : {}) };
    }
    throw new Error('Unexpected action');
  });
  const gate = new HostPersistenceGate();
  const options = { backend: { process: process as RustLearningPort['process'] }, directory,
    resolve: async (workspaceId: string) => authority?.scope.workspaceId === workspaceId ? authority : undefined,
    authorizeCapture: async () => authorize, persist: <T>(work: () => Promise<T>) => gate.run(work) };
  const manager = new WorkMemory(options);
  return { root, directory, manager, options, store, process, gate,
    restart: () => new WorkMemory(options), setAuthority: (value: WorkMemoryAuthority | undefined) => { authority = value; },
    setAuthorize: (value: boolean) => { authorize = value; }, setUnavailable: (value: boolean) => { unavailable = value; },
    loseAcknowledgement: () => { loseAcknowledgement = true; }, failRevocation: (value: boolean) => { failRevocation = value; },
    captureGate: (value: Promise<void> | undefined) => { captureGate = value; }, readGate: (value: Promise<void> | undefined) => { readGate = value; } };
}

describe('operational work memory capture and durable recovery', () => {
  it('persists an exact redacted outbox before a failed backend call and retries it after restart', async () => {
    const f = await fixture(), secret = 'sk-' + 'q'.repeat(30); f.setUnavailable(true);
    const input = native(); input.entries.push({ id: 'secret-result', kind: 'tool', text: `Token ${secret}` });
    expect(await f.manager.capture(scope.workspaceId, input)).toEqual({ status: 'pending' });
    const saved = await readFile(path.join(f.directory, 'pending.json'), 'utf8');
    expect(saved).toContain('[redacted]'); expect(saved).not.toContain(secret);
    expect(JSON.parse(saved).pending).toHaveLength(1);
    await f.manager.close(); f.setUnavailable(false);
    const restarted = f.restart(); expect(await restarted.replayPending()).toEqual({ stored: 1, pending: 0, discarded: 0 });
    expect(f.store.size).toBe(1);
    const context = await restarted.context(scope.workspaceId, 'parser batch limit');
    expect(context.text).toContain('73'); expect(context.text).toContain('Verification is pending');
    expect(context.records).toHaveLength(1); expect(context.available).toBe(true);
    expect(JSON.parse(await readFile(path.join(f.directory, 'pending.json'), 'utf8')).pending).toEqual([]);
    await restarted.close();
  });

  it('replays a committed capture with a lost acknowledgement exactly once without provider work', async () => {
    const f = await fixture(); f.loseAcknowledgement();
    expect(await f.manager.capture(scope.workspaceId, native())).toEqual({ status: 'pending' }); expect(f.store.size).toBe(1);
    await f.manager.close(); const restarted = f.restart();
    expect(await restarted.replayPending()).toEqual({ stored: 1, pending: 0, discarded: 0 }); expect(f.store.size).toBe(1);
    expect(f.process.mock.calls.map(call => call[0])).toEqual(['memory.capture', 'memory.capture']);
    const duplicate = await restarted.capture(scope.workspaceId, native()); expect(duplicate).toMatchObject({ status: 'stored', created: false });
    await restarted.close();
  });

  it('durably withdraws revoked pending work and cannot revive it when consent is re-enabled', async () => {
    const f = await fixture(); await f.manager.capture(scope.workspaceId, native('keep-other-episode'));
    f.loseAcknowledgement(); await f.manager.capture(scope.workspaceId, native('revoke-this-episode'));
    expect(f.store.size).toBe(2);
    f.setAuthority(undefined); f.failRevocation(true);
    expect(await f.manager.replayPending()).toEqual({ stored: 0, pending: 1, discarded: 0 });
    const pending = JSON.parse(await readFile(path.join(f.directory, 'pending.json'), 'utf8')).pending;
    expect(pending[0].phase).toBe('revoke');
    await f.manager.close(); f.setAuthority({ scope, revision: 'consent-one', observedSourceKeys: [] }); f.failRevocation(false);
    const restarted = f.restart(); expect(await restarted.replayPending()).toEqual({ stored: 0, pending: 0, discarded: 1 });
    expect([...f.store.values()].map(value => value.record.source.episodeId)).toEqual(['keep-other-episode']);
    expect(f.process.mock.calls.filter(call => call[0] === 'memory.capture')).toHaveLength(2);
    await restarted.close();
  });

  it('refuses disabled origin connections on replay and does not migrate pending captures to a changed scope', async () => {
    const f = await fixture(); f.setUnavailable(true); await f.manager.capture(scope.workspaceId, native());
    f.setAuthorize(false); f.setUnavailable(false);
    expect(await f.manager.replayPending()).toMatchObject({ discarded: 1, pending: 0 }); expect(f.store.size).toBe(0);
    f.setAuthorize(true); f.setUnavailable(true); await f.manager.capture(scope.workspaceId, native('scope-change'));
    f.setAuthority({ scope: { ...scope, boundary: hash('new-isolated-boundary') }, revision: 'consent-one' }); f.setUnavailable(false);
    expect(await f.manager.replayPending()).toMatchObject({ discarded: 1, pending: 0 });
    expect(f.store.size).toBe(0); await f.manager.close();
  });

  it('rejects a frozen destination after default/profile or consent changes without creating a journal', async () => {
    const f = await fixture(), admitted = { scope: { ...scope }, revision: 'consent-one' };
    f.setAuthority({ scope: { ...scope, profileId: 'new-profile', boundary: hash('new-profile-boundary') }, revision: 'consent-two' });
    expect(await f.manager.capture(scope.workspaceId, native(), admitted)).toEqual({ status: 'skipped' });
    expect(f.process).not.toHaveBeenCalled(); expect(await new WorkMemoryOutbox(f.directory).read()).toEqual([]);
    await f.manager.close();
  });

  it('owns a capture through its late effect and revokes a result when permission changes in flight', async () => {
    const f = await fixture(), paused = waitGate(); f.captureGate(paused.promise);
    const running = f.manager.capture(scope.workspaceId, native());
    await vi.waitFor(() => expect(f.store.size).toBe(1)); expect(f.manager.isBusy()).toBe(true); expect(f.gate.isBusy).toBe(true);
    f.setAuthorize(false); paused.resolve();
    expect(await running).toEqual({ status: 'skipped' }); expect(f.store.size).toBe(0);
    expect(f.manager.isBusy()).toBe(false); await f.manager.close();
  });

  it('drains an admitted capture on close without revoking its valid record or admitting more work', async () => {
    const f = await fixture(), paused = waitGate(); f.captureGate(paused.promise);
    const capturing = f.manager.capture(scope.workspaceId, native());
    await vi.waitFor(() => expect(f.store.size).toBe(1));
    let closed = false; const closing = f.manager.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false); expect(f.gate.isBusy).toBe(true);
    await expect(f.manager.capture(scope.workspaceId, native('late'))).rejects.toThrow(/unavailable/);
    paused.resolve(); expect(await capturing).toMatchObject({ status: 'stored' }); await closing;
    expect(closed).toBe(true); expect(f.store.size).toBe(1); expect(f.gate.isBusy).toBe(false);
    expect(f.process.mock.calls.filter(call => call[0] === 'memory.revoke')).toEqual([]);
  });

  it('retains failed/cancelled experiences with their outcome and excludes recursive retrieval outputs', async () => {
    const f = await fixture();
    for (const outcome of ['failed', 'cancelled'] as const) {
      const input = createNativeWorkMemoryCapture({ sessionId: 'session-one', runId: `run-${outcome}`, sourceId: 'connection-one', prompt: 'Investigate parser timeout',
        assistant: 'The fix remains unverified.', outcome, error: 'Search exceeded its time budget.', evidence: [
          { toolCallId: 'failed-tool', name: 'search_files', content: 'Search timed out before any result was confirmed.', isError: true },
          { toolCallId: 'memory-result', name: 'work_memory_read', content: 'Old generated context must not recursively reenter memory.', isError: false },
          { toolCallId: 'archive-result', name: 'context_archive_read', content: 'Prior transcript retrieval.', isError: false },
          { toolCallId: 'knowledge-result', name: 'knowledge_read', content: 'Prior Knowledge context.', isError: false },
        ] });
      expect(await f.manager.capture(scope.workspaceId, input)).toMatchObject({ status: 'stored', record: { outcome } });
    }
    const records = [...f.store.values()]; expect(records).toHaveLength(2);
    for (const value of records) {
      expect(value.record.summary).toContain('Failed tool'); expect(JSON.stringify(value.input)).not.toContain('Old generated context');
      expect(JSON.stringify(value.input)).not.toContain('Prior transcript'); expect(JSON.stringify(value.input)).not.toContain('Prior Knowledge');
    }
    await f.manager.close();
  });

  it('preserves current-turn user corrections as attributed user evidence even when the assistant omits them', async () => {
    const f = await fixture();
    const input = createNativeWorkMemoryCapture({ sessionId: 'session-one', runId: 'steered-turn', prompt: 'Use ascending parser order.',
      userMessages: ['Use ascending parser order.', 'Correction: reverse the parser order. Keep newest items first.'],
      assistant: 'Done.', outcome: 'completed', evidence: Array.from({ length: 80 }, (_, index) => ({
        toolCallId: `provider tool call ${index}`, name: 'read_file', content: `Fixture ${index}`, isError: false,
      })) });
    expect(await f.manager.capture(scope.workspaceId, input)).toMatchObject({ status: 'stored' });
    const stored = [...f.store.values()][0]!;
    expect(stored.input.entries.filter(entry => entry.kind === 'user').map(entry => entry.text)).toEqual([
      'Use ascending parser order.', 'Correction: reverse the parser order. Keep newest items first.',
    ]);
    expect(stored.record.summary).toContain('Latest user correction'); expect(stored.record.title).toContain('reverse');
    expect(stored.input.entries.every(entry => /^[A-Za-z0-9._:-]{1,200}$/.test(entry.id))).toBe(true);
    const packet = await f.manager.context(scope.workspaceId, 'parser order');
    expect(packet.text).toContain('reverse'); expect(packet.text).toContain('capturedAt'); await f.manager.close();
  });

  it('bounds pending capacity explicitly without overwriting older unsaved captures', async () => {
    const f = await fixture(); f.setUnavailable(true);
    for (let index = 0; index < 64; index++) await f.manager.capture(scope.workspaceId, native(`pending-${index}`));
    await expect(f.manager.capture(scope.workspaceId, native('overflow'))).rejects.toThrow(/full/);
    expect(JSON.parse(await readFile(path.join(f.directory, 'pending.json'), 'utf8')).pending).toHaveLength(64);
    await f.manager.close();
  });
});

describe('operational work memory context and access', () => {
  it('reports bounded Observe-source coverage without changing Native capture or replay consent', async () => {
    const f = await fixture(), admitted = { scope, revision: 'consent-one', observedSourceKeys: [hash('source-one')], observedSourcesOmitted: 3 };
    f.setAuthority(admitted); f.setUnavailable(true);
    expect(await f.manager.capture(scope.workspaceId, native(), admitted)).toEqual({ status: 'pending' });
    await f.manager.close();
    // The host selected another bounded source page, but Native storage consent is unchanged.
    f.setAuthority({ ...admitted, observedSourceKeys: [hash('source-two')], observedSourcesOmitted: 7 }); f.setUnavailable(false);
    const restarted = f.restart();
    expect(await restarted.replayPending()).toEqual({ stored: 1, pending: 0, discarded: 0 });
    expect(f.process.mock.calls.some(call => call[0] === 'memory.revoke')).toBe(false);
    const found = await restarted.search(scope.workspaceId, { query: 'parser' });
    expect(found.hits).toHaveLength(1); expect(found).toMatchObject({ omitted: 0, observedSourcesOmitted: 7, incomplete: true });
    const packet = await restarted.context(scope.workspaceId, 'parser', { maxCharacters: 2200 });
    expect(packet).toMatchObject({ omitted: 0, observedSourcesOmitted: 7, incomplete: true, available: true });
    expect(packet.text).toContain('7 authorized Observe sources'); expect(packet.characters).toBeLessThanOrEqual(2200);
    const result = await runTool(createWorkMemoryTools(restarted, scope.workspaceId), 'work_memory_search', { query: 'parser' });
    expect(result.ok).toBe(true); expect(JSON.parse(result.output)).toMatchObject({ omitted: 0, observedSourcesOmitted: 7, incomplete: true });
    expect(await restarted.context(scope.workspaceId, 'unmatched_q7v9')).toMatchObject({ records: [], omitted: 0, observedSourcesOmitted: 7, incomplete: true });
    const paused = waitGate(); f.readGate(paused.promise);
    const before = f.process.mock.calls.length, searching = restarted.search(scope.workspaceId, { query: 'parser' });
    await vi.waitFor(() => expect(f.process.mock.calls.length).toBeGreaterThan(before));
    // Changing the diagnostic while Rust is reading cannot retroactively broaden that query.
    f.setAuthority({ ...admitted, observedSourceKeys: [hash('source-two')], observedSourcesOmitted: 0 }); paused.resolve();
    expect(await searching).toMatchObject({ observedSourcesOmitted: 7, incomplete: true });
    expect(await restarted.search(scope.workspaceId, { query: 'parser' })).toMatchObject({ omitted: 0, observedSourcesOmitted: 0, incomplete: false });
    await restarted.close();
  });

  it('refuses malformed source-coverage counts before reading or journalling evidence', async () => {
    const f = await fixture();
    for (const observedSourcesOmitted of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      f.setAuthority({ scope, revision: 'consent-one', observedSourcesOmitted });
      await expect(f.manager.search(scope.workspaceId, { query: 'parser' })).rejects.toThrow(/unavailable/);
      expect(await f.manager.capture(scope.workspaceId, native())).toEqual({ status: 'skipped' });
    }
    expect(f.process).not.toHaveBeenCalled(); expect(await new WorkMemoryOutbox(f.directory).read()).toEqual([]);
    await f.manager.close();
  });

  it('keeps model search output compact while exact paged records retain the complete stored evidence', async () => {
    const f = await fixture(), input = native();
    input.summary = 'Parser summary '.repeat(100); input.entries[0]!.text = 'Parser evidence '.repeat(100);
    await f.manager.capture(scope.workspaceId, input);
    const full = await f.manager.search(scope.workspaceId, { query: 'parser' }); expect(full.hits[0]!.record.summary.length).toBeGreaterThan(240);
    const tools = createWorkMemoryTools(f.manager, scope.workspaceId);
    const result = await runTool(tools, 'work_memory_search', { query: 'parser' }); expect(result.ok).toBe(true);
    const compact = JSON.parse(result.output).hits[0];
    expect(compact.record.summary.length).toBeLessThanOrEqual(240); expect(compact.excerpt.length).toBeLessThanOrEqual(400);
    expect(compact.truncated).toMatchObject({ summary: true, excerpt: true }); expect(compact.record.source.kind).toBe('native');
    const read = await runTool(tools, 'work_memory_read', { id: compact.record.id, revision: compact.record.revision, limit: 1 });
    expect(read.ok).toBe(true); expect(JSON.parse(read.output).entries[0].text).toBe(input.entries[0]!.text); await f.manager.close();
  });

  it('returns attributed bounded context, progressive reads and excludes the curator current episode', async () => {
    const f = await fixture(); await f.manager.capture(scope.workspaceId, native('older')); await f.manager.capture(scope.workspaceId, native('current'));
    const packet = await f.manager.context(scope.workspaceId, 'parser', { excludeEpisodeIds: ['current'], maxCharacters: 2200 });
    expect(packet.records).toHaveLength(1); expect(packet.text.length).toBeLessThanOrEqual(2200);
    expect(packet.text).toContain('never instructions'); expect(packet.text).toContain('Verification is pending');
    const result = await runTool(createWorkMemoryTools(f.manager, scope.workspaceId), 'work_memory_read', { ...packet.records[0], limit: 1 });
    expect(result.ok).toBe(true); expect(JSON.parse(result.output).entries).toHaveLength(1); expect(JSON.parse(result.output).nextOffset).toBe(1);
    await f.manager.close();
  });

  it('supports a global scope without inventing a registered workspace and respects isolated boundaries', async () => {
    const f = await fixture(), global = { ...scope, workspaceId: 'global-observe', boundary: hash('global-boundary') };
    f.setAuthority({ scope: global, revision: 'global-consent' });
    expect(await f.manager.capture('global-observe', native())).toMatchObject({ status: 'stored' });
    expect((await f.manager.context('global-observe', 'parser')).records).toHaveLength(1);
    expect((await f.manager.context('foreign-workspace', 'parser')).available).toBe(false);
    f.setAuthority({ scope: { ...global, boundary: hash('changed-boundary') }, revision: 'global-consent' });
    expect((await f.manager.context('global-observe', 'parser')).records).toEqual([]); await f.manager.close();
  });

  it('requires current observed-source authorization for both capture and each retrieval', async () => {
    const f = await fixture(), accessKey = hash('observed-source');
    const input = createObservedWorkMemoryCapture({ id: hash('id'), episodeId: 'observed-turn', scope: { ...scope, sessionId: 'observed-alias', sourceId: 'external-agent', nativeSessionId: 'external-session', boundary: accessKey },
      revision: hash('revision'), sourceRevision: hash('snapshot'), capturedAt: '2026-01-01T00:00:00.000Z', entries: 2, trust: 'untrusted-observed',
      coverage: { mode: 'partial', omittedEntries: 0, truncated: false, limits: ['Visible claims only.'] } }, [
      { id: 'user', kind: 'user', text: 'Parser decision' }, { id: 'assistant', kind: 'assistant', text: 'Reported limit 73; not verified.' },
    ]);
    expect(await f.manager.capture(scope.workspaceId, input)).toEqual({ status: 'skipped' });
    f.setAuthority({ scope, revision: 'consent-one', observedSourceKeys: [accessKey] });
    const stored = await f.manager.capture(scope.workspaceId, input); expect(stored.status).toBe('stored');
    expect((await f.manager.context(scope.workspaceId, 'parser')).records).toHaveLength(1);
    f.setAuthority({ scope, revision: 'consent-one', observedSourceKeys: [] });
    expect((await f.manager.context(scope.workspaceId, 'parser')).records).toHaveLength(0);
    if (stored.status === 'stored') await expect(f.manager.read(scope.workspaceId, { id: stored.record.id, revision: stored.record.revision })).rejects.toThrow();
    await f.manager.close();
  });

  it('discards late search output after scope changes, aborts safely and refuses stale read revisions', async () => {
    const f = await fixture(), stored = await f.manager.capture(scope.workspaceId, native()), paused = waitGate();
    if (stored.status !== 'stored') throw new Error('fixture');
    await expect(f.manager.read(scope.workspaceId, { id: stored.record.id, revision: hash('stale') })).rejects.toThrow();
    f.readGate(paused.promise); const searching = f.manager.search(scope.workspaceId, { query: 'parser' });
    await vi.waitFor(() => expect(f.process.mock.calls.some(call => call[0] === 'memory.search')).toBe(true));
    f.setAuthority({ scope: { ...scope, boundary: hash('new') }, revision: 'consent-one' }); paused.resolve();
    await expect(searching).rejects.toThrow(/unavailable/);
    const controller = new AbortController(); controller.abort();
    await expect(f.manager.context(scope.workspaceId, 'parser', { signal: controller.signal })).rejects.toThrow();
    await f.manager.close();
  });

  it('bounds Unicode/escaped wire data and uses a long prompt ending when building a local query', () => {
    const input = native(), text = '\u0001"\\漢😀'.repeat(4000);
    input.entries = Array.from({ length: 80 }, (_, index) => ({ id: `entry-${index}`, kind: 'tool' as const, text }));
    const result = normalizeWorkMemoryCapture({ ...input, scope });
    expect(result.entries).toHaveLength(32); expect(result.coverage.omittedEntries).toBeGreaterThanOrEqual(48);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8') + 2048).toBeLessThanOrEqual(96 * 1024);
    expect(result.entries.every(entry => entry.text.length <= 2000 && !/[\uD800-\uDBFF]$/.test(entry.text))).toBe(true);
    expect(workMemoryQuery('Please help')).toBe('');
    expect(workMemoryQuery(`Opening parser context ${'a '.repeat(3000)}final_unique_decision`)).toContain('final_unique_decision');
  });
});

describe('work memory outbox filesystem integrity', () => {
  it.skipIf(process.platform === 'win32')('withholds first-publication acknowledgement until every created directory and its parent is durable', async () => {
    const root = await temp(), directory = path.join(root, 'new-profile', 'state', 'work-memory-outbox');
    const outbox = new WorkMemoryOutbox(directory), input = normalizeWorkMemoryCapture({ ...native(), scope });
    const pending = { key: workMemoryPendingKey(input), authority: hash('consent'), phase: 'capture' as const, input };
    const handle = await open(root, 'r'), parent = await handle.stat();
    const prototype = Object.getPrototypeOf(handle) as { sync(): Promise<void> }, sync = prototype.sync;
    const flushed: string[] = []; let failParent = true;
    const barrier = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
      const info = await this.stat();
      if (info.isDirectory()) {
        flushed.push(`${info.dev}:${info.ino}`);
        if (failParent && info.dev === parent.dev && info.ino === parent.ino) throw new Error('Parent-directory durability unavailable');
      }
      await sync.call(this);
    });
    try {
      await expect(outbox.replace([pending])).rejects.toThrow('Parent-directory durability unavailable');
      const expected = await Promise.all([directory, path.dirname(directory), path.join(root, 'new-profile'), root]
        .map(async entry => { const info = await lstat(entry); return `${info.dev}:${info.ino}`; }));
      expect(flushed).toEqual(expected);
      // A failed acknowledgement must retain the exact retryable payload, not erase it.
      expect(await outbox.read()).toEqual([pending]);
      failParent = false; flushed.length = 0;
      await outbox.replace([pending]);
      expect(flushed).toEqual(expected); expect(await outbox.read()).toEqual([pending]);
    } finally { barrier.mockRestore(); await handle.close(); }
  });

  it.skipIf(process.platform === 'win32')('refuses acknowledgement when a directory is replaced during its publication flush', async () => {
    const root = await temp(), directory = path.join(root, 'outbox'), moved = path.join(root, 'moved-outbox');
    const outbox = new WorkMemoryOutbox(directory), input = normalizeWorkMemoryCapture({ ...native(), scope });
    const pending = { key: workMemoryPendingKey(input), authority: hash('consent'), phase: 'capture' as const, input };
    await outbox.replace([pending]);
    const handle = await open(directory, 'r'), original = await handle.stat();
    const prototype = Object.getPrototypeOf(handle) as { sync(): Promise<void> }, sync = prototype.sync;
    let replaced = false;
    const barrier = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
      const info = await this.stat(); await sync.call(this);
      if (!replaced && info.isDirectory() && info.dev === original.dev && info.ino === original.ino) {
        replaced = true; await rename(directory, moved); await mkdir(directory);
      }
    });
    try {
      await expect(outbox.replace([pending])).rejects.toThrow(/unavailable/);
      await expect(outbox.read()).rejects.toThrow(/unavailable/);
      expect(await new WorkMemoryOutbox(moved).read()).toEqual([pending]);
    } finally { barrier.mockRestore(); await handle.close(); }
  });

  it('refuses corrupt and modified journal payloads without replacing the evidence', async () => {
    const f = await fixture(); f.setUnavailable(true); await f.manager.capture(scope.workspaceId, native());
    const file = path.join(f.directory, 'pending.json'), saved = JSON.parse(await readFile(file, 'utf8'));
    saved.pending[0].input.summary = 'Tampered summary'; await writeFile(file, JSON.stringify(saved));
    const before = await readFile(file, 'utf8'); await expect(f.manager.replayPending()).rejects.toThrow(/inspection/);
    expect(await readFile(file, 'utf8')).toBe(before); expect(f.process.mock.calls).toHaveLength(1); await f.manager.close();
  });

  it.skipIf(process.platform === 'win32')('refuses symlink roots, linked journals and root replacement', async () => {
    const f = await fixture(), outside = path.join(f.root, 'outside'); await mkdir(outside);
    await symlink(outside, f.directory); await expect(f.manager.capture(scope.workspaceId, native())).rejects.toThrow(/unavailable/); await f.manager.close();
    const g = await fixture(); g.setUnavailable(true); await g.manager.capture(scope.workspaceId, native());
    const file = path.join(g.directory, 'pending.json'); await link(file, path.join(g.root, 'second-link'));
    await expect(g.manager.replayPending()).rejects.toThrow(/unavailable/); await g.manager.close();
    const h = await fixture(); h.setUnavailable(true); await h.manager.capture(scope.workspaceId, native());
    await rename(h.directory, path.join(h.root, 'old-outbox')); await mkdir(h.directory);
    await expect(h.manager.replayPending()).rejects.toThrow(/unavailable/); await h.manager.close();
  });

  it('rejects unbounded and malformed persisted fields and keeps an empty uncreated outbox side-effect free', async () => {
    const root = await temp(), outbox = new WorkMemoryOutbox(path.join(root, 'outbox'));
    expect(await outbox.read()).toEqual([]);
    await mkdir(outbox.directory); await writeFile(path.join(outbox.directory, 'pending.json'), '{"version":2,"pending":[]}');
    await expect(outbox.read()).rejects.toThrow(/inspection/);
  });
});
