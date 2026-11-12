import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { redact } from '@extalia/core';
import type { ContinuityReadPage, ContinuitySnapshotSummary } from '@extalia/platform';
import { ContinuityAccess, type ContinuityAccessBinding, type ContinuityAccessStatus } from '../src/continuityAccess.js';
import { SessionContinuity, type ContinuityPacketContext, type ContinuitySourceSnapshot } from '../src/sessionContinuity.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const start = Date.parse('2026-01-02T03:04:05Z');
const snapshot = (id = 'snapshot-one'): ContinuitySnapshotSummary => ({ id, sessionId: 'source', sourceId: 'codex', title: 'Parser task', capturedAt: new Date(start).toISOString(), revision: 'v1', entries: 3,
  coverage: { mode: 'partial', observedEntries: 3, omittedEntries: 1, limits: ['Only observed context is available.'] } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'extalia-context-grant-')); roots.push(root);
  const file = join(root, 'access.json'); let now = start, allowed = true, reads = 0;
  const binding: ContinuityAccessBinding = { sessionId: 'destination', sourceId: 'gemini', nativeSessionId: 'gemini-thread', workspaceId: 'workspace', boundary: 'folders-v1', watching: true, persistent: true };
  const source: ContinuitySourceSnapshot = { sessionId: 'source', sourceId: 'codex', nativeSessionId: 'codex-thread', workspaceId: 'workspace', title: 'Parser', revision: 'v1', persistent: true, entries: [], coverage: snapshot().coverage };
  const context: ContinuityPacketContext = { canonicalId: 'canonical-one', source, target: { kind: 'observed', sessionId: 'destination', capabilityId: 'route' },
    destination: { revision: 'v1', label: 'Gemini', sessionId: 'destination', workspaceId: 'workspace', persistent: true }, snapshots: [snapshot(), snapshot('snapshot-two'), snapshot('snapshot-three')],
    notes: { goal: 'Complete parser', decisions: 'Reject booleans', completed: '', pending: 'Boundary tests', verification: '', risks: '' }, notesOrigin: 'user-reviewed', persistent: true };
  const options = { file, now: () => now,
    binding: async (id: string) => { if (!allowed || id !== binding.sessionId) throw new Error('Current profile privacy denies access.'); return { ...binding }; },
    read: async (_id: string, input: { snapshotId: string; offset?: number; limit?: number }): Promise<ContinuityReadPage> => {
      reads++; return { canonicalId: context.canonicalId, snapshot: context.snapshots.find(value => value.id === input.snapshotId)!, entries: [{ id: 'original', kind: 'tool', text: 'Tests: 12 passed' }], offset: input.offset ?? 0, total: 3, nextOffset: 1 };
    } };
  const service = new ContinuityAccess(options);
  return { root, file, context, binding, options, service, advance: (ms: number) => { now += ms; }, deny: () => { allowed = false; }, reads: () => reads };
}
const codeOf = (packet: string) => packet.match(/sk-extalia-context-[a-f0-9]{64}/)![0];

