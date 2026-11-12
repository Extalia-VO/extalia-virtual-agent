import type { AgentHostApi, HostState, ObservedWorkspaceLinkStatus, SessionSummary } from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import './observedWorkspaceLink.css';

type LinkMessages = Messages['observedWorkspaceLink'];
export interface ObservedWorkspaceLinkViewState {
  status?: ObservedWorkspaceLinkStatus;
  selected: string | null;
  edited: boolean;
  busy?: 'load' | 'apply';
  error?: string;
  sourceChanged?: boolean;
  needsRefresh?: boolean;
  applied?: boolean;
}

export function observedWorkspaceLinkSourceKey(session: SessionSummary, state: HostState): string {
  return JSON.stringify([session.id, session.control, session.observation?.sourceId, session.observation?.nativeSessionId,
    session.observation?.projectPath, state.workspaces.map(item => [item.id, item.name, item.projectLocation, item.additionalProjectLocations])]);
}
export function observedWorkspaceLinkSupported(agents: AgentHostApi, session: SessionSummary): boolean {
  return session.control === 'observed' && Boolean(agents.observedWorkspaceLink && agents.setObservedWorkspaceLink);
}
export function canApplyObservedWorkspaceLink(value: ObservedWorkspaceLinkViewState): boolean {
  const status = value.status;
  if (!status || value.busy || value.needsRefresh || value.applied) return false;
  if (value.selected === null && status.lockedWorkspaceId && status.automaticWorkspaceId !== status.lockedWorkspaceId) return false;
  if (value.selected !== null && (!status.candidates.some(item => item.workspaceId === value.selected)
    || (status.lockedWorkspaceId && status.lockedWorkspaceId !== value.selected))) return false;
  return value.selected !== (status.linkedWorkspaceId ?? null) || status.mode === 'invalid';
}

/** UI request lifetime and draft ownership; physical-root validation and persistence belong to the host. */
export class ObservedWorkspaceLinkController {
  value: ObservedWorkspaceLinkViewState = { selected: null, edited: false };
  private agents?: AgentHostApi;
  private sessionId = '';
  private source = '';
  private generation = 0;
  private applying = false;
  private readonly listeners = new Set<() => void>();
  constructor(private applied: (state: HostState) => void) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = (): ObservedWorkspaceLinkViewState => this.value;
  setApplied(callback: (state: HostState) => void): void { this.applied = callback; }
  matches(agents: AgentHostApi, session: SessionSummary, state: HostState): boolean { return this.agents === agents && this.source === observedWorkspaceLinkSourceKey(session, state); }
  bind(agents: AgentHostApi, session: SessionSummary, state: HostState): void {
    const source = observedWorkspaceLinkSourceKey(session, state);
    if (this.agents === agents && this.source === source) return;
    const sameDraft = this.agents === agents && this.sessionId === session.id;
    const previous = this.value;
    this.generation++; this.agents = agents; this.sessionId = session.id; this.source = source;
    this.value = { selected: sameDraft ? previous.selected : null, edited: sameDraft && previous.edited,
      sourceChanged: sameDraft, needsRefresh: sameDraft, ...(this.applying ? { busy: 'apply' } : {}) };
    this.notify();
  }
  invalidate(): void { this.generation++; this.agents = undefined; this.source = ''; }
  private notify(): void { for (const listener of this.listeners) listener(); }
  private publish(next: Partial<ObservedWorkspaceLinkViewState>): void { this.value = { ...this.value, ...next }; this.notify(); }
  select(workspaceId: string | null): void {
    if (!this.agents || this.applying) return;
    this.publish({ selected: workspaceId, edited: true, applied: false });
  }
  async load(): Promise<void> {
    const host = this.agents, generation = this.generation, sessionId = this.sessionId;
    if (!host?.observedWorkspaceLink || this.value.busy || this.applying) return;
    this.publish({ busy: 'load', error: undefined });
    try {
      const status = await host.observedWorkspaceLink(sessionId);
      if (generation !== this.generation) return;
      if (status.sessionId !== sessionId) throw new Error('The association response belongs to another session.');
      this.publish({ status, selected: this.value.edited ? this.value.selected : status.linkedWorkspaceId ?? null,
        needsRefresh: false, sourceChanged: false, applied: false });
    } catch (failure) { if (generation === this.generation) this.publish({ error: errorMessage(failure), needsRefresh: true }); }
    finally { if (generation === this.generation) this.publish({ busy: undefined }); }
  }
  async apply(): Promise<void> {
    const host = this.agents, status = this.value.status, generation = this.generation;
    if (!host?.setObservedWorkspaceLink || !status || this.applying || !canApplyObservedWorkspaceLink(this.value)) return;
    this.applying = true;
    this.publish({ busy: 'apply', error: undefined });
    let next: HostState | undefined;
    try {
      next = await host.setObservedWorkspaceLink(this.sessionId, { revision: status.revision, workspaceId: this.value.selected });
      if (generation !== this.generation) return;
      this.publish({ applied: true, edited: false });
    } catch (failure) {
      // A stale review or lost acknowledgement must be inspected with Refresh, never silently retried.
      if (generation === this.generation) this.publish({ error: errorMessage(failure), needsRefresh: true });
    } finally {
      this.applying = false;
      if (generation === this.generation) this.publish({ busy: undefined });
      else if (this.agents) this.publish({ busy: undefined, needsRefresh: true });
    }
    if (next && generation === this.generation) this.applied(next);
  }
}

