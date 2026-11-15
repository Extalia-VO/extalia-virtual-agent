import { createHash } from 'node:crypto';
import { createEvent, type EventBody } from '@extalia/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ObservedMemory, createObservedMemoryTools, type ObservedMemorySource } from '../src/observedMemory.js';
import type { ObservedMemoryEntry, ObservedMemoryEpisode, ObservedMemoryScope, RustLearningAction, RustLearningInputs, RustLearningPort } from '../src/rustLearning.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nativeKey = (scope: ObservedMemoryScope) => hash([scope.profileId, scope.workspaceId, scope.sourceId, scope.nativeSessionId, scope.boundary]);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

function fixture(enabled = true, withStorageSource = false) {
  let sequence = 0, revision = 0, created = true, unknownCapture = false;
  let captureGate: Promise<void> | undefined, searchGate: Promise<void> | undefined, readGate: Promise<void> | undefined;
  const scope: ObservedMemoryScope = { profileId: 'profile-one', workspaceId: 'workspace-one', sessionId: 'observed-one', sourceId: 'codex', nativeSessionId: 'native-one', boundary: hash('original-boundary') };
  const sources = new Map<string, ObservedMemorySource>([[scope.sessionId, { scope, revision: hash(++revision), events: [], running: false, pending: false, enabled }]]);
  const event = (body: EventBody, sessionId = scope.sessionId) => createEvent({ id: `event-${++sequence}`, seq: sequence, at: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(), sessionId,
    source: { runtime: 'codex', channel: 'transcript', adapter: 'native-transcript' }, body });
  const calls: Array<{ action: RustLearningAction; input: unknown }> = [];
  const stored = new Map<string, { episode: ObservedMemoryEpisode; entries: ObservedMemoryEntry[] }>();
  const process = vi.fn(async (action: RustLearningAction, raw: unknown): Promise<unknown> => {
    calls.push({ action, input: structuredClone(raw) });
    if (action === 'observed.capture') {
      const input = raw as RustLearningInputs['observed.capture'];
      const id = hash([nativeKey(input.scope), input.episodeId]);
      const episode: ObservedMemoryEpisode = { id, episodeId: input.episodeId, scope: { ...input.scope }, revision: hash(input.entries), sourceRevision: input.sourceRevision,
        capturedAt: '2026-01-01T00:00:00.000Z', entries: input.entries.length, trust: 'untrusted-observed', coverage: input.coverage };
      stored.set(id, { episode, entries: input.entries });
      await captureGate;
      if (unknownCapture) throw new Error('private backend detail');
      return { action, episode, created };
    }
    if (action === 'observed.revoke') {
      const input = raw as RustLearningInputs['observed.revoke']; let removed = 0;
      for (const [id, value] of stored) if (nativeKey(value.episode.scope) === nativeKey(input.scope)) { stored.delete(id); removed++; }
      return { action, removed };
    }
    if (action === 'observed.search') {
      const input = raw as RustLearningInputs['observed.search']; await searchGate;
      const values = [...stored.values()].filter(value => nativeKey(value.episode.scope) === nativeKey(input.scope));
      return { action, hits: values.slice(0, input.limit).map(value => ({ episode: value.episode, excerpt: value.entries[0]!.text.slice(0, 600) })), omitted: Math.max(0, values.length - (input.limit ?? 6)) };
    }
    if (action === 'observed.read') {
      const input = raw as RustLearningInputs['observed.read']; await readGate;
      const value = stored.get(input.episodeId);
      if (!value || nativeKey(value.episode.scope) !== nativeKey(input.scope) || value.episode.revision !== input.revision) throw new Error('Unavailable native scope or stale revision');
      const offset = input.offset ?? 0, entries = value.entries.slice(offset, offset + (input.limit ?? 4));
      return { action, episode: value.episode, entries, offset, total: value.entries.length, ...(offset + entries.length < value.entries.length ? { nextOffset: offset + entries.length } : {}) };
    }
    throw new Error('Unexpected backend action');
  });
  const onEpisode = vi.fn(), onRevoked = vi.fn(), onWorkEvidence = vi.fn();
  const source = vi.fn(async (id: string) => sources.get(id));
  const storageSource = vi.fn(async (id: string) => sources.get(id));
  const manager = new ObservedMemory({ backend: { process: process as RustLearningPort['process'] }, source,
    ...(withStorageSource ? { storageSource } : {}),
    list: async workspaceId => [...sources.values()].filter(source => source.scope.workspaceId === workspaceId).map(source => source.scope.sessionId), onEpisode, onRevoked, onWorkEvidence });
  const update = (patch: Partial<ObservedMemorySource>, id = scope.sessionId) => { const current = sources.get(id)!; sources.set(id, { ...current, ...patch, revision: hash(++revision) }); };
  const append = (bodies: EventBody[], patch: Partial<ObservedMemorySource> = {}, id = scope.sessionId) => update({ ...patch, events: [...sources.get(id)!.events, ...bodies.map(body => event(body, id))] }, id);
  const complete = async (id = scope.sessionId) => { append([{ type: 'prompt.submitted', text: 'Fresh task: retain this decision', via: 'native' }, { type: 'model.completed', text: 'Observed result, not independent proof.' }], { running: false }, id); await manager.afterPersisted(id); };
  return { scope, sources, source, storageSource, manager, event, update, append, complete, calls, stored, onEpisode, onRevoked, onWorkEvidence,
    duplicateReceipt: () => { created = false; }, unknownCapture: () => { unknownCapture = true; },
    captureGate: (value: Promise<void>) => { captureGate = value; }, searchGate: (value: Promise<void>) => { searchGate = value; }, readGate: (value: Promise<void>) => { readGate = value; } };
}

