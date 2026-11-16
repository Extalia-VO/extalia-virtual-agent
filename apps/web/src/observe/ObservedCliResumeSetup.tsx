import type { AgentHostApi, ObservedCliResumePreview, ObservedCliResumeStatus } from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import './observedCliResumeSetup.css';

export type CliResumeMessages = Messages['observedCliResume'];
type Busy = 'load' | 'preview' | 'pair' | 'disconnect' | 'reconcile';
export interface ObservedCliResumeViewState {
  status?: ObservedCliResumeStatus;
  preview?: ObservedCliResumePreview;
  busy?: Busy;
  exclusiveOwnerConfirmed: boolean;
  inspected: boolean;
  error?: string;
}

export function observedCliResumeSupported(agents: AgentHostApi): boolean {
  return Boolean(agents.observedCliResumeStatus && agents.previewObservedCliResume && agents.pairObservedCliResume
    && agents.disconnectObservedCliResume && agents.reconcileObservedCliResume);
}

/** Owns UI requests only. Executables, source identity and process lifetime stay in the host. */
export class ObservedCliResumeController {
  value: ObservedCliResumeViewState = { exclusiveOwnerConfirmed: false, inspected: false };
  private agents?: AgentHostApi;
  private sessionId = '';
  private sourceKey = '';
  private generation = 0;
  private statusRequest = 0;
  private pendingPoll?: number;
  private mutation?: 'pair' | 'disconnect' | 'reconcile';
  private readonly listeners = new Set<() => void>();
  constructor(private changed: () => void) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = (): ObservedCliResumeViewState => this.value;
  setChanged(changed: () => void): void { this.changed = changed; }
  matches(agents: AgentHostApi, sessionId: string, sourceKey: string): boolean {
    return this.agents === agents && this.sessionId === sessionId && this.sourceKey === sourceKey;
  }
  bind(agents: AgentHostApi, sessionId: string, sourceKey: string): void {
    if (this.matches(agents, sessionId, sourceKey)) return;
    this.generation++; this.statusRequest++; this.pendingPoll = undefined; this.agents = agents; this.sessionId = sessionId; this.sourceKey = sourceKey;
    this.value = { exclusiveOwnerConfirmed: false, inspected: false, ...(this.mutation ? { busy: this.mutation } : {}) };
    this.notify();
  }
  invalidate(): void { this.generation++; this.statusRequest++; this.pendingPoll = undefined; this.agents = undefined; this.sourceKey = ''; }
  private notify(): void { for (const listener of this.listeners) listener(); }
  private publish(next: Partial<ObservedCliResumeViewState>): void { this.value = { ...this.value, ...next }; this.notify(); }
  private checkSession(value: { sessionId: string }, sessionId: string): void {
    if (value.sessionId !== sessionId) throw new Error('CLI_RESUME_RESPONSE_SESSION_MISMATCH');
  }
  confirm(value: boolean): void {
    if (!this.value.busy && this.value.preview && !this.mutation) this.publish({ exclusiveOwnerConfirmed: value });
  }
  inspect(value: boolean): void {
    if (!this.value.busy && this.value.status?.state === 'uncertain' && !this.mutation) this.publish({ inspected: value });
  }
  async load(): Promise<void> {
    const host = this.agents, sessionId = this.sessionId, generation = this.generation;
    if (!host?.observedCliResumeStatus || !sessionId || this.value.busy || this.mutation) return;
    this.statusRequest++;
    this.publish({ busy: 'load', preview: undefined, exclusiveOwnerConfirmed: false, inspected: false, error: undefined });
    try {
      const status = await host.observedCliResumeStatus(sessionId);
      if (generation !== this.generation) return;
      this.checkSession(status, sessionId); this.publish({ status });
    } catch (failure) { if (generation === this.generation) this.publish({ error: errorMessage(failure) }); }
    finally { if (generation === this.generation) this.publish({ busy: undefined }); }
  }
  /** Status only: never probes an executable or changes a pending review/confirmation. */
  async poll(): Promise<void> {
    const host = this.agents, sessionId = this.sessionId, generation = this.generation;
    if (!host?.observedCliResumeStatus || !sessionId || !this.value.status?.pairingId || this.value.busy || this.value.preview || this.mutation || this.pendingPoll !== undefined) return;
    const request = ++this.statusRequest;
    this.pendingPoll = request;
    const current = () => generation === this.generation && request === this.statusRequest && !this.value.busy && !this.value.preview && !this.mutation;
    try {
      const status = await host.observedCliResumeStatus(sessionId);
      if (!current()) return;
      this.checkSession(status, sessionId);
      this.publish({ status, ...(status.operationId !== this.value.status?.operationId ? { inspected: false } : {}) });
    } catch (failure) { if (current() && !this.value.error) this.publish({ error: errorMessage(failure) }); }
    finally { if (this.pendingPoll === request) this.pendingPoll = undefined; }
  }
  async preview(): Promise<void> {
    const host = this.agents, sessionId = this.sessionId, generation = this.generation;
    if (!host?.previewObservedCliResume || !sessionId || this.value.busy || this.mutation
      || this.value.status?.state === 'running' || this.value.status?.state === 'uncertain') return;
    this.statusRequest++;
    this.publish({ busy: 'preview', preview: undefined, exclusiveOwnerConfirmed: false, error: undefined });
    try {
      const preview = await host.previewObservedCliResume(sessionId);
      if (generation !== this.generation) return;
      this.checkSession(preview, sessionId); this.publish({ preview });
    } catch (failure) { if (generation === this.generation) this.publish({ error: errorMessage(failure) }); }
    finally { if (generation === this.generation) this.publish({ busy: undefined }); }
  }
  async pair(): Promise<void> {
    const host = this.agents, preview = this.value.preview;
    if (!host?.pairObservedCliResume || !preview || !this.value.exclusiveOwnerConfirmed || this.value.busy || this.mutation) return;
    await this.mutate('pair', () => host.pairObservedCliResume!(this.sessionId, { reviewId: preview.reviewId, exclusiveOwnerConfirmed: true }));
  }
  async disconnect(): Promise<void> {
    const host = this.agents;
    if (!host?.disconnectObservedCliResume || !this.value.status?.pairingId || this.value.busy || this.mutation) return;
    await this.mutate('disconnect', () => host.disconnectObservedCliResume!(this.sessionId));
  }
  async reconcile(): Promise<void> {
    const host = this.agents, status = this.value.status;
    if (!host?.reconcileObservedCliResume || status?.state !== 'uncertain' || !status.operationId
      || !this.value.inspected || this.value.busy || this.mutation) return;
    await this.mutate('reconcile', () => host.reconcileObservedCliResume!(this.sessionId, { operationId: status.operationId!, inspected: true }));
  }
  private async mutate(kind: 'pair' | 'disconnect' | 'reconcile', action: () => Promise<ObservedCliResumeStatus>): Promise<void> {
    const sessionId = this.sessionId, generation = this.generation;
    this.statusRequest++; this.mutation = kind;
    // Consumed reviews and inspections are never blindly replayed after a failed response.
    this.publish({ busy: kind, preview: undefined, exclusiveOwnerConfirmed: false, inspected: false, error: undefined });
    try {
      const status = await action();
      if (generation !== this.generation) return;
      this.checkSession(status, sessionId); this.publish({ status }); this.changed();
    } catch (failure) { if (generation === this.generation) this.publish({ error: errorMessage(failure) }); }
    finally {
      this.mutation = undefined;
      if (generation === this.generation) this.publish({ busy: undefined });
      else if (this.agents) { this.publish({ busy: undefined }); void this.load(); }
    }
  }
}

