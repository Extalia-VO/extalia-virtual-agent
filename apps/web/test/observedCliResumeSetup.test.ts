import type { AgentHostApi, ObservedCliResumePreview, ObservedCliResumeStatus, ObservedControlStatus } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { handoverRouteOptions } from '../src/chat/SessionHandoverDialog';
import { MESSAGES } from '../src/i18n';
import { ObservedCliResumeController, ObservedCliResumeSetupView, observedCliResumeSupported, startObservedCliResumePolling, type ObservedCliResumeViewState } from '../src/observe/ObservedCliResumeSetup';

const status = (state: ObservedCliResumeStatus['state'] = 'disconnected', sessionId = 'session-a'): ObservedCliResumeStatus => ({ sessionId, state, ...(state !== 'disconnected' ? { pairingId: 'pair-a' } : {}) });
const preview = (sessionId = 'session-a'): ObservedCliResumePreview => ({ sessionId, reviewId: 'review-a', expiresAt: '2030-01-01T00:00:00Z', family: 'codex', nativeSessionId: 'native-a', executable: '/tools/codex', version: '1.0.0', projectPath: '/projects/example', profilePath: '/profiles/example', arguments: ['exec', 'resume', 'native-a', '--json'] });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (failure: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; }
function harness(initial = status()) {
  const host = {
    observedCliResumeStatus: vi.fn(async (_id: string): Promise<ObservedCliResumeStatus> => initial),
    previewObservedCliResume: vi.fn(async (_id: string): Promise<ObservedCliResumePreview> => preview()),
    pairObservedCliResume: vi.fn(async (_id: string, _input: { reviewId: string; exclusiveOwnerConfirmed: boolean }): Promise<ObservedCliResumeStatus> => status('ready')),
    disconnectObservedCliResume: vi.fn(async (_id: string): Promise<ObservedCliResumeStatus> => status()),
    reconcileObservedCliResume: vi.fn(async (_id: string, _input: { operationId: string; inspected: boolean }): Promise<ObservedCliResumeStatus> => status('ready')),
  };
  const agents = host as unknown as AgentHostApi, changed = vi.fn(), owner = new ObservedCliResumeController(changed);
  owner.bind(agents, 'session-a', 'source-a'); return { host, agents, changed, owner };
}
function render(value: ObservedCliResumeViewState, language: 'en' | 'id' = 'en') {
  return renderToStaticMarkup(createElement(ObservedCliResumeSetupView, { t: MESSAGES[language].observedCliResume, value, supported: true,
    onPreview: vi.fn(), onRefresh: vi.fn(), onConfirm: vi.fn(), onPair: vi.fn(), onDisconnect: vi.fn(), onInspected: vi.fn(), onReconcile: vi.fn() }));
}