describe('scoped continuity access', () => {
  it('requires exact packet activation, stores only a code hash, and survives restart with pinned metadata', async () => {
    const f = await fixture(), packet = await f.service.prepare('Reviewed capsule', f.context), accessCode = codeOf(packet);
    await expect(access(f.file)).rejects.toThrow();
    await expect(f.service.request('destination', { accessCode, operation: 'status' })).rejects.toThrow('unavailable');
    await expect(f.service.activate(`${packet} changed`, 'destination')).rejects.toThrow('unavailable');
    await expect(f.service.activate(packet, 'other-session')).rejects.toThrow('unavailable');
    await f.service.activate(packet, 'destination'); await f.service.activate(packet, 'destination');
    const disk = await readFile(f.file, 'utf8'); expect(disk).not.toContain(accessCode); expect(JSON.parse(disk).grants).toHaveLength(1);
    f.context.notes.goal = 'Future goal must not leak'; f.context.snapshots = [...f.context.snapshots, snapshot('future-snapshot')];
    const status = await f.service.request('destination', { accessCode, operation: 'status' }) as ContinuityAccessStatus;
    expect(status.notes.goal).toBe('Complete parser'); expect(status.total).toBe(3); expect(status.nextOffset).toBe(1); expect(f.reads()).toBe(0);
    await f.service.close(); const restarted = new ContinuityAccess(f.options);
    const second = await restarted.request('destination', { accessCode, operation: 'status', offset: 1, limit: 2 }) as ContinuityAccessStatus;
    expect(second.snapshots.map(value => value.id)).toEqual(['snapshot-two', 'snapshot-three']); expect(second.nextOffset).toBeUndefined();
    expect(await restarted.request('destination', { accessCode, operation: 'read', snapshotId: 'snapshot-one' })).toMatchObject({ entries: [{ text: 'Tests: 12 passed' }] });
    await expect(restarted.request('destination', { accessCode, operation: 'read', snapshotId: 'future-snapshot' })).rejects.toThrow('unavailable');
  });
  it('rejects another session, wrong code, stale app/thread/workspace/boundary, removed watch and current privacy', async () => {
    const f = await fixture(), packet = await f.service.prepare('Capsule', f.context), accessCode = codeOf(packet);
    await f.service.activate(packet, 'destination');
    await expect(f.service.request('other', { accessCode, operation: 'status' })).rejects.toThrow('unavailable');
    await expect(f.service.request('destination', { accessCode: `sk-extalia-context-${'0'.repeat(64)}`, operation: 'status' })).rejects.toThrow('unavailable');
    for (const key of ['sourceId', 'nativeSessionId', 'workspaceId', 'boundary'] as const) {
      const old = f.binding[key]; f.binding[key] = `${old}-changed`;
      await expect(f.service.request('destination', { accessCode, operation: 'status' })).rejects.toThrow('unavailable'); f.binding[key] = old;
    }
    f.binding.watching = false;
    await expect(f.service.request('destination', { accessCode, operation: 'status' })).rejects.toThrow('unavailable');
    f.binding.watching = true; f.deny();
    await expect(f.service.request('destination', { accessCode, operation: 'read', snapshotId: 'snapshot-one' })).rejects.toThrow('privacy');
    expect(f.reads()).toBe(0);
  });
  it('does not activate stale preview, changed boundary or pending reviews after restart', async () => {
    const f = await fixture(), packet = await f.service.prepare('Capsule', f.context);
    f.binding.boundary = 'changed'; await expect(f.service.activate(packet, 'destination')).rejects.toThrow('unavailable');
    f.binding.boundary = 'folders-v1'; f.advance(10 * 60_000 + 1);
    await expect(f.service.activate(packet, 'destination')).rejects.toThrow('unavailable');
    const recent = await f.service.prepare('New capsule', f.context); await f.service.close();
    await expect(new ContinuityAccess(f.options).activate(recent, 'destination')).rejects.toThrow('unavailable');
  });
  it('expires and revokes active grants without allowing reactivation', async () => {
    const f = await fixture(), packet = await f.service.prepare('Capsule', f.context), accessCode = codeOf(packet);
    await f.service.activate(packet, 'destination'); f.advance(24 * 60 * 60_000 + 1);
    await expect(f.service.request('destination', { accessCode, operation: 'status' })).rejects.toThrow('unavailable');
    await expect(f.service.activate(packet, 'destination')).rejects.toThrow('unavailable');
    const next = await f.service.prepare('New capsule', f.context); await f.service.activate(next, 'destination'); await f.service.revoke('destination');
    await expect(f.service.request('destination', { accessCode: codeOf(next), operation: 'status' })).rejects.toThrow('unavailable');
    await expect(f.service.activate(next, 'destination')).rejects.toThrow('unavailable');
  });
  it('keeps history-off grants in memory and never promotes them through a later saved destination', async () => {
    const f = await fixture(); f.context.persistent = false;
    const packet = await f.service.prepare('Capsule', f.context), accessCode = codeOf(packet);
    await f.service.activate(packet, 'destination');
    expect(JSON.parse(await readFile(f.file, 'utf8')).grants).toEqual([]);
    expect((await f.service.request('destination', { accessCode, operation: 'status' }) as ContinuityAccessStatus).canonicalId).toBe('canonical-one');
    await f.service.close();
    await expect(new ContinuityAccess(f.options).request('destination', { accessCode, operation: 'status' })).rejects.toThrow('unavailable');
  });
  it('preserves durable grants when a private Native preview is canceled, demoting only the committed transition', async () => {
    const f = await fixture(), packet = await f.service.prepare('Capsule', f.context), accessCode = codeOf(packet);
    await f.service.activate(packet, 'destination');
    expect(JSON.parse(await readFile(f.file, 'utf8')).grants).toHaveLength(1);
    expect(await f.service.prepare('Private Native hop', { ...f.context, persistent: false, target: { kind: 'native', connectionId: 'no-history' } })).toBe('Private Native hop');
    expect(JSON.parse(await readFile(f.file, 'utf8')).grants).toHaveLength(1);
    await f.service.close();
    const restarted = new ContinuityAccess(f.options);
    expect((await restarted.request('destination', { accessCode, operation: 'status' }) as ContinuityAccessStatus).canonicalId).toBe('canonical-one');
    await restarted.demote('canonical-one');
    expect(JSON.parse(await readFile(f.file, 'utf8')).grants).toEqual([]);
    await restarted.activate(packet, 'destination');
    expect(JSON.parse(await readFile(f.file, 'utf8')).grants).toEqual([]);
    expect((await restarted.request('destination', { accessCode, operation: 'status' }) as ContinuityAccessStatus).canonicalId).toBe('canonical-one');
  });
  it('removes a previously persisted grant when its destination disables history', async () => {
    const f = await fixture(), packet = await f.service.prepare('Capsule', f.context), accessCode = codeOf(packet);
    await f.service.activate(packet, 'destination'); f.binding.persistent = false;
    await f.service.request('destination', { accessCode, operation: 'status' });
    expect(JSON.parse(await readFile(f.file, 'utf8')).grants).toEqual([]);
    f.binding.persistent = true; await f.service.activate(packet, 'destination');
    expect(JSON.parse(await readFile(f.file, 'utf8')).grants).toEqual([]);
  });
  it('does not issue access for Native or an unbound manual target and enforces paging and transport bounds', async () => {
    const f = await fixture();
    expect(await f.service.prepare('Plain', { ...f.context, target: { kind: 'native', connectionId: 'native' } })).toBe('Plain');
    expect(await f.service.prepare('Plain', { ...f.context, target: { kind: 'manual', label: 'Unbound' }, destination: { ...f.context.destination, sessionId: undefined } })).toBe('Plain');
    await expect(f.service.prepare('x'.repeat(14 * 1024), f.context)).rejects.toThrow('transport limit');
    const packet = await f.service.prepare('Capsule', f.context), accessCode = codeOf(packet); await f.service.activate(packet, 'destination');
    await expect(f.service.request('destination', { accessCode, operation: 'status', offset: -1 })).rejects.toThrow('offset');
    await expect(f.service.request('destination', { accessCode, operation: 'read', snapshotId: 'snapshot-one', limit: 3 })).rejects.toThrow('page limit');
    await expect(f.service.request('destination', { accessCode, operation: 'status', offset: 99 })).rejects.toThrow('outside');
  });
  it('rechecks privacy after an asynchronous archive read and seals admission while close drains it', async () => {
    const f = await fixture(); let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), released = new Promise<void>(resolve => { finish = resolve; });
    const service = new ContinuityAccess({ ...f.options, read: async (id, input) => { entered(); await released; return f.options.read(id, input); } });
    const packet = await service.prepare('Capsule', f.context), accessCode = codeOf(packet); await service.activate(packet, 'destination');
    const reading = service.request('destination', { accessCode, operation: 'read', snapshotId: 'snapshot-one' }); await started;
    let closed = false; const closing = service.close().then(() => { closed = true; });
    await expect(service.request('destination', { accessCode, operation: 'status' })).rejects.toThrow('closed');
    expect(closed).toBe(false); f.deny(); finish();
    await expect(reading).rejects.toThrow('privacy'); await closing; expect(closed).toBe(true);
  });
  it('revalidates revocation after archive I/O without blocking revocation behind the read', async () => {
    const f = await fixture(); let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), released = new Promise<void>(resolve => { finish = resolve; });
    const service = new ContinuityAccess({ ...f.options, read: async (id, input) => { entered(); await released; return f.options.read(id, input); } });
    const packet = await service.prepare('Capsule', f.context), accessCode = codeOf(packet); await service.activate(packet, 'destination');
    const reading = service.request('destination', { accessCode, operation: 'read', snapshotId: 'snapshot-one' }); await started;
    await service.revoke(); finish();
    await expect(reading).rejects.toThrow('unavailable');
    expect(JSON.parse(await readFile(f.file, 'utf8')).grants).toEqual([]);
    await expect(service.activate(packet, 'destination')).rejects.toThrow('unavailable');
  });
  it('allows preview decoration and an external archive read concurrently without inverting their serial lanes', async () => {
    const f = await fixture(); let hold = false, sourceEntered!: () => void, releaseSource!: () => void, readEntered!: () => void;
    const sourceStarted = new Promise<void>(resolve => { sourceEntered = resolve; });
    const sourceReleased = new Promise<void>(resolve => { releaseSource = resolve; });
    const readStarted = new Promise<void>(resolve => { readEntered = resolve; });
    const accessService = new ContinuityAccess({ ...f.options, read: async (id, input) => { readEntered(); return continuity.readContinuity(id, input); } });
    const continuity: SessionContinuity = new SessionContinuity({ file: join(f.root, 'chain.json'),
      snapshot: async id => {
        if (hold && id === 'source') { sourceEntered(); await sourceReleased; }
        return { ...f.context.source, sessionId: id, entries: [{ id: 'goal', kind: 'user', text: 'Complete parser' }] };
      },
      inspectTarget: async () => f.context.destination,
      decoratePacket: (packet, context) => accessService.prepare(packet, context),
      applyEffect: async (_source, _target, packet, _operation, target) => { await accessService.activate(packet, target.sessionId!); return { state: 'submitted' }; },
    });
    const first = await continuity.previewHandover('source', { target: f.context.target });
    await continuity.applyHandover('source', { reviewId: first.reviewId, operationId: 'first' });
    hold = true;
    const previewing = continuity.previewHandover('source', { target: f.context.target }); await sourceStarted;
    const reading = accessService.request('destination', { accessCode: codeOf(first.packet), operation: 'read', snapshotId: first.coverage[0]!.id }); await readStarted;
    releaseSource();
    const [preview, result] = await Promise.all([previewing, reading]);
    expect(preview.canonicalId).toBe(first.canonicalId); expect((result as ContinuityReadPage).entries[0]!.text).toBe('Complete parser');
    await accessService.close(); await continuity.close();
  });
  it('redacts access codes from later source archives and repeated handover capsules without changing outbound delivery', async () => {
    const f = await fixture();
    const accessService = new ContinuityAccess({ ...f.options, read: (id, input) => continuity.readContinuity(id, input) });
    const sources = new Map<string, ContinuitySourceSnapshot>([['source', { ...f.context.source, entries: [{ id: 'goal', kind: 'user', text: 'Complete parser' }] }], ['destination', { ...f.context.source, sessionId: 'destination', sourceId: 'gemini', nativeSessionId: 'gemini-thread' }]]);
    let sends = 0, outbound = '';
    const continuity: SessionContinuity = new SessionContinuity({ file: join(f.root, 'chain.json'), snapshot: async id => structuredClone(sources.get(id)!),
      inspectTarget: async (_source, target) => ({ ...f.context.destination, ...(target.kind === 'manual' && !target.sessionId ? { sessionId: undefined } : {}) }),
      decoratePacket: (packet, context) => accessService.prepare(packet, context),
      applyEffect: async (_source, _target, packet, _operation, target) => { await accessService.activate(packet, target.sessionId!); sends++; outbound = packet; return { state: 'unknown' }; },
    });
    const preview = await continuity.previewHandover('source', { target: f.context.target }), accessCode = codeOf(preview.packet);
    const receipt = await continuity.applyHandover('source', { reviewId: preview.reviewId, operationId: 'dispatch' });
    expect(outbound).toContain(accessCode); expect(redact(outbound)).not.toContain(accessCode);
    await continuity.applyHandover('source', { reviewId: preview.reviewId, operationId: 'dispatch' }); expect(sends).toBe(1);
    const archive = await accessService.request('destination', { accessCode, operation: 'read', snapshotId: preview.coverage[0]!.id }) as ContinuityReadPage;
    expect(archive.entries[0]!.text).toBe('Complete parser');
    sources.get('destination')!.entries = [{ id: 'import', kind: 'user', text: outbound }, { id: 'tool', kind: 'tool', text: `Used context access ${accessCode}` }];
    await continuity.reconcileHandover('source', { operationId: 'dispatch', packetDigest: receipt.packetDigest, outcome: 'accepted' });
    const next = await continuity.previewHandover('destination', { target: { kind: 'manual', label: 'Next harness' } });
    expect(next.packet).not.toContain(accessCode);
    const stored = await continuity.readContinuity('destination', { snapshotId: next.coverage.at(-1)!.id });
    expect(JSON.stringify(stored)).not.toContain(accessCode); expect(JSON.stringify(stored)).toContain('[redacted]');
    expect(await readFile(join(f.root, 'chain.json'), 'utf8')).not.toContain(accessCode);
    expect(await readFile(f.file, 'utf8')).not.toContain(accessCode);
    await accessService.close(); await continuity.close();
  });
});