describe('observed operational evidence capture', () => {
  it('does not turn external archive retrieval into new operational or learning evidence', async () => {
    const f = fixture();
    await f.manager.afterPersisted(f.scope.sessionId);
    f.append([
      { type: 'prompt.submitted', text: 'Verify the current project', via: 'native' },
      { type: 'tool.completed', toolCallId: 'status', tool: 'extalia_continuity_status', kind: 'read', label: 'Archive status', ok: true, output: 'ARCHIVE-STATUS-REPEATED' },
      { type: 'tool.completed', toolCallId: 'read', tool: 'mcp__extalia__extalia_continuity_read', kind: 'read', label: 'Archive read', ok: true, output: 'ARCHIVE-CONTENT-REPEATED' },
      { type: 'tool.completed', toolCallId: 'file', tool: 'read_file', kind: 'read', label: 'Project file', ok: true, output: 'FRESH-PROJECT-EVIDENCE' },
      { type: 'model.completed', text: 'Current work reported after archive retrieval.' },
    ]);
    await f.manager.afterPersisted(f.scope.sessionId);
    expect(f.onWorkEvidence).toHaveBeenCalledOnce();
    const operational = f.onWorkEvidence.mock.calls[0]![1];
    expect(JSON.stringify(operational.entries)).not.toContain('ARCHIVE-');
    expect(JSON.stringify(operational.entries)).toContain('FRESH-PROJECT-EVIDENCE');
    const capture = f.calls.find(call => call.action === 'observed.capture')!.input as RustLearningInputs['observed.capture'];
    expect(JSON.stringify(capture.entries)).not.toContain('ARCHIVE-');
    expect(JSON.stringify(capture.entries)).toContain('FRESH-PROJECT-EVIDENCE');
    await f.manager.afterPersisted(f.scope.sessionId);
    expect(f.calls.filter(call => call.action === 'observed.capture')).toHaveLength(1);
    await f.manager.close();
  });

  it.each([
    [{ type: 'turn.failed', error: 'Search timed out.' }, 'failed'],
    [{ type: 'turn.failed', error: 'Stopped after 50 steps without finishing.' }, 'failed'],
    [{ type: 'turn.failed', error: 'Stopped by the user.' }, 'cancelled'],
    [{ type: 'session.ended', reason: 'cancelled' }, 'cancelled'],
  ] as const)('retains terminal failure evidence separately from completed-task learning (%j)', async (terminal, outcome) => {
    const f = fixture(); await f.manager.afterPersisted(f.scope.sessionId);
    f.append([{ type: 'prompt.submitted', text: 'Investigate parser timeout', via: 'native' }, terminal], { running: true });
    await f.manager.afterPersisted(f.scope.sessionId); expect(f.onWorkEvidence).not.toHaveBeenCalled();
    f.update({ running: false }); await f.manager.afterPersisted(f.scope.sessionId);
    expect(f.onWorkEvidence).toHaveBeenCalledOnce();
    expect(f.onWorkEvidence.mock.calls[0]![0].scope).toEqual(f.scope);
    const evidence = f.onWorkEvidence.mock.calls[0]![1];
    expect(evidence).toMatchObject({ outcome, coverage: { mode: 'partial' } });
    expect(evidence.entries.some((entry: { kind: string }) => entry.kind === 'user')).toBe(true);
    expect(evidence.entries.some((entry: { kind: string }) => entry.kind === 'status')).toBe(true);
    expect(f.calls).toEqual([]); expect(f.onEpisode).not.toHaveBeenCalled();
    await f.manager.afterPersisted(f.scope.sessionId); expect(f.onWorkEvidence).toHaveBeenCalledOnce(); await f.manager.close();
  });

  it('requires a terminal result and does not backfill a startup/enable/replacement history', async () => {
    const f = fixture(false);
    f.append([{ type: 'prompt.submitted', text: 'Historic task', via: 'native' }, { type: 'turn.failed', error: 'Historic error' }]);
    await f.manager.afterPersisted(f.scope.sessionId); f.update({ enabled: true }); await f.manager.afterPersisted(f.scope.sessionId);
    expect(f.onWorkEvidence).not.toHaveBeenCalled();
    f.append([{ type: 'prompt.submitted', text: 'Fresh task with no result', via: 'native' }]); await f.manager.afterPersisted(f.scope.sessionId);
    expect(f.onWorkEvidence).not.toHaveBeenCalled();
    f.append([{ type: 'turn.failed', error: 'Fresh failure' }]); await f.manager.afterPersisted(f.scope.sessionId);
    expect(f.onWorkEvidence).toHaveBeenCalledOnce();
    await f.manager.close();
    const restarted = new ObservedMemory({ backend: { process: vi.fn() as RustLearningPort['process'] }, source: async id => f.sources.get(id),
      list: async () => [f.scope.sessionId], onWorkEvidence: f.onWorkEvidence });
    await restarted.afterPersisted(f.scope.sessionId); expect(f.onWorkEvidence).toHaveBeenCalledOnce(); await restarted.close();
  });

  it('acknowledges operational capture before curation and retains independent legacy learning if that callback fails', async () => {
    const f = fixture(); await f.manager.afterPersisted(f.scope.sessionId);
    f.onWorkEvidence.mockImplementationOnce(async () => {
      expect(f.calls).toEqual([]); expect(f.onEpisode).not.toHaveBeenCalled(); throw new Error('Outbox unavailable');
    });
    await f.complete();
    expect(f.calls.map(call => call.action)).toEqual(['observed.capture']); expect(f.onEpisode).toHaveBeenCalledOnce();
    expect(f.manager.status().sources[0]).toMatchObject({ state: 'uncertain', problem: expect.stringContaining('Operational work memory') });
    await f.manager.afterPersisted(f.scope.sessionId); expect(f.onWorkEvidence).toHaveBeenCalledOnce(); await f.manager.close();
  });

  it('captures each terminal turn in one poll once and never claims the latest unfinished turn completed', async () => {
    const f = fixture(); await f.manager.afterPersisted(f.scope.sessionId);
    f.append([
      { type: 'prompt.submitted', text: 'First completed task', via: 'native' }, { type: 'model.completed', text: 'First report' }, { type: 'turn.completed' },
      { type: 'prompt.submitted', text: 'Second completed task', via: 'native' }, { type: 'model.completed', text: 'Second report' },
      { type: 'prompt.submitted', text: 'Third failed task', via: 'native' }, { type: 'turn.failed', error: 'Missing source' },
      { type: 'prompt.submitted', text: 'Latest unfinished task', via: 'native' }, { type: 'model.completed', text: 'I will inspect the file now.' },
      { type: 'tool.started', tool: 'read_file', kind: 'read', label: 'Reading fixture' }, { type: 'tool.completed', tool: 'read_file', kind: 'read', label: 'Read fixture', ok: true, output: 'File evidence' },
    ], { running: true });
    await f.manager.afterPersisted(f.scope.sessionId); expect(f.onWorkEvidence).not.toHaveBeenCalled();
    f.update({ running: false }); await f.manager.afterPersisted(f.scope.sessionId);
    expect(f.onWorkEvidence.mock.calls.map(call => call[1].outcome)).toEqual(['completed', 'completed', 'failed']);
    expect(f.onWorkEvidence.mock.calls.map(call => call[1].entries[0].text)).toEqual(['First completed task', 'Second completed task', 'Third failed task']);
    expect(f.calls).toEqual([]); expect(f.onEpisode).not.toHaveBeenCalled();
    await f.manager.afterPersisted(f.scope.sessionId); expect(f.onWorkEvidence).toHaveBeenCalledTimes(3);
    f.append([{ type: 'turn.failed', error: 'Context limit' }]); await f.manager.afterPersisted(f.scope.sessionId);
    expect(f.onWorkEvidence).toHaveBeenCalledTimes(4); expect(f.onWorkEvidence.mock.calls[3]![1].outcome).toBe('failed');
    await f.manager.close();
  });

  it('bounds a delayed polling backlog explicitly and clears an ended unfinished frame', async () => {
    const f = fixture(); await f.manager.afterPersisted(f.scope.sessionId);
    const events: EventBody[] = [];
    for (let index = 0; index < 12; index++) events.push({ type: 'prompt.submitted', text: `Completed task ${index}`, via: 'native' }, { type: 'turn.completed', summary: `Report ${index}` });
    events.push({ type: 'prompt.submitted', text: 'Unfinished tail', via: 'native' }, { type: 'session.ended', reason: 'closed' });
    f.append(events); await f.manager.afterPersisted(f.scope.sessionId);
    expect(f.onWorkEvidence).toHaveBeenCalledTimes(8);
    expect(f.onWorkEvidence.mock.calls[0]![1].coverage).toMatchObject({ truncated: true });
    expect(f.onWorkEvidence.mock.calls[0]![1].coverage.limits.join(' ')).toContain('4 earlier terminal episodes');
    f.append([{ type: 'model.completed', text: 'A detached reply after close cannot finish the old task.' }]);
    await f.manager.afterPersisted(f.scope.sessionId); expect(f.onWorkEvidence).toHaveBeenCalledTimes(8); await f.manager.close();
  });
});

