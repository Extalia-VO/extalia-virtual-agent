import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { Component, lazy, Suspense, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Language, Messages } from '../i18n';
import { CharacterConversation } from '../office/CharacterConversation';
import { allocateOfficeAgents } from '../office/scene/interior/seating';
import type { FurnishedOfficeView } from '../office/scene/FurnishedFloors';
import { projectOfficePresence, type OfficeAgent } from '../office/presence';
import { useOfficeEvents } from '../office/useOfficeEvents';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';

const OfficeCanvas = lazy(() => import('../office/scene/OfficeCanvas'));
const MAX_SESSIONS = 24;
class SceneBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
const subscribeTheme = (notify: () => void) => {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
};
const subscribeMotion = (notify: () => void) => {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};
const getDark = () => document.documentElement.dataset.theme === 'dark';
const getReduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const getFalse = () => false;
function statusLabel(t: Messages, agent: OfficeAgent): string {
  if (agent.status === 'observing') return t.office.observing;
  if (agent.status === 'paused') return t.observer.paused;
  if (agent.status === 'unavailable') return t.observer.unavailable;
  return t.chat.status[agent.status];
}

export function OfficePage({ t, language, agents, state, onState, workspaceId, onWorkspace, onOpenSession, onStartChat, onOpenSettings }: {
  t: Messages; language: Language; agents?: AgentHostApi; state: HostState | null; workspaceId?: string; onState(next: HostState): void;
  onWorkspace(id: string | undefined): void; onOpenSession(session: SessionSummary): void;
  onStartChat(): void; onOpenSettings(): void;
}) {
  const [view, setView] = useState<FurnishedOfficeView>('campus');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const dark = useSyncExternalStore(subscribeTheme, getDark, getFalse);
  const reducedMotion = useSyncExternalStore(subscribeMotion, getReduced, getFalse);
  const sessions = useMemo(() => (state?.sessions ?? []).filter(session => !workspaceId || session.workspaceId === workspaceId)
    .sort((a, b) => Number(b.running) - Number(a.running) || b.lastActiveAt.localeCompare(a.lastActiveAt)), [state?.sessions, workspaceId]);
  const visible = useMemo(() => sessions.slice(0, MAX_SESSIONS), [sessions]);
  const selectedSessionId = selectedId ? visible.find(session => selectedId.startsWith(`${session.id}:`))?.id : undefined;
  const historyIds = visible.filter(session => session.control === 'managed' && (session.running || session.id === selectedSessionId)).map(session => session.id);
  const { events, error } = useOfficeEvents(agents, historyIds);
  const presences = useMemo(() => projectOfficePresence(visible, events), [visible, events]);
  const selected = presences.find(agent => agent.id === selectedId);
  const allocations = useMemo(() => allocateOfficeAgents(presences), [presences]);
  const selectAgent = (id: string) => { setSelectedId(id); const seat = allocations.find(item => item.agentId === id); if (seat) setView(seat.floor); };
  const selectedSession = visible.find(session => session.id === selected?.sessionId);
  const open = (agent: OfficeAgent) => { const session = visible.find(item => item.id === agent.sessionId); if (session) onOpenSession(session); };
  const failed = <div className="office-scene-message" role="alert"><Icon name="monitor" /><p>{t.office.unavailable}</p>
    <button type="button" onClick={() => setAttempt(value => value + 1)}>{t.common.retry}</button><button type="button" onClick={onStartChat}>{t.office.openChat}</button></div>;

  return <div className="office-page">
    <div className="office-toolbar">
      <div className="office-view-switch" aria-label={t.office.view} role="group">
        <button type="button" aria-pressed={view === 'campus'} onClick={() => setView('campus')}>{t.office.campus}</button>
        {([1, 2, 3] as const).map(floor => <button key={floor} type="button" data-floor={floor} aria-label={t.office[`f${floor}`]} aria-pressed={view === floor} onClick={() => setView(floor)}>F{floor}</button>)}
        <button type="button" aria-pressed={view === 'stack'} onClick={() => setView('stack')}>{t.office.stack}</button>
      </div>
      <Select aria-label={t.office.project} value={workspaceId ?? 'all'} options={[{ value: 'all', label: t.office.allProjects }, ...(state?.workspaces ?? []).map(workspace => ({ value: workspace.id, label: workspace.name }))]}
        onChange={id => onWorkspace(id === 'all' ? undefined : id)} />
      <span className="office-live" role="status"><span className={agents ? 'pulse' : ''} aria-hidden="true" />{agents ? t.office.connected : t.office.disconnected}</span>
      <button type="button" className="button primary" onClick={onStartChat}><Icon name="chat" />{t.office.openChat}</button>
    </div>
    <div className="office-stage" aria-label={t.office.title}>
      <SceneBoundary key={attempt} fallback={failed}>
        <Suspense fallback={<div className="office-scene-message" role="status">{t.office.loading}</div>}>
          <OfficeCanvas agents={presences} selectedId={selected?.id ?? null} onSelect={selectAgent} view={view} language={language} dark={dark} reducedMotion={reducedMotion} />
        </Suspense>
      </SceneBoundary>
      <div className="office-hint">{t.office.controls}</div>
      <aside className={`office-panel ${selected ? 'office-panel-conversation' : ''}`} aria-label={t.office.agents}>
        <div className="office-panel-head"><strong>{t.office.agents}</strong><span className="badge">{presences.length}</span></div>
        <div className="office-metrics"><span>{t.office.running} <strong>{visible.filter(session => session.running).length}</strong></span><span>{t.office.waiting} <strong>{visible.filter(session => session.pendingApprovalId).length}</strong></span><span>{t.office.observed} <strong>{visible.filter(session => session.control === 'observed').length}</strong></span></div>
        {error && <p className="form-error" role="alert">{t.office.activityError} {error}</p>}
        {!presences.length ? <div className="office-empty"><p>{t.office.empty}</p><button type="button" className="button" onClick={state?.workspaces.length ? onStartChat : onOpenSettings}>{state?.workspaces.length ? t.office.startSession : t.office.configure}</button></div> :
          <ul className="office-agent-list">{presences.map(agent => <li key={agent.id}>
            <button type="button" className="office-agent" aria-pressed={selected?.id === agent.id} onClick={() => selectAgent(agent.id)}>
              <span className={`office-agent-dot status-${agent.status}`} aria-hidden="true" /><span><strong>{agent.displayName}</strong><small>{statusLabel(t, agent)}{agent.activity && agent.running ? ` · ${t.chat.activity[agent.activity]}` : ''}</small></span>
              {agent.parentId && <Icon name="users" />}
            </button>
          </li>)}</ul>}
        {sessions.length > MAX_SESSIONS && <p className="note">{t.office.limited(MAX_SESSIONS, sessions.length)}</p>}
        {selected && <div className="office-selected"><div className="office-panel-head"><strong>{t.office.conversation}</strong><button type="button" className="icon-button" aria-label={t.office.closeConversation} onClick={() => setSelectedId(null)}><Icon name="close" /></button></div>
          {agents && state && selectedSession && <CharacterConversation key={selected.id} t={t} language={language} agents={agents} state={state} session={selectedSession} agent={selected} onState={onState} />}
          <button type="button" className="button" onClick={() => open(selected)}><Icon name={selected.control === 'observed' ? 'book' : 'chat'} />{selected.control === 'observed' ? t.office.openObserved : t.office.openSession}</button>
        </div>}
      </aside>
    </div>
  </div>;
}
