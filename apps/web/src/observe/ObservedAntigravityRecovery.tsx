import type { AgentHostApi, SessionSummary } from '@extalia/platform';
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { Messages } from '../i18n';

export type AntigravityRecoveryMessages = Messages['observedAntigravity'];
export interface AntigravityRecoveryState { phase: 'idle' | 'pending' | 'finished' | 'uncertain' }
export function antigravityRecoverySourceKey(session: SessionSummary): string {
  return JSON.stringify([session.id, session.workspaceId, session.connectionId, session.observation?.sourceId, session.observation?.nativeSessionId, session.observation?.projectPath]);
}
export class ObservedAntigravityRecoveryController {
  value: AntigravityRecoveryState = { phase: 'idle' };
  private agents?: AgentHostApi;
  private session?: SessionSummary;
  private key = '';
  private generation = 0;
  private pending = false;
  private readonly listeners = new Set<() => void>();
  constructor(private changed: () => void) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.value;
  setChanged(changed: () => void) { this.changed = changed; }
  matches(agents: AgentHostApi, session: SessionSummary) { return this.agents === agents && this.key === antigravityRecoverySourceKey(session); }
  bind(agents: AgentHostApi, session: SessionSummary) {
    if (this.matches(agents, session)) return;
    this.generation++; this.agents = agents; this.session = session; this.key = antigravityRecoverySourceKey(session);
    this.publish(this.pending ? 'pending' : 'idle');
  }
  invalidate() { this.generation++; this.agents = undefined; this.key = ''; }
  private publish(phase: AntigravityRecoveryState['phase']) { this.value = { phase }; for (const listener of this.listeners) listener(); }
  async inspect(): Promise<void> {
    const agents = this.agents, session = this.session, generation = this.generation;
    if (!agents?.reconcileObservedAntigravity || this.pending || session?.control !== 'observed' || session.observation?.sourceId !== 'antigravity') return;
    this.pending = true; this.publish('pending');
    try {
      const result = await agents.reconcileObservedAntigravity(session.id);
      if (generation !== this.generation) return;
      if (result?.sessionId !== session.id || result.nativeSessionId && result.nativeSessionId !== session.observation.nativeSessionId || !Array.isArray(result.routes)) { this.publish('uncertain'); return; }
      const route = result.routes.find(item => item.route === 'antigravity-native');
      this.publish(route && (route.state === 'ready' || route.state === 'busy') ? 'finished' : 'uncertain');
      try { this.changed(); } catch { /* A view refresh cannot change the inspection result. */ }
    } catch { if (generation === this.generation) this.publish('uncertain'); }
    finally { this.pending = false; if (generation !== this.generation && this.agents) this.publish('idle'); }
  }
}

export function ObservedAntigravityRecovery({ agents, session, t, disabled, onChanged }: {
  agents: AgentHostApi; session: SessionSummary; t: AntigravityRecoveryMessages; disabled?: boolean; onChanged(): void;
}) {
  const [controller] = useState(() => new ObservedAntigravityRecoveryController(onChanged));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const current = controller.matches(agents, session);
  useLayoutEffect(() => { controller.setChanged(onChanged); }, [controller, onChanged]);
  useLayoutEffect(() => { controller.bind(agents, session); }, [controller, agents, session]);
  useEffect(() => () => controller.invalidate(), [controller]);
  return <ObservedAntigravityRecoveryView t={t} state={current ? state : { phase: 'idle' }}
    supported={session.control === 'observed' && session.observation?.sourceId === 'antigravity' && typeof agents.reconcileObservedAntigravity === 'function'}
    disabled={disabled} onInspect={() => { void controller.inspect(); }} />;
}
export function ObservedAntigravityRecoveryView({ t, state, supported, disabled, onInspect }: {
  t: AntigravityRecoveryMessages; state: AntigravityRecoveryState; supported: boolean; disabled?: boolean; onInspect(): void;
}) {
  if (!supported) return null;
  return <div className="observed-antigravity-recovery">
    <button type="button" className="button small" disabled={disabled || state.phase === 'pending'} aria-busy={state.phase === 'pending'} onClick={onInspect}>{state.phase === 'pending' ? t.inspecting : t.inspect}</button>
    {state.phase === 'finished' && <p className="muted small" role="status">{t.finished}</p>}
    {state.phase === 'uncertain' && <p className="form-error" role="alert">{t.uncertain}</p>}
  </div>;
}
