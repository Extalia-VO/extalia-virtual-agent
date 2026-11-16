import type { Effort } from '@extalia/core';
import {
  nextScheduleRunAt,
  parseCronExpression,
  type AgentHostApi,
  type GeneralSchedule,
  type GeneralScheduleCatalog,
  type HostState,
  type ModelChoices,
  type PermissionMode,
  type SaveGeneralScheduleInput,
  type ScheduleMissedPolicy,
  type ScheduleSessionTarget,
  type ScheduleTrigger,
  type ScheduleWorkerAssignment,
} from '@extalia/platform';
import { useEffect, useMemo, useState } from 'react';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';

const CRON_PRESETS = [
  { key: 'every30m', cron: '*/30 * * * *' },
  { key: 'hourly', cron: '0 * * * *' },
  { key: 'daily9am', cron: '0 9 * * *' },
  { key: 'weekdays9am', cron: '0 9 * * 1-5' },
  { key: 'monday9am', cron: '0 9 * * 1' },
] as const;

function defaultOneOffLocal(): string {
  const nextHour = new Date(Date.now() + 3_600_000);
  nextHour.setMinutes(0, 0, 0);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${nextHour.getFullYear()}-${pad(nextHour.getMonth() + 1)}-${pad(nextHour.getDate())}T${pad(nextHour.getHours())}:${pad(nextHour.getMinutes())}`;
}

function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return defaultOneOffLocal();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateTime(iso: string | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return date.toLocaleString();
}

export function previewTriggerNextRun(trigger: ScheduleTrigger, nowMs = Date.now()): string | undefined {
  try {
    if (trigger.kind === 'cron') parseCronExpression(trigger.cron);
    return nextScheduleRunAt(trigger, nowMs);
  } catch {
    return undefined;
  }
}

export function SchedulesPage({
  t,
  agents,
  state,
  workspaceId: initialWorkspaceId,
  onSelectWorkspace,
  onOpenSession,
  onOpenSettings,
  onState,
}: {
  t: Messages;
  agents: AgentHostApi;
  state: HostState;
  workspaceId?: string | undefined;
  onSelectWorkspace: (workspaceId: string) => void;
  onOpenSession: (sessionId: string, workspaceId: string) => void;
  onOpenSettings: () => void;
  onState: (next: HostState) => void;
}) {
  const text = t.schedules;
  const managedWorkspaces = useMemo(
    () => state.workspaces.filter(workspace => workspace.mode !== 'observe'),
    [state.workspaces],
  );
  const activeWorkspaceId = (initialWorkspaceId && managedWorkspaces.some(w => w.id === initialWorkspaceId))
    ? initialWorkspaceId
    : managedWorkspaces[0]?.id ?? '';
  const activeWorkspace = managedWorkspaces.find(w => w.id === activeWorkspaceId);

  const [catalog, setCatalog] = useState<GeneralScheduleCatalog>({ revision: '', schedules: [] });
  const [choices, setChoices] = useState<ModelChoices | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingRevision, setEditingRevision] = useState<number | undefined>(undefined);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [triggerKind, setTriggerKind] = useState<'cron' | 'interval' | 'once'>('cron');
  const [cron, setCron] = useState('0 9 * * 1-5');
  const [intervalMinutes, setIntervalMinutes] = useState('60');
  const [runAtLocal, setRunAtLocal] = useState(defaultOneOffLocal);
  const [sessionMode, setSessionMode] = useState<ScheduleSessionTarget['mode']>('create-and-reuse');
  const [targetSessionId, setTargetSessionId] = useState('');
  const [sourceSessionId, setSourceSessionId] = useState('');
  const [reuseDerived, setReuseDerived] = useState(true);
  const [leadModel, setLeadModel] = useState('');
  const [leadEffort, setLeadEffort] = useState<Effort | ''>('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode | ''>('');
  const [teamMode, setTeamMode] = useState<'workspace' | 'solo' | 'custom'>('workspace');
  const [workers, setWorkers] = useState<ScheduleWorkerAssignment[]>([]);
  const [missedPolicy, setMissedPolicy] = useState<ScheduleMissedPolicy>('skip');

  const supported = Boolean(
    agents.listSchedules && agents.saveSchedule && agents.setScheduleEnabled && agents.runScheduleNow && agents.deleteSchedule,
  );

  const workspaceSessions = useMemo(
    () => state.sessions.filter(session => session.workspaceId === activeWorkspaceId && session.control !== 'observed'),
    [state.sessions, activeWorkspaceId],
  );

  useEffect(() => {
    if (!supported || !agents.listSchedules) return;
    let cancelled = false;
    const load = () => {
      agents.listSchedules!().then(next => {
        if (!cancelled) setCatalog(next);
      }, () => undefined);
    };
    load();
    const unsubscribe = agents.subscribe(() => load());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [agents, supported]);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    let cancelled = false;
    agents.modelChoices(activeWorkspaceId).then(next => {
      if (!cancelled) setChoices(next);
    }, () => {
      if (!cancelled) setChoices(null);
    });
    return () => { cancelled = true; };
  }, [agents, activeWorkspaceId]);

  const resetForm = () => {
    setEditingId(null);
    setEditingRevision(undefined);
    setName('');
    setPrompt('');
    setEnabled(true);
    setTriggerKind('cron');
    setCron('0 9 * * 1-5');
    setIntervalMinutes('60');
    setRunAtLocal(defaultOneOffLocal());
    setSessionMode('create-and-reuse');
    setTargetSessionId(workspaceSessions[0]?.id ?? '');
    setSourceSessionId(workspaceSessions[0]?.id ?? '');
    setReuseDerived(true);
    setLeadModel('');
    setLeadEffort('');
    setPermissionMode('');
    setTeamMode('workspace');
    setWorkers([]);
    setMissedPolicy('skip');
    setError(null);
  };

  const beginEdit = (schedule: GeneralSchedule) => {
    setEditingId(schedule.id);
    setEditingRevision(schedule.revision);
    if (schedule.workspaceId !== activeWorkspaceId) onSelectWorkspace(schedule.workspaceId);
    setName(schedule.name);
    setPrompt(schedule.prompt);
    setEnabled(schedule.enabled);
    setTriggerKind(schedule.trigger.kind);
    if (schedule.trigger.kind === 'cron') setCron(schedule.trigger.cron);
    else if (schedule.trigger.kind === 'interval') setIntervalMinutes(String(schedule.trigger.intervalMinutes));
    else setRunAtLocal(isoToLocalInput(schedule.trigger.runAt));

    setSessionMode(schedule.sessionTarget.mode);
    if (schedule.sessionTarget.mode === 'existing') setTargetSessionId(schedule.sessionTarget.sessionId);
    if (schedule.sessionTarget.mode === 'derive-from-session') {
      setSourceSessionId(schedule.sessionTarget.sourceSessionId);
      setReuseDerived(schedule.sessionTarget.reuseDerived !== false);
    }
    setLeadModel(schedule.assignment.leadModel ?? '');
    setLeadEffort(schedule.assignment.leadEffort ?? '');
    setPermissionMode(schedule.assignment.permissionMode ?? '');
    setTeamMode(schedule.assignment.teamMode);
    setWorkers(schedule.assignment.workers ? schedule.assignment.workers.map(w => ({ ...w })) : []);
    setMissedPolicy(schedule.missedPolicy);
    setError(null);
  };

  const currentTrigger: ScheduleTrigger | null = useMemo(() => {
    if (triggerKind === 'cron') {
      return cron.trim() ? { kind: 'cron', cron: cron.trim() } : null;
    }
    if (triggerKind === 'interval') {
      const minutes = Number(intervalMinutes);
      return Number.isSafeInteger(minutes) && minutes >= 1 ? { kind: 'interval', intervalMinutes: minutes } : null;
    }
    const ms = Date.parse(runAtLocal);
    return Number.isFinite(ms) ? { kind: 'once', runAt: new Date(ms).toISOString() } : null;
  }, [triggerKind, cron, intervalMinutes, runAtLocal]);

  const nextPreviewIso = useMemo(
    () => (currentTrigger ? previewTriggerNextRun(currentTrigger) : undefined),
    [currentTrigger],
  );

  const loadMembersFromWorkspaceOrSession = async () => {
    const pickSessionId = sessionMode === 'existing' ? targetSessionId : sessionMode === 'derive-from-session' ? sourceSessionId : '';
    if (pickSessionId) {
      const team = await agents.getSessionTeam(pickSessionId).catch(() => undefined);
      if (team?.members.length) {
        setWorkers(team.members.map(member => ({
          name: member.name,
          role: member.role,
          ...(member.task ? { task: member.task } : {}),
          ...(member.models[0] ? { model: member.models[0] } : {}),
        })));
        return;
      }
    }
    if (activeWorkspace?.team?.members.length) {
      setWorkers(activeWorkspace.team.members.map(member => ({
        name: member.name,
        role: member.role,
        ...(member.task ? { task: member.task } : {}),
        ...(member.models[0] ? { model: member.models[0] } : {}),
      })));
    }
  };

  const deriveFromSelectedSession = async () => {
    const id = sessionMode === 'existing' ? targetSessionId : sourceSessionId || workspaceSessions[0]?.id;
    if (!id) return;
    const summary = workspaceSessions.find(item => item.id === id);
    if (summary && !name.trim()) setName(summary.title);
    const summaryModel = summary?.options?.model ?? summary?.model;
    const summaryEffort = summary?.options?.effort ?? summary?.effort;
    const summaryPermission = summary?.options?.permissionMode;
    if (summaryModel && !leadModel) setLeadModel(summaryModel);
    if (summaryEffort && !leadEffort) setLeadEffort(summaryEffort);
    if (summaryPermission && !permissionMode) setPermissionMode(summaryPermission);
    const events = await agents.sessionEvents(id).catch(() => []);
    const lastPrompt = [...events].reverse().find(event => event.body.type === 'prompt.submitted');
    if (lastPrompt && lastPrompt.body.type === 'prompt.submitted' && lastPrompt.body.text.trim()) {
      setPrompt(lastPrompt.body.text.trim());
    }
    const team = await agents.getSessionTeam(id).catch(() => undefined);
    if (team?.members.length) {
      setTeamMode('custom');
      setWorkers(team.members.map(member => ({
        name: member.name,
        role: member.role,
        ...(member.task ? { task: member.task } : {}),
        ...(member.models[0] ? { model: member.models[0] } : {}),
      })));
    }
  };

  const handleSave = async () => {
    if (!agents.saveSchedule || !activeWorkspaceId || !currentTrigger) {
      setError(text.invalidTrigger);
      return;
    }
    const sessionTarget: ScheduleSessionTarget = sessionMode === 'existing'
      ? { mode: 'existing', sessionId: targetSessionId || workspaceSessions[0]?.id || '' }
      : sessionMode === 'derive-from-session'
        ? { mode: 'derive-from-session', sourceSessionId: sourceSessionId || workspaceSessions[0]?.id || '', reuseDerived }
        : { mode: sessionMode };
    const payload: SaveGeneralScheduleInput = {
      ...(editingId ? { id: editingId, expectedRevision: editingRevision } : {}),
      workspaceId: activeWorkspaceId,
      name: name.trim(),
      prompt: prompt.trim(),
      enabled,
      trigger: currentTrigger,
      sessionTarget,
      assignment: {
        ...(leadModel ? { leadModel } : {}),
        ...(leadEffort ? { leadEffort } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        teamMode,
        ...(teamMode === 'custom' && workers.length ? { workers } : {}),
      },
      missedPolicy,
    };
    setBusy(true);
    setError(null);
    try {
      const next = await agents.saveSchedule(payload);
      setCatalog(next);
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : text.invalidTrigger);
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (schedule: GeneralSchedule) => {
    if (!agents.setScheduleEnabled) return;
    setBusy(true);
    setError(null);
    try {
      setCatalog(await agents.setScheduleEnabled(schedule.id, !schedule.enabled, schedule.revision));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update schedule.');
    } finally {
      setBusy(false);
    }
  };

  const handleRunNow = async (schedule: GeneralSchedule) => {
    if (!agents.runScheduleNow) return;
    setBusy(true);
    setError(null);
    try {
      const next = await agents.runScheduleNow(schedule.id, schedule.revision);
      setCatalog(next);
      const freshState = await agents.getState().catch(() => undefined);
      if (freshState) onState(freshState);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scheduled run failed.');
      if (agents.listSchedules) {
        const refreshed = await agents.listSchedules().catch(() => undefined);
        if (refreshed) setCatalog(refreshed);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (schedule: GeneralSchedule) => {
    if (!agents.deleteSchedule) return;
    setBusy(true);
    setError(null);
    try {
      setCatalog(await agents.deleteSchedule(schedule.id, schedule.revision));
      if (editingId === schedule.id) resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete schedule.');
    } finally {
      setBusy(false);
    }
  };

  if (!supported) {
    return (
      <section className="page">
        <header className="page-head">
          <h1>{text.title}</h1>
          <p className="muted">{text.hostUnavailable}</p>
        </header>
      </section>
    );
  }

  if (!managedWorkspaces.length) {
    return (
      <section className="page">
        <header className="page-head">
          <h1>{text.title}</h1>
          <p className="muted">{text.noWorkspaces}</p>
        </header>
        <div className="row-actions">
          <button type="button" className="button primary" onClick={onOpenSettings}>
            <Icon name="settings" />{text.openSettings}
          </button>
        </div>
      </section>
    );
  }

  const workspaceSchedules = catalog.schedules.filter(item => item.workspaceId === activeWorkspaceId);

  return (
    <section className="page" data-testid="schedules-page">
      <header className="page-head">
        <div>
          <h1>{text.title}</h1>
          <p className="muted">{text.lead}</p>
        </div>
        <div className="row-actions">
          <Select
            label={text.workspace}
            value={activeWorkspaceId}
            options={managedWorkspaces.map(workspace => ({ value: workspace.id, label: workspace.name }))}
            onChange={id => { onSelectWorkspace(id); resetForm(); }}
          />
        </div>
      </header>

      {error && (
        <div className="card" role="alert">
          <p className="error-text"><Icon name="alert" /> {error}</p>
        </div>
      )}

      <div className="card" data-testid="schedule-editor">
        <div className="card-head">
          <h2>{editingId ? text.editSchedule : text.newSchedule}</h2>
          {editingId && (
            <button type="button" className="button small" onClick={resetForm}>
              {text.cancelEdit}
            </button>
          )}
        </div>

        <div className="form-grid">
          <label className="field">
            <span>{text.nameLabel}</span>
            <input
              type="text"
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder={text.namePlaceholder}
              maxLength={120}
            />
          </label>

          <Select
            label={text.triggerKind}
            value={triggerKind}
            options={[
              { value: 'cron', label: text.triggerKinds.cron },
              { value: 'interval', label: text.triggerKinds.interval },
              { value: 'once', label: text.triggerKinds.once },
            ]}
            onChange={value => setTriggerKind(value)}
          />
        </div>

        {triggerKind === 'cron' && (
          <div className="field">
            <label>
              <span>{text.cronLabel}</span>
              <input
                type="text"
                value={cron}
                onChange={event => setCron(event.target.value)}
                placeholder="0 9 * * 1-5"
              />
            </label>
            <div className="row-actions" style={{ marginTop: '0.5rem', flexWrap: 'wrap' }}>
              {CRON_PRESETS.map(preset => (
                <button
                  key={preset.key}
                  type="button"
                  className="button small"
                  onClick={() => setCron(preset.cron)}
                >
                  {text.cronPresets[preset.key]} ({preset.cron})
                </button>
              ))}
            </div>
          </div>
        )}

        {triggerKind === 'interval' && (
          <label className="field">
            <span>{text.intervalLabel}</span>
            <input
              type="number"
              min={1}
              max={10080}
              value={intervalMinutes}
              onChange={event => setIntervalMinutes(event.target.value)}
            />
          </label>
        )}

        {triggerKind === 'once' && (
          <label className="field">
            <span>{text.runAtLabel}</span>
            <input
              type="datetime-local"
              value={runAtLocal}
              onChange={event => setRunAtLocal(event.target.value)}
            />
          </label>
        )}

        <p className="muted" data-testid="schedule-next-preview">
          <Icon name="clock" /> {nextPreviewIso ? text.nextPreview(formatDateTime(nextPreviewIso)) : text.invalidTrigger}
        </p>

        <div className="form-grid">
          <Select
            label={text.sessionMode}
            value={sessionMode}
            options={[
              { value: 'create-and-reuse', label: text.sessionModes['create-and-reuse'] },
              { value: 'existing', label: text.sessionModes.existing },
              { value: 'derive-from-session', label: text.sessionModes['derive-from-session'] },
              { value: 'new-each-run', label: text.sessionModes['new-each-run'] },
            ]}
            onChange={value => setSessionMode(value)}
          />

          {sessionMode === 'existing' && (
            <Select
              label={text.targetSession}
              value={targetSessionId || workspaceSessions[0]?.id || ''}
              placeholder={text.chooseSession}
              options={workspaceSessions.map(session => ({ value: session.id, label: session.title }))}
              onChange={value => setTargetSessionId(value)}
            />
          )}

          {sessionMode === 'derive-from-session' && (
            <Select
              label={text.sourceSession}
              value={sourceSessionId || workspaceSessions[0]?.id || ''}
              placeholder={text.chooseSession}
              options={workspaceSessions.map(session => ({ value: session.id, label: session.title }))}
              onChange={value => setSourceSessionId(value)}
            />
          )}
        </div>

        {sessionMode === 'derive-from-session' && (
          <div className="row-actions" style={{ marginTop: '0.5rem' }}>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={reuseDerived}
                onChange={event => setReuseDerived(event.target.checked)}
              />
              <span>{text.reuseDerived}</span>
            </label>
            <button type="button" className="button small" onClick={() => void deriveFromSelectedSession()}>
              <Icon name="copy" />{text.derivePromptButton}
            </button>
          </div>
        )}

        <label className="field" style={{ marginTop: '0.75rem' }}>
          <span>{text.promptLabel}</span>
          <textarea
            rows={3}
            value={prompt}
            onChange={event => setPrompt(event.target.value)}
            placeholder={text.promptPlaceholder}
          />
        </label>

        <div className="form-grid" style={{ marginTop: '0.75rem' }}>
          <Select
            label={text.leadModel}
            value={leadModel}
            options={[
              { value: '', label: text.defaultWorkspaceModel },
              ...(choices?.models ?? []).map(model => ({ value: model, label: model })),
            ]}
            onChange={value => setLeadModel(value)}
          />

          {Boolean(choices?.efforts.length) && (
            <Select
              label={text.leadEffort}
              value={leadEffort}
              options={[
                { value: '', label: text.defaultEffort },
                ...(choices?.efforts ?? []).map(effort => ({ value: effort, label: effort })),
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
                  onClick={() => setWorkers(prev => [...prev, { name: `Worker ${prev.length + 1}`, role: 'Engineer' }])}
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
                    onChange={event => setWorkers(prev => prev.map((item, idx) => idx === index ? { ...item, ...(event.target.value ? { task: event.target.value } : {}) } : item))}
                  />
                </label>
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

        <div className="row-actions" style={{ marginTop: '1rem' }}>
          <button
            type="button"
            className="button primary"
            disabled={busy || !name.trim() || !prompt.trim() || !nextPreviewIso}
            onClick={() => void handleSave()}
          >
            <Icon name={editingId ? 'check' : 'plus'} />
            {busy ? text.saving : editingId ? text.saveUpdate : text.saveCreate}
          </button>
        </div>
      </div>

      <div className="stack" style={{ marginTop: '1rem' }} data-testid="schedule-list">
        {!workspaceSchedules.length ? (
          <div className="card">
            <p className="muted">{text.empty}</p>
          </div>
        ) : (
          workspaceSchedules.map(schedule => {
            const linkedSessionId = schedule.lastSessionId ?? schedule.boundSessionId ?? (schedule.sessionTarget.mode === 'existing' ? schedule.sessionTarget.sessionId : undefined);
            const triggerText = schedule.trigger.kind === 'cron'
              ? `Cron: ${schedule.trigger.cron}`
              : schedule.trigger.kind === 'interval'
                ? `${schedule.trigger.intervalMinutes} min`
                : formatDateTime(schedule.trigger.runAt);
            return (
              <article key={schedule.id} className="card" data-testid={`schedule-card-${schedule.id}`}>
                <div className="card-head">
                  <div>
                    <h3>{schedule.name}</h3>
                    <p className="muted">
                      <span className="badge">{text.states[schedule.state]}</span>
                      {' · '}
                      <code>{triggerText}</code>
                      {' · '}
                      {text.sessionModes[schedule.sessionTarget.mode]}
                      {' · '}
                      {text.teamModes[schedule.assignment.teamMode]}
                      {schedule.assignment.leadModel ? ` (${schedule.assignment.leadModel})` : ''}
                    </p>
                  </div>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="button small"
                      disabled={busy || schedule.state === 'running'}
                      onClick={() => void handleRunNow(schedule)}
                    >
                      <Icon name="send" />{text.runNow}
                    </button>
                    <button
                      type="button"
                      className="button small"
                      disabled={busy || schedule.state === 'running'}
                      onClick={() => void handleToggle(schedule)}
                    >
                      {schedule.enabled ? text.pause : text.resume}
                    </button>
                    <button
                      type="button"
                      className="button small"
                      disabled={busy || schedule.state === 'running'}
                      onClick={() => beginEdit(schedule)}
                    >
                      <Icon name="edit" />{text.edit}
                    </button>
                    <button
                      type="button"
                      className="button small"
                      disabled={busy || schedule.state === 'running'}
                      onClick={() => void handleDelete(schedule)}
                    >
                      <Icon name="trash" />{text.delete}
                    </button>
                  </div>
                </div>
                <p style={{ whiteSpace: 'pre-wrap', margin: '0.5rem 0' }}>{schedule.prompt}</p>
                <div className="row-actions" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                  <span className="muted">
                    {schedule.nextRunAt ? text.nextRun(formatDateTime(schedule.nextRunAt)) : '—'}
                    {schedule.lastRunAt ? ` · ${text.lastRun(formatDateTime(schedule.lastRunAt))}` : ''}
                    {schedule.lastOutcome ? ` · ${text.outcomes[schedule.lastOutcome]}` : ''}
                    {` · ${text.runsCount(schedule.runCount)}`}
                  </span>
                  {linkedSessionId && (
                    <button
                      type="button"
                      className="button small"
                      onClick={() => onOpenSession(linkedSessionId, schedule.workspaceId)}
                    >
                      <Icon name="chat" />{text.openSession}
                    </button>
                  )}
                </div>
                {schedule.lastError && <p className="error-text" style={{ marginTop: '0.5rem' }}>{schedule.lastError}</p>}
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
