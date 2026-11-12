import type { AgentHostApi, ContinuityNotes, ContinuityReadPage, ContinuityView, HandoverPreview, HandoverReceipt, ObservedControlStatus, SessionSummary } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  HandoverDialogController, SessionHandoverDialogView, handoverDialogSourceKey, handoverRouteOptions,
  type HandoverMessages, type SessionHandoverDialogViewProps,
} from '../src/chat/SessionHandoverDialog';

const notes: ContinuityNotes = { goal: 'Continue the parser change', decisions: 'Retain source provenance', completed: 'Parser reviewed', pending: 'Boundary tests', verification: 'External test log', risks: 'Hidden context unknown' };
const session: SessionSummary = { id: 'source-session', workspaceId: 'workspace-a', connectionId: 'connection-a', title: 'Parser task', control: 'observed', createdAt: '2026-11-12T00:00:00Z', lastActiveAt: '2026-11-12T01:00:00Z', running: false,
  observation: { sourceId: 'codex', nativeSessionId: 'native-codex', watching: true, status: 'watching' } };
const snapshot: ContinuityView['snapshots'][number] = { id: 'snapshot-a', sessionId: session.id, sourceId: 'codex', nativeSessionId: 'native-codex', title: session.title, capturedAt: '2026-11-12T01:00:00Z', revision: 'source-r1', entries: 20,
  coverage: { mode: 'partial', observedThrough: 'event-20', observedEntries: 20, omittedEntries: 2, limits: ['Hidden runtime context is unavailable.'] },
  context: { usedTokens: 5000, windowTokens: 100000, estimated: false, compactions: 1, updatedAt: '2026-11-12T01:00:00Z' } };
const continuity = (): ContinuityView => ({ canonicalId: 'continuity-one', revision: 1, workspaceId: session.workspaceId, persistent: true, notes: { ...notes }, notesOrigin: 'user-reviewed', snapshots: [{ ...snapshot }], handovers: [] });
const preview = (): HandoverPreview => ({ canonicalId: 'continuity-one', sourceSessionId: session.id, reviewId: 'review-exact', expiresAt: '2026-11-12T01:10:00Z', target: { kind: 'manual', label: 'Claude' }, targetLabel: 'Claude', notes: { ...notes }, notesOrigin: 'user-reviewed', packet: 'Immutable reviewed packet', packetDigest: 'a'.repeat(64), coverage: [snapshot], packetOmittedEntries: 2, persistent: true, handoverCount: 0 });
const receipt = (state: HandoverReceipt['state'] = 'manual-ready'): HandoverReceipt => ({ canonicalId: 'continuity-one', sourceSessionId: session.id, operationId: 'operation-one', reviewId: 'review-exact', target: { kind: 'manual', label: 'Claude' }, state, at: '2026-11-12T01:01:00Z', packetDigest: 'a'.repeat(64), retryable: false });
const inspectedReceipt = (outcome: 'accepted' | 'not-delivered'): HandoverReceipt => ({ ...receipt(outcome === 'accepted' ? 'inspected' : 'rejected'), resolution: { kind: 'user-inspected', outcome, at: '2026-11-12T01:03:00Z' } });
const page = (offset = 0): ContinuityReadPage => ({ canonicalId: 'continuity-one', snapshot, offset, total: 60, entries: [{ id: `entry-${offset}`, kind: 'user', text: `Source at ${offset}` }], ...(offset === 0 ? { nextOffset: 30 } : {}) });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
function harness() {
  const host = { sessionContinuity: vi.fn(async () => continuity()), previewHandover: vi.fn(async () => preview()), applyHandover: vi.fn(async () => receipt()), readContinuity: vi.fn(async () => page()), reconcileHandover: vi.fn(async () => inspectedReceipt('accepted')) };
  const changed = vi.fn(), applied = vi.fn(), owner = new HandoverDialogController(changed, applied);
  const agents = host as unknown as AgentHostApi;
  owner.bind(agents, session);
  return { host, owner, agents, changed, applied };
}

