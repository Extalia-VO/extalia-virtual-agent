import type { Effort } from '@extalia/core';
import {
  isValidIanaTimeZone, nextScheduleRunAt, parseCronExpression,
  type AgentHostApi, type GeneralSchedule, type GeneralScheduleCatalog, type HostState,
  type ModelChoices, type NextRunPreview, type PermissionMode, type SaveGeneralScheduleInput,
  type ScheduleMissedPolicy, type ScheduleReviewDecision, type ScheduleRunDetail,
  type ScheduleRunPage, type ScheduleRunState, type ScheduleRunV1,
  type ScheduleSessionTarget, type ScheduleTrigger, type ScheduleWorkerAssignment,
} from '@extalia/platform';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';
import { ScheduleRunHistoryPanel } from './ScheduleRunHistoryPanel';
import { NextRunsPreviewPanel, ScheduleTimezoneField } from './ScheduleTimezoneField';
import { formatTimestampInZone, scheduleTriggerZoneBadge } from './scheduleFormatting';
import './schedulesPage.css';

type Recurrence = 'daily' | 'weekdays' | 'weekly' | 'hourly' | 'once' | 'custom';
type Suggestion = 'projectReview' | 'sessionFollowup' | 'knowledgeReview';
const defaultOneOffLocal = () => isoToLocalInput(new Date(Date.now() + 3_600_000).toISOString());
function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
const formatDateTime = (iso?: string) => iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleString() : '—';

export function scheduleRecoveryStatus(
  recovery: GeneralSchedule['recovery'],
  formattedRetryTime: string | undefined,
  text: Pick<Messages['schedules'], 'recoveryBusy' | 'recoveryConnection'>,
): string | undefined {
  if (!recovery) return undefined;
  const time = formattedRetryTime ?? '—';
  return recovery.reason === 'busy' ? text.recoveryBusy(time) : text.recoveryConnection(time);
}

/** The picker lists only managed conversations owned by the chosen project. */
export function scheduleSessionChoices(state: HostState, workspaceId: string) {
  return state.sessions.filter(session => session.workspaceId === workspaceId && session.control === 'managed');
}
/** A vanished choice stays invalid instead of selecting the first remaining conversation. */
export function scheduleSessionTarget(mode: ScheduleSessionTarget['mode'], selectedId: string, sourceId: string, reuseDerived: boolean, sessions: HostState['sessions']): ScheduleSessionTarget | undefined {
  if (mode === 'existing') return sessions.some(session => session.id === selectedId) ? { mode, sessionId: selectedId } : undefined;
  if (mode === 'derive-from-session') return sessions.some(session => session.id === sourceId && !session.runtime) ? { mode, sourceSessionId: sourceId, reuseDerived } : undefined;
  return { mode };
}
export function scheduleRecurrenceTrigger(recurrence: Recurrence, time: string, weekday = '1', timeZone?: string): ScheduleTrigger | undefined {
  const trimmedZone = timeZone?.trim();
  const zoneFields = trimmedZone ? { timeZone: trimmedZone, dstPolicy: 'each-valid-instant' as const } : {};
  if (recurrence === 'hourly') return { kind: 'cron', cron: '0 * * * *', ...zoneFields };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return undefined;
  const [hour, minute] = time.split(':').map(Number);
  if (recurrence === 'daily') return { kind: 'cron', cron: `${minute} ${hour} * * *`, ...zoneFields };
  if (recurrence === 'weekdays') return { kind: 'cron', cron: `${minute} ${hour} * * 1-5`, ...zoneFields };
  if (recurrence === 'weekly' && /^[0-6]$/.test(weekday)) return { kind: 'cron', cron: `${minute} ${hour} * * ${weekday}`, ...zoneFields };
  return undefined;
}
/** Recognize only exact editable presets; custom expressions keep their original bytes. */
export function scheduleTriggerPreset(trigger: ScheduleTrigger): { recurrence: Recurrence; time: string; weekday: string } {
  if (trigger.kind === 'once') return { recurrence: 'once', time: '09:00', weekday: '1' };
  if (trigger.kind === 'cron') {
    if (trigger.cron === '0 * * * *') return { recurrence: 'hourly', time: '09:00', weekday: '1' };
    const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(trigger.cron);
    if (match && Number(match[1]) < 60 && Number(match[2]) < 24) return {
      recurrence: match[3] === '*' ? 'daily' : match[3] === '1-5' ? 'weekdays' : 'weekly',
      time: `${match[2]!.padStart(2, '0')}:${match[1]!.padStart(2, '0')}`, weekday: /^[0-6]$/.test(match[3]!) ? match[3]! : '1',
    };
  }
  return { recurrence: 'custom', time: '09:00', weekday: '1' };
}
export function previewTriggerNextRun(trigger: ScheduleTrigger, nowMs = Date.now()): string | undefined {
  try { if (trigger.kind === 'cron') parseCronExpression(trigger.cron); return nextScheduleRunAt(trigger, nowMs); }
  catch { return undefined; }
}

