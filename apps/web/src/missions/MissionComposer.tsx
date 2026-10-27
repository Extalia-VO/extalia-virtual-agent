import type { Workspace } from '@extalia/core';
import type { AgentHostApi, ConnectionView, HostState, SessionSummary } from '@extalia/platform';
import { useId, useMemo, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { useLoad } from '../inspect/useLoad';
import { Icon } from '../ui/Icon';
import { ProviderLogo } from '../ui/ProviderLogo';
import {
  DEFAULT_PLAN_TASKS, MAX_GOAL, MAX_TASKS, allowedConnections, allowedPairs, blankPlan, connectionModels, draftFromPlan, missionPlanner,
  type AllowedPairs, type DraftPlan, type MissionPlanRequest, type MissionPlanTask,
} from './missionModel';

/** Explicitly choose which extra saved connections may run mission tasks in this workspace (`setWorkspaceMissionConnections`). */
function AllowedConnectionsEditor({ t, agents, state, workspace, onState, onClose }: {
  t: Messages; agents: AgentHostApi; state: HostState; workspace: Workspace; onState(next: HostState): void; onClose(): void;
}) {
  const c = t.missions.compose;
  const headingId = useId();
  const [chosen, setChosen] = useState<string[]>(() => [...(workspace.missionConnectionIds ?? [])]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const others = state.connections.filter(connection => connection.id !== workspace.providerProfileId);
  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    try { onState(await agents.setWorkspaceMissionConnections(workspace.id, chosen)); setSaved(true); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };
  return (
    <section className="mission-allowlist" aria-labelledby={headingId}>
      <h4 id={headingId}>{c.manageTitle(workspace.name)}</h4>
      <p className="muted small">{c.manageHint}</p>
      <ul className="mission-allowlist-list">
        {others.map(connection => (
          <li key={connection.id}>
            <label className="mission-check">
              <input type="checkbox" checked={chosen.includes(connection.id)} disabled={busy}
                onChange={event => { setSaved(false); setChosen(event.target.checked ? [...chosen, connection.id] : chosen.filter(id => id !== connection.id)); }} />
              <span className="mission-logo" aria-hidden="true"><ProviderLogo preset={connection.preset} /></span>
              <span>{connection.name} <code>{connection.model}</code></span>
              {connection.credentialStatus === 'missing' && <span className="badge warn">{c.credentialMissing}</span>}
              {connection.features.history === false && <span className="badge">{c.historyOff}</span>}
            </label>
          </li>
        ))}
      </ul>
      {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>{busy ? t.common.saving : c.manageSave}</button>
        <button type="button" onClick={onClose}>{t.common.close}</button>
        <span role="status" className="muted small">{saved ? c.manageSaved : ''}</span>
      </div>
    </section>
  );
}

const toggle = (list: readonly string[], value: string, on: boolean) => on ? [...new Set([...list, value])] : list.filter(item => item !== value);

/** Goal, allowed connections/models and size; then either the lead plans or the user writes the plan. */
export function MissionComposer({ t, agents, state, session, workspace, onState, onPlanned }: {
  t: Messages;
  agents: AgentHostApi;
  state: HostState;
  session: SessionSummary;
  workspace: Workspace;
  onState(next: HostState): void;
  onPlanned(draft: DraftPlan, pairs: AllowedPairs): void;
}) {
  const c = t.missions.compose;
  const ids = { goal: useId(), goalHint: useId(), maxTasks: useId(), connections: useId(), models: useId() };
  const connections = useMemo(() => allowedConnections(state, workspace), [state, workspace]);
  const [goal, setGoal] = useState('');
  const [chosen, setChosen] = useState<string[]>(() => connections.map(connection => connection.id));
  const [excludedModels, setExcludedModels] = useState<string[]>([]);
  const [maxTasks, setMaxTasks] = useState(DEFAULT_PLAN_TASKS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manage, setManage] = useState(false);
  const planner = missionPlanner(agents);
  // The primary connection may list more models (endpoint catalog); a session override counts too.
  const choices = useLoad(workspace.id, 0, () => agents.modelChoices(workspace.id));
  const primaryExtra = [...(choices.value?.models ?? []), ...(session.options?.model ? [session.options.model] : [])];

  // Newly allowed connections start selected; removed ones drop out (adjusted while rendering, not in an effect).
  const allowedIds = connections.map(connection => connection.id);
  const [knownIds, setKnownIds] = useState(allowedIds);
  if (knownIds.join('\n') !== allowedIds.join('\n')) {
    const added = allowedIds.filter(id => !knownIds.includes(id) && !chosen.includes(id));
    setKnownIds(allowedIds);
    setChosen([...chosen.filter(id => allowedIds.includes(id)), ...added]);
  }

  const selected: ConnectionView[] = connections.filter(connection => chosen.includes(connection.id));
  const modelsByConnection = selected.map(connection => ({ connection, models: connectionModels(connection, connection.id === workspace.providerProfileId ? primaryExtra : []) }));
  const allModels = [...new Set(modelsByConnection.flatMap(entry => entry.models))];
  const includedModels = allModels.filter(model => !excludedModels.includes(model));
  const goalText = goal.trim();
  const goalTooLong = goal.length > MAX_GOAL;
  const ready = Boolean(goalText) && !goalTooLong && selected.length > 0 && includedModels.length > 0 && !busy;

  const pairsFor = (planned: readonly MissionPlanTask[] = []) => allowedPairs(selected, {
    primaryId: workspace.providerProfileId, primaryExtra, models: excludedModels.length ? includedModels : undefined, planned,
  });

  const plan = async () => {
    if (!planner || !ready) return;
    setBusy(true); setError(null);
    const request: MissionPlanRequest = {
      goal: goalText, maxTasks,
      ...(selected.length !== connections.length ? { connectionIds: selected.map(connection => connection.id) } : {}),
      ...(excludedModels.length ? { models: includedModels } : {}),
    };
    try {
      const result = await planner(session.id, request);
      onPlanned(draftFromPlan(result), pairsFor(result.tasks));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card mission-compose" aria-labelledby={`${ids.goal}-heading`}>
      <h2 id={`${ids.goal}-heading`} className="mission-heading">{c.heading}</h2>
      <form className="form-stack" onSubmit={event => { event.preventDefault(); void plan(); }}>
        <div className="field">
          <label htmlFor={ids.goal}>{c.goal}</label>
          <textarea id={ids.goal} rows={4} value={goal} maxLength={MAX_GOAL + 200} placeholder={c.goalPlaceholder} aria-describedby={ids.goalHint}
            aria-invalid={goalTooLong || undefined} onChange={event => setGoal(event.target.value)} />
          <span id={ids.goalHint} className={`muted small ${goalTooLong ? 'field-error' : ''}`}>{goalTooLong ? c.goalLong(MAX_GOAL) : c.goalHint}</span>
        </div>

        <fieldset className="mission-fieldset">
          <legend id={ids.connections}>{c.connections}</legend>
          <p className="muted small">{c.connectionsHint}</p>
          <ul className="mission-connection-list">
            {connections.map(connection => {
              const primary = connection.id === workspace.providerProfileId;
              return (
                <li key={connection.id}>
                  <label className="mission-check">
                    <input type="checkbox" checked={chosen.includes(connection.id)} disabled={busy}
                      onChange={event => setChosen(toggle(chosen, connection.id, event.target.checked))} />
                    <span className="mission-logo" aria-hidden="true"><ProviderLogo preset={connection.preset} /></span>
                    <span>{connection.name}</span>
                    {primary && <span className="chip">{c.primary}</span>}
                    {connection.credentialStatus === 'missing' && <span className="badge warn">{c.credentialMissing}</span>}
                    {connection.features.history === false && <span className="badge">{c.historyOff}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
          {!selected.length && <p className="field-error small" role="alert">{c.needConnection}</p>}
          {manage
            ? <AllowedConnectionsEditor t={t} agents={agents} state={state} workspace={workspace} onState={onState} onClose={() => setManage(false)} />
            : state.connections.length > 1 && <button type="button" className="link-button" onClick={() => setManage(true)}>{c.manage}</button>}
        </fieldset>

        {allModels.length > 0 && (
          <fieldset className="mission-fieldset">
            <legend id={ids.models}>{c.models}</legend>
            <p className="muted small">{c.modelsHint}</p>
            <div className="mission-model-chips">
              {modelsByConnection.map(({ connection, models }) => models.map(model => (
                <button key={`${connection.id}:${model}`} type="button" className="chip-button" aria-pressed={!excludedModels.includes(model)} disabled={busy}
                  onClick={() => setExcludedModels(toggle(excludedModels, model, !excludedModels.includes(model)))}>
                  <code>{model}</code><span className="muted small">{connection.name}</span>
                </button>
              )))}
            </div>
          </fieldset>
        )}

        <div className="field mission-narrow-field">
          <label htmlFor={ids.maxTasks}>{c.maxTasks}</label>
          <input id={ids.maxTasks} type="number" min={1} max={MAX_TASKS} step={1} value={maxTasks} disabled={busy}
            onChange={event => setMaxTasks(Math.min(MAX_TASKS, Math.max(1, Math.round(Number(event.target.value) || 1))))} />
        </div>

        <p className="note"><Icon name="shield" />{t.missions.plan.readOnly}</p>
        {!planner && <p className="note" role="status"><Icon name="alert" />{c.planUnavailable}</p>}
        {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
        <div className="actions">
          {planner && <button type="submit" className="primary" disabled={!ready} aria-busy={busy || undefined}>
            {busy ? <><Icon name="refresh" className="spin" />{c.planning}</> : <><Icon name="spark" />{c.plan}</>}
          </button>}
          <button type="button" className={planner ? '' : 'primary'} disabled={!ready} onClick={() => onPlanned(blankPlan(goalText, pairsFor()), pairsFor())}>
            <Icon name="edit" />{c.manual}
          </button>
        </div>
      </form>
    </section>
  );
}