describe('handover dialog ownership and explicit actions', () => {
  it('loads preserved working notes and previews exact edited notes without applying or sending', async () => {
    const h = harness(); await h.owner.load();
    expect(h.owner.value.notes).toEqual(notes);
    h.owner.editNotes('pending', 'Add zero and float cases');
    await h.owner.review({ kind: 'manual', label: 'Claude' });
    expect(h.host.previewHandover).toHaveBeenCalledExactlyOnceWith(session.id, { target: { kind: 'manual', label: 'Claude' }, notes: { ...notes, pending: 'Add zero and float cases' } });
    expect(h.owner.value.preview?.packet).toBe('Immutable reviewed packet');
    expect(h.host.applyHandover).not.toHaveBeenCalled();
    await h.owner.apply(false, 'operation-one');
    expect(h.host.applyHandover).not.toHaveBeenCalled();
  });

  it('ignores a stale preview after notes/target editing and never copies or applies its packet', async () => {
    const h = harness(); await h.owner.load();
    const pending = deferred<HandoverPreview>(); h.host.previewHandover.mockReturnValueOnce(pending.promise);
    const request = h.owner.review({ kind: 'manual', label: 'Gemini' });
    h.owner.editNotes('goal', 'A newer goal');
    pending.resolve(preview()); await request;
    expect(h.owner.value.preview).toBeUndefined(); expect(h.owner.value.busy).toBeUndefined();
    const write = vi.fn(async () => undefined); await h.owner.copy(write, 'Clipboard unavailable'); await h.owner.apply(true, 'operation-one');
    expect(write).not.toHaveBeenCalled(); expect(h.host.applyHandover).not.toHaveBeenCalled();
  });

  it('does not overwrite in-progress user notes when the initial continuity request settles', async () => {
    const h = harness(), pending = deferred<ContinuityView>();
    h.host.sessionContinuity.mockReturnValueOnce(pending.promise);
    const request = h.owner.load(); h.owner.editNotes('decisions', 'New explicit decision');
    pending.resolve(continuity()); await request;
    expect(h.owner.value.continuity?.canonicalId).toBe('continuity-one');
    expect(h.owner.value.notes.decisions).toBe('New explicit decision');
  });

  it('drops old source/host load failures and finalizers without clearing a new source load', async () => {
    const h = harness(), old = deferred<ContinuityView>(), newer = deferred<ContinuityView>();
    h.host.sessionContinuity.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
    const first = h.owner.load(); h.owner.bind(h.agents, { ...session, id: 'new-source' }); const second = h.owner.load();
    old.reject(new Error('old failure')); await first;
    expect(h.owner.value.error).toBeUndefined(); expect(h.owner.value.busy).toBe('load');
    newer.resolve({ ...continuity(), canonicalId: 'continuity-two' }); await second;
    expect(h.owner.value.continuity?.canonicalId).toBe('continuity-two');
    const next = harness(); h.owner.bind(next.agents, session); expect(h.owner.value.continuity).toBeUndefined();
  });

  it('submits the reviewed operation once after confirmation, retaining the actual receipt state', async () => {
    const h = harness(); await h.owner.load(); await h.owner.review({ kind: 'manual', label: 'Claude' });
    const pending = deferred<HandoverReceipt>(); h.host.applyHandover.mockReturnValueOnce(pending.promise);
    const first = h.owner.apply(true, 'operation-one'), second = h.owner.apply(true, 'operation-two');
    h.owner.editNotes('goal', 'Should not change an entered apply');
    expect(h.owner.value.notes.goal).toBe(notes.goal);
    expect(h.host.applyHandover).toHaveBeenCalledExactlyOnceWith(session.id, { reviewId: 'review-exact', operationId: 'operation-one' });
    h.host.sessionContinuity.mockResolvedValueOnce({ ...continuity(), handovers: [receipt('queued')] });
    pending.resolve(receipt('queued')); await first; await second;
    expect(h.owner.value.continuity?.handovers).toEqual([receipt('queued')]);
    expect(h.owner.value.receipt?.state).toBe('queued'); expect(h.applied).toHaveBeenCalledExactlyOnceWith(receipt('queued'));
    await h.owner.apply(true, 'operation-three'); expect(h.host.applyHandover).toHaveBeenCalledOnce();
  });

  it('retains an entered apply acknowledgement when activity advances on the same source identity', async () => {
    const h = harness(); await h.owner.load(); await h.owner.review({ kind: 'manual', label: 'Claude' });
    const pending = deferred<HandoverReceipt>(); h.host.applyHandover.mockReturnValueOnce(pending.promise);
    const request = h.owner.apply(true, 'operation-one');
    h.owner.bind(h.agents, { ...session, lastActiveAt: '2026-11-12T02:00:00Z' }); await h.owner.load();
    expect(h.owner.value.busy).toBe('apply');
    pending.resolve(receipt()); await request;
    expect(h.applied).toHaveBeenCalledExactlyOnceWith(receipt());
  });

  it('does not publish an old apply receipt to a replacement source', async () => {
    const h = harness(); await h.owner.load(); await h.owner.review({ kind: 'manual', label: 'Claude' });
    const pending = deferred<HandoverReceipt>(); h.host.applyHandover.mockReturnValueOnce(pending.promise);
    const request = h.owner.apply(true, 'operation-one'); h.owner.bind(h.agents, { ...session, workspaceId: 'workspace-b' });
    pending.resolve(receipt()); await request;
    expect(h.applied).not.toHaveBeenCalled(); expect(h.owner.value.receipt).toBeUndefined();
  });

  it('clears uncertain failed apply review and never retries it automatically', async () => {
    const h = harness(); await h.owner.load(); await h.owner.review({ kind: 'manual', label: 'Claude' });
    h.host.applyHandover.mockRejectedValueOnce(new Error('Delivery outcome unknown; inspect before another request.'));
    await h.owner.apply(true, 'operation-one');
    expect(h.owner.value.preview).toBeUndefined(); expect(h.owner.value.error).toMatch(/unknown/);
    await h.owner.apply(true, 'operation-one'); expect(h.host.applyHandover).toHaveBeenCalledOnce();
  });

  it('copies only the immutable reviewed packet and discards old copy acknowledgement after an edit', async () => {
    const h = harness(); await h.owner.load(); await h.owner.review({ kind: 'manual', label: 'Claude' });
    const copied = deferred<void>(), write = vi.fn(() => copied.promise);
    const request = h.owner.copy(write, 'Clipboard unavailable'); h.owner.editTarget(); copied.resolve(); await request;
    expect(write).toHaveBeenCalledExactlyOnceWith('Immutable reviewed packet'); expect(h.owner.value.copied).toBe(false);
    await h.owner.review({ kind: 'manual', label: 'Gemini' });
    await h.owner.copy(async () => { throw new Error('Permission denied'); }, 'Clipboard unavailable');
    expect(h.owner.value.error).toBe('Clipboard unavailable');
  });

  it('pages evidence at the exact source offset without accumulating the full transcript', async () => {
    const h = harness(); await h.owner.load(); h.host.readContinuity.mockResolvedValueOnce(page()).mockResolvedValueOnce(page(30));
    await h.owner.read(snapshot.id); await h.owner.read(snapshot.id, true);
    expect(h.host.readContinuity).toHaveBeenLastCalledWith(session.id, { snapshotId: snapshot.id, offset: 30, limit: 30 });
    expect(h.owner.value.page?.entries).toEqual(page(30).entries); expect(h.owner.value.page?.offset).toBe(30);
    const pending = deferred<ContinuityReadPage>(); h.host.readContinuity.mockReturnValueOnce(pending.promise);
    const request = h.owner.read(snapshot.id); h.owner.bind(h.agents, { ...session, lastActiveAt: '2026-11-12T02:00:00Z' }); pending.resolve(page()); await request;
    expect(h.owner.value.page).toBeUndefined();
  });

  it('recovers a persisted unknown receipt without allowing a new review or hiding it through editing', async () => {
    const h = harness(); h.host.sessionContinuity.mockResolvedValueOnce({ ...continuity(), handovers: [receipt('unknown')] });
    await h.owner.load(); expect(h.owner.value.receipt?.state).toBe('unknown');
    h.owner.editTarget(); h.owner.editNotes('goal', 'New draft'); await h.owner.review({ kind: 'manual', label: 'Another destination' });
    expect(h.owner.value.receipt?.state).toBe('unknown'); expect(h.owner.value.notes.goal).toBe(notes.goal);
    expect(h.host.previewHandover).not.toHaveBeenCalled();
    await h.owner.reconcile(false, 'accepted'); expect(h.host.reconcileHandover).not.toHaveBeenCalled();
  });

  it('records one exact user-inspected resolution, refreshes the chain and never resends the packet', async () => {
    const h = harness(); h.host.sessionContinuity.mockResolvedValueOnce({ ...continuity(), handovers: [receipt('unknown')] });
    await h.owner.load(); const pending = deferred<HandoverReceipt>(); h.host.reconcileHandover.mockReturnValueOnce(pending.promise);
    h.host.sessionContinuity.mockResolvedValueOnce({ ...continuity(), handovers: [inspectedReceipt('accepted')] });
    const first = h.owner.reconcile(true, 'accepted'), second = h.owner.reconcile(true, 'not-delivered');
    expect(h.host.reconcileHandover).toHaveBeenCalledExactlyOnceWith(session.id, { operationId: 'operation-one', packetDigest: 'a'.repeat(64), outcome: 'accepted' });
    pending.resolve(inspectedReceipt('accepted')); await first; await second;
    expect(h.owner.value.receipt?.state).toBe('inspected'); expect(h.owner.value.continuity?.handovers[0]?.resolution?.kind).toBe('user-inspected');
    expect(h.host.applyHandover).not.toHaveBeenCalled(); expect(h.applied).not.toHaveBeenCalled();
    h.owner.editTarget(); await h.owner.review({ kind: 'manual', label: 'Claude' }); expect(h.host.previewHandover).toHaveBeenCalledOnce();
  });

  it('records not-delivered as user inspection rather than transport evidence, then permits a fresh review', async () => {
    const h = harness(); h.host.sessionContinuity.mockResolvedValueOnce({ ...continuity(), handovers: [receipt('unknown')] }); await h.owner.load();
    h.host.reconcileHandover.mockResolvedValueOnce(inspectedReceipt('not-delivered'));
    await h.owner.reconcile(true, 'not-delivered');
    expect(h.owner.value.receipt).toMatchObject({ state: 'rejected', resolution: { kind: 'user-inspected', outcome: 'not-delivered' } });
    expect(h.host.applyHandover).not.toHaveBeenCalled();
  });

  it('retains unknown status on failed inspection and drops late inspection results after host replacement', async () => {
    const h = harness(); h.host.sessionContinuity.mockResolvedValueOnce({ ...continuity(), handovers: [receipt('unknown')] }); await h.owner.load();
    h.host.reconcileHandover.mockRejectedValueOnce(new Error('Inspection could not be recorded'));
    await h.owner.reconcile(true, 'accepted'); expect(h.owner.value.receipt?.state).toBe('unknown');
    const pending = deferred<HandoverReceipt>(); h.host.reconcileHandover.mockReturnValueOnce(pending.promise);
    const request = h.owner.reconcile(true, 'accepted'); h.owner.bind(harness().agents, session);
    pending.resolve(inspectedReceipt('accepted')); await request;
    expect(h.owner.value.receipt).toBeUndefined(); expect(h.host.applyHandover).not.toHaveBeenCalled();
  });

  it('retains edited notes when the same source receives new events while invalidating its old packet', async () => {
    const h = harness(); await h.owner.load(); h.owner.editNotes('pending', 'User draft pending work');
    await h.owner.review({ kind: 'manual', label: 'Claude', sessionId: 'claude-session' });
    h.owner.bind(h.agents, { ...session, lastActiveAt: '2026-11-12T02:00:00Z' });
    expect(h.owner.value.preview).toBeUndefined(); expect(h.owner.value.sourceChanged).toBe(true);
    expect(h.owner.value.notes.pending).toBe('User draft pending work');
    await h.owner.load(); expect(h.owner.value.notes.pending).toBe('User draft pending work');
    await h.owner.review({ kind: 'manual', label: 'Claude', sessionId: 'claude-session' });
    expect(h.host.previewHandover).toHaveBeenLastCalledWith(session.id, expect.objectContaining({ target: { kind: 'manual', label: 'Claude', sessionId: 'claude-session' } }));
  });

  it('ignores watcher heartbeat timestamps while tracking actual source changes', () => {
    expect(handoverDialogSourceKey({ ...session, observation: { ...session.observation!, lastCheckedAt: '2026-11-12T02:00:00Z' } })).toBe(handoverDialogSourceKey(session));
  });

  it('treats context and workspace/source changes as review boundaries', () => {
    for (const next of [{ ...session, running: true }, { ...session, connectionId: 'connection-b' }, { ...session, workspaceId: 'workspace-b' }, { ...session, lastActiveAt: 'new-time' }, { ...session, observation: { ...session.observation!, nativeSessionId: 'different-native-id' } }]) {
      expect(handoverDialogSourceKey(next)).not.toBe(handoverDialogSourceKey(session));
    }
  });
});