describe('official CLI continuation UI ownership', () => {
  it('prefers native routes and labels explicitly paired CLI continuation', () => {
    const capabilities = (capabilityId: string) => [{ capabilityId, action: 'start' as const, available: true }];
    const source = { sessionId: 'session-a', state: 'ready', routes: [
      { route: 'official-cli-resume', state: 'ready', capabilities: capabilities('cli') },
      { route: 'codex-native', state: 'ready', capabilities: capabilities('native') },
    ] } as ObservedControlStatus;
    const options = handoverRouteOptions(source, 'session-a', MESSAGES.en.sessionHandover.cliResume);
    expect(options.map(option => option.value)).toEqual(['native', 'cli']);
    expect(options[1]?.label).toBe(MESSAGES.en.sessionHandover.cliResume);
    expect(handoverRouteOptions({ ...source, routes: [source.routes[1]!] }, 'session-a').some(option => option.value === 'cli')).toBe(false);
  });

  it('defaults handover to the real Antigravity native route before cooperative inbox and CLI', () => {
    const source = { sessionId: 'antigravity-session', state: 'ready', routes: [
      { route: 'cooperative-inbox', state: 'ready', capabilities: [{ capabilityId: 'unconsumed-inbox', action: 'inbox-send', available: true }] },
      { route: 'official-cli-resume', state: 'ready', capabilities: [{ capabilityId: 'paired-cli', action: 'start', available: true }] },
      { route: 'antigravity-native', state: 'ready', capabilities: [{ capabilityId: 'actual-native', action: 'start', available: true }] },
    ] } as ObservedControlStatus;
    expect(handoverRouteOptions(source, source.sessionId).map(option => option.value)).toEqual(['actual-native', 'paired-cli', 'unconsumed-inbox']);
  });
  it('loads passive status without discovering executables or pairing', async () => {
    const h = harness(); expect(observedCliResumeSupported(h.agents)).toBe(true);
    expect(observedCliResumeSupported({} as AgentHostApi)).toBe(false);
    await h.owner.load();
    expect(h.host.observedCliResumeStatus).toHaveBeenCalledExactlyOnceWith('session-a');
    expect(h.host.previewObservedCliResume).not.toHaveBeenCalled(); expect(h.host.pairObservedCliResume).not.toHaveBeenCalled();
  });
  it('polls paired state silently and exposes running/unknown without executing or probing', async () => {
    const h = harness(status('ready')); await h.owner.load();
    h.host.observedCliResumeStatus.mockResolvedValueOnce(status('running'));
    await h.owner.poll(); expect(h.owner.value.status?.state).toBe('running'); expect(h.owner.value.busy).toBeUndefined();
    h.host.observedCliResumeStatus.mockResolvedValueOnce({ ...status('uncertain'), operationId: 'operation-a', lastOutcome: 'unknown' });
    await h.owner.poll(); h.owner.inspect(true);
    h.host.observedCliResumeStatus.mockResolvedValueOnce({ ...status('uncertain'), operationId: 'operation-a', lastOutcome: 'unknown' });
    await h.owner.poll(); expect(h.owner.value.inspected).toBe(true);
    expect(h.host.previewObservedCliResume).not.toHaveBeenCalled(); expect(h.host.pairObservedCliResume).not.toHaveBeenCalled(); expect(h.changed).not.toHaveBeenCalled();
    expect(render(h.owner.value)).toContain(MESSAGES.en.observedCliResume.outcomes.unknown);
  });
  it('does not poll during a reviewed preview or clear its checked ownership confirmation', async () => {
    const h = harness(status('ready')); await h.owner.load(); await h.owner.preview(); h.owner.confirm(true);
    const review = h.owner.value.preview; await h.owner.poll();
    expect(h.host.observedCliResumeStatus).toHaveBeenCalledOnce(); expect(h.owner.value.preview).toBe(review); expect(h.owner.value.exclusiveOwnerConfirmed).toBe(true);
  });
  it('discards a silent read that predates a new preview or source boundary', async () => {
    const h = harness(status('ready')), pending = deferred<ObservedCliResumeStatus>(); await h.owner.load();
    h.host.observedCliResumeStatus.mockReturnValueOnce(pending.promise); const polling = h.owner.poll();
    await h.owner.preview(); h.owner.confirm(true); pending.resolve(status('running')); await polling;
    expect(h.owner.value.preview?.reviewId).toBe('review-a'); expect(h.owner.value.exclusiveOwnerConfirmed).toBe(true); expect(h.owner.value.status?.state).toBe('ready');
    const other = deferred<ObservedCliResumeStatus>(); h.owner.bind(h.agents, 'session-a', 'new-revision'); await h.owner.load();
    h.host.observedCliResumeStatus.mockReturnValueOnce(other.promise); const stale = h.owner.poll(); h.owner.bind(h.agents, 'session-b', 'source-b');
    other.resolve(status('uncertain')); await stale; expect(h.owner.value.status).toBeUndefined();
  });
  it('bounds silent read concurrency and stops timer requests and stale results on unmount', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(status('ready')), pending = deferred<ObservedCliResumeStatus>(); await h.owner.load();
      h.host.observedCliResumeStatus.mockReturnValueOnce(pending.promise); const stop = startObservedCliResumePolling(h.owner);
      await vi.advanceTimersByTimeAsync(9000); expect(h.host.observedCliResumeStatus).toHaveBeenCalledTimes(2); expect(h.owner.value.busy).toBeUndefined();
      stop(); h.owner.invalidate(); pending.resolve(status('uncertain')); await Promise.resolve();
      await vi.advanceTimersByTimeAsync(9000); expect(h.host.observedCliResumeStatus).toHaveBeenCalledTimes(2); expect(h.owner.value.status?.state).toBe('ready');
    } finally { vi.useRealTimers(); }
  });
  it.each(['completed', 'failed', 'unknown'] as const)('labels %s as a CLI outcome without claiming task verification', outcome => {
    const html = render({ status: { ...status('ready'), lastOutcome: outcome }, exclusiveOwnerConfirmed: false, inspected: false });
    expect(html).toContain(MESSAGES.en.observedCliResume.outcomes[outcome]);
  });
  it('requires an explicit review and ownership confirmation and admits pairing once', async () => {
    const h = harness(), pending = deferred<ObservedCliResumeStatus>();
    await h.owner.pair(); await h.owner.preview(); await h.owner.pair();
    expect(h.host.pairObservedCliResume).not.toHaveBeenCalled();
    h.owner.confirm(true); h.host.pairObservedCliResume.mockReturnValueOnce(pending.promise);
    const operation = h.owner.pair(); await h.owner.pair();
    expect(h.host.pairObservedCliResume).toHaveBeenCalledExactlyOnceWith('session-a', { reviewId: 'review-a', exclusiveOwnerConfirmed: true });
    expect(h.owner.value.preview).toBeUndefined(); expect(h.owner.value.busy).toBe('pair');
    pending.resolve(status('ready')); await operation; expect(h.changed).toHaveBeenCalledOnce(); expect(h.owner.value.status?.state).toBe('ready');
  });
  it('invalidates late passive status and executable previews when the source changes', async () => {
    const h = harness(), staleStatus = deferred<ObservedCliResumeStatus>(), stalePreview = deferred<ObservedCliResumePreview>();
    h.host.observedCliResumeStatus.mockReturnValueOnce(staleStatus.promise); const load = h.owner.load();
    h.owner.bind(h.agents, 'session-b', 'source-b'); staleStatus.resolve(status()); await load;
    expect(h.owner.value.status).toBeUndefined();
    h.host.previewObservedCliResume.mockReturnValueOnce(stalePreview.promise); const review = h.owner.preview();
    h.owner.bind(h.agents, 'session-c', 'source-c'); stalePreview.resolve(preview('session-b')); await review;
    expect(h.owner.value.preview).toBeUndefined(); expect(h.owner.value.error).toBeUndefined();
  });
  it('invalidates a late preview on host replacement even with the same session ID', async () => {
    const h = harness(), next = harness(), pending = deferred<ObservedCliResumePreview>();
    h.host.previewObservedCliResume.mockReturnValueOnce(pending.promise); const review = h.owner.preview();
    h.owner.bind(next.agents, 'session-a', 'source-a'); pending.resolve(preview()); await review;
    expect(h.owner.value.preview).toBeUndefined(); expect(h.owner.matches(next.agents, 'session-a', 'source-a')).toBe(true);
  });
  it('discards a failed pairing review and does not blindly retry', async () => {
    const h = harness(); await h.owner.preview(); h.owner.confirm(true);
    h.host.pairObservedCliResume.mockRejectedValueOnce(new Error('Review expired'));
    await h.owner.pair(); await h.owner.pair();
    expect(h.host.pairObservedCliResume).toHaveBeenCalledOnce(); expect(h.owner.value.error).toBe('Review expired');
    expect(h.owner.value.preview).toBeUndefined(); expect(h.owner.value.exclusiveOwnerConfirmed).toBe(false);
    await h.owner.preview(); expect(h.owner.value.error).toBeUndefined();
  });
  it('retains an entered mutation across source switches without replay or stale callback', async () => {
    const h = harness(), pending = deferred<ObservedCliResumeStatus>();
    await h.owner.preview(); h.owner.confirm(true); h.host.pairObservedCliResume.mockReturnValueOnce(pending.promise);
    const operation = h.owner.pair(); h.owner.bind(h.agents, 'session-b', 'source-b'); await h.owner.preview(); await h.owner.pair();
    expect(h.owner.value.busy).toBe('pair'); expect(h.host.previewObservedCliResume).toHaveBeenCalledOnce();
    h.host.observedCliResumeStatus.mockResolvedValueOnce(status('disconnected', 'session-b'));
    pending.resolve(status('ready')); await operation; await Promise.resolve();
    expect(h.host.pairObservedCliResume).toHaveBeenCalledOnce(); expect(h.changed).not.toHaveBeenCalled();
    expect(h.owner.value.status?.sessionId).toBe('session-b');
  });
  it('waits for host disconnect before replacing running status', async () => {
    const h = harness(status('running')), pending = deferred<ObservedCliResumeStatus>(); await h.owner.load();
    h.host.disconnectObservedCliResume.mockReturnValueOnce(pending.promise); const operation = h.owner.disconnect(); await h.owner.disconnect();
    expect(h.owner.value.status?.state).toBe('running'); expect(h.owner.value.busy).toBe('disconnect'); expect(h.changed).not.toHaveBeenCalled();
    pending.resolve(status()); await operation; expect(h.host.disconnectObservedCliResume).toHaveBeenCalledOnce(); expect(h.owner.value.status?.state).toBe('disconnected');
  });
  it('requires inspection to reconcile an uncertain operation and never resends it', async () => {
    const h = harness({ ...status('uncertain'), operationId: 'operation-a', lastOutcome: 'unknown' }); await h.owner.load();
    await h.owner.preview(); await h.owner.reconcile(); expect(h.host.previewObservedCliResume).not.toHaveBeenCalled(); expect(h.host.reconcileObservedCliResume).not.toHaveBeenCalled();
    h.owner.inspect(true); await h.owner.reconcile();
    expect(h.host.reconcileObservedCliResume).toHaveBeenCalledExactlyOnceWith('session-a', { operationId: 'operation-a', inspected: true });
    expect(h.host.pairObservedCliResume).not.toHaveBeenCalled();
  });
  it('rejects a host response for a different conversation', async () => {
    const h = harness(); h.host.previewObservedCliResume.mockResolvedValueOnce(preview('other')); await h.owner.preview();
    expect(h.owner.value.preview).toBeUndefined(); expect(h.owner.value.error).toBe('CLI_RESUME_RESPONSE_SESSION_MISMATCH');
  });
  it('keeps compact runtime uncertainty visible and sends setup/inspection controls to Advanced', () => {
    const html = renderToStaticMarkup(createElement(ObservedCliResumeSetupView, { t: MESSAGES.en.observedCliResume, value: { status: { ...status('uncertain'), operationId: 'uncertain-operation', lastOutcome: 'unknown' }, exclusiveOwnerConfirmed: false, inspected: false }, supported: true, compact: true, onExpand: vi.fn(), onPreview: vi.fn(), onRefresh: vi.fn(), onConfirm: vi.fn(), onPair: vi.fn(), onDisconnect: vi.fn(), onInspected: vi.fn(), onReconcile: vi.fn() }));
    expect(html).toContain(MESSAGES.en.observedCliResume.outcomes.unknown); expect(html).toContain(MESSAGES.en.observedCliResume.openControls);
    expect(html).not.toContain(MESSAGES.en.observedCliResume.review); expect(html).not.toContain('type="checkbox"'); expect(html).not.toContain(MESSAGES.en.observedCliResume.reconcile);
  });
  it('distinguishes Claude reported model from the current native default selection', () => {
    const html = render({ preview: { ...preview(), family: 'claude', model: 'claude-sonnet-4-6' }, exclusiveOwnerConfirmed: false, inspected: false });
    expect(html).toContain(MESSAGES.en.observedCliResume.claudeDefaults); expect(html).toContain(MESSAGES.en.observedCliResume.model);
    expect(html).toContain('claude-sonnet-4-6');
  });
  it.each(['profile', 'project', 'environment'] as const)('shows exact reviewed Claude request selection separately from reported model (%s)', resumeModelSource => {
    const html = render({ preview: { ...preview(), family: 'claude', model: 'claude-sonnet-4-6', resumeModel: 'example-router/claude-sonnet-4-6', resumeModelSource }, exclusiveOwnerConfirmed: false, inspected: false });
    expect(html).toContain('example-router/claude-sonnet-4-6'); expect(html).toContain(MESSAGES.en.observedCliResume.resumeModel);
    expect(html).toContain(MESSAGES.en.observedCliResume.resumeModelSources[resumeModelSource]);
    expect(html).toContain(MESSAGES.en.observedCliResume.configuredModel); expect(html).not.toContain(MESSAGES.en.observedCliResume.claudeDefaults);
  });
  it.each(['en', 'id'] as const)('renders literal review data, fixed args and a disabled unchecked pair action in %s', language => {
    const html = render({ preview: { ...preview(), projectPath: '/projects/<example>' }, exclusiveOwnerConfirmed: false, inspected: false }, language);
    expect(html).toContain('native-a'); expect(html).toContain('/projects/&lt;example&gt;'); expect(html).toContain('/profiles/example');
    expect(html).toContain(MESSAGES[language].observedCliResume.permissions); expect(html).toContain('"exec"'.replaceAll('"', '&quot;'));
    expect(html).toMatch(/<input type="checkbox"\/>/); expect(html).toMatch(/disabled=""[^>]*>[^<]*<\/button>/);
    expect(html).not.toContain('style="width:');
  });
});
