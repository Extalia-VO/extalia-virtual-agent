import { access, mkdtemp, mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContinuityEntry, HandoverTarget } from '@extalia/platform';
import { redact } from '@extalia/core';
import { SessionContinuity, type ContinuityEffectResult, type ContinuitySourceSnapshot, type ContinuityTargetSnapshot } from '../src/sessionContinuity.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const now = Date.parse('2026-01-02T03:04:05Z');
function source(sessionId = 'codex-session', sourceId = 'codex', entries?: ContinuityEntry[]): ContinuitySourceSnapshot {
  return { sessionId, workspaceId: 'workspace-test', sourceId, nativeSessionId: `${sourceId}-thread`, title: `${sourceId} task`, revision: `${sessionId}-v1`, persistent: true,
    coverage: { mode: 'full', observedThrough: 'event-2', observedEntries: entries?.length ?? 2, omittedEntries: 0, limits: [] },
    entries: entries ?? [{ id: 'event-1', kind: 'user', text: 'Build the parser. Retain strict validation and verify all cases.' }, { id: 'event-2', kind: 'assistant', text: 'Parser implemented; boundary tests remain.' }] };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'extalia-continuity-')); roots.push(root);
  const file = join(root, 'continuity.json');
  const sources = new Map<string, ContinuitySourceSnapshot>([['codex-session', source()], ['gemini-session', source('gemini-session', 'gemini')], ['claude-session', source('claude-session', 'claude')]]);
  let revision = 'target-v1', timestamp = now, targetPersistent = true;
  const effects: { source: string; target: HandoverTarget; packet: string; operation: string }[] = [];
  let effect: ((target: HandoverTarget) => Promise<ContinuityEffectResult>) | undefined;
  const options = {
    file, now: () => timestamp,
    snapshot: async (id: string) => { const value = sources.get(id); if (!value) throw new Error('Missing selected source.'); return structuredClone(value); },
    inspectTarget: async (from: ContinuitySourceSnapshot, target: HandoverTarget): Promise<ContinuityTargetSnapshot> => ({ revision, label: target.kind,
      workspaceId: from.workspaceId, persistent: targetPersistent,
      ...(target.kind === 'native' ? { sessionId: from.sessionId } : target.sessionId ? { sessionId: target.sessionId } : {}) }),
    applyEffect: async (from: ContinuitySourceSnapshot, target: HandoverTarget, packet: string, operation: string): Promise<ContinuityEffectResult> => {
      effects.push({ source: from.sessionId, target, packet, operation });
      if (effect) return effect(target);
      return { state: target.kind === 'native' ? 'native-ready' : target.kind === 'manual' ? 'manual-ready' : 'submitted' };
    },
  };
  return { file, root, sources, effects, options, service: new SessionContinuity(options),
    setRevision: (value: string) => { revision = value; }, advance: (ms: number) => { timestamp += ms; },
    setPrivateTarget: () => { targetPersistent = false; },
    setEffect: (value: typeof effect) => { effect = value; } };
}
const observed = (sessionId: string): HandoverTarget => ({ kind: 'observed', sessionId, capabilityId: 'capability-1' });

describe.skipIf(process.platform === 'win32')('handover reservation publication barriers', () => {
  it('does not invoke the destination when the reservation directory cannot be flushed', async () => {
    const f = await fixture();
    const preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session') });
    const input = { reviewId: preview.reviewId, operationId: 'reserve-flush-failed' };
    const handle = await open(f.root, 'r'), directory = await handle.stat();
    const prototype = Object.getPrototypeOf(handle) as { sync(): Promise<void> }, sync = prototype.sync;
    const barrier = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
      const info = await this.stat();
      if (info.isDirectory() && info.dev === directory.dev && info.ino === directory.ino) throw new Error('Reservation directory flush failed');
      await sync.call(this);
    });
    try {
      await expect(f.service.applyHandover('codex-session', input)).rejects.toThrow('Reservation directory flush failed');
      expect(f.effects).toHaveLength(0);
    } finally { barrier.mockRestore(); await handle.close(); }
    await f.service.close();
    const restarted = new SessionContinuity(f.options);
    expect(await restarted.applyHandover('codex-session', input)).toMatchObject({ state: 'unknown', retryable: false });
    expect(f.effects).toHaveLength(0);
    await restarted.close();
  });

  it('keeps a settled effect uncertain and never replays it if its receipt directory flush fails', async () => {
    const f = await fixture();
    const preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session') });
    const input = { reviewId: preview.reviewId, operationId: 'settlement-flush-failed' };
    const handle = await open(f.root, 'r'), directory = await handle.stat();
    const prototype = Object.getPrototypeOf(handle) as { sync(): Promise<void> }, sync = prototype.sync;
    let publications = 0;
    const barrier = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
      const info = await this.stat();
      if (info.isDirectory() && info.dev === directory.dev && info.ino === directory.ino && ++publications === 2) throw new Error('Settlement directory flush failed');
      await sync.call(this);
    });
    try {
      const receipt = await f.service.applyHandover('codex-session', input);
      expect(publications).toBe(2);
      expect(receipt).toMatchObject({ state: 'unknown', retryable: false, problem: expect.stringContaining('receipt could not be saved') });
      expect(await f.service.applyHandover('codex-session', input)).toMatchObject({ state: 'unknown', retryable: false });
      expect(f.effects).toHaveLength(1);
    } finally { barrier.mockRestore(); await handle.close(); }
    await f.service.close();
    const restarted = new SessionContinuity(f.options);
    // The rename is visible even though its persistence was not acknowledged.
    expect(await restarted.applyHandover('codex-session', input)).toMatchObject({ state: 'submitted', retryable: false });
    expect(f.effects).toHaveLength(1);
    await restarted.close();
  });

  it('acknowledges the reservation before dispatch and preserves its replay fence across restart', async () => {
    const f = await fixture();
    const preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session') });
    const input = { reviewId: preview.reviewId, operationId: 'acknowledged-reservation' };
    const handle = await open(f.root, 'r'), directory = await handle.stat();
    const prototype = Object.getPrototypeOf(handle) as { sync(): Promise<void> }, sync = prototype.sync;
    let acknowledged = false, dispatchedAfterAcknowledgement = false;
    const barrier = vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
      const info = await this.stat(); await sync.call(this);
      if (info.isDirectory() && info.dev === directory.dev && info.ino === directory.ino) {
        const journal = JSON.parse(await readFile(f.file, 'utf8'));
        expect(journal.chains[0].handovers[0]).toMatchObject({ operationId: input.operationId, state: 'unknown' });
        acknowledged = true;
      }
    });
    f.setEffect(async () => { dispatchedAfterAcknowledgement = acknowledged; throw new Error('Destination acknowledgement was lost'); });
    try {
      expect(await f.service.applyHandover('codex-session', input)).toMatchObject({ state: 'unknown', retryable: false });
      expect(dispatchedAfterAcknowledgement).toBe(true);
      expect(f.effects).toHaveLength(1);
    } finally { barrier.mockRestore(); await handle.close(); }
    await f.service.close();
    const restarted = new SessionContinuity(f.options);
    expect(await restarted.applyHandover('codex-session', input)).toMatchObject({ state: 'unknown', retryable: false });
    expect(f.effects).toHaveLength(1);
    await restarted.close();
  });
});

