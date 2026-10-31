import type { AgentHostApi, ConnectionView, HostMissionRecoveryResult, HostMissionRun, HostMissionTask, SessionSummary } from '@extalia/platform';
import type { Workspace } from '@extalia/core';
import type { ExtaliaEvent, MissionState } from '@extalia/protocol';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Markdown } from '../chat/Markdown';
import { useSessionEvents } from '../chat/useSessionEvents';
import { errorMessage } from '../host/remote';
import type { Language, Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { ProviderLogo } from '../ui/ProviderLogo';
import { hasWriteTasks, MissionChanges, missionChangesSupported } from './MissionChanges';
import { MissionDag } from './MissionDag';
import { isNeverStarted, isTerminalRun, missionBudgetView, missionGraphTasks, missionProgress, shortId, taskTone } from './missionModel';

const POLL_MS = 1500;
const HIDDEN_POLL_MS = 6000;

export function StateChip({ t, state, notStarted = false }: { t: Messages; state: HostMissionTask['state'] | MissionState; notStarted?: boolean }) {
  const r = t.missions.run;
  const tone = notStarted ? 'off' : taskTone(state);
  const label = notStarted ? r.notStarted : state === 'recovering' ? r.states.recovering : (r.taskStates as Record<string, string>)[state] ?? state;
  return <span className="mission-state" data-tone={tone}>{tone === 'running' && <span className="pulse" aria-hidden="true" />}{label}</span>;
}

function eventLine(t: Messages, event: ExtaliaEvent, titleOf: (taskId?: string, agentId?: string) => string): string | null {
  const e = t.missions.run.eventText;
  const task = titleOf(event.taskId, event.agentId);
  const body = event.body;
  switch (body.type) {
    case 'prompt.submitted': return e.started;
    case 'turn.completed': return event.taskId ? e.completed(task) : e.finished;
    case 'turn.failed': return event.taskId ? e.stopped(task, body.error) : e.ended(body.error);
    case 'task.created': return e.created(task);
    case 'subagent.spawned': return e.spawned(body.label ?? task);
    case 'task.completed': return body.ok ? e.completed(task) : e.stopped(task, body.summary ?? '');
    // ADR 0028: a write-capable worker's edit names the tool and, when bounded, its worktree-relative path.
    case 'tool.started': return body.kind === 'edit' ? e.edited(task, body.target) : e.tool(task, body.label ?? body.tool);
    case 'model.completed': return e.answered(task);
    case 'agent.state': return body.summary ? e.stopped(task, body.summary) : null;
    case 'tool.completed': case 'model.delta': return null;
    default: return e.other(task, body.type);
  }
}

/** Live mission status: polls `nativeMissionRun` while running and refreshes on correlated session events. */
export function MissionMonitor({ t, language, agents, session, connections, initial, onBack, onChanged, workspace, onEditGate }: {
  t: Messages;
  language: Language;
  agents: AgentHostApi;
  session: SessionSummary;
  connections: readonly ConnectionView[];
  initial: HostMissionRun;
  onBack(): void;
  onChanged(run: HostMissionRun): void;
  /** The mission's workspace: its integration test gate pre-fills the Changes panel (ADR 0028). */
  workspace?: Workspace | undefined;
  onEditGate?: ((workspaceId: string) => void) | undefined;
}) {
  const r = t.missions.run;
  const headingId = useId();
  const [run, setRun] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [recovery, setRecovery] = useState<HostMissionRecoveryResult | null>(null);
  const inspection = useRef({ generation: 0, active: true, pending: false });
  useEffect(() => {
    const guard = inspection.current;
    guard.active = true;
    return () => { guard.active = false; guard.pending = false; guard.generation++; };
  }, [agents, session.id, initial.id]);
  const { events } = useSessionEvents(agents, session.id);
  const missionEvents = useMemo(() => events.filter(event => event.correlationId === run.id), [events, run.id]);
  const running = !isTerminalRun(run);

  // Poll while running; a new correlated event restarts the chain so changes show at once.
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const generation = inspection.current.generation;
      try {
        const next = await agents.nativeMissionRun(session.id, initial.id);
        if (!active || !inspection.current.active || inspection.current.pending || generation !== inspection.current.generation) return;
        setRun(next); setError(null); onChanged(next);
        if (!isTerminalRun(next)) timer = setTimeout(() => void tick(), document.visibilityState === 'hidden' ? HIDDEN_POLL_MS : POLL_MS);
      } catch (failure) {
        if (!active || !inspection.current.active || inspection.current.pending || generation !== inspection.current.generation) return;
        setError(errorMessage(failure));
        timer = setTimeout(() => void tick(), HIDDEN_POLL_MS);
      }
    };
    void tick();
    return () => { active = false; clearTimeout(timer); };
    // onChanged is a notification only; the chain restarts per mission and per correlated event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, session.id, initial.id, missionEvents.length]);

  const cancel = async () => {
    setCancelling(true); setError(null);
    try { await agents.cancel(session.id); setConfirming(false); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setCancelling(false); }
  };

  const refreshRecovery = async () => {
    if (!agents.refreshNativeMissionRecovery || inspection.current.pending) return;
    const generation = ++inspection.current.generation;
    inspection.current.pending = true;
    const current = () => inspection.current.active && generation === inspection.current.generation;
    setRefreshing(true); setError(null); setRecovery(null);
    try {
      const result = await agents.refreshNativeMissionRecovery(session.id, run.id);
      if (!current()) return;
      setRecovery(result); setRun(result.run); onChanged(result.run);
    } catch { if (current()) setError(r.recoveryReasons['core-unavailable']); }
    finally {
      if (current()) {
        inspection.current.pending = false; inspection.current.generation++; setRefreshing(false);
      }
    }
  };

  const progress = missionProgress(run);
  const graphTasks = missionGraphTasks(run);
  const connectionOf = (id: string) => connections.find(connection => connection.id === id);
  const byTaskId = new Map(run.tasks.map(task => [task.taskId, task]));
  const byAgentId = new Map(run.tasks.map(task => [task.agentId, task]));
  const titleOf = (taskId?: string, agentId?: string) => (taskId && byTaskId.get(taskId)?.title) || (agentId && byAgentId.get(agentId)?.title) || r.mission;
  const time = (iso: string) => new Date(iso).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const lines = missionEvents.flatMap(event => { const text = eventLine(t, event, titleOf); return text ? [{ id: event.id, at: event.at, text }] : []; }).slice(-12).reverse();
  const detail = r.progressDetail(progress.running, progress.failed);
  const budget = missionBudgetView(run);
  const number = (value: number) => value.toLocaleString(language);

  return (
    <section className="card mission-monitor" aria-labelledby={headingId}>
      <button type="button" className="button small back-to-list" onClick={onBack}><Icon name="chevron" className="flip" />{r.back}</button>
      <header className="mission-monitor-head">
        <div>
          <h2 id={headingId} className="mission-heading">{run.title}</h2>
          <p className="muted small">{r.updated(time(run.updatedAt))}</p>
        </div>
        <StateChip t={t} state={run.state} />
      </header>

      <div className="mission-progress" role="status" aria-live="polite">
        <strong>{r.progress(progress.completed, progress.total)}</strong>
        {detail && <span className="muted"> · {detail}</span>}
        {/* No evidence is ever attached by this kernel, so answers stay unverified. */}
        {progress.evidence === 0 && <span className="badge warn"><Icon name="alert" />{r.unverified}</span>}
      </div>
      <p className="muted small">{r.unverifiedHint}</p>
      {budget.exhausted && <p className="warning" role="alert"><Icon name="alert" />{r.exhausted[budget.exhausted] ?? budget.exhausted}</p>}
      <section className="mission-usage" aria-label={r.usage}>
        <p>
          <strong>{r.usage}: </strong>
          {!budget.reported ? <span className="muted">{r.usageNotRecorded}</span>
            : budget.tokens === undefined ? <span>{r.usageUnknown}</span>
              : <span>{budget.maxTokens !== undefined ? r.tokensOf(number(budget.tokens), number(budget.maxTokens)) : r.tokens(number(budget.tokens))}
                {budget.inputTokens !== undefined && budget.outputTokens !== undefined && <span className="muted"> ({r.tokensSplit(number(budget.inputTokens), number(budget.outputTokens))})</span>}</span>}
        </p>
        {budget.lowerBound && <p className="muted small">{r.lowerBound(budget.unknownTasks)}</p>}
        {run.budget && <p className="muted small">{r.limits}: {[
          budget.maxTokens !== undefined ? r.limitTokens(number(budget.maxTokens)) : '',
          budget.maxTaskTokens !== undefined ? r.limitTask(number(budget.maxTaskTokens)) : '',
          budget.maxDurationMs !== undefined ? r.limitDuration(number(Math.round(budget.maxDurationMs / 6_000) / 10)) : '',
        ].filter(Boolean).join(' · ') || r.noBudget}</p>}
      </section>
      {run.transient && <p className="note"><Icon name="alert" />{r.transient}</p>}
      {run.state === 'recovering' && <p className="warning" role="alert"><Icon name="alert" />{r.recovering}</p>}
      {run.tasks.some(task => task.state === 'unknown') && run.state !== 'recovering' && <p className="warning"><Icon name="alert" />{r.unknown}</p>}
      {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}

      {run.state === 'recovering' && <section aria-label={r.recoveryInspection}>
        {typeof agents.refreshNativeMissionRecovery === 'function'
          ? <button type="button" className="button small" disabled={refreshing} onClick={() => void refreshRecovery()}>{refreshing ? r.refreshingRecovery : r.refreshRecovery}</button>
          : <p className="muted small">{r.recoveryUnsupported}</p>}
      </section>}
      {recovery && <section className="mission-recovery" aria-label={r.recoveryInspection} aria-live="polite">
        {recovery.reason && <p className="warning">{r.recoveryReasons[recovery.reason]}</p>}
        {recovery.status === 'refreshed' && <p className="note">{r.recoveryRefreshed}</p>}
        {recovery.snapshot && <>
          <p><strong>{r.canonicalState}: </strong><StateChip t={t} state={recovery.snapshot.state} /></p>
          <p className="muted small">{r.snapshotDetail(recovery.snapshot.version, recovery.snapshot.sequence, recovery.snapshot.leases.length)}</p>
          <ul>{recovery.snapshot.tasks.map(task => <li key={task.taskId}>
            {byTaskId.get(task.taskId)?.title ?? task.taskId}: <StateChip t={t} state={task.state} />
          </li>)}</ul>
        </>}
        {recovery.reviewInspection && <section aria-label={r.recoveryReview}>
          <h4>{r.recoveryReview}</h4>
          {recovery.reviewInspection.status === 'available' ? <>
            <p className="muted small">{r.recoveryReviewScope}</p>
            {recovery.reviewInspection.review.missingAdmissionTaskIds.length ? <>
              <p>{r.recoveryReviewMissing}</p>
              <ul>{recovery.reviewInspection.review.missingAdmissionTaskIds.map(id => <li key={id}>{byTaskId.get(id)?.title ?? id}</li>)}</ul>
            </> : <p className="muted small">{r.recoveryReviewComplete}</p>}
            <details><summary>{r.recoveryReviewId}</summary><code style={{ overflowWrap: 'anywhere', whiteSpace: 'normal' }}>{recovery.reviewInspection.review.reviewDigest}</code></details>
          </> : <p className="muted small">{recovery.reviewInspection.status === 'unsupported' ? r.recoveryReviewUnsupported : r.recoveryReviewUnavailable}</p>}
        </section>}
        {recovery.executionInspection && <section aria-label={r.executionObservations}>
          <h4>{r.executionObservations}</h4>
          <p className="muted small">{r.executionObservationLimit}</p>
          {recovery.executionInspection.status === 'available'
            ? recovery.executionInspection.executions.length
              ? <ul>{recovery.executionInspection.executions.map(record => <li key={record.admission.leaseId}>
                {byTaskId.get(record.admission.taskId)?.title ?? record.admission.taskId}: {record.observation ? r.executionTurnSettled : r.executionTurnPending}
                <p className="muted small">{record.localDrain ? <>{r.executionLocalDrained} · {r.executionLocalCounts(record.localDrain.providerOperations, record.localDrain.toolOperations)}</> : r.executionLocalUnverified}</p>
              </li>)}</ul>
              : <p className="muted small">{r.executionNoAdmissions}</p>
            : <p className="muted small">{recovery.executionInspection.status === 'unsupported' ? r.executionUnsupported : r.executionUnavailable}</p>}
          {recovery.executionInspection.status === 'available' && recovery.executionInspection.executions.some(record => record.localDrain) && <p className="muted small">{r.executionLocalLimit}</p>}
        </section>}
      </section>}

      {running && run.state !== 'recovering' && (
        <div className="actions">
          {confirming
            ? <>
              <span className="mission-confirm-text">{r.cancelConfirm}</span>
              <button type="button" className="danger" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? r.cancelling : r.cancel}</button>
              <button type="button" disabled={cancelling} onClick={() => setConfirming(false)}>{t.common.cancel}</button>
            </>
            : <button type="button" onClick={() => setConfirming(true)}><Icon name="stop" />{r.cancel}</button>}
        </div>
      )}

      {graphTasks
        ? <MissionDag t={t} label={t.missions.plan.graph} nodes={graphTasks.map(task => ({
          key: task.taskId, id: task.id, title: task.title, dependsOn: task.dependsOn,
          tone: isNeverStarted(run, task) ? 'off' : taskTone(task.state), status: <StateChip t={t} state={task.state} notStarted={isNeverStarted(run, task)} />,
          meta: <><span>{connectionOf(task.connectionId)?.name ?? task.connectionId}</span><code>{task.model}</code></>,
        }))} />
        : <p className="muted small">{r.graphMissing}</p>}

      <ol className="mission-task-list">
        {run.tasks.map(task => {
          const connection = connectionOf(task.connectionId);
          const notStarted = isNeverStarted(run, task);
          return (
            <li key={task.taskId} className="mission-task" data-tone={notStarted ? 'off' : taskTone(task.state)}>
              <header className="mission-task-head">
                <h3>{task.title}</h3>
                <StateChip t={t} state={task.state} notStarted={notStarted} />
              </header>
              <p className="mission-task-meta">
                <span title={task.agentId}><Icon name="users" />{r.worker(shortId(task.agentId))}</span>
                <span>{connection && <span className="mission-logo" aria-hidden="true"><ProviderLogo preset={connection.preset} /></span>}{connection?.name ?? task.connectionId}</span>
                <code>{task.model}</code>
                <span className="muted">{task.id}</span>
              </p>
              {task.usage && <p className="muted small mission-task-usage">{task.usage.inputTokens !== undefined || task.usage.outputTokens !== undefined
                ? r.taskUsage(number((task.usage.inputTokens ?? 0) + (task.usage.outputTokens ?? 0))) : ''}{task.usage.unknown ? `${task.usage.inputTokens !== undefined || task.usage.outputTokens !== undefined ? ' · ' : ''}${r.taskUsageUnknown}` : ''}</p>}
              {task.reason && <p className={task.state === 'unknown' ? 'warning' : 'form-error'}><Icon name="alert" />{r.reasons[task.reason] ?? task.reason}</p>}
              {task.answer !== undefined
                ? <details className="mission-answer" open={run.tasks.length <= 3}>
                  <summary><span>{r.answer}</span><span className="badge warn"><Icon name="alert" />{r.unverifiedBadge}</span></summary>
                  <div className="mission-answer-body"><Markdown text={task.answer} /></div>
                </details>
                : task.state === 'completed' && <p className="muted small">{r.noAnswer}</p>}
            </li>
          );
        })}
      </ol>

      {hasWriteTasks(run) && missionChangesSupported(agents) && <MissionChanges t={t} language={language} agents={agents} run={run} workspace={workspace} onEditGate={onEditGate} />}

      <section className="mission-events" aria-label={r.events}>
        <h3>{r.events}</h3>
        {lines.length
          ? <ol>{lines.map(line => <li key={line.id}><time dateTime={line.at}>{time(line.at)}</time><span>{line.text}</span></li>)}</ol>
          : <p className="muted small">{r.noEvents}</p>}
      </section>
    </section>
  );
}