export function ObservedWorkspaceLinkButton({ agents, session, state, t, onState }: {
  agents: AgentHostApi; session: SessionSummary; state: HostState; t: Messages; onState(state: HostState): void;
}) {
  const [openSession, setOpenSession] = useState<string>();
  if (!observedWorkspaceLinkSupported(agents, session)) return null;
  return <><button type="button" className="icon-button small observed-workspace-link-button" aria-label={t.observedWorkspaceLink.title}
    title={t.observedWorkspaceLink.title} aria-haspopup="dialog" onClick={() => setOpenSession(session.id)}><Icon name="folder" /></button>
    {openSession === session.id && <ObservedWorkspaceLinkDialog key={session.id} agents={agents} session={session} state={state} t={t.observedWorkspaceLink}
      onClose={() => setOpenSession(undefined)} onState={next => { setOpenSession(undefined); onState(next); }} />}</>;
}

export function ObservedWorkspaceLinkDialog({ agents, session, state, t, onClose, onState }: {
  agents: AgentHostApi; session: SessionSummary; state: HostState; t: LinkMessages; onClose(): void; onState(state: HostState): void;
}) {
  const [controller] = useState(() => new ObservedWorkspaceLinkController(onState));
  const value = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const current = controller.matches(agents, session, state);
  const source = observedWorkspaceLinkSourceKey(session, state);
  useLayoutEffect(() => { controller.setApplied(onState); }, [controller, onState]);
  useLayoutEffect(() => { controller.bind(agents, session, state); void controller.load(); }, [controller, agents, source]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => controller.invalidate(), [controller]);
  return <ObservedWorkspaceLinkDialogView t={t} value={current ? value : { selected: value.selected, edited: value.edited, busy: 'load' }}
    onSelect={id => controller.select(id)} onRefresh={() => { void controller.load(); }} onApply={() => { void controller.apply(); }} onClose={onClose} />;
}

export function ObservedWorkspaceLinkDialogView({ t, value, onSelect, onRefresh, onApply, onClose }: {
  t: LinkMessages; value: ObservedWorkspaceLinkViewState; onSelect(id: string | null): void; onRefresh(): void; onApply(): void; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), id = useId();
  const applying = value.busy === 'apply', busy = Boolean(value.busy), status = value.status;
  const selectionMissing = value.selected !== null && !status?.candidates.some(item => item.workspaceId === value.selected);
  useEffect(() => {
    const element = dialog.current, focus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (element && !element.open) element.showModal();
    return () => { element?.close(); if (focus?.isConnected) focus.focus(); };
  }, []);
  return <dialog ref={dialog} className="observed-workspace-link-dialog" aria-labelledby={`${id}-title`}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!applying) onClose(); }}>
    <header><h2 id={`${id}-title`}>{t.title}</h2><button type="button" className="icon-button" aria-label={t.close} disabled={applying} onClick={onClose}><Icon name="close" /></button></header>
    <p>{t.description}</p><p className="muted small">{t.scopeHint}</p>
    {value.busy === 'load' && <p role="status">{t.loading}</p>}
    {status && <>
      <dl><dt>{t.project}</dt><dd>{status.projectPath ? <code>{status.projectPath}</code> : t.unknownProject}</dd>
        <dt>{t.state}</dt><dd>{t.modes[status.mode]}</dd>
        <dt>{t.currentWorkspace}</dt><dd>{status.workspaceId ? status.candidates.find(item => item.workspaceId === status.workspaceId)?.name ?? <code>{status.workspaceId}</code> : t.modes.unbound}</dd></dl>
      {status.reason && <p className="note small">{t.reasons[status.reason]}</p>}
      {status.lockedWorkspaceId && <p className="note small">{t.continuityHint} <code>{status.lockedWorkspaceId}</code></p>}
      {status.projectPath && !status.candidates.length && <p className="note small">{t.registerHint}</p>}
      <fieldset disabled={applying}><legend>{t.destination}</legend>
        <label className="observed-workspace-choice"><input type="radio" name={`${id}-workspace`} checked={value.selected === null}
          disabled={Boolean(status.lockedWorkspaceId && status.automaticWorkspaceId !== status.lockedWorkspaceId)} onChange={() => onSelect(null)} />
          <span><strong>{t.automatic}</strong><span className="muted small">{t.automaticHint}</span></span></label>
        {status.candidates.map((candidate, index) => <label className="observed-workspace-choice" key={`${candidate.workspaceId}:${candidate.root}`}>
          <input type="radio" name={`${id}-workspace`} value={candidate.workspaceId} checked={value.selected === candidate.workspaceId}
            disabled={Boolean(status.lockedWorkspaceId && status.lockedWorkspaceId !== candidate.workspaceId)} onChange={() => onSelect(candidate.workspaceId)} aria-describedby={`${id}-root-${index}`} />
          <span><strong>{candidate.name}</strong><code id={`${id}-root-${index}`}>{candidate.root}</code></span></label>)}
      </fieldset>
    </>}
    {selectionMissing && value.edited && <p className="note small">{t.selectionMissing} <code>{value.selected}</code></p>}
    {value.sourceChanged && <p className="note small">{t.sourceChanged}</p>}
    {value.needsRefresh && <p className="note small">{t.refreshHint}</p>}
    {value.error && <p className="form-error" role="alert">{value.error}</p>}
    {value.applied && <p role="status">{t.applied}</p>}
    <footer className="row-actions"><button type="button" className="button small" disabled={busy} onClick={onRefresh}>{t.refresh}</button>
      <button type="button" className="button" disabled={applying} onClick={onClose}>{t.cancel}</button>
      <button type="button" className="button primary" disabled={!canApplyObservedWorkspaceLink(value)} onClick={onApply}>{applying ? t.applying : t.apply}</button></footer>
  </dialog>;
}
