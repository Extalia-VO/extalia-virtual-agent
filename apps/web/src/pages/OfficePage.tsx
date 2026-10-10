import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { Component, lazy, Suspense, useCallback, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Language, Messages } from '../i18n';
import { CharacterConversation } from '../office/CharacterConversation';
import { useOfficeAllocations } from '../office/scene/interior/useOfficeAllocations';
import { createCharacterPositionStore } from '../office/scene/movement/positionStore';
import type { FurnishedOfficeView } from '../office/scene/FurnishedFloors';
import { projectOfficePresence, type OfficeAgent } from '../office/presence';
import { useOfficeEvents } from '../office/useOfficeEvents';
import { useCharacterAppearances } from '../office/useCharacterAppearances';
import { OfficeLoading, type OfficeLoadStage } from '../office/OfficeLoading';
import { OfficeToasts, useActivityToasts } from '../office/OfficeToasts';
import { OfficePromptDock } from '../office/OfficePromptDock';
import { ActivityBoard } from '../office/overlay/ActivityBoardDrawer';
import { LeadAgentBar } from '../office/overlay/LeadAgentBar';
import { OfficeFullNotice } from '../office/overlay/OfficeFullNotice';
import { OfficeMetrics } from '../office/overlay/OfficeMetrics';
import { OfficeTools } from '../office/overlay/OfficeTools';
import { roomView } from '../office/overlay/rooms';
import { agentStatusLabel } from '../office/overlay/status';
import { useOfficeOverlay } from '../office/overlay/useOfficeOverlay';
import type { FocusPoint } from '../office/scene/cameraFocus';
import { LIGHT_OVERRIDES, loadLightOverride, saveLightOverride, type LightOverride } from '../office/scene/environment/lightOverride';
import { usePreferencesStore } from '../preferences';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';

const OfficeCanvas = lazy(() => import('../office/scene/OfficeCanvas'));
const MAX_SESSIONS = 24;
class SceneBoundary extends Component<{ children: ReactNode; fallback: ReactNode; onFailure(): void }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch() { this.props.onFailure(); }
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