const text: HandoverMessages = {
  title: 'Handover work', description: 'Continue with explicit context coverage.', close: 'Close', loading: 'Loading', unavailable: 'Unavailable', canonical: 'Continuity ID', source: 'Source', destination: 'Destination', native: 'Native model', observed: 'Existing conversation', manual: 'Manual packet', connection: 'Connection', model: 'Model', effort: 'Effort', defaultValue: 'Default', targetSession: 'Target session', route: 'Delivery route', refreshRoutes: 'Refresh routes', noRoute: 'No supported route. Use a manual packet.', manualLabel: 'Destination label', manualUnbound: 'Copy only, no linked session', notes: 'Working notes', sourceExcerpt: 'Review these source excerpts; they are not verified summaries.', fields: { goal: 'Goal', decisions: 'Decisions', completed: 'Completed', pending: 'Pending', verification: 'Verification', risks: 'Risks' }, coverage: 'Context coverage', coverageModes: { full: 'All observed entries', partial: 'Partial observations', unknown: 'Unknown coverage' }, observedThrough: 'Observed through', entries: 'Entries', omitted: 'Omitted', limits: 'Limits', unknown: 'Unknown', context: 'Reported context', estimated: 'Estimated', reported: 'Reported', compactions: 'Compactions', contextLimit: 'Only context visible to Extalia is represented; hidden runtime state is unknown.', chain: 'Handover chain', noHandovers: 'No prior handovers', delivery: 'Delivery', statuses: { 'native-ready': 'Native session ready', 'manual-ready': 'Manual packet ready', queued: 'Queued', submitted: 'Submitted', unknown: 'Outcome unknown', inspected: 'User inspected destination', rejected: 'Rejected' }, receiptLimit: 'Delivery acceptance does not prove the receiving model read or retained the packet.', transient: 'This continuity is not durable.', inspect: 'Inspect observed source', loadMore: 'Next source page', evidence: 'Observed evidence', review: 'Review exact packet', reviewing: 'Preparing review', apply: 'Apply reviewed handover', applying: 'Applying', confirm: 'Use this exact reviewed packet and destination.', packet: 'Reviewed packet', digest: 'Packet digest', expires: 'Review expires', copy: 'Copy packet', copied: 'Copied', copyFailed: 'Clipboard unavailable', copyAfterApply: 'Apply before copying so the destination and scoped archive access are recorded.', cancel: 'Close', edit: 'Edit before review', sourceChanged: 'Source changed; review again.', recoveryTitle: 'Inspect uncertain handover', recoveryDescription: 'Inspect the destination and previous agent state. No resend or execution authority is inferred.', recoveryConfirm: 'I inspected the destination and previous agent state.', recoveryAccepted: 'Recorded in destination', recoveryNotDelivered: 'Not delivered', recovering: 'Recording inspection', userInspected: 'User-reported inspection only',
};
function viewProps(): SessionHandoverDialogViewProps {
  return { t: text, state: { notes: { ...notes }, notesEdited: false, copied: false, continuity: continuity() }, session, supported: true, kind: 'manual', onKind: vi.fn(), connectionId: '', connections: [], onConnection: vi.fn(), model: '', onModel: vi.fn(), effort: '', onEffort: vi.fn(), observedId: '', observedSessions: [], onObserved: vi.fn(), routeId: '', routes: [], onRoute: vi.fn(), routeBusy: false, onRefreshRoutes: vi.fn(), manualLabel: 'Claude', onManualLabel: vi.fn(), onNote: vi.fn(), confirmed: false, onConfirm: vi.fn(), canReview: true, onReview: vi.fn(), onApply: vi.fn(), onEdit: vi.fn(), onCopy: vi.fn(), onRead: vi.fn(), onClose: vi.fn() };
}
const html = (p: SessionHandoverDialogViewProps) => renderToStaticMarkup(createElement(SessionHandoverDialogView, p));

