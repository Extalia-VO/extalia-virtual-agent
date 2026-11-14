import type { AgentHostApi, ObservedControlStatus, SessionSummary } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { ObservedAntigravityRecovery, ObservedAntigravityRecoveryController, ObservedAntigravityRecoveryView } from '../src/observe/ObservedAntigravityRecovery';

const session = { id: 'observed-antigravity', workspaceId: 'workspace-a', control: 'observed', observation: { sourceId: 'antigravity', nativeSessionId: 'native-original', projectPath: '/projects/example' } } as SessionSummary;
const status = (state: 'ready' | 'uncertain' = 'ready'): ObservedControlStatus => ({ sessionId: session.id, nativeSessionId: session.observation!.nativeSessionId, state: state === 'ready' ? 'ready' : 'unavailable', routes: [{ route: 'antigravity-native', state, evidence: 'native-attachment', limit: 'existing-native-owner', capabilities: [], relatedControls: [] }] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function harness() {
  const api = { reconcileObservedAntigravity: vi.fn(async (_id: string) => status()) }, agents = api as unknown as AgentHostApi, changed = vi.fn();
  const owner = new ObservedAntigravityRecoveryController(changed); owner.bind(agents, session); return { owner, agents, api, changed };
}

describe('explicit observed Antigravity recovery', () => {
  it('does nothing until explicitly inspected and refreshes the exact source once on success', async () => {
    const h = harness(); await Promise.resolve(); expect(h.api.reconcileObservedAntigravity).not.toHaveBeenCalled();
    await h.owner.inspect(); expect(h.api.reconcileObservedAntigravity).toHaveBeenCalledExactlyOnceWith(session.id);
    expect(h.owner.value.phase).toBe('finished'); expect(h.changed).toHaveBeenCalledOnce();
  });
  it('deduplicates an admitted inspection while pending', async () => {
    const h = harness(), pending = deferred<ObservedControlStatus>(); h.api.reconcileObservedAntigravity.mockReturnValueOnce(pending.promise);
    const inspection = h.owner.inspect(); await h.owner.inspect(); expect(h.owner.value.phase).toBe('pending'); expect(h.api.reconcileObservedAntigravity).toHaveBeenCalledOnce();
    pending.resolve(status()); await inspection; expect(h.owner.value.phase).toBe('finished');
  });
  it('does not call inspection for another harness', async () => {
    const h = harness(), other = { ...session, observation: { ...session.observation!, sourceId: 'codex' } };
    h.owner.bind(h.agents, other); await h.owner.inspect(); expect(h.api.reconcileObservedAntigravity).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(createElement(ObservedAntigravityRecovery, { agents: h.agents, session: other, t: MESSAGES.en.observedAntigravity, onChanged: h.changed })); expect(html).toBe('');
  });
  it('drops stale source and unmounted results without refreshing another conversation', async () => {
    const h = harness(), pending = deferred<ObservedControlStatus>(); h.api.reconcileObservedAntigravity.mockReturnValueOnce(pending.promise);
    const inspection = h.owner.inspect(); h.owner.bind(h.agents, { ...session, workspaceId: 'workspace-b', observation: { ...session.observation!, nativeSessionId: 'different-native' } });
    pending.resolve(status()); await inspection; expect(h.owner.value.phase).toBe('idle'); expect(h.changed).not.toHaveBeenCalled();
    const next = deferred<ObservedControlStatus>(); h.api.reconcileObservedAntigravity.mockReturnValueOnce(next.promise); const unmounted = h.owner.inspect(); h.owner.invalidate();
    next.resolve(status()); await unmounted; expect(h.changed).not.toHaveBeenCalled(); expect(h.owner.value.phase).not.toBe('finished');
  });
  it('retains the pending guard across host replacement and only accepts the new explicit inspection', async () => {
    const h = harness(), next = harness(), pending = deferred<ObservedControlStatus>(); h.api.reconcileObservedAntigravity.mockReturnValueOnce(pending.promise);
    const inspection = h.owner.inspect(); h.owner.bind(next.agents, session); await h.owner.inspect(); expect(next.api.reconcileObservedAntigravity).not.toHaveBeenCalled();
    pending.resolve(status()); await inspection; expect(h.changed).not.toHaveBeenCalled(); expect(h.owner.value.phase).toBe('idle');
    h.owner.setChanged(next.changed); await h.owner.inspect(); expect(next.changed).toHaveBeenCalledOnce(); expect(h.owner.value.phase).toBe('finished');
  });
  it('does not accept a different native conversation as a successful recovery', async () => {
    const h = harness(); h.api.reconcileObservedAntigravity.mockResolvedValueOnce({ ...status(), nativeSessionId: 'unrelated-native' }); await h.owner.inspect();
    expect(h.owner.value.phase).toBe('uncertain'); expect(h.changed).not.toHaveBeenCalled();
  });
  it('retains uncertainty and uses generic feedback without exposing transport errors', async () => {
    const h = harness(); h.api.reconcileObservedAntigravity.mockResolvedValueOnce(status('uncertain')); await h.owner.inspect(); expect(h.owner.value.phase).toBe('uncertain'); expect(h.changed).toHaveBeenCalledOnce();
    h.api.reconcileObservedAntigravity.mockRejectedValueOnce(new Error('private endpoint detail')); await h.owner.inspect(); expect(h.owner.value.phase).toBe('uncertain'); expect(JSON.stringify(h.owner.value)).not.toContain('private endpoint');
  });
  it.each(['en', 'id'] as const)('renders disabled pending and explicit recovery results in %s', language => {
    const t = MESSAGES[language].observedAntigravity;
    const render = (phase: 'pending' | 'finished' | 'uncertain') => renderToStaticMarkup(createElement(ObservedAntigravityRecoveryView, { t, state: { phase }, supported: true, onInspect: vi.fn() }));
    expect(render('pending')).toContain('disabled=""'); expect(render('pending')).toContain(t.inspecting);
    expect(render('finished')).toContain(t.finished); expect(render('uncertain')).toContain(t.uncertain);
    expect(render('finished')).not.toContain('type="submit"');
  });
});
