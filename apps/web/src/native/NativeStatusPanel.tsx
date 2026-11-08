import type { AgentHostApi, HostState, NativeStatus, NativeStatusBlocker } from '@extalia/platform';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useApprovals } from '../approvals/context';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { cancelNativeStatusOperation, type NativeStatusView } from './nativeStatusModel';
import { useNativeStatus } from './useNativeStatus';

export interface NativeStatusProps {
  t: Messages;
  agents: AgentHostApi;
  state: HostState;
  onState(next: HostState): void;
  onOpenSession(sessionId: string, workspaceId: string): void;
  onOpenMissions(sessionId: string, workspaceId: string, missionId?: string): void;
}

function knownSession(state: HostState, item: { sessionId: string; workspaceId: string }) {
  return state.sessions.find(session => session.id === item.sessionId && session.workspaceId === item.workspaceId)
    && state.workspaces.some(workspace => workspace.id === item.workspaceId);
}

/** Pure presentation also used for server-rendered evidence checks. */
export function NativeStatusContent({ t, state, view, requested = new Set<string>(), busy = false, onCancel, onInspect, onChat, onMission, onApprovals }: {
  t: Messages; state: HostState; view: NativeStatusView; requested?: ReadonlySet<string>; busy?: boolean;
  onCancel?(sessionId: string, runId: string): void; onInspect?(blocker: NativeStatusBlocker): void;
  onChat?(sessionId: string, workspaceId: string): void; onMission?(sessionId: string, workspaceId: string, missionId?: string): void; onApprovals?(): void;
}) {
  const c = t.nativeStatus;
  const data = view.data;
  const fresh = view.phase === 'ready';
  const disabled = !fresh || busy;
  const stateLabel = (value: string) => c.states[value] ?? c.unknownState;
  const links = (item: { sessionId: string; workspaceId: string; missionId?: string; kind?: string }) => knownSession(state, item)
    ? <><p className="native-status-scope muted small">{t.inspect.workspace}: {state.workspaces.find(workspace => workspace.id === item.workspaceId)?.name ?? item.workspaceId}</p><div className="native-status-actions">
      <button type="button" className="button small" disabled={disabled} onClick={() => onChat?.(item.sessionId, item.workspaceId)}>{c.openChat}</button>
      {item.missionId && (item.kind !== 'preparation' || data?.missions.some(mission => mission.id === item.missionId && mission.sessionId === item.sessionId)) && <button type="button" className="button small" disabled={disabled} onClick={() => onMission?.(item.sessionId, item.workspaceId, item.missionId)}>{c.openMissions}</button>}
    </div></> : <p className="muted small">{c.unknownSession}</p>;
  const sessionTitle = (sessionId: string) => state.sessions.find(session => session.id === sessionId)?.title;
  const section = (key: keyof NativeStatus['totals'], title: string, empty: string, children: ReactNode) => <section className="native-status-section" aria-label={title}>
    <h3>{title}<span>{c.count(data?.[key].length ?? 0, data?.totals[key] ?? 0)}</span></h3>
    {data?.truncated[key] && <p className="native-status-warning">{c.truncated}</p>}
    {data?.[key].length ? <ul className="native-status-list">{children}</ul> : data?.totals[key] === 0 ? <p className="muted">{empty}</p> : null}
  </section>;
  return <>
    {view.phase !== 'ready' && <div role={view.phase === 'loading' || view.phase === 'refreshing' ? 'status' : 'alert'} className={`native-status-notice ${view.phase}`}>
      <p>{c[view.phase]}</p>{view.error && <p>{c.errors[view.error]}</p>}
    </div>}
    {data && <>
      <p className="native-status-sampled muted">{c.sampled}: <time dateTime={data.sampledAt}>{new Date(data.sampledAt).toLocaleString(c.locale)}</time></p>
      <dl className="native-status-facts">
        <div><dt>{c.backend}</dt><dd>{c.backends[data.backend]}</dd></div>
        <div><dt>{c.providerLoop}</dt><dd>{c.backends[data.providerLoop]}</dd></div>
        <div><dt>{c.daemon}</dt><dd>{c.daemonStates[data.daemon.state]}</dd></div>
      </dl>
      {data.daemon.lastError && <p className="native-status-warning">{c.daemonError}</p>}
      {section('active', c.active, c.activeEmpty, data.active.map(item => {
        const cancelling = item.cancellationRequested || requested.has(item.id);
        return <li key={item.id}>
          <div className="native-status-row"><strong>{c.kinds[item.kind]}</strong><span>{sessionTitle(item.sessionId)}</span></div>
          {item.approvalId && <p className="native-status-warning">{c.waitingApproval}</p>}
          {cancelling && <p className="native-status-warning" role="status">{c.cancelling}</p>}
          {links(item)}
          <div className="native-status-actions">
            <button type="button" className="button small" disabled={disabled || cancelling || !knownSession(state, item)} onClick={() => onCancel?.(item.sessionId, item.id)}><Icon name="stop" />{c.cancel}</button>
            {item.approvalId && <button type="button" className="button small" disabled={disabled || !knownSession(state, item)} onClick={onApprovals}>{c.openApprovals}</button>}
          </div>
        </li>;
      }))}
      {section('blockers', c.blockers, c.blockersEmpty, data.blockers.map(item => <li key={item.id}>
        <div className="native-status-row"><strong>{c.kinds[item.kind]}</strong><span>{sessionTitle(item.sessionId)}</span></div>
        <span className="native-status-evidence">{item.localActive ? c.localActive : c.unresolved}</span>
        <p>{c.reasons[item.reason]}</p>
        {links(item)}
        {item.kind === 'mission-recovery' && item.missionId && <>
          <p className="muted small">{c.recoveryLead}</p>
          {onInspect && <button type="button" className="button small" disabled={disabled || item.localActive || !knownSession(state, item)} onClick={() => onInspect(item)}>{c.inspect}</button>}
        </>}
      </li>))}
      {section('workers', c.workers, c.workersEmpty, data.workers.map(item => <li key={item.id}>
        <div className="native-status-row"><strong>{item.label || (item.kind === 'delegated' ? c.delegated : c.recordedTask)}</strong><span>{stateLabel(item.state)}</span></div>
        <p className="native-status-evidence">{item.evidence === 'local-invocation' ? c.localEvidence : c.recordedEvidence}</p>
        {item.active && item.evidence === 'local-invocation' && <span className="native-status-evidence">{c.localActive}</span>}
        {links(item)}
      </li>))}
      {section('missions', c.missions, c.missionsEmpty, data.missions.map(item => <li key={item.id}>
        <div className="native-status-row"><strong>{item.title}</strong><span>{stateLabel(item.state)} · {c.backends[item.backend]}</span></div>
        {item.tasks.length > 0 && <ul className="native-status-tasks">{item.tasks.map(task => <li key={task.id}>{task.title}<span>{stateLabel(task.state)}</span></li>)}</ul>}
        {links({ ...item, missionId: item.id })}
      </li>))}
      {data.recheck && <p role="status" className="muted">{c.recheckStates[data.recheck.status]} · {c.rechecked(data.recheck.inspected, data.recheck.retired, data.recheck.retained, data.recheck.remaining, data.recheck.skippedActive)}</p>}
    </>}
  </>;
}