describe('session continuity', () => {
  it('reserves reviewed workspace references alongside the original request in a long bounded archive', async () => {
    const f = await fixture(), contextId = `workspace-context-${'a'.repeat(64)}`;
    const original = source('codex-session', 'codex', [{ id: contextId, kind: 'status', text: 'Reviewed reference '.repeat(300) },
      { id: 'original-goal', kind: 'user', text: 'Keep the original parser decision.' },
      ...Array.from({ length: 600 }, (_, index) => ({ id: `later-${index}`, kind: 'assistant' as const, text: `Later claim ${index}. ${'x'.repeat(2000)}` }))]);
    original.workspaceContext = { workspaceId: original.workspaceId, profileId: 'profile-test', boundary: 'b'.repeat(64) };
    f.sources.set('codex-session', original);
    const view = await f.service.sessionContinuity('codex-session');
    const page = await f.service.readContinuity('codex-session', { snapshotId: view.snapshots[0]!.id, offset: 0, limit: 2 });
    expect(page.entries.map(entry => entry.id)).toEqual([contextId, 'original-goal']);
    expect(view.snapshots[0]!.coverage.mode).toBe('partial');
    const preview = await f.service.previewHandover('codex-session', { target: { kind: 'manual', label: 'Reviewed receiver' } });
    expect(preview.packet).toContain('Archives also retain bounded workspace memory');
  });
  it('checks whether continuity is bound without capturing history or creating storage', async () => {
    const f = await fixture();
    expect(await f.service.has('codex-session')).toBe(false);
    await expect(access(f.file)).rejects.toThrow();
    await f.service.sessionContinuity('codex-session');
    expect(await f.service.has('codex-session')).toBe(true);
    expect(await f.service.has('gemini-session')).toBe(false);
    expect(await f.service.has('../invalid')).toBe(false);
  });
  it('fills an initially empty source goal when the first prompt arrives, while preserving explicitly reviewed empty notes', async () => {
    const f = await fixture(); f.sources.set('codex-session', source('codex-session', 'codex', []));
    const empty = await f.service.sessionContinuity('codex-session');
    expect(empty.notes.goal).toBe('');
    f.sources.set('codex-session', source());
    const populated = await f.service.sessionContinuity('codex-session');
    expect(populated.canonicalId).toBe(empty.canonicalId);
    expect(populated.notes.goal).toContain('Build the parser');
    const notes = { goal: '', decisions: '', completed: '', pending: '', verification: '', risks: '' };
    const preview = await f.service.previewHandover('codex-session', { target: { kind: 'manual', label: 'Reviewed' }, notes });
    await f.service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'review-empty-goal' });
    f.sources.get('codex-session')!.entries = [{ id: 'new-user', kind: 'user', text: 'A later prompt must not replace reviewed notes.' }];
    const reviewed = await f.service.sessionContinuity('codex-session');
    expect(reviewed.notesOrigin).toBe('user-reviewed'); expect(reviewed.notes.goal).toBe('');
  });
  it('discloses Unicode working-note clipping while retaining the full reviewed notes', async () => {
    const f = await fixture();
    const notes = { goal: '目标'.repeat(1900), decisions: '决策'.repeat(1900), completed: '', pending: '', verification: '', risks: '' };
    const preview = await f.service.previewHandover('codex-session', { target: { kind: 'manual', label: 'Archive review' }, notes });
    expect(preview.packet).toContain('[shortened; full reviewed notes remain in Extalia]');
    expect(preview.packet).toContain(`Packet omits ${preview.packetOmittedEntries} retained entries`);
    expect(Buffer.byteLength(preview.packet)).toBeLessThanOrEqual(12 * 1024);
    expect(preview.notes).toEqual(notes);
    await f.service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'unicode-notes' });
    expect((await f.service.sessionContinuity('codex-session')).notes).toEqual(notes);
  });
  it('reserves the inspected Native endpoint before creation and retains it after an uncertain effect and restart', async () => {
    const f = await fixture(); let inspectedCanonical = '', effectDestination = '';
    const service = new SessionContinuity({ ...f.options,
      inspectTarget: async (from, _target, continuity) => {
        inspectedCanonical = continuity!.canonicalId;
        return { revision: 'allocated-endpoint-v1', label: 'Native endpoint', sessionId: 'native-reserved', workspaceId: from.workspaceId, persistent: true };
      },
      applyEffect: async (_from, _target, _packet, _operation, destination) => {
        effectDestination = destination.sessionId!;
        const durable = JSON.parse(await readFile(f.file, 'utf8'));
        expect(durable.chains[0].sessionIds).toContain('native-reserved');
        expect(durable.chains[0].handovers[0].targetSessionId).toBe('native-reserved');
        throw new Error('Simulated crash during endpoint creation');
      },
    });
    const preview = await service.previewHandover('codex-session', { target: { kind: 'native', connectionId: 'native-connection' } });
    const receipt = await service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'preallocated' });
    expect(inspectedCanonical).toBe(preview.canonicalId); expect(effectDestination).toBe('native-reserved');
    expect(receipt.state).toBe('unknown'); expect(receipt.targetSessionId).toBe('native-reserved');
    await service.close();
    const restarted = new SessionContinuity(f.options);
    expect(await restarted.has('native-reserved')).toBe(true);
    expect(await restarted.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'preallocated' })).toEqual(receipt);
    expect(f.effects).toHaveLength(0);
  });

  it('preserves one canonical lineage over Codex → Gemini → Claude → Codex and a host restart', async () => {
    const f = await fixture();
    const first = await f.service.previewHandover('codex-session', { target: observed('gemini-session'), notes: {
      goal: 'Build the parser', decisions: 'Reject booleans', completed: 'Parser implemented', pending: 'Boundary tests', verification: 'No tests run yet', risks: 'Zero and negative values need coverage',
    } });
    const firstReceipt = await f.service.applyHandover('codex-session', { reviewId: first.reviewId, operationId: 'transfer-1' });
    expect(firstReceipt.state).toBe('submitted');
    f.sources.set('gemini-session', source('gemini-session', 'gemini', [
      { id: 'gemini-1', kind: 'user', text: 'Continue boundary tests for the parser.' },
      { id: 'gemini-2', kind: 'tool', text: 'Tests: 8 passed, exit code 0.' },
    ]));
    const second = await f.service.previewHandover('gemini-session', { target: observed('claude-session') });
    expect(second.canonicalId).toBe(first.canonicalId);
    expect(second.notes.decisions).toBe('Reject booleans');
    expect(second.packet).toContain('Build the parser');
    expect(second.packet).toContain('8 passed');
    expect(second.packet).toContain('submitted');
    await f.service.applyHandover('gemini-session', { reviewId: second.reviewId, operationId: 'transfer-2' });
    await f.service.close();
    const restarted = new SessionContinuity(f.options);
    const third = await restarted.previewHandover('claude-session', { target: observed('codex-session') });
    expect(third.canonicalId).toBe(first.canonicalId);
    expect(third.handoverCount).toBe(2);
    expect(third.coverage.map(item => item.sourceId)).toEqual(['codex', 'gemini', 'claude']);
    await restarted.applyHandover('claude-session', { reviewId: third.reviewId, operationId: 'transfer-3' });
    const view = await restarted.sessionContinuity('codex-session');
    expect(view.handovers).toHaveLength(3);
    expect(new Set(view.handovers.map(hop => hop.canonicalId))).toEqual(new Set([first.canonicalId]));
    expect(view.snapshots).toHaveLength(3); // Same source revision does not recursively duplicate imported packets.
    const archive = await restarted.readContinuity('codex-session', { snapshotId: first.coverage[0]!.id, limit: 1 });
    expect(archive.entries[0]!.text).toContain('strict validation');
    expect(archive.nextOffset).toBe(1);
  });

  it('excludes exact observed capsule echoes through repeated harnesses and restart without nesting generated packets', async () => {
    const f = await fixture();
    const service = new SessionContinuity({ ...f.options, decoratePacket: async packet => `${packet}\nScoped code: sk-extalia-context-${'a'.repeat(64)}\n` });
    let current = 'codex-session';
    const originalGoal = (await service.sessionContinuity(current)).notes.goal;
    for (const [index, target] of ['gemini-session', 'claude-session', 'codex-session'].entries()) {
      const preview = await service.previewHandover(current, { target: observed(target) });
      expect(preview.packet.match(/EXTALIA CONTINUITY CAPSULE v1/g)).toHaveLength(1);
      const receipt = await service.applyHandover(current, { reviewId: preview.reviewId, operationId: `echo-hop-${index}` });
      expect(receipt.sanitizedPacketDigest).toMatch(/^[a-f0-9]{64}$/);
      const previous = target === 'codex-session' ? [...f.sources.get(target)!.entries] : [];
      const work: ContinuityEntry = { id: `work-${index}`, kind: 'tool', text: `Original verification step ${index}: passed.` };
      const echo: ContinuityEntry = { id: `echo-${index}`, kind: 'user', text: `  ${redact(preview.packet).replace(/\n/g, '\r\n')}  ` };
      f.sources.get(target)!.entries = [...previous, work, echo];
      f.sources.get(target)!.coverage.observedThrough = echo.id;
      const view = await service.sessionContinuity(target), latest = view.snapshots.at(-1)!;
      expect(latest.coverage.limits.join(' ')).toContain('1 exact previously handed-over user capsules excluded');
      expect(latest.coverage.observedThrough).toBe(work.id);
      const archive = await service.readContinuity(target, { snapshotId: latest.id });
      expect(archive.entries.some(entry => entry.id === echo.id)).toBe(false);
      expect(archive.entries.some(entry => entry.id === work.id)).toBe(true);
      expect(view.notes.goal).toBe(originalGoal);
      current = target;
    }
    await service.close();
    const restarted = new SessionContinuity(f.options);
    const final = await restarted.previewHandover('codex-session', { target: { kind: 'manual', label: 'Review original work' } });
    expect(final.packet.match(/EXTALIA CONTINUITY CAPSULE v1/g)).toHaveLength(1);
    expect(final.notes.goal).toBe(originalGoal);
    expect(final.handoverCount).toBe(3);
    expect(final.packet).toContain('Original verification step 2');
  });
  it('keeps user commentary, assistant quotes and an exact packet addressed to another conversation', async () => {
    const f = await fixture();
    const first = await f.service.previewHandover('codex-session', { target: observed('gemini-session') });
    await f.service.applyHandover('codex-session', { reviewId: first.reviewId, operationId: 'quoted-packet' });
    f.sources.get('gemini-session')!.entries = [
      { id: 'exact', kind: 'user', text: first.packet },
      { id: 'comment', kind: 'user', text: `My question about this handover:\n${first.packet}` },
      { id: 'assistant-quote', kind: 'assistant', text: first.packet },
    ];
    const gemini = await f.service.sessionContinuity('gemini-session');
    expect((await f.service.readContinuity('gemini-session', { snapshotId: gemini.snapshots.at(-1)!.id })).entries.map(entry => entry.id))
      .toEqual(['comment', 'assistant-quote']);
    f.sources.get('codex-session')!.entries = [{ id: 'wrong-recipient', kind: 'user', text: first.packet }];
    const codex = await f.service.sessionContinuity('codex-session');
    expect((await f.service.readContinuity('codex-session', { snapshotId: codex.snapshots.at(-1)!.id })).entries[0]!.id).toBe('wrong-recipient');
  });
  it('keeps unsubmitted previews and rejected packets, and invalidates review when an excluded source echo changes', async () => {
    const f = await fixture();
    const draft = await f.service.previewHandover('codex-session', { target: { kind: 'manual', label: 'Draft only' } });
    f.sources.get('codex-session')!.entries = [{ id: 'draft-quote', kind: 'user', text: draft.packet }];
    const draftView = await f.service.sessionContinuity('codex-session');
    expect((await f.service.readContinuity('codex-session', { snapshotId: draftView.snapshots.at(-1)!.id })).entries).toHaveLength(1);
    f.setEffect(async () => ({ state: 'rejected' }));
    const rejected = await f.service.previewHandover('codex-session', { target: observed('codex-session') });
    await f.service.applyHandover('codex-session', { reviewId: rejected.reviewId, operationId: 'rejected-packet' });
    f.sources.get('codex-session')!.entries = [{ id: 'rejected-quote', kind: 'user', text: rejected.packet }];
    const rejectedView = await f.service.sessionContinuity('codex-session');
    expect((await f.service.readContinuity('codex-session', { snapshotId: rejectedView.snapshots.at(-1)!.id })).entries).toHaveLength(1);
    f.setEffect(undefined);
    const delivered = await f.service.previewHandover('codex-session', { target: observed('gemini-session') });
    await f.service.applyHandover('codex-session', { reviewId: delivered.reviewId, operationId: 'delivered-packet' });
    f.sources.get('gemini-session')!.entries = [{ id: 'echo', kind: 'user', text: delivered.packet }];
    const next = await f.service.previewHandover('gemini-session', { target: observed('claude-session') });
    expect(next.coverage.at(-1)!.entries).toBe(0);
    expect(next.coverage.at(-1)!.coverage.observedThrough).toBeUndefined();
    f.sources.get('gemini-session')!.entries = [{ id: 'echo', kind: 'user', text: delivered.packet + ' ' }];
    await expect(f.service.applyHandover('gemini-session', { reviewId: next.reviewId, operationId: 'changed-echo' })).rejects.toThrow('changed');
  });

  it('rejects changed source evidence, even if a caller reuses its revision string', async () => {
    const f = await fixture(), preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session') });
    f.sources.get('codex-session')!.entries = [{ id: 'changed', kind: 'user', text: 'New instruction after preview' }];
    await expect(f.service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'stale' })).rejects.toThrow('changed');
    expect(f.effects).toHaveLength(0);
  });

  it('rejects destination generation drift and expired reviews', async () => {
    const f = await fixture(), preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session') });
    f.setRevision('target-v2');
    await expect(f.service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'stale-target' })).rejects.toThrow('changed');
    const fresh = await f.service.previewHandover('codex-session', { target: observed('gemini-session') });
    f.advance(10 * 60_000 + 1);
    await expect(f.service.applyHandover('codex-session', { reviewId: fresh.reviewId, operationId: 'expired' })).rejects.toThrow('expired');
    expect(f.effects).toHaveLength(0);
  });

  it('writes a reservation before the effect and never replays an unknown outcome after restart', async () => {
    const f = await fixture();
    f.setEffect(async () => {
      const saved = JSON.parse(await readFile(f.file, 'utf8'));
      expect(saved.chains[0].handovers[0].state).toBe('unknown');
      throw new Error('Transport disappeared after send');
    });
    const preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session') });
    const request = { reviewId: preview.reviewId, operationId: 'uncertain' };
    expect((await f.service.applyHandover('codex-session', request)).state).toBe('unknown');
    await f.service.close();
    const restarted = new SessionContinuity(f.options);
    expect((await restarted.applyHandover('codex-session', request)).state).toBe('unknown');
    await expect(restarted.previewHandover('gemini-session', { target: observed('claude-session') })).rejects.toThrow('uncertain');
    expect(f.effects).toHaveLength(1);
  });

  it('returns the same successful receipt idempotently and rejects operation-ID reuse for another review', async () => {
    const f = await fixture(), preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session') });
    const request = { reviewId: preview.reviewId, operationId: 'once' };
    const receipt = await f.service.applyHandover('codex-session', request);
    expect(await f.service.applyHandover('codex-session', request)).toEqual(receipt);
    await expect(f.service.applyHandover('codex-session', { ...request, reviewId: 'different-review' })).rejects.toThrow('another');
    expect(f.effects).toHaveLength(1);
    f.sources.delete('codex-session');
    await expect(f.service.applyHandover('codex-session', request)).rejects.toThrow('Missing');
  });

  it('keeps history-off chains RAM-only, including subsequent saved destinations', async () => {
    const f = await fixture(); f.sources.get('codex-session')!.persistent = false;
    const preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session') });
    expect(preview.persistent).toBe(false);
    await f.service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'private-transfer' });
    expect((await f.service.sessionContinuity('gemini-session')).persistent).toBe(false);
    expect(await readFile(f.file, 'utf8')).not.toContain('Build the parser');
    expect(JSON.parse(await readFile(f.file, 'utf8')).chains).toEqual([]);
  });

  it('keeps a canceled private-destination preview durable and only removes disk history after confirmation', async () => {
    const f = await fixture(); await f.service.sessionContinuity('codex-session');
    expect(await readFile(f.file, 'utf8')).toContain('Build the parser');
    f.setPrivateTarget();
    const preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session') });
    expect(preview.persistent).toBe(false);
    expect(JSON.parse(await readFile(f.file, 'utf8')).chains).toHaveLength(1);
    await f.service.close();
    const restarted = new SessionContinuity(f.options);
    expect((await restarted.sessionContinuity('codex-session')).persistent).toBe(true);
    const review = await restarted.previewHandover('codex-session', { target: observed('gemini-session') });
    await restarted.applyHandover('codex-session', { reviewId: review.reviewId, operationId: 'confirmed-private' });
    expect(restarted.retention('codex-session')).toBe(false);
    expect(restarted.canonicalIdFor('gemini-session')).toBe(review.canonicalId);
    expect(JSON.parse(await readFile(f.file, 'utf8')).chains).toEqual([]);
  });

  it('refuses read access after the host revokes source privacy or workspace binding', async () => {
    const f = await fixture(), initial = await f.service.sessionContinuity('codex-session');
    f.sources.get('codex-session')!.workspaceId = 'different-workspace';
    await expect(f.service.readContinuity('codex-session', { snapshotId: initial.snapshots[0]!.id })).rejects.toThrow('workspace');
    f.sources.delete('codex-session'); // A labels-only host may likewise refuse the snapshot callback.
    await expect(f.service.readContinuity('codex-session', { snapshotId: initial.snapshots[0]!.id })).rejects.toThrow('Missing');
  });

  it('keeps manual readiness separate from delivered or consumed context', async () => {
    const f = await fixture(), preview = await f.service.previewHandover('codex-session', { target: { kind: 'manual', label: 'Another agent', sessionId: 'gemini-session' } });
    const receipt = await f.service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'manual' });
    expect(receipt.state).toBe('manual-ready');
    expect(receipt).not.toHaveProperty('acknowledged');
    expect((await f.service.sessionContinuity('gemini-session')).canonicalId).toBe(preview.canonicalId);
  });

  it('reviews a status-only destination archive without joining it until Apply', async () => {
    const f = await fixture(), original = await f.service.sessionContinuity('codex-session'), target = await f.service.sessionContinuity('gemini-session');
    const preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session') });
    expect(preview.targetChain).toEqual({ canonicalId: target.canonicalId, revision: target.revision, snapshots: 1, handovers: 0, requiresConsent: false });
    expect(preview.coverage.map(snapshot => snapshot.id)).toContain(target.snapshots[0]!.id);
    expect(JSON.parse(await readFile(f.file, 'utf8')).chains).toHaveLength(2);
    expect(f.effects).toHaveLength(0);
    await f.service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'join-status-only' });
    expect(f.service.canonicalIdFor('gemini-session')).toBe(original.canonicalId);
    expect(f.service.canonicalIdsFor('gemini-session')).toEqual([original.canonicalId, target.canonicalId]);
    expect(await f.service.readContinuity('gemini-session', { snapshotId: target.snapshots[0]!.id, canonicalId: target.canonicalId })).toMatchObject({ canonicalId: target.canonicalId, total: 2 });
  });

  it('bounds Unicode transport bytes, retains archive pages and states gaps explicitly', async () => {
    const f = await fixture();
    const entries: ContinuityEntry[] = Array.from({ length: 700 }, (_, index) => ({ id: `event-${index}`, kind: index === 0 ? 'user' : 'tool', text: `${index} ${'界🌏'.repeat(4000)}` }));
    f.sources.set('codex-session', source('codex-session', 'codex', entries));
    const preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session') });
    expect(Buffer.byteLength(preview.packet)).toBeLessThanOrEqual(14 * 1024);
    expect(preview.packet.length).toBeLessThan(16000);
    expect(preview.coverage[0]!.coverage.mode).toBe('partial');
    expect(preview.coverage[0]!.coverage.omittedEntries).toBeGreaterThan(0);
    expect(preview.coverage[0]!.coverage.limits.join(' ')).toContain('shortened');
    expect(preview.packet).toContain('Hidden harness context');
    const archive = await f.service.readContinuity('codex-session', { snapshotId: preview.coverage[0]!.id, offset: 0, limit: 1 });
    expect(archive.entries[0]!.id).toBe('event-0');
  });

  it('retains the model, effort and connection for each Native snapshot and freezes the destination label', async () => {
    const f = await fixture();
    const initial = source('codex-session', 'extalia-native');
    initial.model = 'gemini-example'; initial.effort = 'high'; initial.connectionId = 'connection-a';
    f.sources.set('codex-session', initial);
    const first = await f.service.previewHandover('codex-session', { target: { kind: 'native', connectionId: 'connection-b', model: 'claude-example' } });
    expect(first.packet).toContain('gemini-example (high)');
    const receipt = await f.service.applyHandover('codex-session', { reviewId: first.reviewId, operationId: 'model-change' });
    expect(receipt.targetLabel).toBe(first.targetLabel);
    f.sources.set('codex-session', { ...initial, model: 'claude-example', effort: 'medium', connectionId: 'connection-b' });
    const next = await f.service.sessionContinuity('codex-session');
    expect(next.snapshots.map(snapshot => [snapshot.model, snapshot.effort, snapshot.connectionId])).toEqual([
      ['gemini-example', 'high', 'connection-a'], ['claude-example', 'medium', 'connection-b'],
    ]);
    expect(next.notes.goal).toContain('Build the parser');
  });

  it('redacts credentials from notes and archived evidence', async () => {
    const f = await fixture();
    f.sources.set('codex-session', source('codex-session', 'codex', [{ id: 'one', kind: 'user', text: 'Use api_key=sk_test_abcdefghijklmnopqrstuvwxyz1234567890 only as a redaction fixture.' }]));
    const preview = await f.service.previewHandover('codex-session', { target: { kind: 'manual', label: 'Review' } });
    expect(preview.packet).not.toContain('sk_test_abcdefghijklmnopqrstuvwxyz1234567890');
    expect(await readFile(f.file, 'utf8')).not.toContain('sk_test_abcdefghijklmnopqrstuvwxyz1234567890');
  });

  it('leaves malformed storage untouched and never invokes an effect', async () => {
    const f = await fixture(); await writeFile(f.file, '{invalid');
    await expect(f.service.sessionContinuity('codex-session')).rejects.toThrow('not valid JSON');
    expect(await readFile(f.file, 'utf8')).toBe('{invalid'); expect(f.effects).toHaveLength(0);
  });

  it('does not invoke an effect if its reservation cannot be saved', async () => {
    const f = await fixture(), preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session') });
    await rename(f.file, `${f.file}.preserved`); await mkdir(f.file);
    await expect(f.service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'write-failure' })).rejects.toThrow();
    expect(f.effects).toHaveLength(0);
  });

  it('keeps an entered effect unknown when the final receipt write fails', async () => {
    const f = await fixture();
    f.setEffect(async () => { await rename(f.file, `${f.file}.reserved`); await mkdir(f.file); return { state: 'submitted' }; });
    const preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session') });
    const request = { reviewId: preview.reviewId, operationId: 'receipt-failure' };
    expect((await f.service.applyHandover('codex-session', request)).state).toBe('unknown');
    await rm(f.file, { recursive: true }); await rename(`${f.file}.reserved`, f.file);
    await f.service.close();
    expect((await new SessionContinuity(f.options).applyHandover('codex-session', request)).state).toBe('unknown');
    expect(f.effects).toHaveLength(1);
  });

  it('binds a newly created Native target returned by an observed-source effect', async () => {
    const f = await fixture();
    const options = { ...f.options, inspectTarget: async (): Promise<ContinuityTargetSnapshot> => ({ revision: 'new-native-v1', label: 'Native', workspaceId: 'workspace-test', persistent: true }) };
    f.setEffect(async () => { f.sources.set('new-native-session', source('new-native-session', 'extalia-native')); return { state: 'native-ready', targetSessionId: 'new-native-session' }; });
    const service = new SessionContinuity(options), preview = await service.previewHandover('codex-session', { target: { kind: 'native', connectionId: 'connection-1' } });
    const receipt = await service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'new-native' });
    expect(receipt.state).toBe('native-ready'); expect(receipt.targetSessionId).toBe('new-native-session');
    expect((await service.sessionContinuity('new-native-session')).canonicalId).toBe(preview.canonicalId);
  });
});