describe('observed memory admission and Native recall', () => {
  it('does nothing on default-off startup, and enabling establishes a baseline without historical capture', async () => {
    const f = fixture(false); f.append([{ type: 'prompt.submitted', text: 'Historic task', via: 'native' }, { type: 'model.completed', text: 'Historic reply' }]);
    await f.manager.afterPersisted(f.scope.sessionId); expect(f.calls).toEqual([]);
    f.update({ enabled: true }); await f.manager.afterPersisted(f.scope.sessionId); expect(f.calls).toEqual([]);
    await f.complete(); expect(f.calls.map(call => call.action)).toEqual(['observed.capture']); expect(f.onEpisode).toHaveBeenCalledOnce();
    expect(JSON.stringify([...f.stored.values()])).not.toContain('Historic task'); await f.manager.close();
  });

  it('requires a new prompt and nonfailed result while idle, coalescing repeated persistence callbacks', async () => {
    const f = fixture(); await f.manager.afterPersisted(f.scope.sessionId);
    f.append([{ type: 'model.completed', text: 'Old unpaired result' }]); await f.manager.afterPersisted(f.scope.sessionId); expect(f.calls).toEqual([]);
    f.append([{ type: 'prompt.submitted', text: 'New task', via: 'native' }, { type: 'model.completed', text: 'Reported response' }], { running: true });
    await Promise.all(Array.from({ length: 20 }, () => f.manager.afterPersisted(f.scope.sessionId))); expect(f.calls).toEqual([]);
    f.update({ running: false, pending: true }); await f.manager.afterPersisted(f.scope.sessionId); expect(f.calls).toEqual([]);
    f.update({ pending: false }); await f.manager.afterPersisted(f.scope.sessionId);
    expect(f.calls).toHaveLength(1); expect(f.onEpisode).toHaveBeenCalledOnce();
    const entry = [...f.stored.values()][0]!;
    expect(entry.episode).toMatchObject({ trust: 'untrusted-observed', coverage: { mode: 'partial' } });
    expect(entry.episode.coverage.limits.join(' ')).toContain('not independently verified');
    await f.manager.afterPersisted(f.scope.sessionId); expect(f.calls).toHaveLength(1); await f.manager.close();
  });

  it('does not capture idle alone, empty replies, failed turns or rewritten startup history', async () => {
    const f = fixture(); await f.manager.afterPersisted(f.scope.sessionId);
    f.append([{ type: 'prompt.submitted', text: 'No result yet', via: 'native' }]); await f.manager.afterPersisted(f.scope.sessionId);
    f.append([{ type: 'model.completed', text: '  ' }]); await f.manager.afterPersisted(f.scope.sessionId); expect(f.calls).toEqual([]);
    f.append([{ type: 'turn.failed', error: 'Stopped' }]); await f.manager.afterPersisted(f.scope.sessionId); expect(f.calls).toEqual([]);
    f.update({ events: [f.event({ type: 'prompt.submitted', text: 'Rewritten historical prompt', via: 'native' }), f.event({ type: 'model.completed', text: 'Rewritten result' })] });
    await f.manager.afterPersisted(f.scope.sessionId); expect(f.calls).toEqual([]); await f.manager.close();
  });

  it('bounds entries and content while retaining actual tool/status evidence without manufactured tool results', async () => {
    const f = fixture(); await f.manager.afterPersisted(f.scope.sessionId);
    f.append([{ type: 'prompt.submitted', text: 'Bounded task', via: 'native' }, ...Array.from({ length: 40 }, (_, i): EventBody => ({ type: 'tool.output', text: `Tool ${i}: ${'x'.repeat(9000)}` })), { type: 'turn.completed', summary: 'Native reported done' }]);
    await f.manager.afterPersisted(f.scope.sessionId);
    const capture = f.calls[0]!.input as RustLearningInputs['observed.capture'];
    expect(capture.entries).toHaveLength(32); expect(capture.entries[0]?.kind).toBe('user');
    expect(capture.entries.every(entry => entry.text.length <= 8000)).toBe(true);
    expect(capture.entries.some(entry => entry.kind === 'tool')).toBe(true); expect(capture.entries.at(-1)?.kind).toBe('status');
    expect(capture.coverage).toMatchObject({ mode: 'partial', truncated: true, omittedEntries: 10 }); await f.manager.close();
  });

  it('bounds actual UTF-8 JSON transport for escaped and Unicode evidence without losing prompt/result framing', async () => {
    const f = fixture(); await f.manager.afterPersisted(f.scope.sessionId);
    const text = '\u0001"\\漢😀'.repeat(1800);
    f.append([{ type: 'prompt.submitted', text: `Prompt: ${text}`, via: 'native' },
      ...Array.from({ length: 30 }, (): EventBody => ({ type: 'tool.output', text })), { type: 'model.completed', text: `Result: ${text}` }]);
    await f.manager.afterPersisted(f.scope.sessionId);
    const capture = f.calls[0]!.input as RustLearningInputs['observed.capture'];
    expect(Buffer.byteLength(JSON.stringify({ op: 'learning.process', params: { action: 'observed.capture', input: capture } }), 'utf8') + 1024).toBeLessThanOrEqual(96 * 1024);
    expect(capture.entries).toHaveLength(32); expect(capture.entries[0]).toMatchObject({ kind: 'user', text: expect.stringContaining('Prompt:') });
    expect(capture.entries.at(-1)).toMatchObject({ kind: 'assistant', text: expect.stringContaining('Result:') });
    expect(capture.coverage.truncated).toBe(true); expect(capture.coverage.limits.join(' ')).toContain('96 KiB transport');
    expect(f.onEpisode).toHaveBeenCalledOnce(); await f.manager.close();
  });

  it('revokes known in-session disabled/boundary scopes and never analyzes their replacement backlog', async () => {
    const f = fixture(); await f.manager.afterPersisted(f.scope.sessionId); await f.complete();
    f.update({ enabled: false }); await f.manager.afterPersisted(f.scope.sessionId);
    expect(f.stored.size).toBe(0); expect(f.calls.filter(call => call.action === 'observed.revoke')).toHaveLength(1); expect(f.onRevoked).toHaveBeenCalledOnce();
    f.update({ enabled: true }); await f.manager.afterPersisted(f.scope.sessionId); await f.complete();
    const oldCaptures = f.calls.filter(call => call.action === 'observed.capture').length;
    f.update({ scope: { ...f.scope, boundary: hash('new-boundary') } }); await f.manager.afterPersisted(f.scope.sessionId);
    expect(f.stored.size).toBe(0); expect(f.calls.filter(call => call.action === 'observed.capture')).toHaveLength(oldCaptures); await f.manager.close();
  });

  it('rechecks consent after capture and revokes late effects without scheduling paid curation', async () => {
    const f = fixture(), gate = deferred(); f.captureGate(gate.promise); await f.manager.afterPersisted(f.scope.sessionId);
    f.append([{ type: 'prompt.submitted', text: 'New work', via: 'native' }, { type: 'model.completed', text: 'Source response' }]);
    const running = f.manager.afterPersisted(f.scope.sessionId); await vi.waitFor(() => expect(f.calls.some(call => call.action === 'observed.capture')).toBe(true));
    f.update({ enabled: false }); const disabled = f.manager.afterPersisted(f.scope.sessionId); gate.resolve(); await Promise.all([running, disabled]);
    expect(f.stored.size).toBe(0); expect(f.onEpisode).not.toHaveBeenCalled(); await f.manager.close();
  });

  it.each(['duplicate', 'unknown'] as const)('does not trigger duplicate curation or silently retry a %s capture', async mode => {
    const f = fixture(); await f.manager.afterPersisted(f.scope.sessionId);
    if (mode === 'duplicate') f.duplicateReceipt(); else f.unknownCapture();
    await f.complete(); await f.manager.afterPersisted(f.scope.sessionId);
    expect(f.calls.filter(call => call.action === 'observed.capture')).toHaveLength(1); expect(f.onEpisode).not.toHaveBeenCalled();
    if (mode === 'unknown') expect(f.manager.status().sources[0]?.state).toBe('uncertain'); await f.manager.close();
  });

  it('deduplicates native aliases while retaining original attribution and permitting a currently authorized alias read', async () => {
    const f = fixture(), alias = 'observed-alias';
    f.sources.set(alias, { ...f.sources.get(f.scope.sessionId)!, scope: { ...f.scope, sessionId: alias } });
    await Promise.all([f.manager.afterPersisted(f.scope.sessionId), f.manager.afterPersisted(alias)]);
    f.append([{ type: 'prompt.submitted', text: 'Native work', via: 'native' }, { type: 'model.completed', text: 'Native result' }]);
    await Promise.all([f.manager.afterPersisted(f.scope.sessionId), f.manager.afterPersisted(alias)]);
    expect(f.onEpisode).toHaveBeenCalledOnce();
    const result = await f.manager.search('workspace-one', { query: 'Native' }); expect(result.sources).toBe(1); expect(result.hits).toHaveLength(1);
    const episode = result.hits[0]!.episode;
    const page = await f.manager.read('workspace-one', { sessionId: alias, episodeId: episode.id, revision: episode.revision });
    expect(page.episode.scope.sessionId).toBe(f.scope.sessionId); await f.manager.close();
  });

  it('denies foreign and stale reads and discards results when scope changes during Rust access', async () => {
    const f = fixture(); await f.manager.afterPersisted(f.scope.sessionId); await f.complete();
    const episode = [...f.stored.values()][0]!.episode;
    await expect(f.manager.read('foreign-workspace', { sessionId: f.scope.sessionId, episodeId: episode.id, revision: episode.revision })).rejects.toThrow();
    await expect(f.manager.read('workspace-one', { sessionId: f.scope.sessionId, episodeId: episode.id, revision: hash('stale') })).rejects.toThrow();
    const gate = deferred(); f.searchGate(gate.promise);
    const query = f.manager.search('workspace-one', { query: 'Fresh' }); await vi.waitFor(() => expect(f.calls.some(call => call.action === 'observed.search')).toBe(true));
    f.update({ scope: { ...f.scope, boundary: hash('changed-during-query') } }); gate.resolve();
    expect(await query).toMatchObject({ hits: [], incomplete: true }); await f.manager.drain(); await f.manager.close();
  });

  it('reports bounded source omissions and exposes only read-only Native tools with abort-safe output', async () => {
    const f = fixture();
    for (let i = 1; i < 35; i++) f.sources.set(`source-${i}`, { ...f.sources.get(f.scope.sessionId)!, scope: { ...f.scope, sessionId: `source-${i}`, nativeSessionId: `native-${i}` } });
    const result = await f.manager.search('workspace-one', { query: 'task' });
    expect(result).toMatchObject({ sources: 32, omittedSources: 3, incomplete: true }); expect(f.calls).toHaveLength(32);
    const tools = createObservedMemoryTools(f.manager, 'workspace-one'); expect(tools.map(tool => [tool.name, tool.access, tool.kind])).toEqual([['observed_memory_search', 'read', 'read'], ['observed_memory_read', 'read', 'read']]);
    const controller = new AbortController(); controller.abort();
    const count = f.calls.length;
    expect(await tools[0]!.run({ query: 'task' }, { signal: controller.signal, toolCallId: 'call-one', emit: () => undefined })).toMatchObject({ ok: false });
    expect(f.calls).toHaveLength(count); await f.manager.close();
  });

  it('retains an admitted capture during shutdown when sources disappear, without revocation or post-close curation', async () => {
    const f = fixture(), gate = deferred(); f.captureGate(gate.promise); await f.manager.afterPersisted(f.scope.sessionId);
    f.append([{ type: 'prompt.submitted', text: 'Last task', via: 'native' }, { type: 'model.completed', text: 'Last response' }]);
    const admission = f.manager.afterPersisted(f.scope.sessionId); await vi.waitFor(() => expect(f.stored.size).toBe(1));
    let closed = false; const close = f.manager.close().then(() => { closed = true; });
    f.sources.clear(); // The host no longer exposes source lookups once shutdown starts.
    await Promise.resolve(); expect(closed).toBe(false); gate.resolve(); await Promise.all([admission, close]);
    expect(f.manager.isBusy()).toBe(false); expect(f.onEpisode).not.toHaveBeenCalled();
    expect(f.stored.size).toBe(1); expect(f.onRevoked).not.toHaveBeenCalled();
    expect(f.calls.map(call => call.action)).toEqual(['observed.capture']);
  });

  it('drains the stored episode handoff after shutdown through fresh storage consent without accepting later events', async () => {
    const f = fixture(true, true), capture = deferred(), handoff = deferred();
    f.captureGate(capture.promise); await f.manager.afterPersisted(f.scope.sessionId);
    f.onEpisode.mockImplementation(async () => { await handoff.promise; });
    f.append([{ type: 'prompt.submitted', text: 'Accepted task', via: 'native' }, { type: 'model.completed', text: 'Accepted response' }]);
    const admission = f.manager.afterPersisted(f.scope.sessionId);
    await vi.waitFor(() => expect(f.stored.size).toBe(1));
    expect(f.storageSource).not.toHaveBeenCalled();
    let closed = false;
    const closing = f.manager.close().then(() => { closed = true; });
    f.source.mockResolvedValue(undefined); // Provider admission is no longer available.
    f.append([{ type: 'prompt.submitted', text: 'Later task', via: 'native' }, { type: 'model.completed', text: 'Later response' }]);
    await f.manager.afterPersisted(f.scope.sessionId);
    capture.resolve();
    await vi.waitFor(() => expect(f.onEpisode).toHaveBeenCalledOnce());
    expect(f.storageSource).toHaveBeenCalledExactlyOnceWith(f.scope.sessionId);
    expect(f.onEpisode.mock.calls[0]![0]).toEqual([...f.stored.values()][0]!.episode);
    expect(f.manager.isBusy()).toBe(true); expect(closed).toBe(false);
    handoff.resolve(); await Promise.all([admission, closing]);
    expect(f.manager.isBusy()).toBe(false); expect(f.onRevoked).not.toHaveBeenCalled();
    expect(f.calls.map(call => call.action)).toEqual(['observed.capture']);
    expect(JSON.stringify([...f.stored.values()])).not.toContain('Later task');
    await f.manager.afterPersisted(f.scope.sessionId);
    expect(f.onEpisode).toHaveBeenCalledOnce();
  });

  it.each(['disabled', 'profile', 'boundary', 'native-session'] as const)('revokes committed capture when shutdown storage consent confirms %s changed', async change => {
    const f = fixture(true, true), capture = deferred();
    f.captureGate(capture.promise); await f.manager.afterPersisted(f.scope.sessionId);
    f.append([{ type: 'prompt.submitted', text: 'Accepted task', via: 'native' }, { type: 'model.completed', text: 'Accepted response' }]);
    const admission = f.manager.afterPersisted(f.scope.sessionId);
    await vi.waitFor(() => expect(f.stored.size).toBe(1));
    const closing = f.manager.close();
    f.source.mockResolvedValue(undefined);
    if (change === 'disabled') f.update({ enabled: false });
    else f.update({ scope: { ...f.scope, ...(change === 'profile' ? { profileId: 'profile-two' }
      : change === 'boundary' ? { boundary: hash('changed-boundary') } : { nativeSessionId: 'native-two' }) } });
    capture.resolve(); await Promise.all([admission, closing]);
    expect(f.storageSource).toHaveBeenCalledExactlyOnceWith(f.scope.sessionId);
    expect(f.onEpisode).not.toHaveBeenCalled(); expect(f.stored.size).toBe(0);
    expect(f.calls.map(call => call.action)).toEqual(['observed.capture', 'observed.revoke']);
    expect(f.onRevoked).toHaveBeenCalledExactlyOnceWith(f.scope);
  });

  it.each(['unavailable', 'failed'] as const)('retains a committed episode without handoff when shutdown storage authority is %s', async state => {
    const f = fixture(true, true), capture = deferred();
    f.captureGate(capture.promise); await f.manager.afterPersisted(f.scope.sessionId);
    f.append([{ type: 'prompt.submitted', text: 'Accepted task', via: 'native' }, { type: 'model.completed', text: 'Accepted response' }]);
    const admission = f.manager.afterPersisted(f.scope.sessionId);
    await vi.waitFor(() => expect(f.stored.size).toBe(1));
    const closing = f.manager.close();
    if (state === 'unavailable') f.storageSource.mockResolvedValue(undefined);
    else f.storageSource.mockRejectedValue(new Error('Storage authority unavailable'));
    capture.resolve(); await Promise.all([admission, closing]);
    expect(f.storageSource).toHaveBeenCalledOnce();
    expect(f.onEpisode).not.toHaveBeenCalled(); expect(f.onRevoked).not.toHaveBeenCalled();
    expect(f.stored.size).toBe(1); expect(f.calls.map(call => call.action)).toEqual(['observed.capture']);
  });

  it('switches to fresh storage authority when shutdown races the ordinary post-capture source lookup', async () => {
    const f = fixture(true, true), capture = deferred(), sourceRead = deferred();
    f.captureGate(capture.promise); await f.manager.afterPersisted(f.scope.sessionId);
    f.append([{ type: 'prompt.submitted', text: 'Accepted task', via: 'native' }, { type: 'model.completed', text: 'Accepted response' }]);
    const admission = f.manager.afterPersisted(f.scope.sessionId);
    await vi.waitFor(() => expect(f.stored.size).toBe(1));
    let lookupEntered = false;
    f.source.mockImplementationOnce(async () => { lookupEntered = true; await sourceRead.promise; return undefined; });
    capture.resolve(); await vi.waitFor(() => expect(lookupEntered).toBe(true));
    expect(f.storageSource).not.toHaveBeenCalled();
    const closing = f.manager.close(); sourceRead.resolve();
    await Promise.all([admission, closing]);
    expect(f.storageSource).toHaveBeenCalledExactlyOnceWith(f.scope.sessionId);
    expect(f.onEpisode).toHaveBeenCalledOnce(); expect(f.onRevoked).not.toHaveBeenCalled();
    expect(f.stored.size).toBe(1); expect(f.calls.map(call => call.action)).toEqual(['observed.capture']);
  });

  it('does not revoke a known scope when a queued source lookup resolves unavailable after shutdown', async () => {
    const f = fixture(), gate = deferred(), process = vi.fn(); let closing = false, lookingUp = false;
    const manager = new ObservedMemory({ backend: { process: process as RustLearningPort['process'] }, list: async () => [f.scope.sessionId],
      source: async id => { if (closing) { lookingUp = true; await gate.promise; return undefined; } return f.sources.get(id); } });
    await manager.afterPersisted(f.scope.sessionId); closing = true;
    const pending = manager.afterPersisted(f.scope.sessionId); await vi.waitFor(() => expect(lookingUp).toBe(true));
    const close = manager.close(); gate.resolve(); await Promise.all([pending, close]);
    expect(process).not.toHaveBeenCalled(); await f.manager.close();
  });

  it('keeps host-bound foreign observation pulses scoped before asynchronous source lookups', async () => {
    const f = fixture(), gate = deferred(), lookup = vi.fn(async (id: string) => { await gate.promise; return f.sources.get(id); });
    const unknownPulses: boolean[] = [], process = vi.fn();
    const manager = new ObservedMemory({ backend: { process: process as RustLearningPort['process'] }, source: lookup, list: async () => [],
      onWorkChange: () => unknownPulses.push(manager.hasWorkMatching(workspaceId => workspaceId === undefined)) });
    const pending = manager.afterPersisted(f.scope.sessionId, f.scope.workspaceId);
    expect(manager.isBusy()).toBe(true);
    expect(manager.hasWorkMatching(workspaceId => workspaceId === f.scope.workspaceId)).toBe(true);
    expect(manager.hasWorkMatching(workspaceId => workspaceId === undefined || workspaceId === 'isolated-other')).toBe(false);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    gate.resolve(); await pending;
    for (let index = 0; index < 3; index++) {
      f.update({});
      const pulse = manager.afterPersisted(f.scope.sessionId, f.scope.workspaceId);
      expect(manager.hasWorkMatching(workspaceId => workspaceId === undefined || workspaceId === 'isolated-other')).toBe(false);
      await pulse;
    }
    expect(unknownPulses.length).toBeGreaterThan(3);
    expect(unknownPulses.every(value => value === false)).toBe(true);
    expect(process).not.toHaveBeenCalled();
    await manager.close(); await f.manager.close();
  });

  it('holds unknown ownership until source validation and retains entered capture ownership through shutdown', async () => {
    const f = fixture(), lookupGate = deferred(), captureGate = deferred();
    let holdLookup = true; const captureEntered = vi.fn();
    const manager = new ObservedMemory({ backend: { process: (async (action, input) => {
      if (action === 'observed.capture') { captureEntered(); await captureGate.promise; throw new Error('Capture settled without receipt'); }
      throw new Error(`Unexpected ${action}: ${Boolean(input)}`);
    }) as RustLearningPort['process'] }, list: async () => [], source: async id => { if (holdLookup) await lookupGate.promise; return f.sources.get(id); } });
    const baseline = manager.afterPersisted(f.scope.sessionId);
    expect(manager.hasWorkMatching(workspaceId => workspaceId === undefined || workspaceId === 'isolated-other')).toBe(true);
    holdLookup = false; lookupGate.resolve(); await baseline;
    f.append([{ type: 'prompt.submitted', text: 'New task', via: 'native' }, { type: 'model.completed', text: 'Observed response' }]);
    const pending = manager.afterPersisted(f.scope.sessionId);
    await vi.waitFor(() => expect(captureEntered).toHaveBeenCalledOnce());
    expect(manager.hasWorkMatching(workspaceId => workspaceId === f.scope.workspaceId)).toBe(true);
    expect(manager.hasWorkMatching(workspaceId => workspaceId === undefined || workspaceId === 'isolated-other')).toBe(false);
    let closed = false;
    const closing = manager.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false); expect(manager.hasWorkMatching(workspaceId => workspaceId === f.scope.workspaceId)).toBe(true);
    captureGate.resolve(); await Promise.all([pending, closing]);
    expect(manager.isBusy()).toBe(false); expect(manager.hasWorkMatching(() => true)).toBe(false);
    await f.manager.close();
  });

  it('retains old and new workspace ownership while revoking a changed source binding', async () => {
    const f = fixture(), gate = deferred(), revokeEntered = vi.fn();
    const manager = new ObservedMemory({ backend: { process: (async action => {
      if (action !== 'observed.revoke') throw new Error('Unexpected backend action');
      revokeEntered(); await gate.promise; return { action, removed: 0 };
    }) as RustLearningPort['process'] }, source: async id => f.sources.get(id), list: async () => [] });
    await manager.afterPersisted(f.scope.sessionId, f.scope.workspaceId);
    f.update({ scope: { ...f.scope, workspaceId: 'workspace-two', profileId: 'profile-two', boundary: hash('changed-scope') } });
    const pending = manager.afterPersisted(f.scope.sessionId, 'workspace-two');
    await vi.waitFor(() => expect(revokeEntered).toHaveBeenCalledOnce());
    expect(manager.hasWorkMatching(workspaceId => workspaceId === f.scope.workspaceId)).toBe(true);
    expect(manager.hasWorkMatching(workspaceId => workspaceId === 'workspace-two')).toBe(true);
    expect(manager.hasWorkMatching(workspaceId => workspaceId === undefined || workspaceId === 'workspace-three')).toBe(false);
    gate.resolve(); await pending;
    expect(manager.hasWorkMatching(() => true)).toBe(false);
    await manager.close(); await f.manager.close();
  });

  it.each(['search', 'read'] as const)('reserves %s workspace ownership before entry and retains it until Rust settlement', async operation => {
    const f = fixture(), gate = deferred(); await f.manager.afterPersisted(f.scope.sessionId); await f.complete();
    const episode = [...f.stored.values()][0]!.episode;
    if (operation === 'search') f.searchGate(gate.promise); else f.readGate(gate.promise);
    const pending = operation === 'search' ? f.manager.search(f.scope.workspaceId, { query: 'Fresh' })
      : f.manager.read(f.scope.workspaceId, { sessionId: f.scope.sessionId, episodeId: episode.id, revision: episode.revision });
    expect(f.manager.isBusy()).toBe(true);
    expect(f.manager.hasWorkMatching(workspaceId => workspaceId === f.scope.workspaceId)).toBe(true);
    expect(f.manager.hasWorkMatching(workspaceId => workspaceId === undefined || workspaceId === 'isolated-other')).toBe(false);
    await vi.waitFor(() => expect(f.calls.some(call => call.action === `observed.${operation}`)).toBe(true));
    let drained = false; const drain = f.manager.drain().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    expect(f.manager.hasWorkMatching(workspaceId => workspaceId === f.scope.workspaceId)).toBe(true);
    gate.resolve(); await Promise.all([pending, drain]);
    expect(f.manager.hasWorkMatching(() => true)).toBe(false); await f.manager.close();
  });

  it('keeps queued known sources scoped and queued unbound sources conservative until shutdown withdraws them', async () => {
    const f = fixture(), gate = deferred(); await f.manager.afterPersisted(f.scope.sessionId, f.scope.workspaceId);
    f.captureGate(gate.promise);
    f.append([{ type: 'prompt.submitted', text: 'Entered task', via: 'native' }, { type: 'model.completed', text: 'Entered response' }]);
    const entered = f.manager.afterPersisted(f.scope.sessionId, f.scope.workspaceId);
    await vi.waitFor(() => expect(f.calls.some(call => call.action === 'observed.capture')).toBe(true));
    const queuedKnown = f.manager.afterPersisted('queued-known', 'workspace-two');
    expect(f.manager.hasWorkMatching(workspaceId => workspaceId === 'workspace-two')).toBe(true);
    expect(f.manager.hasWorkMatching(workspaceId => workspaceId === undefined || workspaceId === 'isolated-other')).toBe(false);
    const queuedUnknown = f.manager.afterPersisted('queued-unknown');
    expect(f.manager.hasWorkMatching(workspaceId => workspaceId === undefined || workspaceId === 'isolated-other')).toBe(true);
    const closing = f.manager.close();
    // Queued lookups never entered; only the already admitted capture still owns work.
    expect(f.manager.hasWorkMatching(workspaceId => workspaceId === undefined || workspaceId === 'workspace-two')).toBe(false);
    expect(f.manager.hasWorkMatching(workspaceId => workspaceId === f.scope.workspaceId)).toBe(true);
    gate.resolve(); await Promise.all([entered, queuedKnown, queuedUnknown, closing]);
    expect(f.manager.hasWorkMatching(() => true)).toBe(false);
  });

  it('notifies scoped ownership changes without claiming global idle while a read is still pending', async () => {
    const f = fixture(), gate = deferred(), onIdle = vi.fn(), onWorkChange = vi.fn(), process = vi.fn();
    const manager = new ObservedMemory({ backend: { process: process as RustLearningPort['process'] }, source: async id => f.sources.get(id),
      list: async () => { await gate.promise; return []; }, onIdle, onWorkChange });
    const query = manager.search('isolated-other', { query: 'task' });
    await manager.afterPersisted(f.scope.sessionId, f.scope.workspaceId);
    expect(onWorkChange).toHaveBeenCalled(); expect(onIdle).not.toHaveBeenCalled();
    expect(manager.hasWorkMatching(workspaceId => workspaceId === 'isolated-other')).toBe(true);
    expect(manager.hasWorkMatching(workspaceId => workspaceId === f.scope.workspaceId)).toBe(false);
    gate.resolve(); await query;
    expect(onIdle).toHaveBeenCalledOnce(); expect(manager.isBusy()).toBe(false);
    expect(manager.hasWorkMatching(() => true)).toBe(false);
    await manager.close(); await f.manager.close();
  });

  it('keeps repeated unbound-source pulses in their host-proven default profile without granting memory access', async () => {
    const gate = deferred(), process = vi.fn(), changedScopes: boolean[] = [];
    const conflictsWithIsolated = (workspaceId?: string) => workspaceId === undefined || workspaceId === 'isolated-workspace';
    const manager = new ObservedMemory({ backend: { process: process as RustLearningPort['process'] }, source: async () => { await gate.promise; return undefined; },
      list: async () => [], onWorkChange: () => changedScopes.push(manager.hasWorkMatching(conflictsWithIsolated, profileId => profileId === 'isolated-profile')) });
    const pending = manager.afterPersisted('unbound-source', { profileId: 'default-profile' });
    expect(manager.isBusy()).toBe(true);
    expect(manager.hasWorkMatching(conflictsWithIsolated, profileId => profileId === 'isolated-profile')).toBe(false);
    expect(manager.hasWorkMatching(() => false, profileId => profileId === 'default-profile')).toBe(true);
    expect(manager.hasWorkMatching(() => false)).toBe(true); // Older callers cannot resolve direct profile ownership.
    expect(manager.hasWorkMatching(workspaceId => workspaceId === undefined, () => false)).toBe(false);
    gate.resolve(); await pending;
    for (let index = 0; index < 3; index++) {
      const pulse = manager.afterPersist('unbound-source', { profileId: 'default-profile' });
      expect(manager.hasWorkMatching(conflictsWithIsolated, profileId => profileId === 'isolated-profile')).toBe(false);
      await pulse;
    }
    expect(changedScopes.every(value => value === false)).toBe(true);
    expect(await manager.search('isolated-workspace', { query: 'task' })).toMatchObject({ hits: [], sources: 0 });
    await expect(manager.read('isolated-workspace', { sessionId: 'unbound-source', episodeId: hash('episode'), revision: hash('revision') })).rejects.toThrow();
    expect(process).not.toHaveBeenCalled(); await manager.close();
  });

  it('retains prior workspace and direct default-profile ownership through unbound-source revocation', async () => {
    const f = fixture(), gate = deferred(), revokeEntered = vi.fn();
    const manager = new ObservedMemory({ backend: { process: (async action => {
      if (action !== 'observed.revoke') throw new Error('Unexpected backend action');
      revokeEntered(); await gate.promise; return { action, removed: 0 };
    }) as RustLearningPort['process'] }, source: async id => f.sources.get(id), list: async () => [] });
    await manager.afterPersisted(f.scope.sessionId, f.scope.workspaceId);
    f.sources.delete(f.scope.sessionId);
    const pending = manager.afterPersisted(f.scope.sessionId, { profileId: 'default-profile' });
    await vi.waitFor(() => expect(revokeEntered).toHaveBeenCalledOnce());
    expect(manager.hasWorkMatching(workspaceId => workspaceId === f.scope.workspaceId, () => false)).toBe(true);
    expect(manager.hasWorkMatching(() => false, profileId => profileId === 'default-profile')).toBe(true);
    expect(manager.hasWorkMatching(workspaceId => workspaceId === undefined || workspaceId === 'isolated-other', profileId => profileId === 'isolated-profile')).toBe(false);
    gate.resolve(); await pending;
    expect(manager.hasWorkMatching(() => true, () => true)).toBe(false);
    await manager.close(); await f.manager.close();
  });
});