/** The caller cancels this mounted-panel timer on every source or review boundary. */
export function startObservedCliResumePolling(controller: ObservedCliResumeController): () => void {
  const timer = setInterval(() => { void controller.poll(); }, 3000);
  return () => clearInterval(timer);
}

export interface ObservedCliResumeSetupProps {
  agents: AgentHostApi;
  sessionId: string;
  sourceKey: string;
  t: CliResumeMessages;
  disabled?: boolean;
  compact?: boolean;
  onExpand?(): void;
  onChanged(): void;
}
export function ObservedCliResumeSetup({ agents, sessionId, sourceKey, t, disabled, compact, onExpand, onChanged }: ObservedCliResumeSetupProps) {
  const [controller] = useState(() => new ObservedCliResumeController(onChanged));
  const ownerState = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const current = controller.matches(agents, sessionId, sourceKey);
  const value: ObservedCliResumeViewState = current ? ownerState : { exclusiveOwnerConfirmed: false, inspected: false };
  useLayoutEffect(() => { controller.setChanged(onChanged); }, [controller, onChanged]);
  useLayoutEffect(() => {
    if (!controller.matches(agents, sessionId, sourceKey)) {
      controller.bind(agents, sessionId, sourceKey);
      if (observedCliResumeSupported(agents)) void controller.load();
    }
  }, [controller, agents, sessionId, sourceKey]);
  useEffect(() => () => controller.invalidate(), [controller]);
  useEffect(() => {
    if (!current || disabled || !value.status?.pairingId || !['ready', 'running', 'uncertain'].includes(value.status.state) || value.busy || value.preview) return;
    return startObservedCliResumePolling(controller);
  }, [controller, current, disabled, value.status?.pairingId, value.status?.state, value.busy, value.preview]);
  return <ObservedCliResumeSetupView t={t} compact={compact} onExpand={onExpand} value={value} supported={observedCliResumeSupported(agents)} disabled={disabled}
    onPreview={() => { void controller.preview(); }} onRefresh={() => { void controller.load(); }}
    onConfirm={confirmed => controller.confirm(confirmed)} onPair={() => { void controller.pair(); }}
    onDisconnect={() => { void controller.disconnect(); }} onInspected={inspected => controller.inspect(inspected)} onReconcile={() => { void controller.reconcile(); }} />;
}