describe('pinned checkpoints and reviewed lineage joins', () => {
  async function checkpointFixture() {
    const f = await fixture(); let snapshots = 0, denied = false;
    for (const source of f.sources.values()) source.authorityRevision = 'authority-v1';
    const options = { ...f.options,
      snapshot: async (id: string) => { snapshots++; return f.options.snapshot(id); },
      inspectSourceAccess: async (id: string) => {
        if (denied) throw new Error('Source watch consent was revoked.');
        const source = f.sources.get(id)!;
        return { sessionId: id, workspaceId: source.workspaceId, persistent: source.persistent, revision: source.authorityRevision! };
      },
    };
    return { ...f, options, service: new SessionContinuity(options), snapshots: () => snapshots, deny: () => { denied = true; } };
  }
  it('applies the frozen active checkpoint after later progress and status captures without recapturing during Apply or archive reads', async () => {
    const f = await checkpointFixture(); f.sources.get('codex-session')!.activity = 'active';
    const preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session'), capture: 'checkpoint' });
    expect(preview.capture).toBe('checkpoint');
    expect(preview.checkpoint).toEqual({ capturedAt: new Date(now).toISOString(), observedThrough: 'event-2', activity: 'active' });
    expect(preview.packet).toContain('does not stop the source');
    const originalArchive = await f.service.readContinuity('codex-session', { snapshotId: preview.coverage[0]!.id });
    const live = f.sources.get('codex-session')!;
    live.entries = [...live.entries, { id: 'after-checkpoint', kind: 'tool', text: 'Later unreviewed tool result: do not send this yet.' }];
    live.revision = 'source-v2'; live.coverage.observedThrough = 'after-checkpoint';
    const refreshed = await f.service.sessionContinuity('codex-session');
    expect(refreshed.revision).toBeGreaterThan(1);
    const captured = f.snapshots();
    const receipt = await f.service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'pinned-active' });
    expect(receipt.state).toBe('submitted'); expect(f.snapshots()).toBe(captured);
    expect(f.effects[0]!.packet).toBe(preview.packet); expect(f.effects[0]!.packet).not.toContain('Later unreviewed');
    expect(await f.service.readContinuity('codex-session', { snapshotId: preview.coverage[0]!.id })).toEqual(originalArchive);
    expect(f.snapshots()).toBe(captured);
    await f.service.close(); const restarted = new SessionContinuity(f.options);
    expect(await restarted.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'pinned-active' })).toEqual(receipt);
    expect(f.effects).toHaveLength(1); expect(f.snapshots()).toBe(captured);
  });
  it.each(['source-authority', 'destination', 'lineage'] as const)('rejects a checkpoint when %s changes', async change => {
    const f = await checkpointFixture();
    const preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session'), capture: 'checkpoint' });
    if (change === 'source-authority') f.sources.get('codex-session')!.authorityRevision = 'authority-v2';
    if (change === 'destination') f.setRevision('destination-v2');
    if (change === 'lineage') {
      const next = await f.service.previewHandover('codex-session', { target: { kind: 'manual', label: 'Separate reviewed transfer' }, capture: 'checkpoint',
        notes: { ...preview.notes, decisions: 'New reviewed decision after the older checkpoint.' } });
      await f.service.applyHandover('codex-session', { reviewId: next.reviewId, operationId: 'changed-lineage' });
    }
    await expect(f.service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'stale-checkpoint' })).rejects.toThrow('changed');
    expect(f.effects).toHaveLength(change === 'lineage' ? 1 : 0);
  });
  it('checks current source consent for checkpoint reads and receipt replay even when the old transcript is still available', async () => {
    const f = await checkpointFixture();
    const preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session'), capture: 'checkpoint' });
    await f.service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'authorized-once' });
    f.deny(); const captured = f.snapshots();
    await expect(f.service.readContinuity('codex-session', { snapshotId: preview.coverage[0]!.id })).rejects.toThrow('consent');
    await expect(f.service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'authorized-once' })).rejects.toThrow('consent');
    expect(f.snapshots()).toBe(captured); expect(f.effects).toHaveLength(1);
  });
  it('releases only a pristine synthetic inspection scope for explicit host-validated association', async () => {
    const f = await fixture(), source = f.sources.get('codex-session')!;
    source.workspaceId = `observed:${'a'.repeat(32)}`;
    const inspected = await f.service.sessionContinuity('codex-session');
    expect(await f.service.workspaceIdFor('codex-session')).toBeUndefined();
    source.workspaceId = 'isolated-registered-workspace';
    const associated = await f.service.sessionContinuity('codex-session');
    expect(associated.canonicalId).toBe(inspected.canonicalId); expect(associated.workspaceId).toBe(source.workspaceId);
    expect(await f.service.workspaceIdFor('codex-session')).toBe(source.workspaceId);
    const review = await f.service.previewHandover('codex-session', { target: { kind: 'manual', label: 'Registered transfer' }, capture: 'checkpoint' });
    await f.service.applyHandover('codex-session', { reviewId: review.reviewId, operationId: 'established-scope' });
    source.workspaceId = 'unrelated-workspace';
    await expect(f.service.sessionContinuity('codex-session')).rejects.toThrow('another workspace');
  });
  it('does not release a synthetic scope containing reviewed workspace references', async () => {
    const f = await fixture(), source = f.sources.get('codex-session')!;
    source.workspaceId = `observed:${'b'.repeat(32)}`;
    source.workspaceContext = { workspaceId: source.workspaceId, profileId: 'default', boundary: 'b'.repeat(64), connectionId: null };
    await f.service.sessionContinuity('codex-session');
    expect(await f.service.workspaceIdFor('codex-session')).toBe(source.workspaceId);
    source.workspaceId = 'unrelated-isolated-workspace';
    await expect(f.service.sessionContinuity('codex-session')).rejects.toThrow('another workspace');
  });
  it('requires explicit established-lineage consent, preserves original receipt IDs and notes, and survives restart', async () => {
    const f = await fixture();
    const previous = await f.service.previewHandover('gemini-session', { target: observed('claude-session'), notes: {
      goal: 'An independently reviewed parser objective', decisions: 'Independent design decision', completed: '', pending: '', verification: '', risks: '',
    } });
    const originalReceipt = await f.service.applyHandover('gemini-session', { reviewId: previous.reviewId, operationId: 'independent-transfer' });
    const preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session'), capture: 'checkpoint' });
    expect(preview.targetChain).toMatchObject({ canonicalId: previous.canonicalId, handovers: 1, requiresConsent: true });
    await expect(f.service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'no-merge-consent' })).rejects.toThrow('explicitly approve');
    const combined = await f.service.previewHandover('codex-session', { target: observed('gemini-session'), capture: 'checkpoint',
      mergeTargetChain: { canonicalId: preview.targetChain!.canonicalId, revision: preview.targetChain!.revision } });
    expect(combined.targetChain!.requiresConsent).toBe(false);
    expect(combined.packet).toContain('Independent design decision');
    expect(JSON.parse(await readFile(f.file, 'utf8')).chains).toHaveLength(2);
    await f.service.applyHandover('codex-session', { reviewId: combined.reviewId, operationId: 'approved-merge' });
    expect(f.service.canonicalIdsFor('claude-session')).toContain(previous.canonicalId);
    await f.service.close(); const restarted = new SessionContinuity(f.options);
    const result = await restarted.sessionContinuity('claude-session');
    expect(result.canonicalId).toBe(combined.canonicalId); expect(result.handovers).toContainEqual(originalReceipt);
    expect(await restarted.applyHandover('gemini-session', { reviewId: previous.reviewId, operationId: 'independent-transfer' })).toEqual(originalReceipt);
    expect(await restarted.readContinuity('claude-session', { snapshotId: previous.coverage[0]!.id, canonicalId: previous.canonicalId })).toMatchObject({ canonicalId: previous.canonicalId, total: 2 });
    await expect(restarted.readContinuity('claude-session', { snapshotId: previous.coverage[0]!.id, canonicalId: 'unrelated-canonical' })).rejects.toThrow('granted canonical');
    expect(f.effects).toHaveLength(2);
  });
  it('rejects changed destination merge consent and any uncertain target history', async () => {
    const f = await fixture();
    const first = await f.service.previewHandover('gemini-session', { target: observed('claude-session') });
    await f.service.applyHandover('gemini-session', { reviewId: first.reviewId, operationId: 'target-history' });
    const preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session') });
    f.sources.get('gemini-session')!.revision = 'new-target-capture';
    f.sources.get('gemini-session')!.entries = [...f.sources.get('gemini-session')!.entries, { id: 'new-target-evidence', kind: 'tool', text: 'A new result after the merge review.' }];
    await f.service.sessionContinuity('gemini-session');
    await expect(f.service.previewHandover('codex-session', { target: observed('gemini-session'), mergeTargetChain: preview.targetChain! })).rejects.toThrow('lineage changed');
    f.setEffect(async () => ({ state: 'unknown' }));
    const uncertain = await f.service.previewHandover('gemini-session', { target: { kind: 'manual', label: 'Uncertain transfer' } });
    await f.service.applyHandover('gemini-session', { reviewId: uncertain.reviewId, operationId: 'target-uncertain' });
    await expect(f.service.previewHandover('codex-session', { target: observed('gemini-session'), capture: 'checkpoint' })).rejects.toThrow('uncertain handover');
  });
  it('keeps both joined histories in memory when either lineage has history disabled', async () => {
    const f = await fixture(); f.sources.get('gemini-session')!.persistent = false;
    const target = await f.service.sessionContinuity('gemini-session');
    const preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session'), capture: 'checkpoint' });
    expect(preview.persistent).toBe(false);
    expect(JSON.parse(await readFile(f.file, 'utf8')).chains).toHaveLength(1);
    await f.service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'private-merge' });
    expect(f.service.canonicalIdsFor('codex-session')).toContain(target.canonicalId);
    expect(f.service.retention('codex-session')).toBe(false);
    expect(JSON.parse(await readFile(f.file, 'utf8')).chains).toEqual([]);
    await f.service.close(); expect(await new SessionContinuity(f.options).has('codex-session')).toBe(false);
  });
  it('stores repeated growing checkpoints as deltas without losing prior evidence or exceeding the chain budget', async () => {
    const f = await checkpointFixture(), live = f.sources.get('codex-session')!;
    live.entries = [{ id: 'initial-goal', kind: 'user', text: 'Preserve every verified marker.' },
      ...Array.from({ length: 14 }, (_, index) => ({ id: `initial-${index}`, kind: 'tool' as const, text: `Original marker ${index}: ${'x'.repeat(6900)}` }))];
    const initial = await f.service.sessionContinuity('codex-session');
    for (let index = 0; index < 40; index++) {
      live.entries = [...live.entries, { id: `round-${index}`, kind: 'tool', text: `New marker ${index}: ${'y'.repeat(1800)}` }];
      live.revision = `round-${index}`; live.coverage.observedThrough = `round-${index}`;
      const preview = await f.service.previewHandover('codex-session', { target: { kind: 'manual', label: 'Checkpoint reviewer' }, capture: 'checkpoint' });
      await f.service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: `checkpoint-${index}` });
    }
    const disk = await readFile(f.file, 'utf8'); expect(Buffer.byteLength(disk)).toBeLessThan(400_000);
    const state = JSON.parse(disk), stored = state.chains[0].snapshots;
    expect(stored).toHaveLength(41);
    expect(stored.slice(1).every((snapshot: { evidence: unknown[] }) => snapshot.evidence.length === 1)).toBe(true);
    expect(stored.flatMap((snapshot: { evidence: ContinuityEntry[] }) => snapshot.evidence).map((entry: ContinuityEntry) => entry.id)).toHaveLength(55);
    expect(stored.at(-1).coverage.limits[0]).toContain('unchanged entries are retained');
    const original = await f.service.readContinuity('codex-session', { snapshotId: initial.snapshots[0]!.id, limit: 50 });
    expect(original.entries).toHaveLength(15); expect(original.entries[1]!.text).toContain('Original marker 0');
    await f.service.close(); const restarted = new SessionContinuity(f.options);
    expect((await restarted.readContinuity('codex-session', { snapshotId: stored.at(-1).id })).entries[0]!.id).toBe('round-39');
  });
  it('retains a changed long-entry tail even when its bounded visible prefix is identical', async () => {
    const f = await fixture(), live = f.sources.get('codex-session')!;
    live.entries = [{ id: 'long-entry', kind: 'tool', text: `${'x'.repeat(9000)}old-tail` }];
    await f.service.sessionContinuity('codex-session');
    live.entries = [{ id: 'long-entry', kind: 'tool', text: `${'x'.repeat(9000)}new-tail` }];
    const changed = await f.service.sessionContinuity('codex-session');
    expect(changed.snapshots).toHaveLength(2); expect(changed.snapshots[1]!.entries).toBe(1);
    expect(changed.snapshots[1]!.coverage.limits).toContain('1 archived entries were shortened.');
  });
  it('does not consume archive slots for token-only status churn, while preserving changed model and compaction provenance', async () => {
    const f = await checkpointFixture(), live = f.sources.get('codex-session')!;
    live.model = 'model-one';
    live.context = { usedTokens: 10, windowTokens: 1000, estimated: true, compactions: 0, updatedAt: new Date(now).toISOString() };
    const original = await f.service.sessionContinuity('codex-session');
    for (let index = 0; index < 270; index++) {
      live.revision = `token-display-${index}`;
      live.context = { ...live.context, usedTokens: index + 10, updatedAt: new Date(now + index * 1000).toISOString() };
      const refreshed = await f.service.sessionContinuity('codex-session');
      expect(refreshed.snapshots).toEqual(original.snapshots);
    }
    live.model = 'model-two';
    expect((await f.service.sessionContinuity('codex-session')).snapshots).toHaveLength(2);
    live.context.compactions = 1;
    expect((await f.service.sessionContinuity('codex-session')).snapshots).toHaveLength(3);
    expect(JSON.parse(await readFile(f.file, 'utf8')).chains[0].snapshots[0].context.usedTokens).toBe(10);
  });
  it('can inspect and resolve an uncertain receipt when capturing new live evidence would exceed the archive limit', async () => {
    const f = await checkpointFixture(), live = f.sources.get('codex-session')!;
    f.setEffect(async () => ({ state: 'unknown' }));
    const preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session'), capture: 'checkpoint' });
    const uncertain = await f.service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'uncertain-at-capacity' });
    for (let index = 0; index < 255; index++) {
      live.entries = [...live.entries, { id: `retained-${index}`, kind: 'tool', text: `Retained result ${index}.` }];
      live.revision = `capture-${index}`;
      await f.service.sessionContinuity('codex-session');
    }
    live.entries = [...live.entries, { id: 'over-capacity', kind: 'tool', text: 'This additional capture cannot fit.' }];
    await expect(f.service.sessionContinuity('codex-session')).rejects.toThrow('snapshot limit');
    const captures = f.snapshots(), inspected = await f.service.inspectContinuity('codex-session');
    expect(inspected.snapshots).toHaveLength(256); expect(inspected.handovers[0]!.state).toBe('unknown');
    const resolved = await f.service.reconcileHandover('codex-session', { operationId: uncertain.operationId, packetDigest: uncertain.packetDigest, outcome: 'accepted' });
    expect(resolved.state).toBe('inspected'); expect(f.snapshots()).toBe(captures); expect(f.effects).toHaveLength(1);
    f.deny(); await expect(f.service.inspectContinuity('codex-session')).rejects.toThrow('consent');
  });
});

