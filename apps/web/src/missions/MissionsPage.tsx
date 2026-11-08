import type { AgentHostApi, HostMissionRun, HostState } from '@extalia/platform';
import { useEffect, useId, useMemo, useState } from 'react';
import type { Language, Messages } from '../i18n';
import { useLoad } from '../inspect/useLoad';
import { Icon } from '../ui/Icon';
import { MissionMonitor, StateChip } from './MissionMonitor';
import { MissionWorkflow } from './MissionWorkflow';
import { MissionSessionSetup } from './MissionSessionSetup';
import { missionEntry } from './missionNavigation';
import { missionEligibility, missionProgress } from './missionModel';
import { missionMethodUnavailable, missionSelection } from './missionSetup';

type View =
  | { kind: 'compose'; revision: number }
  | { kind: 'monitor'; run: HostMissionRun };

/**
 * v0.0.43 missions: launch, review and monitor read-only native missions of one managed
 * Extalia Native session. The host plans (when it can), validates and runs; this page edits
 * the plan and shows recorded task states. Progress is task states only, never a percentage.
 */
export function MissionsPage({ t, language, agents, state, onState, workspaceId, sessionId, missionId, onSelectWorkspace, onSelectSession, onOpenChat, onOpenSettings, onEditGate }: {
  t: Messages;
  language: Language;
  agents: AgentHostApi;
  state: HostState;
  onState(next: HostState): void;
  /** The session selected elsewhere (Chat, Office); used when it is eligible. */
  sessionId?: string | undefined;
  workspaceId?: string | undefined;
  /** Exact recovery/status target; a missing id never falls back to another mission. */
  missionId?: string | undefined;
  onSelectSession(sessionId: string, workspaceId: string): void;
  onSelectWorkspace?(workspaceId: string): void;
  onOpenChat(): void;
  onOpenSettings?(): void;
  /** ADR 0028: open Settings at this workspace's integration test gate. */
  onEditGate?(workspaceId: string): void;
}) {
  const m = t.missions;
  const listHeading = useId();
  const ineligible = state.sessions.filter(session => missionEligibility(state, session) !== 'eligible').length;
  const initialWorkspace = workspaceId ?? state.sessions.find(item => item.id === sessionId)?.workspaceId;
  const [chosen, setChosen] = useState({ workspaceId: initialWorkspace, sessionId });
  const [followed, setFollowed] = useState({ workspaceId, sessionId });
  const [navigated, setNavigated] = useState(false);
  if (followed.workspaceId !== workspaceId || followed.sessionId !== sessionId) {
    setFollowed({ workspaceId, sessionId });
    setChosen({ workspaceId: workspaceId ?? state.sessions.find(item => item.id === sessionId)?.workspaceId, sessionId });
  }
  const focusedMissionId = navigated ? undefined : missionId;
  const { session, sessions, workspace } = useMemo(() => missionSelection(state, { ...chosen, exact: Boolean(focusedMissionId) }), [state, chosen, focusedMissionId]);
  const supported = ['startNativeMission', 'listNativeMissions', 'nativeMissionRun'].every(key => typeof (agents as unknown as Record<string, unknown>)[key] === 'function');
  // The chosen view belongs to one session; switching sessions starts from that session's default view.
  const [viewOf, setViewOf] = useState<{ owner: AgentHostApi; sessionId: string; view: View } | null>(null);
  const view = viewOf?.owner === agents && viewOf.sessionId === session?.id ? viewOf.view : null;
  const setView = (next: View) => { if (session) setViewOf({ owner: agents, sessionId: session.id, view: next }); };
  const [version, setVersion] = useState(0);
  const [workflowRevision, setWorkflowRevision] = useState(0);
  const missions = useLoad(supported ? session?.id ?? null : null, version, () => agents.listNativeMissions(session!.id), agents);
  const currentSessionId = session?.id;
  // Keep history current even while an older completed mission is selected.
  useEffect(() => {
    if (!supported || !currentSessionId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = agents.subscribe(event => {
      if (!active || event.sessionId !== currentSessionId || event.taskId) return;
      if (!['prompt.submitted', 'turn.completed', 'turn.failed'].includes(event.body.type)) return;
      clearTimeout(timer);
      timer = setTimeout(() => { if (active) setVersion(value => value + 1); }, 150);
    });
    return () => { active = false; clearTimeout(timer); unsubscribe(); };
  }, [agents, currentSessionId, supported]);
  // Live copies from the monitor, so the list shows current task counts without reloading.
  const [latestState, setLatest] = useState<{ owner: AgentHostApi; runs: Record<string, HostMissionRun> }>({ owner: agents, runs: {} });
  const latest = latestState.owner === agents ? latestState.runs : {};
  const runs = (missions.value ?? []).filter(run => run.sessionId === session?.id && run.workspaceId === workspace?.id).map(run => latest[run.id] && latest[run.id]!.updatedAt >= run.updatedAt ? latest[run.id]! : run);
  // Without a chosen view: the newest mission when there is one, otherwise the composer.
  const entry = missionEntry(runs, session?.id, focusedMissionId);
  // A late history response must not replace a goal that the user has started typing.
  const active: View | null = view ?? (entry ? { kind: 'monitor', run: entry }
    : focusedMissionId || missions.loading || missions.value === undefined || missions.error ? null : { kind: 'compose', revision: workflowRevision });
  const selectSession = (next: typeof sessions[number], compose = false) => {
    setNavigated(true); setChosen({ workspaceId: next.workspaceId, sessionId: next.id });
    if (compose) setViewOf({ owner: agents, sessionId: next.id, view: { kind: 'compose', revision: workflowRevision + 1 } });
    setWorkflowRevision(value => value + 1);
    onSelectSession(next.id, next.workspaceId);
  };

  const header = (
    <header className="page-header">
      <h1>{m.title}</h1>
      <p className="lead">{m.lead}</p>
      <ol className="mission-guide" aria-label={m.title}>
        {Object.values(m.steps).map((step, index) => <li key={step}><span className="step-index" aria-hidden="true">{index + 1}</span>{step}</li>)}
      </ol>
      <p className="muted small mission-scope">{m.scope}</p>
    </header>
  );
  if (!supported || missionMethodUnavailable(missions.error)) {
    return (
      <div className="page missions-page">
        {header}
        <section className="card empty-state">
          <Icon name="spark" className="empty-icon" />
          <p>{m.hostUnavailable}</p>
          {onOpenSettings && <button type="button" className="button primary" onClick={onOpenSettings}>{m.configure}</button>}
        </section>
      </div>
    );
  }

  return (
    <div className="page missions-page">
      {header}
      <div className="missions-layout">
        <aside className="missions-side">
          <MissionSessionSetup key={workspace?.id ?? ''} t={t} agents={agents} state={state} workspace={workspace} session={session} sessions={sessions}
            onWorkspace={id => {
              setNavigated(true); setChosen({ workspaceId: id, sessionId: undefined }); setViewOf(null);
              onSelectWorkspace?.(id);
            }} onSession={selectSession} onState={onState} onCreated={next => { selectSession(next, true); setVersion(value => value + 1); }}
            onOpenSettings={onOpenSettings} onOpenChat={() => { if (session) onSelectSession(session.id, session.workspaceId); onOpenChat(); }} />
          {session && <section className="card mission-list-card" aria-labelledby={listHeading}>
            <header className="mission-list-head">
              <h2 id={listHeading} tabIndex={-1}>{m.list}</h2>
              <button type="button" className="icon-button small" aria-label={m.refresh} title={m.refresh} onClick={() => setVersion(value => value + 1)}><Icon name="refresh" className={missions.loading ? 'spin' : ''} /></button>
            </header>
            <button type="button" className="button small mission-new" aria-pressed={active?.kind === 'compose'} onClick={() => { setNavigated(true); setWorkflowRevision(value => value + 1); setView({ kind: 'compose', revision: workflowRevision + 1 }); }}><Icon name="plus" />{m.newMission}</button>
            {missions.error && <p className="form-error" role="alert"><Icon name="alert" />{missions.error}</p>}
            {!runs.length && !missions.loading && !missions.error && <p className="muted small">{m.listEmpty}</p>}
            <ul className="mission-list">
              {runs.map(run => {
                const progress = missionProgress(run);
                return (
                  <li key={run.id}>
                    <button type="button" className="mission-list-item" aria-current={active?.kind === 'monitor' && active.run.id === run.id ? 'true' : undefined}
                      aria-label={m.open(run.title)} onClick={() => setView({ kind: 'monitor', run })}>
                      <span className="mission-list-title">{run.title}</span>
                      <span className="mission-list-meta">
                        <StateChip t={t} state={run.state} />
                        <span className="muted small">{m.run.progress(progress.completed, progress.total)}</span>
                      </span>
                      <time className="muted small" dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' })}</time>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>}
          {ineligible > 0 && <p className="muted small">{m.ineligible(ineligible)}</p>}
        </aside>

        <div className="missions-main">
          {!session && <section className="card empty-state"><Icon name="mission" className="empty-icon" /><h2>{m.compose.heading}</h2><p role="status">{focusedMissionId ? m.missingSession : m.noEligible}</p></section>}
          {session && !active && <section className="card"><p role={missions.error ? 'alert' : 'status'}>{missions.error ?? (missions.loading || missions.value === undefined ? t.common.loading : t.nativeStatus.missingMission)}</p></section>}
          {session && workspace && active?.kind === 'compose' && <MissionWorkflow key={`${session.id}:${active.revision}`} t={t} agents={agents} state={state} session={session} workspace={workspace} onState={onState}
            onLaunched={run => { setView({ kind: 'monitor', run }); setVersion(value => value + 1); onSelectSession(session.id, workspace.id); }} />}
          {session && active?.kind === 'monitor' && <MissionMonitor key={`${session.id}:${active.run.id}`} t={t} language={language} agents={agents} session={session}
            connections={state.connections} initial={active.run} workspace={state.workspaces.find(item => item.id === active.run.workspaceId)} onEditGate={onEditGate}
            onBack={() => { const heading = document.getElementById(listHeading); heading?.scrollIntoView({ block: 'nearest' }); heading?.focus(); }}
            onChanged={run => {
              setLatest(current => ({ owner: agents, runs: { ...(current.owner === agents ? current.runs : {}), [run.id]: run } }));
              // A mission that was not listed yet (just launched) or that just ended refreshes the list.
              const listed = missions.value?.find(item => item.id === run.id);
              if ((!listed && !missions.loading && !missions.error) || (listed && listed.state !== run.state)) setVersion(value => value + 1);
            }} />}
        </div>
      </div>
    </div>
  );
}