export function OfficePage({ t, language, agents, state, onState, workspaceId, onWorkspace, onOpenSession, onStartChat, onOpenSettings }: {
  t: Messages; language: Language; agents?: AgentHostApi; state: HostState | null; workspaceId?: string; onState(next: HostState): void;
  onWorkspace(id: string | undefined): void; onOpenSession(session: SessionSummary): void;
  onStartChat(): void; onOpenSettings(): void;
}) {
  const [view, setView] = useState<FurnishedOfficeView>('campus');
  // Office lights: the choice is remembered on this device; the Solar theme lets the scene follow the sun.
  const [lightOverride, setLightOverride] = useState<LightOverride>(() => loadLightOverride());
  const chooseLights = (mode: LightOverride) => { setLightOverride(mode); saveLightOverride(mode); };
  const followSun = usePreferencesStore(preferences => preferences.theme) === 'solar';
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  // Overlay: the camera follows one character only on request; rooms and the activity drawer are page state.
  const [followId, setFollowId] = useState<string | null>(null);
  const [roomFocus, setRoomFocus] = useState<{ roomId: string; point: FocusPoint } | null>(null);
  const [boardOpen, setBoardOpen] = useState(false);
  const boardId = useId();
  const [attempt, setAttempt] = useState(0);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [loadStage, setLoadStage] = useState<OfficeLoadStage>('engine');
  const [renderFailed, setRenderFailed] = useState(false);
  const markScene = useCallback(() => setLoadStage('scene'), []);
  const markReady = useCallback(() => setLoadStage('ready'), []);
  const markFailed = useCallback(() => setRenderFailed(true), []);
  const dark = useSyncExternalStore(subscribeTheme, getDark, getFalse);
  const reducedMotion = useSyncExternalStore(subscribeMotion, getReduced, getFalse);
  const sessions = useMemo(() => (state?.sessions ?? []).filter(session => !workspaceId || session.workspaceId === workspaceId)
    .sort((a, b) => Number(b.running) - Number(a.running) || b.lastActiveAt.localeCompare(a.lastActiveAt)), [state?.sessions, workspaceId]);
  const visible = useMemo(() => sessions.slice(0, MAX_SESSIONS), [sessions]);
  const selectedSessionId = selectedId ? visible.find(session => selectedId.startsWith(`${session.id}:`))?.id : undefined;
  const historyIds = visible.filter(session => session.control === 'managed' && (session.running || session.id === selectedSessionId)).map(session => session.id);
  const { events, error } = useOfficeEvents(agents, historyIds);
  const presences = useMemo(() => projectOfficePresence(visible, events), [visible, events]);
  const activity = useActivityToasts(events, presences);
  const selected = presences.find(agent => agent.id === selectedId);
  // Characters keep their desks when others arrive; live positions follow them while they walk or ride.
  const allocations = useOfficeAllocations(presences);
  const [positions] = useState(createCharacterPositionStore);
  const floorOf = (id: string) => positions.floor(id) ?? allocations.find(item => item.agentId === id)?.floor;
  const looks = useCharacterAppearances(agents);
  const selectAgent = (id: string) => { setPanelCollapsed(false); setSelectedId(id); const floor = floorOf(id); if (floor) setView(floor); };
  const overlay = useOfficeOverlay({ t, presences, allocations, events, recent: activity.recent, state });
  // Choosing a character anywhere in the overlay selects it and frames it once; Follow is a separate, opt-in camera mode.
  const locateAgent = (id: string) => { selectAgent(id); setFocusRequest(value => value + 1); };
  const focusRoom = (roomId: string) => {
    const room = overlay.rooms.find(item => item.id === roomId);
    if (!room) return;
    setFollowId(null); setView(roomView(room)); setRoomFocus({ roomId, point: { point: room.point, size: room.size } });
  };
  const following = Boolean(selectedId && followId === selectedId);
  const toggleFollow = () => {
    if (!selectedId) return;
    if (following) { setFollowId(null); return; }
    setFollowId(selectedId); setFocusRequest(value => value + 1);
  };
  const selectedSession = visible.find(session => session.id === selected?.sessionId);
  const open = (agent: OfficeAgent) => { const session = visible.find(item => item.id === agent.sessionId); if (session) onOpenSession(session); };
  const failed = <div className="office-scene-message" role="alert"><Icon name="monitor" /><p>{t.office.unavailable}</p>
    <button type="button" onClick={() => { setRenderFailed(false); setLoadStage('engine'); setAttempt(value => value + 1); }}>{t.common.retry}</button><button type="button" onClick={onStartChat}>{t.office.openChat}</button></div>;

  const showDock = Boolean(agents && state && !selected && !visible.some(session => session.running));
  const showLeadBar = !showDock && overlay.model.leads.shown.length > 0;
  return <div className="office-page">
    <div className="office-toolbar">
      <div className="office-view-switch" aria-label={t.office.view} role="group">
        <button type="button" aria-pressed={view === 'campus'} onClick={() => setView('campus')}>{t.office.campus}</button>
        {([1, 2, 3] as const).map(floor => <button key={floor} type="button" data-floor={floor} aria-label={t.office[`f${floor}`]} aria-pressed={view === floor} onClick={() => setView(floor)}>F{floor}</button>)}
        <button type="button" aria-pressed={view === 'stack'} onClick={() => setView('stack')}>{t.office.stack}</button>
      </div>
      <div className="office-view-switch office-light-switch" role="group" aria-label={t.office.lights} title={t.office.lightHints[lightOverride]}>
        <Icon name="bulb" />
        {LIGHT_OVERRIDES.map(mode => <button key={mode} type="button" aria-pressed={lightOverride === mode} title={t.office.lightHints[mode]} onClick={() => chooseLights(mode)}>{t.office.lightModes[mode]}</button>)}
      </div>
      <Select aria-label={t.office.project} value={workspaceId ?? 'all'} options={[{ value: 'all', label: t.office.allProjects }, ...(state?.workspaces ?? []).map(workspace => ({ value: workspace.id, label: workspace.name }))]}
        onChange={id => onWorkspace(id === 'all' ? undefined : id)} />
      <OfficeTools t={t} source={overlay.source} rooms={overlay.rooms} currentRoom={roomFocus?.roomId} boardOpen={boardOpen} boardId={boardId} boardCount={overlay.model.board.length}
        onAgent={locateAgent} onRoom={focusRoom} onToggleBoard={() => setBoardOpen(value => !value)} />
      <span className="office-live" role="status"><span className={agents ? 'pulse' : ''} aria-hidden="true" />{agents ? t.office.connected : t.office.disconnected}</span>
      <button type="button" className="button primary" onClick={onStartChat}><Icon name="chat" />{t.office.openChat}</button>
    </div>
    <div className={`office-stage ${showDock ? 'has-dock' : ''} ${showLeadBar ? 'has-lead-bar' : ''} ${boardOpen ? 'has-board' : ''} ${selected ? 'has-conversation' : ''}`} aria-label={t.office.title}>
      <SceneBoundary key={attempt} fallback={failed} onFailure={markFailed}>
        <Suspense fallback={null}>
          <OfficeCanvas agents={presences} selectedId={selected?.id ?? null} onSelect={selectAgent} view={view} language={language} dark={dark} reducedMotion={reducedMotion} appearances={looks.appearances} activities={activity.recent} onScene={markScene} onReady={markReady} focusRequest={focusRequest} follow={following} onFollowEnd={() => setFollowId(null)} focusPoint={roomFocus?.point} allocations={allocations} positions={positions} lightOverride={lightOverride} followSun={followSun} />
        </Suspense>
      </SceneBoundary>
      {!renderFailed && <OfficeLoading key={attempt} t={t} stage={loadStage} reducedMotion={reducedMotion} />}
      <div className="office-hint">{t.office.controls}</div>
      {boardOpen && <ActivityBoard t={t} id={boardId} items={overlay.model.board} names={overlay.names} now={overlay.now} onSelect={locateAgent} onClose={() => setBoardOpen(false)} />}
      {showLeadBar && <LeadAgentBar t={t} leads={overlay.model.leads.shown} more={overlay.model.leads.more} appearances={looks.appearances} projects={overlay.projects}
        latest={overlay.model.latest} selectedId={selected?.id ?? null} onSelect={locateAgent} />}
      <aside className={`office-panel ${selected ? 'office-panel-conversation' : ''} ${panelCollapsed ? 'office-panel-collapsed' : ''}`} aria-label={t.office.agents}>
        <div className="office-panel-head"><strong>{t.office.agents}</strong><span className="badge">{presences.length}</span><button type="button" className="icon-button" aria-label={panelCollapsed ? t.officeUx.expand : t.officeUx.collapse} aria-expanded={!panelCollapsed} onClick={() => setPanelCollapsed(value => !value)}><Icon name={panelCollapsed ? 'plus' : 'panel'} /></button></div>
        <div className="office-panel-body" aria-hidden={panelCollapsed} inert={panelCollapsed}><div>
        <OfficeMetrics t={t} kpis={overlay.model.kpis} />
        <OfficeFullNotice t={t} waiting={overlay.model.waitingForDesk} onSelect={selectAgent} />
        {error && <p className="form-error" role="alert">{t.office.activityError} {error}</p>}
        {!presences.length ? <div className="office-empty"><p>{t.office.empty}</p><button type="button" className="button" onClick={state?.workspaces.length ? onStartChat : onOpenSettings}>{state?.workspaces.length ? t.office.startSession : t.office.configure}</button></div> :
          <ul className="office-agent-list">{presences.map(agent => <li key={agent.id}>
            <button type="button" className="office-agent" aria-pressed={selected?.id === agent.id} onClick={() => selectAgent(agent.id)}>
              <span className={`office-agent-dot status-${agent.status}`} aria-hidden="true" /><span><strong>{agent.displayName}</strong><small>{agentStatusLabel(t, agent)}{agent.activity && agent.running ? ` · ${t.chat.activity[agent.activity]}` : ''}</small></span>
              {agent.parentId && <Icon name="users" />}
            </button>
          </li>)}</ul>}
        {sessions.length > MAX_SESSIONS && <p className="note">{t.office.limited(MAX_SESSIONS, sessions.length)}</p>}
        {selected && <div className="office-selected"><div className="office-panel-head"><strong>{t.office.conversation}</strong><button type="button" className="icon-button" aria-label={t.office.closeConversation} onClick={() => setSelectedId(null)}><Icon name="close" /></button></div>
          {agents && state && selectedSession && <CharacterConversation key={selected.id} t={t} language={language} agents={agents} state={state} session={selectedSession} agent={selected} onState={onState}
            onLocate={() => { const floor = floorOf(selected.id); if (floor) setView(floor); setFocusRequest(value => value + 1); }} following={following} onToggleFollow={toggleFollow} onSelectCharacter={selectAgent}
            appearance={{ saved: looks.saved[selected.id], onPreview: next => looks.preview(selected.id, next), onSave: next => looks.save(selected.id, next) }} />}
          <button type="button" className="button" onClick={() => open(selected)}><Icon name={selected.control === 'observed' ? 'book' : 'chat'} />{selected.control === 'observed' ? t.office.openObserved : t.office.openSession}</button>
        </div>}
        </div></div>
      </aside>
      {showDock && agents && state && <OfficePromptDock t={t} agents={agents} state={state} workspaceId={workspaceId} onState={onState}
        onStarted={sessionId => { setPanelCollapsed(false); setSelectedId(`${sessionId}:primary`); setFollowId(`${sessionId}:primary`); setView(1); }} onOpenSettings={onOpenSettings} />}
      <OfficeToasts t={t} toasts={activity.toasts} presences={presences} onSelect={selectAgent} onDismiss={activity.dismiss} />
    </div>
  </div>;
}
