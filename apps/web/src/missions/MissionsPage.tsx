import type { AgentHostApi, HostMissionRun, HostState } from '@extalia/platform';
import { useId, useMemo, useState } from 'react';
import type { Language, Messages } from '../i18n';
import { useLoad } from '../inspect/useLoad';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';
import { MissionComposer } from './MissionComposer';
import { MissionMonitor, StateChip } from './MissionMonitor';
import { MissionPlanEditor } from './MissionPlanEditor';
import { allowedConnections, eligibleSessions, missionEligibility, missionProgress, type AllowedPairs, type DraftPlan } from './missionModel';

type View =
  | { kind: 'compose' }
  | { kind: 'review'; draft: DraftPlan; pairs: AllowedPairs }
  | { kind: 'monitor'; run: HostMissionRun };

/**
 * v0.0.43 missions: launch, review and monitor read-only native missions of one managed
 * Extalia Native session. The host plans (when it can), validates and runs; this page edits
 * the plan and shows recorded task states. Progress is task states only, never a percentage.
 */
export function MissionsPage({ t, language, agents, state, onState, sessionId, onSelectSession, onOpenChat, onEditGate }: {
  t: Messages;
  language: Language;
  agents: AgentHostApi;
  state: HostState;
  onState(next: HostState): void;
  /** The session selected elsewhere (Chat, Office); used when it is eligible. */
  sessionId?: string | undefined;
  onSelectSession(sessionId: string, workspaceId: string): void;
  onOpenChat(): void;
  /** ADR 0028: open Settings at this workspace's integration test gate. */
  onEditGate?(workspaceId: string): void;
}) {
  const m = t.missions;
  const listHeading = useId();
  const sessions = useMemo(() => eligibleSessions(state), [state]);
  const ineligible = state.sessions.filter(session => missionEligibility(state, session) !== 'eligible').length;
  // Prefer the session chosen elsewhere, otherwise one that is not busy with a turn.
  const [chosen, setChosen] = useState<string | undefined>(() => sessions.some(session => session.id === sessionId) ? sessionId : (sessions.find(session => !session.running) ?? sessions[0])?.id);
  // A session picked in Chat or the Office later on is followed here when eligible.
  const [followed, setFollowed] = useState(sessionId);
  if (followed !== sessionId) {
    setFollowed(sessionId);
    if (sessionId && sessions.some(item => item.id === sessionId)) setChosen(sessionId);
  }
  const session = sessions.find(item => item.id === chosen) ?? sessions[0];
  const workspace = state.workspaces.find(item => item.id === session?.workspaceId);
  const connections = useMemo(() => allowedConnections(state, workspace), [state, workspace]);
  // The chosen view belongs to one session; switching sessions starts from that session's default view.
  const [viewOf, setViewOf] = useState<{ sessionId: string; view: View } | null>(null);
  const view = viewOf && viewOf.sessionId === session?.id ? viewOf.view : null;
  const setView = (next: View) => { if (session) setViewOf({ sessionId: session.id, view: next }); };
  const [version, setVersion] = useState(0);
  const missions = useLoad(session?.id ?? null, version, () => agents.listNativeMissions(session!.id));


  // Live copies from the monitor, so the list shows current task counts without reloading.
  const [latest, setLatest] = useState<Record<string, HostMissionRun>>({});
  const runs = (missions.value ?? []).map(run => latest[run.id] && latest[run.id]!.updatedAt >= run.updatedAt ? latest[run.id]! : run);
  // Without a chosen view: the newest mission when there is one, otherwise the composer.
  const active: View = view ?? (runs[0] ? { kind: 'monitor', run: runs[0] } : { kind: 'compose' });
  const sessionLabel = (item: typeof sessions[number]) => item.title || item.agentName || m.untitled;

  const header = (
    <header className="page-header">
      <h1>{m.title}</h1>
      <p className="lead">{m.lead}</p>
    </header>
  );
  if (!session || !workspace) {
    return (
      <div className="page missions-page">
        {header}
        <section className="card empty-state">
          <Icon name="spark" className="empty-icon" />
          <p>{m.noEligible}</p>
          {ineligible > 0 && <p className="muted small">{m.ineligible(ineligible)}</p>}
          <button type="button" className="button primary" onClick={onOpenChat}><Icon name="chat" />{m.openChat}</button>
        </section>
      </div>
    );
  }

  return (
    <div className="page missions-page">
      {header}
      <div className="missions-layout">
        <aside className="missions-side">
          <section className="card mission-session">
            <Select id="mission-session" label={m.session} value={session.id}
              options={sessions.map(item => ({ value: item.id, label: sessionLabel(item), description: state.workspaces.find(ws => ws.id === item.workspaceId)?.name ?? '', ...(item.running ? { badge: m.busyBadge } : {}) }))}
              onChange={id => { setChosen(id); const next = sessions.find(item => item.id === id); if (next) onSelectSession(next.id, next.workspaceId); }} />
            {session.running && <p className="warning small" role="status"><Icon name="alert" />{m.sessionBusy}</p>}
            {ineligible > 0 && <p className="muted small">{m.ineligible(ineligible)}</p>}
          </section>
          <section className="card mission-list-card" aria-labelledby={listHeading}>
            <header className="mission-list-head">
              <h2 id={listHeading} tabIndex={-1}>{m.list}</h2>
              <button type="button" className="icon-button small" aria-label={m.refresh} title={m.refresh} onClick={() => setVersion(value => value + 1)}><Icon name="refresh" className={missions.loading ? 'spin' : ''} /></button>
            </header>
            <button type="button" className="button small mission-new" aria-pressed={active.kind !== 'monitor'} onClick={() => setView({ kind: 'compose' })}><Icon name="plus" />{m.newMission}</button>
            {missions.error && <p className="form-error" role="alert"><Icon name="alert" />{missions.error}</p>}
            {!runs.length && !missions.loading && !missions.error && <p className="muted small">{m.listEmpty}</p>}
            <ul className="mission-list">
              {runs.map(run => {
                const progress = missionProgress(run);
                return (
                  <li key={run.id}>
                    <button type="button" className="mission-list-item" aria-current={active.kind === 'monitor' && active.run.id === run.id ? 'true' : undefined}
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
          </section>
        </aside>

        <div className="missions-main">
          {active.kind === 'compose' && <MissionComposer key={session.id} t={t} agents={agents} state={state} session={session} workspace={workspace} onState={onState}
            onPlanned={(draft, pairs) => setView({ kind: 'review', draft, pairs })} />}
          {active.kind === 'review' && <MissionPlanEditor t={t} agents={agents} session={session} connections={connections} pairs={active.pairs} initial={active.draft}
            onBack={() => setView({ kind: 'compose' })}
            onLaunched={run => { setView({ kind: 'monitor', run }); setVersion(value => value + 1); }} />}
          {active.kind === 'monitor' && <MissionMonitor key={active.run.id} t={t} language={language} agents={agents} session={session}
            connections={state.connections} initial={active.run} workspace={state.workspaces.find(item => item.id === active.run.workspaceId)} onEditGate={onEditGate}
            onBack={() => { const heading = document.getElementById(listHeading); heading?.scrollIntoView({ block: 'nearest' }); heading?.focus(); }}
            onChanged={run => {
              setLatest(current => ({ ...current, [run.id]: run }));
              // A mission that was not listed yet (just launched) or that just ended refreshes the list.
              const listed = missions.value?.find(item => item.id === run.id);
              if (!listed || (listed.state === 'running' && run.state !== 'running')) setVersion(value => value + 1);
            }} />}
        </div>
      </div>
    </div>
  );
}