describe('whole-chain archive privacy', () => {
  it('blocks observed archives reached through a Native alias, including pending packet dispatch', async () => {
    const f = await fixture(); let privateMode = false;
    f.sources.set('gemini-session', source('gemini-session', 'extalia-native'));
    const service = new SessionContinuity({ ...f.options, assertArchiveAccess: async snapshots => {
      if (privateMode && snapshots.some(snapshot => snapshot.sourceId !== 'extalia-native')) throw new Error('Observed archive privacy changed.');
    } });
    const first = await service.previewHandover('codex-session', { target: { kind: 'manual', label: 'Native alias', sessionId: 'gemini-session' } });
    await service.applyHandover('codex-session', { reviewId: first.reviewId, operationId: 'link-private-alias' });
    const pending = await service.previewHandover('gemini-session', { target: observed('claude-session') });
    privateMode = true;
    await expect(service.sessionContinuity('gemini-session')).rejects.toThrow('privacy');
    await expect(service.readContinuity('gemini-session', { snapshotId: first.coverage[0]!.id })).rejects.toThrow('privacy');
    await expect(service.previewHandover('gemini-session', { target: { kind: 'manual', label: 'Export' } })).rejects.toThrow('privacy');
    await expect(service.applyHandover('gemini-session', { reviewId: pending.reviewId, operationId: 'blocked-packet' })).rejects.toThrow('privacy');
    expect(f.effects).toHaveLength(1);
  });

  it('blocks inspection of an uncertain observed transfer through a Native alias', async () => {
    const f = await fixture(); let privateMode = false;
    f.sources.set('gemini-session', source('gemini-session', 'extalia-native'));
    f.setEffect(async () => { throw new Error('Uncertain transport'); });
    const service = new SessionContinuity({ ...f.options, assertArchiveAccess: async snapshots => {
      if (privateMode && snapshots.some(snapshot => snapshot.sourceId !== 'extalia-native')) throw new Error('Observed archive privacy changed.');
    } });
    const preview = await service.previewHandover('codex-session', { target: { kind: 'manual', label: 'Native alias', sessionId: 'gemini-session' } });
    const receipt = await service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'uncertain-private' });
    privateMode = true;
    await expect(service.reconcileHandover('gemini-session', { operationId: receipt.operationId, packetDigest: receipt.packetDigest, outcome: 'accepted' })).rejects.toThrow('privacy');
    expect(JSON.parse(await readFile(f.file, 'utf8')).chains[0].handovers[0].state).toBe('unknown');
    expect(f.effects).toHaveLength(1);
  });

  it('allows pure Native archives under a policy that withholds observed content', async () => {
    const f = await fixture(); f.sources.set('codex-session', source('codex-session', 'extalia-native'));
    const service = new SessionContinuity({ ...f.options, assertArchiveAccess: async snapshots => {
      if (snapshots.some(snapshot => snapshot.sourceId !== 'extalia-native')) throw new Error('Observed archive privacy changed.');
    } });
    const preview = await service.previewHandover('codex-session', { target: { kind: 'native', connectionId: 'connection-1' } });
    expect((await service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'pure-native' })).state).toBe('native-ready');
    expect((await service.readContinuity('codex-session', { snapshotId: preview.coverage[0]!.id })).entries[0]!.text).toContain('Build the parser');
  });
});

