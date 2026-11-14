import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { Component, Suspense, useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import type { Language, Messages } from '../i18n';
import { AgentSessionDialog } from '../office/AgentSessionDialog';
import type { OfficeInputFocus, OfficeAttentionOutcome } from '../office/officeInputFocus';
import { officeAttentionOverlayOpen, useOfficeForeground } from '../office/useOfficeForeground';
import { officeAttentionRequests } from '../office/OfficeAutoAttention';
import { useOfficeAllocations } from '../office/scene/interior/useOfficeAllocations';
import { createCharacterPositionStore } from '../office/scene/movement/positionStore';
import { isAdmitted, projectOfficePresence, type OfficeAgent } from '../office/presence';
import { useOfficeMissions } from '../office/useOfficeMissions';
import { officeHistoryIds } from '../office/historyIds';
import { useNow, useStableValue } from '../office/useNow';
import { useOfficeEvents } from '../office/useOfficeEvents';
import { useCharacterAppearances } from '../office/useCharacterAppearances';
import { useLookRoster } from '../office/useLookRoster';
import { useSessionTeamSnapshot } from '../office/useSessionTeams';
import { useNativeStandby } from '../office/useNativeStandby';
import { OfficeLoading, type OfficeLoadStage } from '../office/OfficeLoading';
import { OfficeFollowStatus } from '../office/OfficeFollowStatus';
import { useRecentActivity } from '../office/useRecentActivity';
import { OfficePromptDock } from '../office/OfficePromptDock';
import { promptTargetFor, sessionModel } from '../office/promptTarget';
import { ActivityBoard } from '../office/overlay/ActivityBoardDrawer';
import { LeadAgentBar } from '../office/overlay/LeadAgentBar';
import { OfficeFullNotice } from '../office/overlay/OfficeFullNotice';
import { OfficeMetrics } from '../office/overlay/OfficeMetrics';
import { OfficeTools } from '../office/overlay/OfficeTools';
import { CharacterPopover } from '../office/overlay/CharacterPopover';
import { ContextUsageLine } from '../office/overlay/ContextUsage';
import { AgentPortrait, PortraitPositionContext } from '../office/overlay/AgentPortrait';
import { boardAbsolute, boardActivityAt, boardAgo, boardAgoShort, boardBranchActive, boardOrder, boardTreeActive, boardTreeTone, isOfflineBoardAgent, splitBoard, TREE_ELBOW_PATHS, withTeamMembers, type BoardRow } from '../office/overlay/boardTree';
import { useBoardFlip, useSettledBoardOrder } from '../office/overlay/boardMotion';
import { inOffice } from '../office/overlay/kpis';
import { facilityCard, useFacilityStaff } from '../office/scene/movement/facilityStatus';
import { facilityAppearance } from '../office/scene/movement/facilityNpcs';
import { characterCallouts } from '../office/scene/callouts';
import { popoverState, popoverSummary } from '../office/overlay/popoverModel';
import { initialOfficeSelection, officeSelectionReducer, type SessionDialogTab } from '../office/overlay/officeSelection';
import { OFFICE_RESOURCES } from '../office/scene/interior/resourceRegistry';
import { roomView } from '../office/overlay/rooms';
import { agentStatusLabel } from '../office/overlay/status';
import { useOfficeOverlay } from '../office/overlay/useOfficeOverlay';
import type { FocusPoint } from '../office/scene/cameraFocus';
import { useOfficeControls } from '../office/officeControls';
import { usePreferencesStore } from '../preferences';
import { Icon } from '../ui/Icon';
import { OriginChip } from '../ui/OriginMark';
import { Select } from '../ui/Select';
import { useApprovals } from '../approvals/context';
import { AutoCameraCountdown } from '../office/AutoCameraCountdown';
import type { CameraTourCountdown } from '../office/cameraCountdown';
import { useCameraDirector } from '../office/useCameraDirector';
import { useObservedInputs } from '../observe/ObservedInputProvider';
import { cameraAttentionIds } from '../office/cameraAttention';
import { officeCharacterContext } from '../office/characterContext';
import { createSceneAttempt } from '../office/sceneAttempt';
import type { OfficeContextState } from '../office/contextRecovery';

const loadOfficeCanvas = () => import('../office/scene/OfficeCanvas');
const MAX_SESSIONS = 24;
/** v0.0.43: whether the board's offline group is open, remembered per device (a convenience: storage may be unavailable). */
const EARLIER_OPEN_KEY = 'extalia.office.offlineOpen';
const readEarlierOpen = () => { try { return window.localStorage.getItem(EARLIER_OPEN_KEY) === '1'; } catch { return false; } };
const writeEarlierOpen = (open: boolean) => { try { window.localStorage.setItem(EARLIER_OPEN_KEY, open ? '1' : '0'); } catch { /* not remembered */ } };
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

export function OfficePage({ t, language, agents, hostDisconnected = false, state, onState, workspaceId, onWorkspace, onOpenSession, onOpenMissions, onStartChat, onOpenSettings, onOpenAgentSettings, inputFocus, onInputFocused, onLearningTarget }: {
  t: Messages; language: Language; agents?: AgentHostApi; hostDisconnected?: boolean; state: HostState | null; workspaceId?: string; onState(next: HostState): void;
  onWorkspace(id: string | undefined, sessionId?: string): void; onOpenSession(session: SessionSummary): void;
  /** v0.0.43 missions: open the Missions page, optionally for one session. */
  onOpenMissions?: ((session?: SessionSummary) => void) | undefined;
  onStartChat(): void; onOpenSettings(): void;
  onOpenAgentSettings?(): void;
  inputFocus?: OfficeInputFocus | undefined;
  onInputFocused?: (token: number) => void;
  onLearningTarget?: (target: HTMLDivElement | null) => void;
}) {
  // Floor view and lights are drawn in the App top bar; one shared store drives both. The Solar theme lets the scene follow the sun.
  const view = useOfficeControls(controls => controls.view);
  const setView = useOfficeControls(controls => controls.setView);
  const viewRequest = useOfficeControls(controls => controls.viewRequest);
  const followFloor = useOfficeControls(controls => controls.followFloor);
  const lightOverride = useOfficeControls(controls => controls.lightOverride);
  const autoCamera = useOfficeControls(controls => controls.autoCamera);
  const followSun = usePreferencesStore(preferences => preferences.theme) === 'solar';
  // Avatar cards, board selection and session dialogs have separate state and one dialog slot.
  const [selection, dispatch] = useReducer(officeSelectionReducer, initialOfficeSelection);
  const observedInputs = useObservedInputs();
  const foreground = useOfficeForeground();
  const handledInputFocus = useRef<number | undefined>(undefined);
  const preparedInputFocus = useRef<number | undefined>(undefined);
  const inputCamera = useRef<{ token: number; request: number; characterId: string } | undefined>(undefined);
  const [focusFinished, setFocusFinished] = useState<{ request: number; completed: boolean }>();
  const [inputDialogFocus, setInputDialogFocus] = useState<{ token: number; sessionId: string; requestId: string }>();
  const focusedInputDialog = useRef<number | undefined>(undefined);
  const [officeViewport, setOfficeViewport] = useState<HTMLDivElement | null>(null);
  const selectedId = selection.characterId;
  const panelCollapsed = selection.boardCollapsed;
  const [focusRequest, setFocusRequest] = useState(0);
  const focusSequence = useRef(0);
  const requestFocus = useCallback(() => { const next = ++focusSequence.current; setFocusRequest(next); return next; }, []);
  const cameraFinished = useCallback((request: number, completed: boolean) => setFocusFinished({ request, completed }), []);
  // Overlay: the camera follows one character only on request; rooms and the activity drawer are page state.
  const [followId, setFollowId] = useState<string | null>(null);
  const [roomFocus, setRoomFocus] = useState<{ roomId: string; point: FocusPoint } | null>(null);
  const [boardOpen, setBoardOpen] = useState(false);
  // The prompt dock's target: a session to continue (picked on the board or in the dock) and why, or a new session.
  const [dockTarget, setDockTarget] = useState<{ sessionId?: string; note?: string }>({});
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(() => new Set());
  // Leads whose subagents are folded away on the agents board (all open by default).
  const [collapsedLeads, setCollapsedLeads] = useState<ReadonlySet<string>>(() => new Set());
  const [earlier, setEarlier] = useState(() => {
    const open = readEarlierOpen();
    return { open, mounted: open };
  });
  const earlierOpen = earlier.open;
  const showEarlier = (open: boolean) => {
    setEarlier(current => ({ open, mounted: open || current.mounted }));
    writeEarlierOpen(open);
  };
  const boardId = useId();
  const [sceneAttempt, setSceneAttempt] = useState(() => ({ id: 0, Canvas: createSceneAttempt(loadOfficeCanvas) }));
  const attempt = sceneAttempt.id;
  const OfficeCanvas = sceneAttempt.Canvas;
  const [loadStage, setLoadStage] = useState<OfficeLoadStage>('engine');
  const [renderFailed, setRenderFailed] = useState(false);
  const [dockRevealed, setDockRevealed] = useState(false);
  const [contextState, setContextState] = useState<OfficeContextState>('ready');
  const retryScene = useCallback(() => {
    setRenderFailed(false); setLoadStage('engine'); setContextState('ready');
    setSceneAttempt(current => ({ id: current.id + 1, Canvas: createSceneAttempt(loadOfficeCanvas) }));
  }, []);
  const markScene = useCallback(() => setLoadStage('scene'), []);
  const markReady = useCallback(() => { setLoadStage('ready'); setDockRevealed(true); }, []);
  const markFailed = useCallback(() => { setRenderFailed(true); setDockRevealed(true); }, []);
  const dark = useSyncExternalStore(subscribeTheme, getDark, getFalse);
  const reducedMotion = useSyncExternalStore(subscribeMotion, getReduced, getFalse);
  // Avoid constructing the (potentially large) earlier tree on initial load. Keep it through the
  // close transition, and cancel that unmount if the user reopens it quickly.
  useEffect(() => {
    if (earlierOpen || !earlier.mounted) return;
    const timeout = window.setTimeout(() => {
      setEarlier(current => current.open ? current : { ...current, mounted: false });
    }, reducedMotion ? 0 : 240);
    return () => window.clearTimeout(timeout);
  }, [earlierOpen, earlier.mounted, reducedMotion]);
  // Task context changes independently; the board and scene retain every project's sessions.
  const sessions = useMemo(() => [...(state?.sessions ?? [])]
    .filter(session => state?.workflow !== 'observe' || session.control === 'observed')
    .sort((a, b) => Number(b.id === (inputFocus?.sessionId ?? selection.dialog?.sessionId)) - Number(a.id === (inputFocus?.sessionId ?? selection.dialog?.sessionId))
      || Number(b.running) - Number(a.running) || b.lastActiveAt.localeCompare(a.lastActiveAt)), [state?.sessions, state?.workflow, inputFocus?.sessionId, selection.dialog?.sessionId]);
  const visible = useMemo(() => sessions.slice(0, MAX_SESSIONS), [sessions]);
  const selectedSessionId = selectedId ? visible.find(session => selectedId.startsWith(`${session.id}:`))?.id : undefined;
  // Managed sessions that run or are selected, plus watched observed sessions, so outside-app activity reaches presence, screens and bubbles.
  // v0.0.47: sessions whose mission workers are still in the office keep their history after the mission ends (linger, then leave).
  const [missionSessions, setMissionSessions] = useState<{ key: string; ids: ReadonlySet<string> }>(() => ({ key: '', ids: new Set() }));
  const historyIds = useMemo(() => officeHistoryIds(visible, selectedSessionId, undefined, missionSessions.ids), [visible, selectedSessionId, missionSessions]);
  const { events, error, loadedSessionIds } = useOfficeEvents(agents, historyIds);
  // v0.0.47 (ADR 0016): retained native mission records (title, connection, exact task state and reason) for mission workers.
  const missions = useOfficeMissions(agents, state, events);
  // Observed liveness and (v0.0.44) a finished subagent's Ready linger depend on event age, so presence re-evaluates on a
  // slow clock while any session is shown.
  const now = useNow(visible.length > 0);
  // v0.0.30: team members' names and genders, so subagents are named and dressed like in the team dialog.
  const standbyScope = JSON.stringify([state?.profile.id, state?.dataDirectory ?? state?.storage?.dataDirectory]);
  const { teams, readySessionIds: readyTeamIds } = useSessionTeamSnapshot(agents, visible, events, standbyScope);
  const reportedPresences = useMemo(() => projectOfficePresence(visible, events, now, teams, missions), [visible, events, now, teams, missions]);
  const presences = useStableValue(useNativeStandby(agents, standbyScope, reportedPresences, visible, teams, now, loadedSessionIds, readyTeamIds));
  // v0.0.43: agents under the board's "Earlier" group (ended or quiet sessions, subagents that left) are not in the 3D office.
  // v0.0.47: nor are mission workers that have not started (queued): they walk in through the spawn queue when their task runs.
  const officeAgents = useMemo(() => presences.filter(agent => !agent.earlier && isAdmitted(agent)), [presences]);
  // v0.0.48: an agent that waits for an approval gets its answer inline; the handlers come from the approval provider.
  const approvals = useApprovals();
  const approvalById = (pendingId: string | undefined) => (pendingId ? approvals.pending.find(item => item.id === pendingId) : undefined);
  const missionKey = [...new Set(presences.filter(agent => agent.mission && agent.status !== 'offline').map(agent => agent.sessionId))].sort().join('|');
  // Adjusting state while rendering (as in useOfficeAllocations): the set only changes when a session gains or loses its last worker.
  if (missionSessions.key !== missionKey) setMissionSessions({ key: missionKey, ids: new Set(missionKey ? missionKey.split('|') : []) });
  // Every name in the office (leads of all sessions, team members, shown agents), so new names stay unique office-wide.
  const officeNames = useMemo(() => {
    const names = new Set<string>();
    for (const session of state?.sessions ?? []) { const name = (session as { agentName?: unknown }).agentName; if (typeof name === 'string' && name.trim()) names.add(name.trim()); }
    for (const members of teams.values()) for (const member of members) if (member.name.trim()) names.add(member.name.trim());
    for (const agent of presences) if (agent.look) names.add(agent.displayName);
    return names;
  }, [state?.sessions, teams, presences]);
  // Activity shows only as flash bubbles over characters (no toasts).
  const recentActivity = useRecentActivity(events);
  const selected = presences.find(agent => agent.id === selectedId);
  // Facility staff (receptionist, bartender) are scene characters, not sessions: selectable, never counted as agents.
  const staff = useFacilityStaff();
  const selectedStaff = staff.find(entry => entry.definition.id === selectedId);
  // Characters keep their desks when others arrive; live positions follow them while they walk or ride.
  const allocations = useOfficeAllocations(officeAgents);
  const [positions] = useState(createCharacterPositionStore);
  const positionVersion = useSyncExternalStore(positions.subscribe, positions.version, () => 0);
  const floorOf = (id: string) => positions.floor(id) ?? allocations.find(item => item.agentId === id)?.floor;
  const looks = useCharacterAppearances(agents);
  // Generated looks are allocated among the visible characters (unique casual clothing); scene, portraits and editor share them.
  useLookRoster(officeAgents, looks.saved);
  // Deliberate character actions choose task context. Automatic camera attention remains visual.
  const activateCharacterContext = (agent: OfficeAgent | undefined) => {
    const context = officeCharacterContext(t, agent, state?.sessions ?? [], presences);
    if (!context) return;
    onWorkspace(context.workspaceId, context.sessionId);
    setDockTarget(context.dock);
  };
  const selectAgent = (id: string) => {
    activateCharacterContext(presences.find(agent => agent.id === id));
    dispatch({ type: 'pick', characterId: id });
  };
  const overlay = useOfficeOverlay({ t, presences, allocations, events, recent: recentActivity, state });
  // Direct avatar inspection preserves the user's camera; Locate and Follow move it explicitly.
  // v0.0.38: a picked character answers with a short reply bubble, so it is easy to spot.
  const callOut = (id: string) => { if (officeAgents.some(agent => agent.id === id)) characterCallouts.say(id, t.characterCallouts); };
  const locateAgent = (id: string) => {
    selectAgent(id);
    const floor = floorOf(id); if (floor && floor !== view) setView(floor);
    requestFocus(); callOut(id);
  };
  const focusRoom = (roomId: string) => {
    const room = overlay.rooms.find(item => item.id === roomId);
    if (!room) return;
    setFollowId(null); setView(roomView(room)); setRoomFocus({ roomId, point: { point: room.point, size: room.size } });
  };
  useEffect(() => {
    if (!inputFocus || handledInputFocus.current === inputFocus.token) return;
    const frame = requestAnimationFrame(() => {
      const finish = (outcome: OfficeAttentionOutcome = 'canceled') => {
        inputCamera.current = undefined;
        handledInputFocus.current = inputFocus.token;
        inputFocus.onSettled?.(outcome);
        onInputFocused?.(inputFocus.token);
      };
      const session = state?.sessions.find(item => item.id === inputFocus.sessionId);
      const approval = inputFocus.kind === 'approval' ? approvals.pending.find(item => item.sessionId === inputFocus.sessionId && item.id === inputFocus.requestId) : undefined;
      const entry = observedInputs?.view.entries[inputFocus.sessionId];
      if (inputFocus.automatic && inputFocus.kind !== 'approval') {
        if (entry?.phase === 'unavailable') { finish('retry'); return; }
        if (entry?.phase === 'loading') return;
      }
      if (inputFocus.attentionKey && !officeAttentionRequests(approvals.pending, observedInputs?.view.entries ?? {}).some(request => request.key === inputFocus.attentionKey)) { finish(); return; }
      if (!session || (inputFocus.kind === 'approval' ? !approval
        : session.control !== 'observed' || !session.observation?.watching
          || (inputFocus.requestId && !entry?.requests.some(request => request.id === inputFocus.requestId)))) { finish(); return; }
      if (inputFocus.automatic && !approval) {
        const request = entry?.requests.find(item => item.id === inputFocus.requestId);
        if (entry?.phase !== 'ready' || !request || request.state !== 'pending' || !request.canAnswer || request.identityVerified === false) { finish(); return; }
      }
      if (inputFocus.automatic && !foreground) return;
      if (approval && !loadedSessionIds.has(session.id)) {
        if (!error) return;
        // A verified approval stays answerable when Office history cannot identify its actor.
        if (inputFocus.automatic && officeAttentionOverlayOpen()) { finish('retry'); return; }
        approvals.openInbox(); finish('shown'); return;
      }
      const owner = inputFocus.agentId ?? (approval ? events.find(event => event.sessionId === session.id && event.body.type === 'approval.requested' && event.body.approvalId === approval.id)?.agentId : undefined) ?? 'primary';
      const agent = presences.find(item => item.sessionId === session.id && item.agentId === owner)
        ?? presences.find(item => item.sessionId === session.id && item.agentId === 'primary');
      if (!agent) return;
      const present = () => {
        if (inputFocus.automatic && officeAttentionOverlayOpen()) { finish('retry'); return; }
        if (approval) approvals.openInbox();
        else {
          dispatch({ type: 'openDialog', sessionId: session.id, characterId: agent.id, tab: 'messages', returnFocus: null });
          if (inputFocus.requestId) setInputDialogFocus({ token: inputFocus.token, sessionId: session.id, requestId: inputFocus.requestId });
        }
        finish('shown');
      };
      if (preparedInputFocus.current !== inputFocus.token) {
        preparedInputFocus.current = inputFocus.token;
        onWorkspace(session.workspaceId || undefined, session.id);
        if (!approval) setDockTarget({ note: t.officeUx.composer.observedTarget(agent.displayName) });
        dispatch({ type: 'select', characterId: agent.id });
        setRoomFocus(null); setFollowId(null);
      }
      if (inputCamera.current?.token === inputFocus.token) {
        const camera = inputCamera.current;
        if (selectedId && selectedId !== camera.characterId) { finish(); return; }
        if (renderFailed || contextState !== 'ready') { present(); return; }
        if (focusFinished?.request === camera.request) {
          if (focusFinished.completed) present(); else finish();
        }
        return;
      }
      // The 2D request remains usable when a character or renderer is unavailable.
      if (!isAdmitted(agent) || agent.earlier || renderFailed || contextState !== 'ready') { present(); return; }
      if (loadStage !== 'ready') return;
      if (!positions.position(agent.id)) return;
      const floor = positions.floor(agent.id) ?? allocations.find(item => item.agentId === agent.id)?.floor;
      if (floor) setView(floor);
      inputCamera.current = { token: inputFocus.token, request: requestFocus(), characterId: agent.id };
      characterCallouts.say(agent.id, t.characterCallouts);
    });
    return () => cancelAnimationFrame(frame);
  }, [inputFocus, foreground, loadedSessionIds, error, state?.sessions, approvals, observedInputs?.view.entries, events, presences, positions, positionVersion, allocations, renderFailed, contextState, loadStage, selectedId, focusFinished, requestFocus, setView, t.characterCallouts, t.officeUx.composer, onWorkspace, onInputFocused]);
  useEffect(() => {
    if (!inputDialogFocus || focusedInputDialog.current === inputDialogFocus.token || selection.dialog?.sessionId !== inputDialogFocus.sessionId) return;
    let frame = 0, attempts = 0;
    const focus = () => {
      const form = [...document.querySelectorAll<HTMLElement>('.session-dialog [data-observed-input-id]')]
        .find(element => element.dataset.observedInputId === inputDialogFocus.requestId && element.getClientRects().length > 0);
      if (form) { form.scrollIntoView({ block: 'nearest' }); form.focus({ preventScroll: true }); focusedInputDialog.current = inputDialogFocus.token; }
      else if (++attempts < 12) frame = requestAnimationFrame(focus);
    };
    frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [inputDialogFocus, selection.dialog, observedInputs?.view.entries]);
  const following = Boolean(selectedId && followId === selectedId);
  const followingName = selected?.displayName ?? (selectedStaff ? facilityCard(t, selectedStaff).displayName : '');
  const stopFollowing = () => {
    setFollowId(null);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.topbar-views button[aria-pressed="true"]')?.focus({ preventScroll: true }));
  };
  const toggleFollow = () => {
    if (!selectedId) return;
    if (following) { setFollowId(null); return; }
    setFollowId(selectedId); requestFocus();
  };
  useEffect(() => { dispatch({ type: 'prune', present: new Set([...presences.map(agent => agent.id), ...staff.map(entry => entry.definition.id)]) }); }, [presences, staff]);
  const p = t.characterPopover;
  const composer = t.officeUx.composer;
  // Board rows start live Follow; direct avatar/card inspection preserves the camera.
  const selectRow = (agent: OfficeAgent) => {
    activateCharacterContext(agent);
    dispatch({ type: 'select', characterId: agent.id });
    const track = inOffice(agent);
    setRoomFocus(null); setFollowId(track ? agent.id : null);
    callOut(agent.id);
    const floor = floorOf(agent.id);
    if (floor && floor !== view) {
      if (track) followFloor(floor);
      else setView(floor);
    }
    setFocusRequest(value => value + 1);
  };
  const toggleRow = (id: string) => setExpandedRows(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const toggleLead = (id: string) => setCollapsedLeads(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  // The board rows in tree order: subagents right under their lead, folded when the lead is collapsed.
  // v0.0.43: agents that left are split off into the "Earlier" group, per session, newest first.
  // v0.0.50: leads newest first by their latest activity, subagents newest first too; the order changes at most once a second.
  const boardMembers = useMemo(() => withTeamMembers(presences, teams), [presences, teams]);
  const liveOrder = useMemo(() => boardOrder(boardMembers, agent => boardActivityAt(agent, overlay.model.latest)), [boardMembers, overlay.model.latest]);
  const order = useSettledBoardOrder(liveOrder);
  const board = useMemo(() => splitBoard(boardMembers, collapsedLeads, agent => boardActivityAt(agent, overlay.model.latest), order),
    [boardMembers, collapsedLeads, overlay.model.latest, order]);
  const boardList = useRef<HTMLUListElement>(null);
  useBoardFlip(boardList, reducedMotion);
  const presentCount = useMemo(() => presences.filter(inOffice).length, [presences]);
  // A search hit on an earlier agent opens its group and focuses its row: it has no character in the office.
  const findAgent = (id: string) => {
    const found = boardMembers.find(agent => agent.id === id);
    if (!found || !isOfflineBoardAgent(found)) { locateAgent(id); return; }
    showEarlier(true);
    if (panelCollapsed) dispatch({ type: 'toggleBoard' });
    activateCharacterContext(presences.find(agent => agent.id === id));
    dispatch({ type: 'select', characterId: id });
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(`row:${id}`)}"]`)?.focus()));
  };
  // v0.0.37: an agent's source (observed app + channel, or managed runtime) and the model it uses.
  const o = t.observedOrigin;
  const channelOf = (agent: OfficeAgent) => agent.origin?.channel ? o.channels[agent.origin.channel] : undefined;
  const modelOf = (agent: OfficeAgent, session: SessionSummary | undefined) => agent.mission
    ? [agent.mission.provider, agent.mission.model].filter(Boolean).join(' · ') || composer.modelUnknown
    : agent.control === 'managed' ? (agent.agentId === 'primary' ? (state && sessionModel(state, session)) : agent.model) ?? composer.modelUnknown : agent.model ?? o.modelUnknown;
  // v0.0.47 (ADR 0016): mission workers on the board: their mission, a warning for unknown work, and the lead's Missions link.
  const mt = t.officeMissions;
  const missionLeads = useMemo(() => new Set(presences.filter(agent => agent.mission).map(agent => agent.sessionId)), [presences]);
  // Plans are often titled "Mission: …"; the badge already says so.
  const missionName = (mission: NonNullable<OfficeAgent['mission']>) => mission.missionTitle?.replace(/^\s*(?:mission|misi)\s*[:·-]\s*/i, '').trim() || mt.untitled;
  const statusHint = (agent: OfficeAgent) => agent.mission?.state === 'queued' ? mt.queuedHint : agent.mission?.state === 'unknown' ? mt.unknownHint : undefined;
  const roleOf = (agent: OfficeAgent) => agent.control === 'observed' ? p.roles.observed : agent.agentId === 'primary' ? p.roles.lead : p.roles.worker;
  // Where a character is, said only when it means something: its desk's room, a lounge break, or a wait for a desk.
  const placeOf = (agent: OfficeAgent) => {
    const allocation = allocations.find(item => item.agentId === agent.id);
    const resource = allocation && OFFICE_RESOURCES.find(item => item.id === allocation.resourceId);
    const room = resource && overlay.rooms.find(item => item.id === resource.roomId)?.label;
    const place = !allocation ? (overlay.model.waitingForDesk.some(item => item.id === agent.id) ? p.waitingDesk : undefined)
      : room && resource.kind === 'workstation' ? p.desk(room) : room;
    return { place, onBreak: resource?.kind === 'lounge-seat' };
  };
  const appearanceOf = (id: string) => ({ saved: looks.saved[id], identity: presences.find(agent => agent.id === id)?.look, onPreview: (next: Parameters<typeof looks.preview>[1]) => looks.preview(id, next), onSave: (next: Parameters<typeof looks.save>[1]) => looks.save(id, next) });
  const openDialog = (agent: OfficeAgent, tab: SessionDialogTab, returnFocus: string | null) => {
    if (!agents || !state?.sessions.some(session => session.id === agent.sessionId)) { selectAgent(agent.id); return; }
    activateCharacterContext(agent);
    dispatch({ type: 'openDialog', sessionId: agent.sessionId, characterId: agent.id, tab, returnFocus });
  };
  const restoreFocus = (key: string | null | undefined) => {
    if (!key) return;
    // Closing the dialog removes modal inertness; the board keeps its manual expansion state.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      // A row that left the board (session removed) falls back to the board toggle.
      const target = document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`) ?? document.querySelector<HTMLElement>('[data-focus-key="board:toggle"]');
      target?.focus({ preventScroll: true });
    }));
  };
  const closeDialog = () => { restoreFocus(selection.dialog?.returnFocus); dispatch({ type: 'closeDialog' }); };
  const dialog = selection.dialog;
  const dialogAgent = dialog ? presences.find(agent => agent.id === dialog.characterId) : undefined;
  const dialogSession = dialog ? sessions.find(session => session.id === dialog.sessionId) : undefined;
  const popoverAgent = selection.popoverOpen ? selected : undefined;
  const popoverStaff = selection.popoverOpen ? selectedStaff : undefined;
  const popoverPlace = popoverAgent ? placeOf(popoverAgent) : undefined;
  const [cameraCountdown, setCameraCountdown] = useState<{ scope: string; value: CameraTourCountdown | null } | null>(null);
  const automaticShot = useCameraDirector({
    enabled: autoCamera && loadStage === 'ready' && contextState === 'ready' && !renderFailed && !hostDisconnected,
    reducedMotion,
    suspended: Boolean(dialog || approvals.inboxOpen || following || inputFocus),
    workingIds: officeAgents.filter(agent => !agent.stalled && (agent.meeting || agent.status === 'thinking' || agent.status === 'working' || agent.status === 'delegating')).map(agent => agent.id),
    idleIds: [...officeAgents.filter(agent => !['thinking', 'working', 'delegating', 'offline', 'unavailable', 'paused'].includes(agent.status) || agent.stalled).map(agent => agent.id), ...staff.map(entry => entry.definition.id)],
    positionReady: id => Boolean(positions.position(id)),
    currentFloor: typeof view === 'number' ? view : undefined,
    floorOf: id => positions.floor(id),
    subjectOf: id => {
      const agent = officeAgents.find(agent => agent.id === id);
      return { moving: positions.moving(id), meeting: Boolean(agent?.meeting),
        ...(agent ? { role: agent.agentId === 'primary' && !agent.parentId ? 'lead' as const : 'worker' as const } : {}) };
    },
    attentionIds: cameraAttentionIds(officeAgents, events, approvals.pending, Object.entries(observedInputs?.view.entries ?? {}).flatMap(([sessionId, entry]) => entry.requests
      .filter(request => request.identityVerified !== false && (request.state === 'pending' || request.state === 'unknown')).map(request => ({ sessionId, id: request.id, requestedAt: request.askedAt ?? '' })))), scope: standbyScope,
    onCountdown: value => setCameraCountdown({ scope: standbyScope, value }),
    onFocus: shot => {
      setRoomFocus(null);
      dispatch({ type: shot.mode === 'attention' ? 'pick' : 'select', characterId: shot.targetId });
    },
  });
  const countdownStaff = staff.find(entry => entry.definition.id === cameraCountdown?.value?.targetId);
  // The card's quick prompt goes into the character's own managed session (a worker's lead); observed agents have none.
  const observeOnly = state?.workflow === 'observe';
  const popoverTarget = !observeOnly && popoverAgent && agents ? promptTargetFor(popoverAgent, state?.sessions ?? []) : undefined;
  const popoverSession = popoverTarget ? state?.sessions.find(item => item.id === popoverTarget.sessionId) : undefined;
  const popoverPrompt = popoverTarget && popoverSession && agents ? {
    busy: popoverSession.running,
    lead: popoverTarget.viaWorker ? presences.find(item => item.sessionId === popoverSession.id && item.agentId === 'primary')?.displayName ?? (popoverSession.title.trim() || composer.untitled) : undefined,
    send: async (text: string) => { await agents.sendPrompt(popoverSession.id, text); onState(await agents.getState()); },
  } : undefined;
  const failed = <div className="office-scene-message" role="alert"><div className="office-scene-error-card">
    <Icon name="monitor" /><p>{t.office.unavailable}</p>
    <div className="actions"><button type="button" className="button primary" onClick={retryScene}>{t.common.retry}</button>
      <button type="button" className="button" onClick={onStartChat}>{observeOnly ? t.nav.observe : t.office.openChat}</button></div>
  </div></div>;

  // One board row (a lead, a subagent or a team member), on the board or in its "Earlier" group.
  const renderRow = ({ agent, depth, descendants, expanded: branchOpen, guides, last, stem }: BoardRow, index: number, rows: readonly BoardRow[]) => {
    const session = state?.sessions.find(item => item.id === agent.sessionId);
    const model = modelOf(agent, session);
    const channel = channelOf(agent);
    // Observed leads get a third, muted line with mark, app and channel; everyone else shows the mark next to the name.
    const sourceLine = agent.control === 'observed' && depth === 0;
    const open = expandedRows.has(agent.id);
    const detailsId = `${boardId}-row-${agent.id}`;
    const branchLabel = composer.subagents(descendants, branchOpen);
    // v0.0.38: when the row last did something, relative to the 30 s clock; the full date and time is its title.
    const activityAt = boardActivityAt(agent, overlay.model.latest);
    const ago = activityAt === undefined ? undefined : { text: boardAgo(activityAt, overlay.now, language, t.officeOverlay.ago.now), short: boardAgoShort(activityAt, overlay.now, composer.agoShort), title: boardAbsolute(activityAt, language), iso: new Date(activityAt).toISOString() };
    const mission = agent.mission;
    const warn = agent.stalled || (mission?.state === 'unknown' && agent.status !== 'offline');
    const statusText = agentStatusLabel(t, agent, language);
    const hint = statusHint(agent);
    const missionsLink = depth === 0 && agent.agentId === 'primary' && session && onOpenMissions && missionLeads.has(agent.sessionId) ? session : undefined;
    return <li key={agent.id} data-flip-key={agent.id} data-native-standby={agent.nativeStandby} className={`office-agent-row ${depth ? 'is-subagent' : ''}${mission ? ' is-mission' : ''}`} data-expanded={open || undefined}
      style={depth ? { '--depth': depth } as CSSProperties : undefined}>
      {(depth > 0 || stem) && <span className="office-tree" aria-hidden="true">
        {guides.map((on, at) => on && <span key={at} className="office-tree-pass" style={{ '--at': at } as CSSProperties} />)}
        {depth > 0 && <span className="office-tree-elbow" data-last={last || undefined} data-tone={boardTreeTone(agent)} data-active={boardTreeActive(agent) || undefined} style={{ '--at': depth - 1 } as CSSProperties}>
          <svg className="office-tree-corner" width="13" height="27" viewBox="0 0 13 27" aria-hidden="true" focusable="false"><path d={last ? TREE_ELBOW_PATHS.last : TREE_ELBOW_PATHS.branch} /></svg>
        </span>}
        {stem && <span className="office-tree-stem" data-active={boardBranchActive(rows, index) || undefined} style={{ '--at': depth } as CSSProperties} />}
      </span>}
      <div className="office-agent-line">
        <button type="button" className={`office-agent ${selected?.id === agent.id || dialog?.characterId === agent.id ? 'current' : ''}`} aria-pressed={selected?.id === agent.id}
          data-focus-key={`row:${agent.id}`} title={agent.title ? `${composer.selectRow(agent.displayName)}\n${agent.title}` : composer.selectRow(agent.displayName)} onClick={() => selectRow(agent)}>
          <span className="office-agent-avatar">
            <AgentPortrait characterId={agent.id} appearance={looks.appearances[agent.id]} identity={agent.look} activity={agent} />
            <span className={`office-agent-dot status-${agent.status}${warn ? ' is-stalled' : ''}${agent.phase === 'error' ? ' is-error' : ''}${mission?.state === 'queued' ? ' is-queued' : ''}`} aria-hidden="true" />
          </span>
          <span className="office-agent-text"><span className="office-agent-name"><strong>{agent.displayName}</strong>{agent.origin && !sourceLine && <OriginChip origin={agent.origin} channel={channel} iconOnly />}{ago && <time className="office-agent-ago" dateTime={ago.iso} title={`${ago.text} · ${ago.title}`}>{ago.short}</time>}</span><small><span className={warn ? 'office-agent-status is-stalled' : agent.phase === 'error' ? 'office-agent-status is-error' : undefined} title={hint ? `${statusText} · ${hint}` : statusText}>{statusText}</span><span className="office-agent-model" title={model}>{model}</span></small>
            {sourceLine && agent.origin && <span className="office-agent-origin"><OriginChip origin={agent.origin} channel={channel} showChannel /></span>}
            {mission && <span className="office-agent-mission">{agent.title && <span className="office-agent-task" title={agent.title}>{agent.title}</span>}
              <span className="office-mission-badge" title={mt.badge(missionName(mission))}><Icon name="mission" /><span>{mt.badge(missionName(mission))}</span></span></span>}</span>
          {agent.parentId && <Icon name="users" />}
        </button>
        {missionsLink && <button type="button" className="icon-button small office-agent-missions" aria-label={t.missions.linkLabel(agent.displayName)} title={t.missions.linkLabel(agent.displayName)}
          onClick={() => onOpenMissions?.(missionsLink)}><Icon name="mission" /></button>}
        {descendants > 0 && <button type="button" className="office-agent-branch" aria-expanded={branchOpen} aria-label={branchLabel} title={branchLabel}
          onClick={() => toggleLead(agent.id)}><span className="badge">{descendants}</span><Icon name="chevron" /></button>}
        <button type="button" className="icon-button small office-agent-toggle" aria-expanded={open} aria-controls={detailsId} aria-label={composer.details(agent.displayName)}
          title={composer.details(agent.displayName)} onClick={() => toggleRow(agent.id)}><Icon name="chevron" /></button>
      </div>
      <div className="board-collapse office-agent-collapse" data-open={open || undefined} inert={!open}><div className="board-collapse-inner">
      <div id={detailsId} className="office-agent-details">
        <dl>
          <div><dt>{composer.role}</dt><dd>{roleOf(agent)}</dd></div>
          {agent.title && <div><dt>{agent.agentId === 'primary' ? t.identity.sessionTitle : o.task}</dt><dd>{agent.title}</dd></div>}
          {mission && <div><dt>{mt.mission}</dt><dd>{missionName(mission)}</dd></div>}
          {mission && <div><dt>{mt.state}</dt><dd>{t.missions.run.taskStates[mission.state]}</dd></div>}
          {mission?.reason && <div><dt>{mt.reason}</dt><dd>{t.missions.run.reasons[mission.reason] ?? mission.reason}</dd></div>}
          {mission?.provider && <div><dt>{mt.connection}</dt><dd>{mission.provider}</dd></div>}
          {agent.origin && <div><dt>{agent.control === 'observed' ? o.source : o.runtime}</dt><dd><OriginChip origin={agent.origin} channel={channel} showChannel /></dd></div>}
          <div><dt>{o.model}</dt><dd><code>{model}</code></dd></div>
          {agent.context && <div><dt>{t.context.label}</dt><dd><ContextUsageLine t={t} context={agent.context} /></dd></div>}
          {ago && <div><dt>{composer.lastActivity}</dt><dd><time dateTime={ago.iso} title={ago.title}>{ago.text}</time></dd></div>}
          {session && <div><dt>{composer.workspace}</dt><dd>{state?.workspaces.find(item => item.id === session.workspaceId)?.name ?? session.workspaceId}</dd></div>}
          {(agent.summary || agent.activity) && <div><dt>{composer.task}</dt><dd>{agent.summary ?? (agent.activity ? t.chat.activity[agent.activity] : '')}</dd></div>}
          <div><dt>{composer.sessionId}</dt><dd><code>{agent.sessionId}</code></dd></div>
          {agent.agentId !== 'primary' && <div><dt>{composer.agentId}</dt><dd><code>{agent.agentId}</code></dd></div>}
        </dl>
        <button type="button" className="button small" aria-haspopup="dialog" data-focus-key={`rowopen:${agent.id}`}
          onClick={() => openDialog(agent, 'messages', `rowopen:${agent.id}`)}><Icon name="external" />{composer.openSession}</button>
      </div>
      </div></div>{/* v0.0.48: the details stay mounted so they can animate closed; inert while closed */}
    </li>;
  };

  // Reveal after first load/failure, then retain the composer through renderer retries
  // so its local draft and attachment state never unmount with the 3D scene.
  const showDock = Boolean(!observeOnly && agents && state && (dockRevealed || loadStage === 'ready' || renderFailed));
  const showLeadBar = overlay.model.leads.shown.length > 0;
  return <PortraitPositionContext value={positions}><div className="office-page">
    <div className="office-toolbar">
      <Select aria-label={t.office.activeWorkspace} value={workspaceId ?? 'all'} options={[{ value: 'all', label: t.office.defaultWorkspace }, ...(state?.workspaces ?? []).map(workspace => ({ value: workspace.id, label: workspace.name }))]}
        onChange={id => { setDockTarget({}); onWorkspace(id === 'all' ? undefined : id); }} />
      <OfficeTools t={t} source={overlay.source} rooms={overlay.rooms} currentRoom={roomFocus?.roomId} boardOpen={boardOpen} boardId={boardId} boardCount={overlay.model.board.length}
        onAgent={findAgent} onRoom={focusRoom} onToggleBoard={() => setBoardOpen(value => !value)} />
      {agents && <button type="button" className="office-tool-button" title={t.agentApps.title} onClick={onOpenAgentSettings ?? onOpenSettings}>
        <Icon name="terminal" /><span>{t.agentApps.officeButton}</span>
      </button>}
      <span className="office-live" role="status" title={hostDisconnected ? t.hostConnection.title : agents ? t.office.connected : t.office.disconnected}><span className={agents && !hostDisconnected ? 'pulse' : ''} aria-hidden="true" /><span className="office-live-text">{hostDisconnected ? t.hostConnection.title : agents ? t.office.connected : t.office.disconnected}</span></span>
    </div>
    <div ref={setOfficeViewport} className={`office-stage ${showDock ? 'has-dock' : ''} ${showLeadBar ? 'has-lead-bar' : ''} ${boardOpen ? 'has-board' : ''}`} aria-label={t.office.title}>
      <SceneBoundary key={`scene-${attempt}`} fallback={failed} onFailure={markFailed}>
        <Suspense fallback={null}>
          <OfficeCanvas automaticShot={automaticShot} agents={officeAgents} selectedId={selected?.id ?? selectedStaff?.definition.id ?? null} onSelect={selectAgent} popoverId={popoverAgent?.id ?? popoverStaff?.definition.id ?? null} onMiss={() => dispatch({ type: 'closePopover' })} view={view} viewRequest={viewRequest} language={language} dark={dark} reducedMotion={reducedMotion} appearances={looks.appearances} activities={recentActivity} onScene={markScene} onReady={markReady} onContextState={setContextState} onRetryScene={retryScene} focusRequest={focusRequest} onFocusFinished={cameraFinished} follow={following} onFollowEnd={() => setFollowId(null)} onFollowFloor={followFloor} focusPoint={roomFocus?.point} allocations={allocations} positions={positions} lightOverride={lightOverride} followSun={followSun} />
        </Suspense>
      </SceneBoundary>
      {autoCamera && !dialog && !approvals.inboxOpen && !following && !inputFocus && loadStage === 'ready' && contextState === 'ready' && !renderFailed && !hostDisconnected
        && automaticShot?.mode === 'tour' && automaticShot.phase === 'focus' && cameraCountdown?.scope === standbyScope
        && <AutoCameraCountdown t={t} countdown={cameraCountdown.value} name={presences.find(agent => agent.id === cameraCountdown.value?.targetId)?.displayName
          ?? (countdownStaff ? facilityCard(t, countdownStaff).displayName : undefined)} />}
      {!renderFailed && <OfficeLoading key={`loading-${attempt}`} t={t} stage={loadStage} reducedMotion={reducedMotion} />}
      {following && followingName && loadStage === 'ready' && contextState === 'ready' && !renderFailed &&
        <OfficeFollowStatus t={t} name={followingName} onStop={stopFollowing} />}
      {boardOpen && <ActivityBoard t={t} id={boardId} items={overlay.model.board} names={overlay.names} now={overlay.now} onSelect={locateAgent} onClose={() => setBoardOpen(false)} onOpenMissions={onOpenMissions && (() => onOpenMissions())} approvalFor={characterId => approvalById(officeAgents.find(agent => agent.id === characterId)?.pendingApprovalId)} />}
      {showLeadBar && <LeadAgentBar t={t} leads={overlay.model.leads.shown} more={overlay.model.leads.more} appearances={looks.appearances} projects={overlay.projects}
        latest={overlay.model.latest} selectedId={selected?.id ?? null} onSelect={locateAgent} />}
      <aside className={`office-panel ${panelCollapsed ? 'office-panel-collapsed' : ''}`} aria-label={t.office.agents}>
        <div className="office-panel-head"><strong>{t.office.agents}</strong><span className="badge">{presentCount}</span><button type="button" className="icon-button" aria-label={panelCollapsed ? t.officeUx.expand : t.officeUx.collapse} aria-expanded={!panelCollapsed} data-focus-key="board:toggle" onClick={() => dispatch({ type: 'toggleBoard' })}><Icon name={panelCollapsed ? 'plus' : 'panel'} /></button></div>
        <div className="office-panel-body" aria-hidden={panelCollapsed} inert={panelCollapsed}><div>
        <OfficeMetrics t={t} kpis={overlay.model.kpis} />
        <OfficeFullNotice t={t} waiting={overlay.model.waitingForDesk} onSelect={locateAgent} />
        {error && <p className="form-error" role="alert">{t.office.activityError} {error}</p>}
        {!presences.length ? <div className="office-empty"><p>{t.office.empty}</p><div className="row-actions"><button type="button" className="button" onClick={observeOnly || state?.workspaces.length ? onStartChat : onOpenSettings}>{observeOnly ? t.nav.observe : state?.workspaces.length ? t.office.startSession : t.office.configure}</button>{agents && <button type="button" className="button" onClick={onOpenAgentSettings ?? onOpenSettings}><Icon name="terminal" />{t.agentApps.title}</button>}</div></div> :
          <>
            {board.present.length ? <ul ref={boardList} className="office-agent-list">{board.present.map(renderRow)}</ul> : <p className="office-earlier-none">{composer.noneActive}</p>}
            {board.earlierCount > 0 && <section className="office-earlier" aria-label={composer.earlier(board.earlierCount)}>
              <button type="button" className="office-earlier-toggle" aria-expanded={earlierOpen} title={composer.earlierHint} data-focus-key="board:earlier"
                onClick={() => showEarlier(!earlierOpen)}><Icon name="chevron" /><span>{earlierOpen ? composer.hideOffline(board.earlierCount) : composer.showOffline(board.earlierCount)}</span></button>
              {/* Keep rows mounted through the close animation, then release hidden portraits. */}
              <div className="board-collapse" data-open={earlierOpen || undefined} inert={!earlierOpen}><div className="board-collapse-inner">
                {earlier.mounted && board.earlier.map(group => <div key={group.sessionId} className="office-earlier-group">
                  {group.presentLead && <p className="office-earlier-from">{composer.earlierFrom(group.presentLead.displayName)}</p>}
                  <ul className="office-agent-list">{group.rows.map(renderRow)}</ul>
                </div>)}
              </div></div>
            </section>}
          </>}
        {sessions.length > MAX_SESSIONS && <p className="note">{t.office.limited(MAX_SESSIONS, sessions.length)}</p>}
        </div></div>
      </aside>
      {showDock && agents && state && <OfficePromptDock t={t} agents={agents} state={state} workspaceId={workspaceId} onState={onState} compact
        officeNames={officeNames} savedLooks={looks.saved} onLearningTarget={onLearningTarget}
        targetSessionId={dockTarget.sessionId} note={dockTarget.note} onTarget={sessionId => setDockTarget(sessionId ? { sessionId } : {})}
        onStarted={sessionId => { dispatch({ type: 'select', characterId: `${sessionId}:primary` }); setFollowId(`${sessionId}:primary`); setView(1); }} onOpenSettings={onOpenSettings} />}
      {popoverAgent && <CharacterPopover key={`popover:${popoverAgent.id}`} t={t} look={looks.appearances[popoverAgent.id]} activity={popoverAgent} following={following} suspended={Boolean(dialog)}
        character={{ id: popoverAgent.id, displayName: popoverAgent.displayName, identity: popoverAgent.look, task: popoverAgent.title, role: roleOf(popoverAgent), project: overlay.projects.get(popoverAgent.id), place: popoverPlace?.place,
          ...(popoverAgent.control === 'observed' && popoverAgent.origin ? { origin: { origin: popoverAgent.origin, channel: channelOf(popoverAgent), model: popoverAgent.model ?? o.modelUnknown } } : {}),
          ...(popoverAgent.context ? { context: popoverAgent.context } : {}),
          state: popoverState(popoverAgent, popoverPlace?.onBreak), summary: popoverSummary(t, popoverAgent, popoverPlace?.onBreak) }}
        prompt={popoverPrompt} approval={approvalById(popoverAgent.pendingApprovalId)}
        onMessage={agents ? () => openDialog(popoverAgent, 'messages', 'popover:message') : undefined}
        onActivity={agents ? () => openDialog(popoverAgent, 'activity', 'popover:activity') : undefined}
        onFollow={toggleFollow} appearance={agents ? appearanceOf(popoverAgent.id) : undefined}
        onLocate={() => locateAgent(popoverAgent.id)} onClose={() => dispatch({ type: 'closePopover' })} />}
      {popoverStaff && <CharacterPopover key={`popover:${popoverStaff.definition.id}`} t={t} look={facilityAppearance(popoverStaff.definition, looks.appearances[popoverStaff.definition.id])} following={following} suspended={Boolean(dialog)}
        character={facilityCard(t, popoverStaff)} onFollow={toggleFollow}
        appearance={agents ? { ...appearanceOf(popoverStaff.definition.id), uniform: popoverStaff.definition.role, defaults: popoverStaff.definition.appearance } : undefined}
        onLocate={() => locateAgent(popoverStaff.definition.id)} onClose={() => dispatch({ type: 'closePopover' })} />}
      {dialog && agents && state && (state.workflow !== 'observe' || dialogSession?.control === 'observed') && <AgentSessionDialog key={`dialog:${dialog.characterId}`} t={t} language={language} agents={agents} state={state} onState={onState}
        viewport={officeViewport}
        officeNames={officeNames} savedLooks={looks.saved}
        session={dialogSession} agent={dialogAgent} role={dialogAgent ? roleOf(dialogAgent) : ''} workspace={state.workspaces.find(item => item.id === dialogSession?.workspaceId)?.name}
        look={looks.appearances[dialog.characterId]} appearance={appearanceOf(dialog.characterId)} tab={dialog.tab} onTab={tab => dispatch({ type: 'setTab', tab })}
        onClose={closeDialog} onOpenInChat={onOpenSession} onOpenMissions={onOpenMissions}
        onLocate={() => { dispatch({ type: 'closeDialog' }); locateAgent(dialog.characterId); }}
        onSelectCharacter={id => { const member = presences.find(agent => agent.id === id); if (member) {
          activateCharacterContext(member);
          dispatch({ type: 'openDialog', sessionId: member.sessionId, characterId: id, tab: 'activity', returnFocus: null });
        } }} />}
    </div>
  </div></PortraitPositionContext>;
}