describe('handover coverage, chain and honest receipt presentation', () => {
  it('shows one canonical continuity across repeated Codex → Gemini → Claude handovers while preserving separate native IDs', () => {
    const p = viewProps(); p.state.continuity!.handovers = [
      { ...receipt('submitted'), operationId: 'hop-one', target: { kind: 'observed', sessionId: 'gemini-session', capabilityId: 'gemini-route' }, targetSessionId: 'gemini-session' },
      { ...receipt('queued'), operationId: 'hop-two', sourceSessionId: 'gemini-session', target: { kind: 'observed', sessionId: 'claude-session', capabilityId: 'claude-route' }, targetSessionId: 'claude-session' },
    ];
    const markup = html(p);
    expect(markup).toContain('continuity-one'); expect(markup).toContain('source-session → gemini-session'); expect(markup).toContain('gemini-session → claude-session');
    expect(markup).toContain('native-codex'); expect(markup).toContain('event-20'); expect(markup).toContain('Partial observations'); expect(markup).toContain('Hidden runtime context is unavailable.');
    expect(markup).toContain('5,000 / 100,000'); expect(markup).toContain(text.receiptLimit);
  });

  it('shows immutable source model/effort and durable target labels without conflating native thread IDs', () => {
    const p = viewProps(); p.state.continuity!.snapshots[0] = { ...snapshot, model: 'example-model', effort: 'high', connectionId: 'connection-a' };
    p.state.continuity!.handovers = [{ ...receipt('native-ready'), target: { kind: 'native', connectionId: 'connection-b', model: 'second-model' }, targetLabel: 'Second model connection', targetSessionId: 'native-destination' }];
    const markup = html(p);
    expect(markup).toContain('example-model'); expect(markup).toContain('high'); expect(markup).toContain('connection-a');
    expect(markup).toContain('source-session → Second model connection'); expect(markup).toContain('native-destination'); expect(markup).toContain('native-codex');
  });

  it.each(['native-ready', 'manual-ready', 'queued', 'submitted', 'unknown', 'inspected', 'rejected'] as const)('renders %s literally without claiming model understanding', state => {
    const p = viewProps(); p.state.preview = preview(); p.state.receipt = receipt(state);
    const markup = html(p);
    expect(markup).toContain(text.statuses[state]); expect(markup).toContain(text.receiptLimit);
    expect(markup).not.toMatch(/understood|successfully continued|consumed/i);
  });

  it('keeps source text/packet literal, requires explicit review confirmation and hides apply before preview', () => {
    const p = viewProps(); expect(html(p)).not.toContain(text.apply);
    p.state.preview = { ...preview(), packet: '<script>unsafe()</script>' }; p.state.notes.goal = '<img src=x onerror=unsafe()>';
    const markup = html(p);
    expect(markup).not.toContain('<script>'); expect(markup).not.toContain('<img src=x'); expect(markup).toContain('&lt;script&gt;');
    expect(markup).toContain('type="checkbox"'); expect(markup).toMatch(/class="button primary"[^>]*disabled=""/);
    expect(markup).toMatch(/readOnly=""/i); expect(markup).toContain(text.copy);
  });

  it('keeps the packet reviewable but disables copying until the handover is applied', () => {
    const p = viewProps(); p.state.preview = preview();
    const before = html(p), copy = before.match(/<button\b[^>]*>(?:(?!<\/button>).)*Copy packet<\/button>/s)?.[0];
    expect(before).toContain(text.copyAfterApply); expect(before).toContain('readOnly=""');
    expect(copy).toContain('disabled=""');
    p.state.receipt = receipt('manual-ready');
    const after = html(p), enabledCopy = after.match(/<button\b[^>]*>(?:(?!<\/button>).)*Copy packet<\/button>/s)?.[0];
    expect(enabledCopy).toBeDefined(); expect(enabledCopy).not.toContain('disabled=""'); expect(after).not.toContain(text.copyAfterApply);
  });

  it('allows copying only acknowledged or user-inspected receipts, never unknown or rejected delivery', () => {
    const p = viewProps(); p.state.preview = preview();
    for (const state of ['native-ready', 'queued', 'submitted', 'inspected', 'unknown', 'rejected'] as const) {
      p.state.receipt = receipt(state);
      const copy = html(p).match(/<button\b[^>]*>(?:(?!<\/button>).)*Copy packet<\/button>/s)?.[0];
      expect(copy).toBeDefined();
      expect(copy!.includes('disabled=""')).toBe(state === 'unknown' || state === 'rejected');
    }
  });

  it('requires destination inspection confirmation for unknown receipts and labels resolutions as user reports', () => {
    const p = viewProps(); p.state.receipt = receipt('unknown'); p.canReconcile = true;
    const markup = html(p);
    expect(markup).toContain(text.recoveryDescription); expect(markup).toContain(text.recoveryConfirm);
    expect(markup).toMatch(/disabled=""[^>]*>Recorded in destination/);
    expect(markup).not.toContain(text.edit);
    p.state.receipt = inspectedReceipt('accepted'); const resolved = html(p);
    expect(resolved).toContain(text.userInspected); expect(resolved).toContain(text.edit);
    expect(resolved).toContain(text.receiptLimit);
  });

  it('offers only fresh supported capabilities of the exact selected target conversation', () => {
    const status: ObservedControlStatus = { sessionId: 'gemini-session', state: 'ready', routes: [{ route: 'cooperative-inbox', state: 'ready', evidence: 'paired-inbox', limit: 'paired-consumer-only', relatedControls: [], capabilities: [
      { action: 'inbox-send', available: true, capabilityId: 'exact-capability' }, { action: 'start', available: false, capabilityId: 'not-available' }, { action: 'queue', available: true },
    ] }] };
    expect(handoverRouteOptions(status, 'other-session')).toEqual([]);
    expect(handoverRouteOptions({ ...status, state: 'unavailable' }, status.sessionId)).toEqual([]);
    expect(handoverRouteOptions({ ...status, routes: [{ ...status.routes[0]!, state: 'uncertain' }] }, status.sessionId)).toEqual([]);
    expect(handoverRouteOptions(status, status.sessionId)).toEqual([{ value: 'exact-capability', label: 'cooperative-inbox · inbox-send', target: { kind: 'observed', sessionId: status.sessionId, capabilityId: 'exact-capability' } }]);
  });
});