describe('explicit uncertain handover inspection', () => {
  async function uncertain() {
    const f = await fixture();
    f.setEffect(async () => { throw new Error('Unconfirmed transport'); });
    const preview = await f.service.previewHandover('codex-session', { target: observed('gemini-session') });
    const request = { reviewId: preview.reviewId, operationId: 'uncertain-inspection' };
    const receipt = await f.service.applyHandover('codex-session', request);
    expect(receipt.state).toBe('unknown');
    return { ...f, preview, request, receipt };
  }

  it('records user inspection without claiming consumption, permits later handovers, and never replays the old operation', async () => {
    const f = await uncertain();
    const resolved = await f.service.reconcileHandover('codex-session', { operationId: f.receipt.operationId, packetDigest: f.receipt.packetDigest, outcome: 'accepted' });
    expect(resolved.state).toBe('inspected');
    expect(resolved.resolution).toEqual({ kind: 'user-inspected', outcome: 'accepted', at: new Date(now).toISOString() });
    expect(resolved.problem).toContain('remain unverified');
    expect(resolved.retryable).toBe(false);
    expect(f.effects).toHaveLength(1);
    expect(await f.service.applyHandover('codex-session', f.request)).toEqual(resolved);
    const next = await f.service.previewHandover('gemini-session', { target: observed('claude-session') });
    expect(next.canonicalId).toBe(f.preview.canonicalId);
    expect(next.packet).toContain('inspected');
    expect(next.notes.goal).toContain('Build the parser');
    await f.service.close();
    const restarted = new SessionContinuity(f.options);
    expect(await restarted.applyHandover('codex-session', f.request)).toEqual(resolved);
    expect(f.effects).toHaveLength(1);
  });

  it('records not-delivered as a user-inspected rejection, without resetting the operation for retry', async () => {
    const f = await uncertain();
    const input = { operationId: f.receipt.operationId, packetDigest: f.receipt.packetDigest, outcome: 'not-delivered' as const };
    const resolved = await f.service.reconcileHandover('codex-session', input);
    expect(resolved.state).toBe('rejected');
    expect(resolved.resolution?.outcome).toBe('not-delivered');
    expect(await f.service.reconcileHandover('codex-session', input)).toEqual(resolved);
    expect(await f.service.applyHandover('codex-session', f.request)).toEqual(resolved);
    expect(f.effects).toHaveLength(1);
    await expect(f.service.previewHandover('codex-session', { target: observed('claude-session') })).resolves.toMatchObject({ canonicalId: resolved.canonicalId });
  });

  it('rejects a stale digest, absent receipt, and contradictory repeated inspection', async () => {
    const f = await uncertain();
    await expect(f.service.reconcileHandover('codex-session', { operationId: f.receipt.operationId, packetDigest: 'a'.repeat(64), outcome: 'accepted' })).rejects.toThrow('does not match');
    await expect(f.service.reconcileHandover('codex-session', { operationId: 'another-operation', packetDigest: f.receipt.packetDigest, outcome: 'accepted' })).rejects.toThrow('does not match');
    await f.service.reconcileHandover('codex-session', { operationId: f.receipt.operationId, packetDigest: f.receipt.packetDigest, outcome: 'accepted' });
    await expect(f.service.reconcileHandover('codex-session', { operationId: f.receipt.operationId, packetDigest: f.receipt.packetDigest, outcome: 'not-delivered' })).rejects.toThrow('different inspection');
    expect(f.effects).toHaveLength(1);
  });

  it('refuses another canonical chain and a source whose host access was revoked', async () => {
    const f = await uncertain();
    await f.service.sessionContinuity('claude-session');
    const input = { operationId: f.receipt.operationId, packetDigest: f.receipt.packetDigest, outcome: 'accepted' as const };
    await expect(f.service.reconcileHandover('claude-session', input)).rejects.toThrow('does not match');
    f.sources.delete('codex-session');
    await expect(f.service.reconcileHandover('codex-session', input)).rejects.toThrow('Missing');
    expect(f.effects).toHaveLength(1);
  });

  it('refuses workspace drift without rewriting the uncertain receipt', async () => {
    const f = await uncertain();
    f.sources.get('codex-session')!.workspaceId = 'other-workspace';
    await expect(f.service.reconcileHandover('codex-session', { operationId: f.receipt.operationId, packetDigest: f.receipt.packetDigest, outcome: 'accepted' })).rejects.toThrow('not bound');
    const saved = JSON.parse(await readFile(f.file, 'utf8'));
    expect(saved.chains[0].handovers[0].state).toBe('unknown');
  });

  it('keeps an inspected history-off chain in memory only', async () => {
    const f = await uncertain();
    f.sources.get('codex-session')!.persistent = false;
    const resolved = await f.service.reconcileHandover('codex-session', { operationId: f.receipt.operationId, packetDigest: f.receipt.packetDigest, outcome: 'accepted' });
    expect(resolved.state).toBe('inspected');
    expect(JSON.parse(await readFile(f.file, 'utf8')).chains).toEqual([]);
    expect((await f.service.sessionContinuity('gemini-session')).persistent).toBe(false);
  });

  it('cannot relabel a confirmed native-ready receipt through an inspection claim', async () => {
    const f = await fixture(), preview = await f.service.previewHandover('codex-session', { target: { kind: 'native', connectionId: 'connection-1' } });
    const receipt = await f.service.applyHandover('codex-session', { reviewId: preview.reviewId, operationId: 'native-ready' });
    await expect(f.service.reconcileHandover('codex-session', { operationId: receipt.operationId, packetDigest: receipt.packetDigest, outcome: 'not-delivered' })).rejects.toThrow('Only an uncertain');
  });
});
