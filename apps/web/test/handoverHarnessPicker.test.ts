import type { AgentHostApi, HandoverDestinationCreateReceipt, HandoverHarnessInventory, HostState, SessionSummary } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { handoverDestinationSessions, handoverHarnessCards, handoverHarnessInventoryCards, HandoverHarnessController, SessionHandoverDialogView, type SessionHandoverDialogViewProps } from '../src/chat/SessionHandoverDialog';
import { MESSAGES } from '../src/i18n';

const source = { id: 'source', workspaceId: 'work-a', control: 'observed', title: 'Current work', observation: { sourceId: 'codex', nativeSessionId: 'native-source' } } as SessionSummary;
const observed = (id: string, sourceId: string, workspaceId = 'work-a') => ({ ...source, id, workspaceId, title: id, observation: { sourceId, nativeSessionId: `native-${id}` } }) as SessionSummary;
const hostState = { sessions: [source, observed('claude-current', 'claude-code'), observed('gemini-other-workspace', 'gemini-cli', 'work-b')], connections: [{ id: 'native-connection', runtime: 'extalia-native', credentialStatus: 'ok', preset: 'kiro' }], workspaces: [{ id: 'work-a', name: 'Example project', providerProfileId: 'native-connection' }] } as unknown as HostState;
function props(language: 'en' | 'id' = 'en'): SessionHandoverDialogViewProps {
  return { t: MESSAGES[language].sessionHandover, state: { notes: { goal: 'Continue work', decisions: '', completed: '', pending: '', verification: '', risks: '' }, notesEdited: false, copied: false }, session: source, supported: true,
    kind: 'observed', onKind: vi.fn(), connectionId: '', connections: [], onConnection: vi.fn(), model: '', onModel: vi.fn(), effort: '', onEffort: vi.fn(),
    observedId: 'claude-current', observedSessions: [], onObserved: vi.fn(), routeId: '', routes: [], onRoute: vi.fn(), routeBusy: false, onRefreshRoutes: vi.fn(),
    manualLabel: '', onManualLabel: vi.fn(), onManualFallback: vi.fn(), onNote: vi.fn(), confirmed: false, onConfirm: vi.fn(), canReview: false, onReview: vi.fn(), onApply: vi.fn(), onEdit: vi.fn(), onCopy: vi.fn(), onRead: vi.fn(), onClose: vi.fn(),
    harnesses: handoverHarnessCards(hostState, source, MESSAGES[language].sessionHandover.harness.names), harnessId: 'claude', onHarness: vi.fn(), harnessSessions: [{ value: 'claude-current', label: 'Existing Claude conversation' }] };
}