export function NativeStatusPanel({ t, agents, state, onState, onOpenSession, onOpenMissions, onClose }: NativeStatusProps & { onClose(): void }) {
  const c = t.nativeStatus;
  const { view, refresh, recheck, currentView } = useNativeStatus(agents);
  const { openInbox } = useApprovals();
  const [requested, setRequested] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<'actionError' | 'actionTimeout'>();
  const [result, setResult] = useState<string>();
  const alive = useRef(true);
  const actionPending = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const leadId = useId();
  const [opener] = useState(() => typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);

  useEffect(() => {
    alive.current = true;
    panel.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    return () => { alive.current = false; if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [opener]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close.current(); return; }
      if (event.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      const first = items[0], last = items.at(-1);
      if (!first || !last) return;
      const active = document.activeElement;
      const inside = active instanceof Node && panel.current.contains(active);
      if (event.shiftKey && (!inside || active === first)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (!inside || active === last)) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const act = async (operation: (current: () => boolean) => Promise<void>) => {
    if (actionPending.current || currentView().phase !== 'ready') return;
    actionPending.current = true; setBusy(true); setResult(undefined); setActionError(undefined);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; if (alive.current) setActionError('actionTimeout'); }, 8_000);
    try { await operation(() => alive.current && !timedOut); }
    catch { if (alive.current && !timedOut) setActionError('actionError'); }
    finally { clearTimeout(timer); actionPending.current = false; if (alive.current) { setBusy(false); refresh(); } }
  };
  const cancel = (sessionId: string, runId: string) => void act(async current => {
    const request = cancelNativeStatusOperation(agents, currentView, sessionId, runId);
    if (request === false) return;
    setRequested(previous => new Set(previous).add(runId));
    try { await request; }
    catch (failure) {
      if (current()) setRequested(previous => new Set([...previous].filter(id => id !== runId)));
      throw failure;
    }
  });
  const inspect = (blocker: NativeStatusBlocker) => {
    const latest = currentView();
    if (latest.phase !== 'ready' || !latest.data?.blockers.some(item => item.id === blocker.id && item.sessionId === blocker.sessionId && item.missionId === blocker.missionId && !item.localActive)) return;
    void act(async current => {
      if (!agents.refreshNativeMissionRecovery || !blocker.missionId) return;
      const next = await agents.refreshNativeMissionRecovery(blocker.sessionId, blocker.missionId);
      if (!current()) return;
      if (!next || !['refreshed', 'quarantined', 'unavailable'].includes(next.status)) throw new Error('Invalid recovery inspection.');
      setResult(c.recoveryResults[next.status] + (next.reason ? ` ${t.missions.run.recoveryReasons[next.reason]}` : ''));
      const nextState = await agents.getState();
      if (current()) onState(nextState);
    });
  };
  const navigate = (action: () => void) => { if (currentView().phase !== 'ready') return; onClose(); action(); };
  return <div className="native-status-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} className="native-status-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={leadId}>
      <header className="native-status-head"><div><h2 id={titleId}>{c.title}</h2><p id={leadId} className="muted">{c.lead}</p></div>
        <button type="button" className="icon-button small" data-autofocus aria-label={c.close} onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="native-status-toolbar"><button type="button" className="button small" disabled={busy} onClick={refresh}><Icon name="refresh" />{c.refresh}</button>
        {typeof agents.refreshNativeStatus === 'function' && <button type="button" className="button small" disabled={busy || view.phase !== 'ready'} onClick={() => { recheck(); }}>{c.recheck}</button>}
      </div>
      {typeof agents.refreshNativeStatus === 'function' && <p className="native-status-recheck-lead muted small">{c.recheckLead}</p>}
      <div className="native-status-body">
        {actionError && <p className="native-status-warning" role="alert">{c[actionError]}</p>}
        {result && <p role="status">{result}</p>}
        <NativeStatusContent t={t} state={state} view={view} requested={requested} busy={busy} onCancel={cancel}
          {...(typeof agents.refreshNativeMissionRecovery === 'function' ? { onInspect: inspect } : {})}
          onChat={(sessionId, workspaceId) => navigate(() => onOpenSession(sessionId, workspaceId))}
          onMission={(sessionId, workspaceId, missionId) => navigate(() => onOpenMissions(sessionId, workspaceId, missionId))}
          onApprovals={() => { if (currentView().phase !== 'ready') return; onClose(); setTimeout(openInbox, 0); }} />
      </div>
    </div>
  </div>;
}