export function SchedulesPage({ t, agents, state, workspaceId: initialWorkspaceId, onSelectWorkspace, onOpenSession, onOpenSettings, onState }: {
  t: Messages; agents: AgentHostApi; state: HostState; workspaceId?: string;
  onSelectWorkspace(id: string): void; onOpenSession(id: string, workspaceId: string): void;
  onOpenSettings(): void; onState(state: HostState): void;
}) {
  const text = t.schedules;
  const managedWorkspaces = state.workspaces.filter(workspace => workspace.mode !== 'observe');
  const activeWorkspaceId = managedWorkspaces.some(workspace => workspace.id === initialWorkspaceId) ? initialWorkspaceId! : managedWorkspaces[0]?.id ?? '';
  const activeWorkspace = managedWorkspaces.find(workspace => workspace.id === activeWorkspaceId);
  const workspaceSessions = scheduleSessionChoices(state, activeWorkspaceId);
  const recentSession = [...workspaceSessions].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0];
  const authority = JSON.stringify([state.host?.instanceId, state.profile?.id, state.dataDirectory]);
  const editorKey = JSON.stringify([authority, activeWorkspaceId]);
  const [scope, setScope] = useState(() => ({ agents, workspaceId: activeWorkspaceId, authority }));
  if (scope.agents !== agents || scope.workspaceId !== activeWorkspaceId || scope.authority !== authority) setScope({ agents, workspaceId: activeWorkspaceId, authority });
  const owner = useRef<typeof scope | undefined>(scope);
  useLayoutEffect(() => { owner.current = scope; return () => { owner.current = undefined; }; }, [scope]);
  const draftEpoch = useRef(0), catalogEpoch = useRef(0), previewEpoch = useRef(0), historyEpoch = useRef(0);
  const [catalog, setCatalog] = useState<GeneralScheduleCatalog>({ revision: '', schedules: [] });
  const [catalogOwner, setCatalogOwner] = useState(() => ({ agents, authority }));
  const catalogCurrent = catalogOwner.agents === agents && catalogOwner.authority === authority;
  const [choiceState, setChoices] = useState<{ owner: typeof scope; value: ModelChoices }>();
  const choices = choiceState?.owner === scope ? choiceState.value : undefined;
  const [knowledgeState, setKnowledgeState] = useState<{ owner: typeof scope; available: boolean }>();
  const [busy, setBusy] = useState(false), [errorState, setErrorState] = useState<{ authority: string; message: string }>();
  const error = errorState?.authority === authority ? errorState.message : null;
  const setError = (message: string | null) => setErrorState(message ? { authority, message } : undefined);
  const [editorWorkspace, setEditorWorkspace] = useState(''), [advanced, setAdvanced] = useState(false);
  const editorOpen = editorWorkspace === editorKey && Boolean(activeWorkspaceId);
  const [editingId, setEditingId] = useState<string | null>(null), [editingRevision, setEditingRevision] = useState<number>();
  const [name, setName] = useState(''), [prompt, setPrompt] = useState(''), [enabled, setEnabled] = useState(true);
  const [recurrence, setRecurrence] = useState<Recurrence>('weekdays'), [time, setTime] = useState('09:00'), [weekday, setWeekday] = useState('1');
  const [triggerKind, setTriggerKind] = useState<'cron' | 'interval' | 'once'>('cron'), [cron, setCron] = useState('0 9 * * 1-5');
  const [timeZone, setTimeZone] = useState(''), [editingLegacyNoZone, setEditingLegacyNoZone] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState('60'), [runAtLocal, setRunAtLocal] = useState(defaultOneOffLocal);
  const [sessionMode, setSessionMode] = useState<ScheduleSessionTarget['mode']>('create-and-reuse');
  const [targetSessionId, setTargetSessionId] = useState(''), [sourceSessionId, setSourceSessionId] = useState(''), [reuseDerived, setReuseDerived] = useState(true);
  const [leadModel, setLeadModel] = useState(''), [leadEffort, setLeadEffort] = useState<Effort | ''>('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode | ''>(''), [teamMode, setTeamMode] = useState<'workspace' | 'solo' | 'custom'>('workspace');
  const [workers, setWorkers] = useState<ScheduleWorkerAssignment[]>([]), [missedPolicy, setMissedPolicy] = useState<ScheduleMissedPolicy>('run-once');
  const [previewResult, setPreviewResult] = useState<{ key: string; preview?: NextRunPreview; error?: string }>();
  const [historyOpen, setHistoryOpen] = useState(false), [historyScheduleId, setHistoryScheduleId] = useState('');
  const [historyStateFilter, setHistoryStateFilter] = useState<ScheduleRunState | ''>('');
  const [runsState, setRunsState] = useState<{ key: string; page: ScheduleRunPage; error?: string }>({ key: '', page: { runs: [], total: 0 } });
  const [runsRefreshing, setRunsRefreshing] = useState(false), [runsLoadingMore, setRunsLoadingMore] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<ScheduleRunDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false), [reviewError, setReviewError] = useState<string | null>(null);
  const supported = Boolean(agents.listSchedules && agents.saveSchedule && agents.setScheduleEnabled && agents.runScheduleNow && agents.deleteSchedule);
  const historySupported = Boolean(agents.listScheduleRuns);
  const previewSupported = Boolean(agents.previewScheduleNextRuns);

  const hostZone = catalogCurrent ? catalog.timeZone : undefined;
  const defaultNewTimeZone = hostZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  useEffect(() => {
    if (!supported || !agents.listSchedules) return;
    let cancelled = false;
    const load = () => { const epoch = ++catalogEpoch.current; void agents.listSchedules!().then(next => {
      if (!cancelled && epoch === catalogEpoch.current) { setCatalog(next); setCatalogOwner({ agents, authority }); }
    }, () => { if (!cancelled && epoch === catalogEpoch.current) setErrorState({ authority, message: text.loadFailed }); }); };
    load(); const unsubscribe = agents.subscribe(load);
    return () => { cancelled = true; unsubscribe(); };
  }, [agents, supported, authority, text.loadFailed]);
  useEffect(() => {
    if (!activeWorkspaceId) return;
    let cancelled = false;
    void agents.modelChoices(activeWorkspaceId).then(value => { if (!cancelled && scope === owner.current) setChoices({ owner: scope, value }); }, () => undefined);
    void agents.listVaultProfiles?.().then(value => {
      if (cancelled || scope !== owner.current) return;
      const profileId = value.workspaces.find(workspace => workspace.id === activeWorkspaceId)?.profileId;
      setKnowledgeState({ owner: scope, available: value.profiles.some(profile => profile.id === profileId) });
    }, () => undefined);
    return () => { cancelled = true; };
  }, [agents, activeWorkspaceId, scope]);

  const resetForm = () => {
    draftEpoch.current++; setEditorWorkspace(''); setEditingId(null); setEditingRevision(undefined);
    setName(''); setPrompt(''); setEnabled(true); setRecurrence('weekdays'); setTime('09:00'); setWeekday('1');
    setTriggerKind('cron'); setCron('0 9 * * 1-5'); setTimeZone(''); setEditingLegacyNoZone(false);
    setIntervalMinutes('60'); setRunAtLocal(defaultOneOffLocal());
    setSessionMode('create-and-reuse'); setTargetSessionId(''); setSourceSessionId(''); setReuseDerived(true);
    setLeadModel(''); setLeadEffort(''); setPermissionMode(''); setTeamMode('workspace'); setWorkers([]); setMissedPolicy('run-once');
    setError(null); setAdvanced(false); setPreviewResult(undefined);
  };
  const beginNew = (suggestion?: Suggestion) => {
    resetForm(); setEditorWorkspace(editorKey); setTimeZone(defaultNewTimeZone); setEditingLegacyNoZone(false);
    if (!suggestion || !activeWorkspace) return;
    const template = text.templates[suggestion]; setName(template.name); setPrompt(template.prompt(activeWorkspace.name));
    if (suggestion === 'sessionFollowup' && recentSession) { setSessionMode('existing'); setTargetSessionId(recentSession.id); }
    if (suggestion === 'knowledgeReview') setRecurrence('weekly');
  };
  const beginEdit = (schedule: GeneralSchedule) => {
    resetForm(); setEditorWorkspace(JSON.stringify([authority, schedule.workspaceId])); setEditingId(schedule.id); setEditingRevision(schedule.revision);
    setName(schedule.name); setPrompt(schedule.prompt); setEnabled(schedule.enabled);
    const preset = scheduleTriggerPreset(schedule.trigger); setRecurrence(preset.recurrence); setTime(preset.time); setWeekday(preset.weekday);
    setTriggerKind(schedule.trigger.kind);
    if (schedule.trigger.kind === 'cron') {
      setCron(schedule.trigger.cron);
      setTimeZone(schedule.trigger.timeZone ?? '');
      setEditingLegacyNoZone(schedule.trigger.timeZone === undefined);
    } else if (schedule.trigger.kind === 'interval') {
      setIntervalMinutes(String(schedule.trigger.intervalMinutes));
      setTimeZone(defaultNewTimeZone);
      setEditingLegacyNoZone(false);
    } else {
      setRunAtLocal(isoToLocalInput(schedule.trigger.runAt));
      setTimeZone(defaultNewTimeZone);
      setEditingLegacyNoZone(false);
    }
    setSessionMode(schedule.sessionTarget.mode);
    if (schedule.sessionTarget.mode === 'existing') setTargetSessionId(schedule.sessionTarget.sessionId);
    if (schedule.sessionTarget.mode === 'derive-from-session') { setSourceSessionId(schedule.sessionTarget.sourceSessionId); setReuseDerived(schedule.sessionTarget.reuseDerived !== false); }
    setLeadModel(schedule.assignment.leadModel ?? ''); setLeadEffort(schedule.assignment.leadEffort ?? ''); setPermissionMode(schedule.assignment.permissionMode ?? '');
    setTeamMode(schedule.assignment.teamMode); setWorkers(schedule.assignment.workers?.map(worker => ({ ...worker })) ?? []); setMissedPolicy(schedule.missedPolicy);
  };

  const isCronEditor = recurrence !== 'once' && (recurrence !== 'custom' || triggerKind === 'cron');
  const trimmedTimeZone = timeZone.trim();
  const timeZoneValid = trimmedTimeZone === '' ? editingLegacyNoZone : isValidIanaTimeZone(trimmedTimeZone);

  const currentTrigger = useMemo<ScheduleTrigger | undefined>(() => {
    if (recurrence !== 'custom' && recurrence !== 'once') {
      if (!timeZoneValid) return undefined;
      return scheduleRecurrenceTrigger(recurrence, time, weekday, trimmedTimeZone || undefined);
    }
    if (recurrence === 'once' || triggerKind === 'once') { const ms = Date.parse(runAtLocal); return Number.isFinite(ms) ? { kind: 'once', runAt: new Date(ms).toISOString() } : undefined; }
    if (triggerKind === 'interval') { const minutes = Number(intervalMinutes); return Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 10080 ? { kind: 'interval', intervalMinutes: minutes } : undefined; }
    if (!timeZoneValid) return undefined;
    try {
      parseCronExpression(cron);
      return {
        kind: 'cron',
        cron,
        ...(trimmedTimeZone ? { timeZone: trimmedTimeZone, dstPolicy: 'each-valid-instant' as const } : {}),
      };
    } catch { return undefined; }
  }, [recurrence, time, weekday, triggerKind, intervalMinutes, cron, runAtLocal, trimmedTimeZone, timeZoneValid]);

  const previewKey = editorOpen && currentTrigger && previewSupported ? JSON.stringify([authority, currentTrigger]) : '';
  const nextRunsPreview = previewKey && previewResult?.key === previewKey ? previewResult.preview : undefined;
  const previewError = previewKey && previewResult?.key === previewKey ? previewResult.error ?? null : null;
  const previewLoading = Boolean(previewKey && previewResult?.key !== previewKey);

  useEffect(() => {
    if (!previewKey || !currentTrigger || !agents.previewScheduleNextRuns) return;
    let cancelled = false;
    const epoch = ++previewEpoch.current;
    void agents.previewScheduleNextRuns(currentTrigger, 5).then(
      preview => {
        if (!cancelled && epoch === previewEpoch.current) {
          setPreviewResult({ key: previewKey, preview });
        }
      },
      failure => {
        if (!cancelled && epoch === previewEpoch.current) {
          setPreviewResult({ key: previewKey, error: failure instanceof Error ? failure.message : text.nextRunsUnavailable });
        }
      },
    );
    return () => { cancelled = true; };
  }, [previewKey, currentTrigger, agents, text.nextRunsUnavailable]);

  const historyKey = historyOpen && historySupported && activeWorkspaceId
    ? JSON.stringify([authority, activeWorkspaceId, historyScheduleId, historyStateFilter, catalog.revision])
    : '';
  const runsPage = historyKey && runsState.key === historyKey ? runsState.page : { runs: [], total: 0 };
  const runsError = historyKey && runsState.key === historyKey ? runsState.error ?? null : null;
  const runsLoading = runsRefreshing || Boolean(historyKey && runsState.key !== historyKey);

  useEffect(() => {
    if (!historyKey || !activeWorkspaceId || !agents.listScheduleRuns) return;
    let cancelled = false;
    const epoch = ++historyEpoch.current;
    void agents.listScheduleRuns({
      workspaceId: activeWorkspaceId,
      ...(historyScheduleId ? { scheduleId: historyScheduleId } : {}),
      ...(historyStateFilter ? { state: historyStateFilter } : {}),
      limit: 20,
    }).then(
      page => {
        if (!cancelled && epoch === historyEpoch.current) {
          setRunsState({ key: historyKey, page });
        }
      },
      failure => {
        if (!cancelled && epoch === historyEpoch.current) {
          setRunsState(prev => ({
            key: historyKey,
            page: prev.key === historyKey ? prev.page : { runs: [], total: 0 },
            error: failure instanceof Error ? failure.message : text.loadFailed,
          }));
        }
      },
    );
    return () => { cancelled = true; };
  }, [historyKey, activeWorkspaceId, historyScheduleId, historyStateFilter, agents, text.loadFailed]);

  const loadRunsManual = async (append = false, cursor?: string) => {
    if (!agents.listScheduleRuns || !activeWorkspaceId || !historyKey) return;
    const epoch = ++historyEpoch.current;
    const targetScope = scope;
    if (append) setRunsLoadingMore(true);
    else setRunsRefreshing(true);
    try {
      const page = await agents.listScheduleRuns({
        workspaceId: activeWorkspaceId,
        ...(historyScheduleId ? { scheduleId: historyScheduleId } : {}),
        ...(historyStateFilter ? { state: historyStateFilter } : {}),
        limit: 20,
        ...(cursor ? { cursor } : {}),
      });
      if (epoch !== historyEpoch.current || targetScope !== owner.current) return;
      setRunsState(prev => ({
        key: historyKey,
        page: append && prev.key === historyKey
          ? { runs: [...prev.page.runs, ...page.runs], total: page.total, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
          : page,
      }));
    } catch (failure) {
      if (epoch === historyEpoch.current && targetScope === owner.current) {
        setRunsState(prev => ({
          key: historyKey,
          page: prev.key === historyKey ? prev.page : { runs: [], total: 0 },
          error: failure instanceof Error ? failure.message : text.loadFailed,
        }));
      }
    } finally {
      if (epoch === historyEpoch.current && targetScope === owner.current) {
        setRunsRefreshing(false);
        setRunsLoadingMore(false);
      }
    }
  };

  const openRunHistory = (scheduleId = '') => {
    setHistoryScheduleId(scheduleId);
    setHistoryOpen(true);
    setSelectedRunId(null);
    setSelectedDetail(undefined);
    setReviewError(null);
  };

  const handleSelectRun = (run: ScheduleRunV1) => {
    setSelectedRunId(run.id);
    setReviewError(null);
    if (!agents.scheduleRunDetail) {
      setSelectedDetail(undefined);
      return;
    }
    setDetailLoading(true);
    const targetScope = scope;
    void agents.scheduleRunDetail(run.id).then(
      detail => {
        if (targetScope === owner.current) {
          setSelectedDetail(detail);
          setDetailLoading(false);
        }
      },
      failure => {
        if (targetScope === owner.current) {
          setRunsState(prev => ({
            key: historyKey,
            page: prev.key === historyKey ? prev.page : { runs: [], total: 0 },
            error: failure instanceof Error ? failure.message : text.loadFailed,
          }));
          setDetailLoading(false);
        }
      },
    );
  };

  const handleReviewUnknownRun = async (runId: string, expectedRevision: number, decision: ScheduleReviewDecision) => {
    if (!agents.reviewUnknownScheduleRun) return;
    setReviewBusy(true);
    setReviewError(null);
    const targetScope = scope;
    try {
      const updated = await agents.reviewUnknownScheduleRun(runId, expectedRevision, decision);
      if (targetScope !== owner.current) return;
      setSelectedDetail(updated);
      setRunsState(prev => ({
        ...prev,
        page: {
          ...prev.page,
          runs: prev.page.runs.map(item => (item.id === updated.run.id ? updated.run : item)),
        },
      }));
    } catch (failure) {
      if (targetScope === owner.current) {
        setReviewError(failure instanceof Error ? failure.message : text.updateFailed);
      }
      throw failure;
    } finally {
      if (targetScope === owner.current) setReviewBusy(false);
    }
  };

  const selectedTarget = scheduleSessionTarget(sessionMode, targetSessionId, sourceSessionId, reuseDerived, workspaceSessions);
  const nextPreviewIso = currentTrigger && previewTriggerNextRun(currentTrigger);
  const zoneMatches = !hostZone || hostZone === Intl.DateTimeFormat().resolvedOptions().timeZone;
  const storageUnavailable = catalogCurrent && catalog.problem === 'storage-unavailable';
  const writeBlocked = busy || storageUnavailable;
  const mutation = async (work: () => Promise<GeneralScheduleCatalog>, done?: () => void) => {
    if (writeBlocked || !owner.current) return; const scope = owner.current; const ticket = ++catalogEpoch.current;
    setBusy(true); setError(null);
    try { const next = await work(); if (scope === owner.current) { if (ticket === catalogEpoch.current) { setCatalog(next); setCatalogOwner({ agents, authority }); } done?.(); } }
    catch (failure) { if (scope === owner.current) setError(failure instanceof Error ? failure.message : text.updateFailed); }
    finally { setBusy(false); }
  };
  const loadMembersFromWorkspaceOrSession = async () => {
    const scope = owner.current, epoch = draftEpoch.current;
    const pick = sessionMode === 'existing' ? targetSessionId : sessionMode === 'derive-from-session' ? sourceSessionId : '';
    const team = pick && workspaceSessions.some(session => session.id === pick) ? await agents.getSessionTeam(pick).catch(() => undefined) : undefined;
    if (scope !== owner.current || epoch !== draftEpoch.current) return;
    const members = team?.members.length ? team.members : activeWorkspace?.team?.members;
    if (members?.length) setWorkers(members.map(member => ({ name: member.name, role: member.role, ...(member.task ? { task: member.task } : {}), ...(member.models[0] ? { model: member.models[0] } : {}) })));
  };
  const deriveFromSelectedSession = async () => {
    const id = sessionMode === 'existing' ? targetSessionId : sourceSessionId;
    const summary = workspaceSessions.find(session => session.id === id && !session.runtime); if (!summary) return;
    const scope = owner.current, epoch = draftEpoch.current;
    const [events, team] = await Promise.all([agents.sessionEvents(id).catch(() => []), agents.getSessionTeam(id).catch(() => undefined)]);
    if (scope !== owner.current || epoch !== draftEpoch.current) return;
    const last = [...events].reverse().find(event => event.body.type === 'prompt.submitted');
    if (!name.trim()) setName(summary.title);
    if (last?.body.type === 'prompt.submitted' && last.body.text.trim()) setPrompt(last.body.text.trim());
    if (!leadModel) setLeadModel(summary.options?.model ?? summary.model ?? '');
    if (!leadEffort) setLeadEffort(summary.options?.effort ?? summary.effort ?? '');
    if (!permissionMode) setPermissionMode(summary.options?.permissionMode ?? '');
    if (team?.members.length) { setTeamMode('custom'); setWorkers(team.members.map(member => ({ name: member.name, role: member.role, ...(member.task ? { task: member.task } : {}), ...(member.models[0] ? { model: member.models[0] } : {}) }))); }
  };
  const handleSave = () => {
    if (!agents.saveSchedule || !editorOpen || !currentTrigger || !selectedTarget) { setError(!selectedTarget ? text.sessionUnavailable : text.invalidTrigger); return; }
    const payload: SaveGeneralScheduleInput = {
      ...(editingId ? { id: editingId, expectedRevision: editingRevision } : {}), workspaceId: activeWorkspaceId,
      name: name.trim(), prompt: prompt.trim(), enabled, trigger: currentTrigger, sessionTarget: selectedTarget,
      assignment: { ...(leadModel ? { leadModel } : {}), ...(leadEffort ? { leadEffort } : {}), ...(permissionMode ? { permissionMode } : {}), teamMode, ...(teamMode === 'custom' && workers.length ? { workers } : {}) }, missedPolicy,
    };
    void mutation(() => agents.saveSchedule!(payload), resetForm);
  };
  const handleRunNow = (schedule: GeneralSchedule) => { const scope = owner.current; void mutation(async () => {
    const next = await agents.runScheduleNow!(schedule.id, schedule.revision);
    const fresh = await agents.getState().catch(() => undefined); if (fresh && scope === owner.current) onState(fresh); return next;
  }); };
  const triggerLabel = (trigger: ScheduleTrigger) => {
    const preset = scheduleTriggerPreset(trigger);
    if (preset.recurrence !== 'custom') return preset.recurrence === 'once' ? formatDateTime(trigger.kind === 'once' ? trigger.runAt : undefined)
      : `${text.recurrences[preset.recurrence]}${preset.recurrence === 'hourly' ? '' : ` · ${preset.time}`}${preset.recurrence === 'weekly' ? ` · ${text.weekdays[Number(preset.weekday)]}` : ''}`;
    return trigger.kind === 'interval' ? text.everyMinutes(trigger.intervalMinutes) : trigger.kind === 'cron' ? trigger.cron : formatDateTime(trigger.runAt);
  };
  if (!supported || !managedWorkspaces.length) return <section className="page"><header className="page-head"><h1>{text.title}</h1><p className="muted">{!supported ? text.hostUnavailable : text.noWorkspaces}</p></header>{supported && <button type="button" className="button primary" onClick={onOpenSettings}><Icon name="settings" />{text.openSettings}</button>}</section>;
  const catalogReady = catalogCurrent && Boolean(catalog.revision);
  const workspaceSchedules = catalogCurrent ? catalog.schedules.filter(schedule => schedule.workspaceId === activeWorkspaceId) : [];
  const suggestions: Suggestion[] = ['projectReview', ...(recentSession ? ['sessionFollowup' as const] : []), ...(knowledgeState?.owner === scope && knowledgeState.available ? ['knowledgeReview' as const] : [])];
  const simpleSession = sessionMode === 'existing' ? targetSessionId : sessionMode === 'create-and-reuse' ? '__new' : '__advanced';
  const touchDraft = () => { draftEpoch.current++; };
  const changeWorker = (index: number, field: 'task' | 'model', value: string) => setWorkers(previous => previous.map((worker, at) => {
    if (at !== index) return worker;
    const next = { ...worker }; if (value) next[field] = value; else delete next[field]; return next;
  }));
  return <section className="page schedules-page" data-testid="schedules-page">
    <header className="page-head"><div><h1>{text.title}</h1><p className="muted">{text.lead}</p></div><div className="row-actions">
      <Select label={text.workspace} value={activeWorkspaceId} options={managedWorkspaces.map(workspace => ({ value: workspace.id, label: workspace.name }))} disabled={busy} onChange={id => { resetForm(); setHistoryScheduleId(''); setSelectedRunId(null); setSelectedDetail(undefined); onSelectWorkspace(id); }} />
      <button type="button" className="button" data-testid="schedules-open-history" onClick={() => historyOpen && !historyScheduleId ? setHistoryOpen(false) : openRunHistory('')}><Icon name="logs" />{historyOpen && !historyScheduleId ? text.hideRuns : text.runHistory}</button>
      <button type="button" className="button primary" disabled={writeBlocked} onClick={() => beginNew()}><Icon name="plus" />{text.newSchedule}</button>
    </div></header>
    <p className="muted small schedule-runtime-hint"><Icon name="clock" />{text.runtimeHint}{' '}{hostZone ? text.hostTimeZone(hostZone) : text.hostLocalTime}</p>
    {storageUnavailable && <p className="note form-error" role="alert">{text.storageUnavailable}</p>}
    {error && <div className="note form-error" role="alert">{error}</div>}
    {!editorOpen && <section className="schedule-suggestions" aria-labelledby="schedule-suggested-title"><h2 id="schedule-suggested-title">{text.suggested}</h2><p className="muted small">{text.suggestionsHint}</p><div className="schedule-suggestion-grid">
      {suggestions.map(key => <button key={key} type="button" className="card schedule-suggestion" disabled={writeBlocked} onClick={() => beginNew(key)}><Icon name={key === 'knowledgeReview' ? 'book' : key === 'sessionFollowup' ? 'chat' : 'check'} /><strong>{text.templates[key].name}</strong><span>{text.templates[key].description}</span><small>{key === 'sessionFollowup' ? recentSession?.title : key === 'knowledgeReview' ? text.knowledgeTemplateSource : activeWorkspace?.name}</small></button>)}
    </div></section>}
    {editorOpen && <section className="card schedule-editor" data-testid="schedule-editor" onInputCapture={touchDraft} onClickCapture={touchDraft} onKeyDownCapture={touchDraft}><fieldset className="schedule-fields" disabled={busy}>
      <div className="card-head"><h2>{editingId ? text.editSchedule : text.newSchedule}</h2><button type="button" className="button small" disabled={busy} onClick={resetForm}>{text.cancelEdit}</button></div>
      <div className="form-grid"><label className="field"><span>{text.nameLabel}</span><input value={name} maxLength={120} onChange={event => setName(event.target.value)} placeholder={text.namePlaceholder} /></label>
        <Select label={text.sessionChoice} value={simpleSession} placeholder={text.chooseSession} options={[{ value: '__new', label: text.newSession }, ...workspaceSessions.map(session => ({ value: session.id, label: session.title, description: text.sessionModes.existing })), ...(simpleSession === '__advanced' ? [{ value: '__advanced', label: text.sessionModes[sessionMode] }] : [])]} disabled={busy} onChange={value => { if (value === '__new') { setSessionMode('create-and-reuse'); setTargetSessionId(''); } else { setSessionMode('existing'); setTargetSessionId(value); } }} />
      </div>
      {sessionMode === 'create-and-reuse' && <p className="muted small">{text.newSessionHint}</p>}
      <label className="field"><span>{text.promptLabel}</span><textarea rows={4} value={prompt} placeholder={text.promptPlaceholder} onChange={event => setPrompt(event.target.value)} /></label>
      <div className="form-grid"><Select label={text.when} value={recurrence} options={(['daily', 'weekdays', 'weekly', 'hourly', 'once', 'custom'] as const).map(value => ({ value, label: text.recurrences[value] }))} disabled={busy} onChange={value => { if (value === 'custom' && currentTrigger?.kind === 'cron') setCron(currentTrigger.cron); setRecurrence(value); if (value !== 'custom') setTriggerKind(value === 'once' ? 'once' : 'cron'); }} />
        {(['daily', 'weekdays', 'weekly'] as Recurrence[]).includes(recurrence) && <label className="field"><span>{text.timeLabel}</span><input type="time" value={time} onChange={event => setTime(event.target.value)} /></label>}
        {recurrence === 'weekly' && <Select label={text.weekdayLabel} value={weekday} options={text.weekdays.map((label, index) => ({ value: String(index), label }))} onChange={setWeekday} />}
        {(recurrence === 'once' || recurrence === 'custom' && triggerKind === 'once') && <label className="field"><span>{text.runAtLabel}</span><input type="datetime-local" value={runAtLocal} onChange={event => setRunAtLocal(event.target.value)} /></label>}
      </div>
      {isCronEditor && <ScheduleTimezoneField text={text} timeZone={timeZone} hostZone={hostZone} isLegacyNoZone={editingLegacyNoZone} disabled={busy} onChangeTimeZone={setTimeZone} />}
      {(recurrence === 'once' || recurrence === 'custom' && triggerKind === 'once') && <p className="muted small">{text.oneOffLocalTime}</p>}
      <p className="muted small" data-testid="schedule-next-preview"><Icon name="clock" />{currentTrigger && currentTrigger.kind !== 'once' && !trimmedTimeZone && !zoneMatches ? text.hostCalculatesNext : nextPreviewIso ? text.nextPreview(formatTimestampInZone(nextPreviewIso, currentTrigger?.kind === 'cron' ? currentTrigger.timeZone : undefined)) : text.invalidTrigger}</p>
      {currentTrigger && <NextRunsPreviewPanel text={text} preview={nextRunsPreview} loading={previewLoading} error={previewError} supported={previewSupported} />}
      {!selectedTarget && <p className="form-error" role="alert">{text.sessionUnavailable}</p>}
      <details className="schedule-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}><summary><Icon name="settings" />{text.advanced}</summary><div className="schedule-advanced-body">
        <div className="form-grid"><Select label={text.triggerKind} value={triggerKind} options={(['cron', 'interval', 'once'] as const).map(value => ({ value, label: text.triggerKinds[value] }))} onChange={value => { setTriggerKind(value); setRecurrence(value === 'once' ? 'once' : 'custom'); }} />
          {triggerKind === 'cron' && <label className="field"><span>{text.cronLabel}</span><input value={recurrence !== 'custom' && currentTrigger?.kind === 'cron' ? currentTrigger.cron : cron} onChange={event => { setCron(event.target.value); setRecurrence('custom'); }} /></label>}
          {triggerKind === 'interval' && <label className="field"><span>{text.intervalLabel}</span><input type="number" min={1} max={10080} value={intervalMinutes} onChange={event => { setIntervalMinutes(event.target.value); setRecurrence('custom'); }} /></label>}
        </div>
        <div className="form-grid"><Select label={text.sessionMode} value={sessionMode} options={(['create-and-reuse', 'existing', 'derive-from-session', 'new-each-run'] as const).map(value => ({ value, label: text.sessionModes[value] }))} onChange={setSessionMode} />
          {sessionMode === 'derive-from-session' && <Select label={text.sourceSession} value={sourceSessionId} placeholder={text.chooseSession} options={workspaceSessions.filter(session => !session.runtime).map(session => ({ value: session.id, label: session.title }))} onChange={setSourceSessionId} />}
        </div>
        {sessionMode === 'derive-from-session' && <div className="row-actions"><label className="checkbox-row"><input type="checkbox" checked={reuseDerived} onChange={event => setReuseDerived(event.target.checked)} />{text.reuseDerived}</label><button type="button" className="button small" disabled={!selectedTarget} onClick={() => void deriveFromSelectedSession()}><Icon name="copy" />{text.derivePromptButton}</button></div>}
        <div className="form-grid" style={{ marginTop: '0.75rem' }}>
          <Select
            label={text.leadModel}
            value={leadModel}
            options={[
              { value: '', label: text.defaultWorkspaceModel },
              ...(choices?.models ?? []).map(model => ({ value: model, label: model })),
              ...(leadModel && !choices?.models.includes(leadModel) ? [{ value: leadModel, label: leadModel }] : []),
            ]}
            onChange={value => setLeadModel(value)}
          />

          {Boolean(choices?.efforts.length || leadEffort) && (
            <Select
              label={text.leadEffort}
              value={leadEffort}
              options={[
                { value: '', label: text.defaultEffort },
                ...(choices?.efforts ?? []).map(effort => ({ value: effort, label: effort })),
                ...(leadEffort && !choices?.efforts.includes(leadEffort) ? [{ value: leadEffort, label: leadEffort }] : []),
              ]}
              onChange={value => setLeadEffort(value as Effort | '')}
            />
          )}

          <Select
            label={text.permissionMode}
            value={permissionMode}
            options={[
              { value: '', label: text.defaultPermission },
              ...(choices?.permissionModes ?? (['workspace', 'ask', 'accept-edits', 'plan'] as const)).map(mode => ({
                value: mode,
                label: text.permissionModes[mode],
              })),
            ]}
            onChange={value => setPermissionMode(value as PermissionMode | '')}
          />

          <Select
            label={text.teamMode}
            value={teamMode}
            options={[
              { value: 'workspace', label: text.teamModes.workspace },
              { value: 'solo', label: text.teamModes.solo },
              { value: 'custom', label: text.teamModes.custom },
            ]}
            onChange={value => setTeamMode(value)}
          />
        </div>

        {teamMode === 'custom' && (
          <div className="card" style={{ marginTop: '0.75rem' }}>
            <div className="card-head">
              <h3>{text.workersLabel}</h3>
              <div className="row-actions">
                <button type="button" className="button small" onClick={() => void loadMembersFromWorkspaceOrSession()}>
                  <Icon name="users" />{text.loadWorkspaceTeam}
                </button>
                <button
                  type="button"
                  className="button small"
                  disabled={workers.length >= 12}
                  onClick={() => setWorkers(prev => [...prev, { name: text.defaultWorkerName(prev.length + 1), role: text.defaultWorkerRole }])}
                >
                  <Icon name="plus" />{text.addWorker}
                </button>
              </div>
            </div>
            {workers.map((worker, index) => (
              <div key={index} className="form-grid" style={{ marginBottom: '0.5rem', alignItems: 'end' }}>
                <label className="field">
                  <span>{text.workerName}</span>
                  <input
                    type="text"
                    value={worker.name}
                    onChange={event => setWorkers(prev => prev.map((item, idx) => idx === index ? { ...item, name: event.target.value } : item))}
                  />
                </label>
                <label className="field">
                  <span>{text.workerRole}</span>
                  <input
                    type="text"
                    value={worker.role}
                    onChange={event => setWorkers(prev => prev.map((item, idx) => idx === index ? { ...item, role: event.target.value } : item))}
                  />
                </label>
                <label className="field">
                  <span>{text.workerTask}</span>
                  <input
                    type="text"
                    value={worker.task ?? ''}
                    onChange={event => changeWorker(index, 'task', event.currentTarget.value)}
                  />
                </label>
                <label className="field"><span>{text.workerModel}</span><input value={worker.model ?? ''} onChange={event => changeWorker(index, 'model', event.currentTarget.value)} /></label>
                <div className="row-actions">
                  <button
                    type="button"
                    className="button small"
                    onClick={() => setWorkers(prev => prev.filter((_, idx) => idx !== index))}
                  >
                    <Icon name="trash" />{text.removeWorker}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="form-grid" style={{ marginTop: '0.75rem' }}>
          <Select
            label={text.missedPolicy}
            value={missedPolicy}
            options={[
              { value: 'skip', label: text.missedPolicies.skip },
              { value: 'run-once', label: text.missedPolicies['run-once'] },
            ]}
            onChange={value => setMissedPolicy(value)}
          />
          <label className="checkbox-row" style={{ alignSelf: 'end' }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={event => setEnabled(event.target.checked)}
            />
            <span>{text.enabledLabel}</span>
          </label>
        </div>
        <p className="muted small schedule-missed-policy-hint">{text.missedPolicyHint}</p>

      </div></details>
      <div className="row-actions schedule-editor-footer"><button type="button" className="button" disabled={busy} onClick={resetForm}>{text.cancelEdit}</button><button type="button" className="button primary" disabled={writeBlocked || !name.trim() || !prompt.trim() || !currentTrigger || !selectedTarget} onClick={handleSave}><Icon name={editingId ? 'check' : 'plus'} />{busy ? text.saving : editingId ? text.saveUpdate : text.saveCreate}</button></div>
    </fieldset></section>}
    {historyOpen && <ScheduleRunHistoryPanel text={text} workspaceName={activeWorkspace?.name} schedules={workspaceSchedules} runs={runsPage.runs} total={runsPage.total} nextCursor={runsPage.nextCursor} loading={runsLoading} loadingMore={runsLoadingMore} error={runsError} supported={historySupported} scheduleFilter={historyScheduleId} stateFilter={historyStateFilter} selectedRunId={selectedRunId} selectedDetail={selectedDetail} detailLoading={detailLoading} reviewBusy={reviewBusy} reviewError={reviewError} onChangeScheduleFilter={value => { setHistoryScheduleId(value); setSelectedRunId(null); setSelectedDetail(undefined); }} onChangeStateFilter={value => { setHistoryStateFilter(value); setSelectedRunId(null); setSelectedDetail(undefined); }} onRefresh={() => void loadRunsManual(false)} onLoadMore={() => { if (runsPage.nextCursor) void loadRunsManual(true, runsPage.nextCursor); }} onSelectRun={handleSelectRun} onCloseDetail={() => { setSelectedRunId(null); setSelectedDetail(undefined); setReviewError(null); }} onClosePanel={() => setHistoryOpen(false)} onOpenSession={onOpenSession} onReviewUnknownRun={handleReviewUnknownRun} />}
    <section className="schedule-list-section" aria-labelledby="schedule-list-title"><h2 id="schedule-list-title">{text.yourSchedules}<span className="badge">{catalogReady ? workspaceSchedules.length : '—'}</span></h2><div className="stack" data-testid="schedule-list">
      {!catalogReady ? <p className="muted" role="status">{error ? text.loadFailed : text.loadingSchedules}</p> : !workspaceSchedules.length ? <div className="card schedule-empty"><Icon name="clock" /><strong>{text.empty}</strong><p className="muted">{text.emptyHint}</p><button type="button" className="button" disabled={writeBlocked} onClick={() => beginNew()}><Icon name="plus" />{text.newSchedule}</button></div> : workspaceSchedules.map(schedule => {
        const linked = schedule.lastSessionId ?? schedule.boundSessionId ?? (schedule.sessionTarget.mode === 'existing' ? schedule.sessionTarget.sessionId : undefined);
        const zoneBadge = scheduleTriggerZoneBadge(schedule.trigger, hostZone, text);
        const scheduleZone = schedule.trigger.kind === 'cron' ? schedule.trigger.timeZone : undefined;
        return <article key={schedule.id} className="card schedule-row" data-testid={`schedule-card-${schedule.id}`}><div className="card-head"><div><h3>{schedule.name}</h3><p className="muted small schedule-card-trigger-line"><span className="badge">{text.states[schedule.state]}</span><span>{triggerLabel(schedule.trigger)}</span>{schedule.trigger.kind === 'cron' && <code>{schedule.trigger.cron}</code>}{zoneBadge && <span className="badge subtle" data-testid={`schedule-zone-badge-${schedule.id}`}>{zoneBadge}</span>}</p></div><div className="row-actions">
          <button type="button" className="button small" data-testid={`schedule-history-btn-${schedule.id}`} onClick={() => openRunHistory(schedule.id)}><Icon name="logs" />{text.viewRuns}</button>
          <button type="button" className="button small" disabled={writeBlocked || schedule.state === 'running'} onClick={() => handleRunNow(schedule)}><Icon name="send" />{text.runNow}</button>
          <button type="button" className="button small" disabled={writeBlocked || schedule.state === 'running'} onClick={() => void mutation(() => agents.setScheduleEnabled!(schedule.id, !schedule.enabled, schedule.revision))}>{schedule.enabled ? text.pause : text.resume}</button>
          <button type="button" className="button small" disabled={writeBlocked || schedule.state === 'running'} onClick={() => beginEdit(schedule)}><Icon name="edit" />{text.edit}</button>
          <button type="button" className="button small" disabled={writeBlocked || schedule.state === 'running'} onClick={() => void mutation(() => agents.deleteSchedule!(schedule.id, schedule.revision), () => { if (editingId === schedule.id) resetForm(); })}><Icon name="trash" />{text.delete}</button>
        </div></div><p className="muted small">{scheduleRecoveryStatus(schedule.recovery, schedule.nextRunAt ? formatTimestampInZone(schedule.nextRunAt, scheduleZone) : undefined, text) ?? (schedule.nextRunAt ? text.nextRun(formatTimestampInZone(schedule.nextRunAt, scheduleZone)) : '—')}{schedule.nextRunAt && scheduleZone ? ` (${schedule.nextRunAt})` : ''}{schedule.lastOutcome && !schedule.recovery ? ` · ${text.outcomes[schedule.lastOutcome]}` : ''}</p>
        <details className="schedule-row-details"><summary>{text.details}</summary><p className="schedule-prompt">{schedule.prompt}</p><p className="muted small">{text.sessionModes[schedule.sessionTarget.mode]} · {text.teamModes[schedule.assignment.teamMode]}{schedule.assignment.leadModel ? ` · ${schedule.assignment.leadModel}` : ''}</p><p className="muted small">{text.runsCount(schedule.runCount)}{schedule.completedRunCount !== undefined ? ` · ${text.completedTurnsCount(schedule.completedRunCount)}` : ''}{schedule.legacyDispatchCount !== undefined ? ` · ${text.legacyDispatchesCount(schedule.legacyDispatchCount)}` : ''}{schedule.lastRunAt ? ` · ${text.lastRun(formatTimestampInZone(schedule.lastRunAt, scheduleZone))}` : ''}</p></details>
        {linked && <button type="button" className="button small" onClick={() => onOpenSession(linked, schedule.workspaceId)}><Icon name="chat" />{text.openSession}</button>}{schedule.lastError && <p className="form-error">{schedule.lastError}</p>}
        </article>;
      })}
    </div></section>
  </section>;
}