const inventory = (): HandoverHarnessInventory => ({ sourceSessionId: source.id, revision: 'reviewed-discovery', harnesses: [
  { id: 'extalia', sourceIds: ['extalia-native'], evidence: ['builtin'], existing: 'unsupported', create: 'ready', sessionIds: [] },
  { id: 'antigravity', sourceIds: ['antigravity'], evidence: ['application'], existing: 'ready', create: 'ready', sessionIds: [] },
  { id: 'kiro', sourceIds: ['kiro'], evidence: ['executable'], existing: 'unsupported', create: 'unsupported', sessionIds: [], reason: 'adapter-unavailable' },
] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function controller() {
  const created = observed('new-conversation', 'antigravity');
  const host = { handoverHarnesses: vi.fn(async () => inventory()), createHandoverDestination: vi.fn(async (_id: string, input: { operationId: string; harnessId: string; revision: string }): Promise<HandoverDestinationCreateReceipt> => ({ operationId: input.operationId, harnessId: input.harnessId, state: 'created', sessionId: created.id, retryable: false })), getState: vi.fn(async () => ({ ...hostState, sessions: [...hostState.sessions, created] })) };
  const agents = host as unknown as AgentHostApi, owner = new HandoverHarnessController(); owner.bind(agents, source); return { owner, agents, host, created };
}

describe('handover inventory and explicit destination creation ownership', () => {
  it('uses detected host inventory without inventing adapters or offering unverified sessions', () => {
    const cards = handoverHarnessInventoryCards(inventory(), hostState, source, MESSAGES.en.sessionHandover.harness);
    expect(cards.map(card => card.id)).toEqual(['extalia', 'antigravity', 'kiro']);
    expect(cards.find(card => card.id === 'kiro')).toMatchObject({ canCreate: false, unavailableReason: MESSAGES.en.sessionHandover.harness.reasons['adapter-unavailable'] });
    expect(handoverHarnessInventoryCards({ ...inventory(), sourceSessionId: 'another-source' }, hostState, source, MESSAGES.en.sessionHandover.harness)).toEqual([]);
  });
  it('blocks fresh creation across a reload and inspects the exact persisted operation explicitly', async () => {
    const h = controller(), pending = deferred<HandoverDestinationCreateReceipt>();
    const saved = { ...inventory(), pendingCreation: { harnessId: 'antigravity', operationId: 'original-operation', nativeSessionId: 'original-native', state: 'created' as const } };
    saved.harnesses[1]!.create = 'unavailable'; h.host.handoverHarnesses.mockResolvedValue(saved);
    await h.owner.load(); await h.owner.create('antigravity'); expect(h.host.createHandoverDestination).not.toHaveBeenCalled();
    const reopened = new HandoverHarnessController(); reopened.bind(h.agents, source); await reopened.load(); await reopened.create('antigravity');
    expect(h.host.createHandoverDestination).not.toHaveBeenCalled(); h.host.createHandoverDestination.mockReturnValueOnce(pending.promise);
    const inspection = reopened.inspectPending(); await reopened.inspectPending();
    expect(h.host.createHandoverDestination).toHaveBeenCalledExactlyOnceWith(source.id, { harnessId: 'antigravity', revision: saved.revision, operationId: 'original-operation' });
    pending.resolve({ operationId: 'original-operation', harnessId: 'antigravity', state: 'created', sessionId: h.created.id, retryable: false }); await inspection;
    expect(reopened.value.createdSession?.id).toBe(h.created.id); expect(handoverHarnessInventoryCards(saved, hostState, source, MESSAGES.en.sessionHandover.harness).find(card => card.id === 'antigravity')?.canCreate).toBe(false);
  });
  it('does not allocate another operation or automatically retry an unknown pending inspection', async () => {
    const h = controller(), saved = { ...inventory(), pendingCreation: { harnessId: 'antigravity', operationId: 'unknown-original-operation', nativeSessionId: 'original-native', state: 'unknown' as const } };
    h.host.handoverHarnesses.mockResolvedValue(saved); await h.owner.load();
    h.host.createHandoverDestination.mockImplementationOnce(async (_id, input) => ({ operationId: input.operationId, harnessId: input.harnessId, state: 'unknown', retryable: false }));
    const uuid = vi.spyOn(crypto, 'randomUUID');
    try { await h.owner.inspectPending(); await h.owner.load(); await h.owner.create('antigravity'); expect(uuid).not.toHaveBeenCalled(); } finally { uuid.mockRestore(); }
    expect(h.host.createHandoverDestination).toHaveBeenCalledOnce(); expect(h.owner.value.receipt?.state).toBe('unknown'); expect(h.owner.value.createdSession).toBeUndefined();
  });
  it('loads inventory passively and creates only an advertised destination after an explicit action', async () => {
    const h = controller(); await h.owner.load(); expect(h.host.createHandoverDestination).not.toHaveBeenCalled();
    await h.owner.create('kiro'); await h.owner.create('extalia'); expect(h.host.createHandoverDestination).not.toHaveBeenCalled();
    await h.owner.create('antigravity');
    expect(h.host.createHandoverDestination).toHaveBeenCalledExactlyOnceWith(source.id, { harnessId: 'antigravity', revision: 'reviewed-discovery', operationId: expect.any(String) });
    expect(h.owner.value.createdSession?.id).toBe(h.created.id); expect(h.host.getState).toHaveBeenCalledOnce();
    await h.owner.create('antigravity'); expect(h.host.createHandoverDestination).toHaveBeenCalledOnce();
  });
  it('offers a newly acknowledged destination immediately while the passive inventory still predates creation', async () => {
    const h = controller(); await h.owner.load(); await h.owner.create('antigravity');
    expect(h.owner.value.inventory?.harnesses.find(item => item.id === 'antigravity')?.sessionIds).toEqual([]);
    expect(handoverDestinationSessions(hostState, source, h.owner.value).map(item => item.id)).toContain(h.created.id);
    expect(handoverDestinationSessions(hostState, source, { ...h.owner.value, receipt: { ...h.owner.value.receipt!, state: 'unknown' } }).map(item => item.id)).not.toContain(h.created.id);
    expect(handoverDestinationSessions({ ...hostState, sessions: [...hostState.sessions, { ...h.created, workspaceId: 'other-workspace' }] }, source, h.owner.value).map(item => item.id)).not.toContain(h.created.id);
  });
  it('keeps Hermes gateway verification passive until the user explicitly requests its advertised creation', async () => {
    const h = controller(), saved: HandoverHarnessInventory = { ...inventory(), harnesses: [{ id: 'hermes', sourceIds: ['hermes'], evidence: ['executable'], existing: 'unsupported', create: 'setup-required', creationProfile: 'research-profile', sessionIds: [] }] };
    h.host.handoverHarnesses.mockResolvedValue(saved);
    await h.owner.load(); await h.owner.load();
    expect(h.host.createHandoverDestination).not.toHaveBeenCalled();
    const cards = handoverHarnessInventoryCards(saved, hostState, source, MESSAGES.en.sessionHandover.harness);
    expect(cards).toMatchObject([{ id: 'hermes', canCreate: true, createNeedsSetup: true, creationProfile: 'research-profile' }]);
    await h.owner.create('hermes');
    expect(h.host.createHandoverDestination).toHaveBeenCalledExactlyOnceWith(source.id, { harnessId: 'hermes', revision: saved.revision, operationId: expect.any(String) });
  });
  it('inspects an uncertain Hermes operation without inventing a native ID or starting a fresh operation', async () => {
    const h = controller(), saved: HandoverHarnessInventory = { ...inventory(), pendingCreation: { harnessId: 'hermes', operationId: 'gateway-lost-ack', state: 'unknown' } };
    saved.harnesses.push({ id: 'hermes', sourceIds: ['hermes'], evidence: ['executable'], existing: 'unsupported', create: 'unavailable', sessionIds: [] });
    h.host.handoverHarnesses.mockResolvedValue(saved);
    h.host.createHandoverDestination.mockImplementationOnce(async (_id, input) => ({ operationId: input.operationId, harnessId: input.harnessId, state: 'unknown', retryable: false }));
    await h.owner.load(); await h.owner.create('hermes');
    expect(h.host.createHandoverDestination).not.toHaveBeenCalled();
    await h.owner.inspectPending();
    expect(h.host.createHandoverDestination).toHaveBeenCalledExactlyOnceWith(source.id, { harnessId: 'hermes', revision: saved.revision, operationId: 'gateway-lost-ack' });
    expect(h.owner.value.receipt?.state).toBe('unknown'); expect(h.owner.value.createdSession).toBeUndefined();
  });
  it('deduplicates entered creation and ignores late source results', async () => {
    const h = controller(), pending = deferred<HandoverDestinationCreateReceipt>(); await h.owner.load();
    h.host.createHandoverDestination.mockReturnValueOnce(pending.promise); const creation = h.owner.create('antigravity'); await h.owner.create('antigravity');
    const input = h.host.createHandoverDestination.mock.calls[0]![1]; h.owner.bind(h.agents, { ...source, id: 'changed-source' });
    pending.resolve({ operationId: input.operationId, harnessId: 'antigravity', state: 'created', sessionId: h.created.id, retryable: false }); await creation;
    expect(h.host.createHandoverDestination).toHaveBeenCalledOnce(); expect(h.host.getState).not.toHaveBeenCalled(); expect(h.owner.value.createdSession).toBeUndefined();
  });
  it('discards stale inventory across source and unmount boundaries', async () => {
    const h = controller(), pending = deferred<HandoverHarnessInventory>(); h.host.handoverHarnesses.mockReturnValueOnce(pending.promise);
    const load = h.owner.load(); h.owner.invalidate(); pending.resolve(inventory()); await load; expect(h.owner.value.inventory).toBeUndefined();
  });
  it('retains unknown creation without automatic resend or target selection', async () => {
    const h = controller(); await h.owner.load(); h.host.createHandoverDestination.mockImplementationOnce(async (_id, input) => ({ operationId: input.operationId, harnessId: input.harnessId, state: 'unknown', retryable: false }));
    await h.owner.create('antigravity'); await h.owner.create('antigravity'); expect(h.host.createHandoverDestination).toHaveBeenCalledOnce(); expect(h.owner.value.receipt?.state).toBe('unknown'); expect(h.owner.value.createdSession).toBeUndefined(); expect(h.host.getState).not.toHaveBeenCalled();
  });
  it('rejects a creation receipt for a different operation before reading or selecting a destination', async () => {
    const h = controller(); await h.owner.load(); h.host.createHandoverDestination.mockResolvedValueOnce({ operationId: 'another-operation', harnessId: 'antigravity', state: 'created', sessionId: h.created.id, retryable: false });
    await h.owner.create('antigravity'); expect(h.owner.value.receipt?.state).toBe('unknown'); expect(h.owner.value.createdSession).toBeUndefined(); expect(h.host.getState).not.toHaveBeenCalled();
  });
  it('never selects a newly created session outside the reviewed workspace', async () => {
    const h = controller(); await h.owner.load(); h.host.getState.mockResolvedValueOnce({ ...hostState, sessions: [{ ...h.created, workspaceId: 'other-workspace' }] });
    await h.owner.create('antigravity'); expect(h.owner.value.receipt?.state).toBe('created'); expect(h.owner.value.createdSession).toBeUndefined(); expect(h.owner.value.error).toBe('HANDOVER_HARNESS_WRONG_SOURCE');
  });
  it('does not repeat a successful creation when its subsequent host-state refresh fails', async () => {
    const h = controller(); await h.owner.load(); h.host.getState.mockRejectedValueOnce(new Error('State unavailable'));
    await h.owner.create('antigravity'); await h.owner.create('antigravity'); expect(h.host.createHandoverDestination).toHaveBeenCalledOnce(); expect(h.owner.value.receipt?.state).toBe('created'); expect(h.owner.value.error).toBe('State unavailable'); expect(h.owner.value.createdSession).toBeUndefined();
  });
});

describe('handover harness selection', () => {
  it('offers only Extalia and owned observed harnesses, never a connection provider as a detected harness', () => {
    const cards = handoverHarnessCards(hostState, source, MESSAGES.en.sessionHandover.harness.names);
    expect(cards.map(card => card.id)).toEqual(['extalia', 'codex', 'claude', 'gemini']);
    expect(cards.find(card => card.id === 'extalia')).toMatchObject({ createConnectionId: 'native-connection', canCreate: true });
    expect(cards.some(card => card.id === 'kiro')).toBe(false);
    expect(cards.find(card => card.id === 'claude')?.sessionIds).toEqual(['claude-current']);
    expect(cards.find(card => card.id === 'codex')?.sessionIds).toEqual([]);
    expect(cards.find(card => card.id === 'gemini')?.sessionIds).toEqual([]);
  });
  it('does not invent creation capability for a missing credential or external harness', () => {
    const state = { ...hostState, connections: [{ ...hostState.connections[0]!, credentialStatus: 'missing' }] } as HostState;
    const cards = handoverHarnessCards(state, source, MESSAGES.en.sessionHandover.harness.names);
    expect(cards.every(card => !card.canCreate)).toBe(true); expect(cards.find(card => card.id === 'claude')?.createConnectionId).toBeUndefined();
  });
  it('leaves detected unavailable harnesses selectable with a visible manual fallback and no fabricated creation', () => {
    const p = props(); p.harnesses = [{ id: 'hermes', label: 'Hermes', sessionIds: [], existing: 'unsupported', canCreate: false }]; p.harnessId = 'hermes'; p.observedId = '';
    const html = renderToStaticMarkup(createElement(SessionHandoverDialogView, p));
    expect(html).toMatch(/<input[^>]*aria-label="Hermes"[^>]*value="hermes"/);
    expect(html).not.toMatch(/<input[^>]*aria-label="Hermes"[^>]*disabled/);
    expect(html).toContain(p.t.flow.manualOnly); expect(html).toContain(p.t.flow.manualAction);
    expect(html).not.toContain(`>${p.t.harness!.create}</button>`);
  });
  it('offers a saved Native connection in Observe while disclosing that workspace enablement needs consent', () => {
    const state = { ...hostState, workspaces: [{ id: source.workspaceId, mode: 'observe', providerProfileId: 'native-connection' }] } as HostState;
    expect(handoverHarnessCards(state, source, MESSAGES.en.sessionHandover.harness.names)[0]!.createConnectionId).toBe('native-connection');
    expect(handoverHarnessInventoryCards(inventory(), state, source, MESSAGES.en.sessionHandover.harness).find(card => card.id === 'extalia')?.canCreate).toBe(true);
    const p = { ...props(), kind: 'native' as const, harnessId: 'extalia', nativeNeedsEnablement: true, nativeEnabled: false };
    const html = renderToStaticMarkup(createElement(SessionHandoverDialogView, p));
    expect(html).toContain(p.t.flow.enableWorkspace); expect(html).toContain(p.t.flow.enableWorkspaceHint);
    expect(html).toMatch(/<input type="checkbox"\/>/);
  });
  it('keeps connection setup reachable for Native even when saved connections already exist', () => {
    const p = { ...props(), kind: 'native' as const, harnessId: 'extalia', connections: [{ value: 'saved-but-unusable', label: 'Needs credentials' }], onOpenSettings: vi.fn() };
    const html = renderToStaticMarkup(createElement(SessionHandoverDialogView, p));
    expect(html).toContain(p.t.flow.openSettings);
  });
  it.each(['en', 'id'] as const)('makes setup, working notes and manual fallback available without Advanced in %s', language => {
    const p = props(language), html = renderToStaticMarkup(createElement(SessionHandoverDialogView, p));
    expect(html).toContain('preset-card provider-card handover-harness-card');
    expect(html).toContain('type="radio"'); expect(html).toMatch(/<input[^>]*checked=""[^>]*value="claude"/);
    expect(html).toContain(MESSAGES[language].sessionHandover.harness.title);
    expect(html).toContain('Existing Claude conversation'); expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(p.t.fields.goal); expect(html).toContain(p.t.refreshRoutes); expect(html).toContain(p.t.flow.manualAction);
    expect(html).not.toContain(p.t.manualLabel);
    expect(html).not.toContain('<code>source</code>');
  });
  it('shows the pending setup inspection action directly while keeping its native ID in Advanced', () => {
    const p = props(); p.harnessState = { inventory: { ...inventory(), pendingCreation: { harnessId: 'antigravity', operationId: 'pending-original', nativeSessionId: 'candidate-native-private', state: 'unknown' } } };
    const html = renderToStaticMarkup(createElement(SessionHandoverDialogView, p));
    expect(html).toContain(p.t.harness!.pendingCreation); expect(html).not.toContain('candidate-native-private'); expect(html).toContain(p.t.harness!.inspectPending);
  });
  it.each(['en', 'id'] as const)('shows the reviewed Hermes profile and explicit gateway check in %s', language => {
    const p = props(language); p.harnesses = [{ id: 'hermes', label: 'Hermes', sessionIds: [], existing: 'unsupported', canCreate: true, createNeedsSetup: true, creationProfile: 'research-profile' }]; p.harnessId = 'hermes'; p.observedId = '';
    const html = renderToStaticMarkup(createElement(SessionHandoverDialogView, p));
    expect(html).toContain(p.t.flow.checkGatewayCreate); expect(html).toContain(p.t.flow.creationProfile); expect(html).toContain('research-profile');
    expect(html).toContain(p.t.flow.needsSetup); expect(html).not.toContain(`>${p.t.harness!.create}</button>`);
  });
  it('keeps an existing ready Hermes conversation distinct from gateway setup for a new one', () => {
    const p = props(); p.harnesses = [{ id: 'hermes', label: 'Hermes', sessionIds: ['hermes-current'], existing: 'ready', canCreate: true, createNeedsSetup: true, creationProfile: 'new-conversation-profile' }]; p.harnessId = 'hermes'; p.observedId = 'hermes-current';
    p.harnessSessions = [{ value: 'hermes-current', label: 'Existing Hermes' }];
    const html = renderToStaticMarkup(createElement(SessionHandoverDialogView, p));
    expect(html).toContain(`class="preset-hint">${p.t.flow.ready}</span>`);
    expect(html).not.toContain('new-conversation-profile'); expect(html).not.toContain(p.t.flow.checkGatewayCreate);
  });
  it('offers pending inspection even when the gateway has not acknowledged a native ID', () => {
    const p = props(); p.harnessState = { inventory: { ...inventory(), pendingCreation: { harnessId: 'hermes', operationId: 'unacknowledged-create', state: 'unknown' } } };
    const html = renderToStaticMarkup(createElement(SessionHandoverDialogView, p));
    expect(html).toContain(p.t.harness!.inspectPending); expect(html).not.toContain(p.t.harness!.pendingNativeId); expect(html).not.toContain('undefined');
  });
  it('keeps an explicit Extalia Native destination selected and describes real new-session behavior', () => {
    const p = { ...props(), kind: 'native' as const, harnessId: 'extalia' }, html = renderToStaticMarkup(createElement(SessionHandoverDialogView, p));
    expect(html).toMatch(/<input[^>]*checked=""[^>]*value="extalia"/); expect(html).toContain(MESSAGES.en.sessionHandover.harness.newConversation);
    expect(html).not.toContain('Existing Claude conversation');
  });
  it('retains a visible packet digest and explicit confirmation in the simple review', () => {
    const p = props(); p.state.preview = { canonicalId: 'work-record', sourceSessionId: source.id, reviewId: 'review', expiresAt: '2030-01-01T00:00:00Z', target: { kind: 'observed', sessionId: 'claude-current', capabilityId: 'verified-capability' }, targetLabel: 'Existing Claude conversation', notes: p.state.notes, notesOrigin: 'user-reviewed', packet: 'Exact context packet', packetDigest: 'a'.repeat(64), coverage: [], packetOmittedEntries: 0, persistent: true, handoverCount: 0 };
    const html = renderToStaticMarkup(createElement(SessionHandoverDialogView, p));
    expect(html).toContain('a'.repeat(64)); expect(html).toContain(p.t.confirm); expect(html).toContain(p.t.harness!.reviewDetails);
    expect(html).toContain('Exact context packet'); expect(html).toContain('type="checkbox"');
  });
  it('never matches unassociated sessions via empty workspaceId and avoids duplicate loading or error banners', () => {
    const emptySource = { ...source, workspaceId: '' };
    const unassociatedPeer = observed('antigravity-unregistered', 'antigravity', '');
    const cardState = { ...hostState, sessions: [emptySource, unassociatedPeer] } as HostState;
    const localCards = handoverHarnessCards(cardState, emptySource, MESSAGES.en.sessionHandover.harness.names);
    expect(localCards.find(card => card.id === 'antigravity')?.sessionIds).toEqual([]);
    const crossInventory: HandoverHarnessInventory = {
      sourceSessionId: emptySource.id,
      revision: 'rev-1',
      harnesses: [
        { id: 'extalia', sourceIds: ['extalia-native'], evidence: ['builtin'], existing: 'unsupported', create: 'unsupported', sessionIds: [] },
        { id: 'antigravity', sourceIds: ['antigravity'], evidence: ['application'], existing: 'ready', create: 'ready', sessionIds: [unassociatedPeer.id] },
      ],
    };
    const invCards = handoverHarnessInventoryCards(crossInventory, cardState, emptySource, MESSAGES.en.sessionHandover.harness);
    expect(invCards.find(card => card.id === 'antigravity')?.sessionIds).toEqual([unassociatedPeer.id]);
    const p = props();
    p.state.busy = 'load';
    p.routeBusy = true;
    p.observedId = 'claude-current';
    p.state.error = 'Duplicate error';
    p.harnessState = { error: 'Duplicate error' };
    const html = renderToStaticMarkup(createElement(SessionHandoverDialogView, p));
    expect(html.split(p.t.loading)).toHaveLength(2);
    expect(html.split('Duplicate error')).toHaveLength(2);
  });
});