export interface ObservedCliResumeSetupViewProps {
  t: CliResumeMessages;
  value: ObservedCliResumeViewState;
  supported: boolean;
  disabled?: boolean;
  compact?: boolean;
  onExpand?(): void;
  onPreview(): void;
  onRefresh(): void;
  onConfirm(value: boolean): void;
  onPair(): void;
  onDisconnect(): void;
  onInspected(value: boolean): void;
  onReconcile(): void;
}
export function ObservedCliResumeSetupView(p: ObservedCliResumeSetupViewProps) {
  const { t, value } = p, id = useId(), status = value.status, preview = value.preview;
  const busy = Boolean(value.busy), disabled = Boolean(p.disabled || busy);
  if (p.compact) {
    if (!p.supported || !status || !status.pairingId && !['running', 'uncertain'].includes(status.state) && !value.error) return null;
    const needsInspection = status.state === 'uncertain' || status.state === 'unavailable' || Boolean(value.error);
    return <section className="observed-cli-resume observed-cli-resume-compact" aria-labelledby={`${id}-title`} role="status">
      <header className="observed-cli-resume-head"><strong id={`${id}-title`}>{t.compactTitle}</strong><span className="small">{t.states[status.state]}</span></header>
      {status.lastOutcome && <p className="muted small">{t.outcomes[status.lastOutcome]}</p>}
      {status.state === 'running' && <p className="muted small">{t.running}</p>}
      {status.state === 'uncertain' && <p className="small">{t.uncertain}</p>}
      {status.problem && <p className="note small">{status.problem}</p>}
      {value.error && <p className="form-error">{value.error === 'CLI_RESUME_RESPONSE_SESSION_MISMATCH' ? t.invalidResponse : value.error}</p>}
      {needsInspection && p.onExpand && <button type="button" className="button small" onClick={p.onExpand}>{t.openControls}</button>}
    </section>;
  }
  return <section className="observed-cli-resume" aria-labelledby={`${id}-title`}>
    <header className="observed-cli-resume-head"><strong id={`${id}-title`}>{t.title}</strong>
      {status && <span className="muted small" role="status">{t.states[status.state]}</span>}
    </header>
    {!p.supported ? <p className="muted small">{t.unavailable}</p> : <>
      <div className="observed-cli-resume-actions">
        {status?.state !== 'ready' && status?.state !== 'running' && status?.state !== 'uncertain' && <button type="button" className="button small" disabled={disabled} onClick={p.onPreview}>{value.busy === 'preview' ? t.reviewing : t.review}</button>}
        <button type="button" className="button small" disabled={disabled} onClick={p.onRefresh}>{t.refresh}</button>
        {status?.pairingId && <button type="button" className="button small" disabled={disabled} onClick={p.onDisconnect}>{value.busy === 'disconnect' ? t.disconnecting : status.state === 'running' ? t.stopDisconnect : t.disconnect}</button>}
      </div>
      {value.busy && <p className="muted small" role="status">{t.busy[value.busy]}</p>}
      {status?.state === 'ready' && <p className="muted small">{t.ready}</p>}
      {status?.state === 'running' && <p className="muted small">{t.running}</p>}
      {status?.lastOutcome && <p className="muted small" role="status">{t.outcomes[status.lastOutcome]}</p>}
      {status?.problem && <p className="note small">{status.problem}</p>}
      {preview && <div className="observed-cli-resume-review">
        <p className="small">{t.description}</p>
        {preview.family === 'claude' && <p className="muted small">{preview.resumeModel ? t.configuredModel : t.claudeDefaults}</p>}
        <dl>
          <dt>{t.runtime}</dt><dd>{t.families[preview.family]} · {preview.version}</dd>
          <dt>{t.nativeSession}</dt><dd><code>{preview.nativeSessionId}</code></dd>
          <dt>{t.executable}</dt><dd><code>{preview.executable}</code></dd>
          <dt>{t.project}</dt><dd><code>{preview.projectPath}</code></dd>
          <dt>{t.profile}</dt><dd><code>{preview.profilePath}</code></dd>
          {preview.model && <><dt>{t.model}</dt><dd><code>{preview.model}</code></dd></>}
          {preview.resumeModel && <><dt>{t.resumeModel}</dt><dd><code>{preview.resumeModel}</code></dd></>}
          {preview.resumeModelSource && <><dt>{t.resumeModelSource}</dt><dd>{t.resumeModelSources[preview.resumeModelSource]}</dd></>}
          <dt>{t.expires}</dt><dd><time dateTime={preview.expiresAt}>{preview.expiresAt}</time></dd>
        </dl>
        <details><summary>{t.arguments}</summary><pre>{preview.arguments.map(argument => JSON.stringify(argument)).join('\n')}</pre></details>
        <p className="muted small">{t.permissions}</p>
        <label className="observed-cli-resume-confirm"><input type="checkbox" checked={value.exclusiveOwnerConfirmed} disabled={disabled} onChange={event => p.onConfirm(event.target.checked)} />{t.exclusiveOwner}</label>
        <button type="button" className="button small primary" disabled={disabled || !value.exclusiveOwnerConfirmed} onClick={p.onPair}>{t.pair}</button>
      </div>}
      {status?.state === 'uncertain' && <div className="observed-cli-resume-inspection">
        <p className="small">{t.uncertain}</p>
        {status.operationId && <>
          <label className="observed-cli-resume-confirm"><input type="checkbox" checked={value.inspected} disabled={disabled} onChange={event => p.onInspected(event.target.checked)} />{t.inspected}</label>
          <button type="button" className="button small" disabled={disabled || !value.inspected} onClick={p.onReconcile}>{t.reconcile}</button>
        </>}
      </div>}
      {value.error && <p className="form-error" role="alert">{value.error === 'CLI_RESUME_RESPONSE_SESSION_MISMATCH' ? t.invalidResponse : value.error}</p>}
    </>}
  </section>;
}
