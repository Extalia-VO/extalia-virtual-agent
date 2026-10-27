import type { AgentHostApi, ConnectionView, HostMissionRun, SessionSummary } from '@extalia/platform';
import { useId, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { ComboBox } from '../ui/ComboBox';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';
import { MissionDag } from './MissionDag';
import {
  MAX_BUDGET_MINUTES, MAX_TASKS, blankTask, emptyBudget, rememberSubmitted, removeTask, renameTask, requestFromDraft, toggleDependency, validatePlan,
  type AllowedPairs, type DraftBudget, type DraftPlan, type DraftTask, type PlanIssue,
} from './missionModel';

const int = (value: string, fallback: number) => { const number = Number(value); return Number.isFinite(number) ? Math.round(number) : fallback; };

function TaskEditor({ t, plan, task, pairs, connections, issues, onChange, onRename, onToggle, onRemove }: {
  t: Messages; plan: DraftPlan; task: DraftTask; pairs: AllowedPairs; connections: readonly ConnectionView[]; issues: readonly PlanIssue[];
  onChange(next: DraftTask): void; onRename(id: string): void; onToggle(dependency: string): void; onRemove(): void;
}) {
  const p = t.missions.plan;
  const base = useId();
  const id = (field: string) => `${base}-${field}`;
  const errorsFor = (field: PlanIssue['field']) => issues.filter(issue => issue.field === field);
  const fieldError = (field: PlanIssue['field']) => {
    const list = errorsFor(field);
    return list.length ? <span id={id(`${field}-error`)} className="field-error small" role="alert">{[...new Set(list.map(issue => p.errors[issue.code] + (issue.detail ? ` (${issue.detail})` : '')))].join(' ')}</span> : null;
  };
  const invalid = (field: PlanIssue['field']) => errorsFor(field).length ? { 'aria-invalid': true as const, 'aria-describedby': id(`${field}-error`) } : {};
  const connectionOptions = [...pairs.keys()].map(connectionId => {
    const connection = connections.find(item => item.id === connectionId);
    return { value: connectionId, label: connection?.name ?? connectionId };
  });
  if (task.connectionId && !pairs.has(task.connectionId)) connectionOptions.push({ value: task.connectionId, label: connections.find(item => item.id === task.connectionId)?.name ?? task.connectionId });
  const models = pairs.get(task.connectionId) ?? [];
  const others = plan.tasks.filter(other => other.key !== task.key);
  return (
    <section className="mission-task-editor" aria-labelledby={id('heading')}>
      <header className="mission-task-editor-head">
        <h4 id={id('heading')}>{p.editing(task.title.trim() || task.id || p.untitledTask)}</h4>
        <button type="button" className="button small" disabled={plan.tasks.length <= 1} onClick={onRemove}><Icon name="trash" />{p.remove}</button>
      </header>
      {task.rationale && <p className="muted small mission-rationale"><strong>{p.rationale}:</strong> {task.rationale}</p>}
      <div className="form-grid">
        <div className="field">
          <label htmlFor={id('title')}>{p.taskTitle}</label>
          <input id={id('title')} type="text" maxLength={240} value={task.title} {...invalid('title')} onChange={event => onChange({ ...task, title: event.target.value })} />
          {fieldError('title')}
        </div>
        <div className="field">
          <label htmlFor={id('id')}>{p.id}</label>
          <input id={id('id')} type="text" maxLength={64} value={task.id} spellCheck={false} autoCapitalize="off" {...invalid('id')}
            aria-describedby={errorsFor('id').length ? id('id-error') : id('id-hint')} onChange={event => onRename(event.target.value.trim())} />
          {fieldError('id') ?? <span id={id('id-hint')} className="muted small">{p.idHint}</span>}
        </div>
        <div className="field">
          <label htmlFor={id('role')}>{p.role}</label>
          <input id={id('role')} type="text" maxLength={80} value={task.role} placeholder={p.rolePlaceholder} onChange={event => onChange({ ...task, role: event.target.value })} />
        </div>
      </div>
      <div className="field">
        <label htmlFor={id('instructions')}>{p.instructions}</label>
        <textarea id={id('instructions')} rows={5} value={task.instructions} {...invalid('instructions')} onChange={event => onChange({ ...task, instructions: event.target.value })} />
        {fieldError('instructions')}
      </div>
      <div className="form-grid">
        <div className="field">
          <Select id={id('connection')} label={p.connection} value={task.connectionId} options={connectionOptions}
            onChange={connectionId => {
              const list = pairs.get(connectionId) ?? [];
              onChange({ ...task, connectionId, model: list.includes(task.model) ? task.model : list[0] ?? task.model });
            }} />
          {fieldError('connection')}
        </div>
        <div className="field">
          <ComboBox id={id('model')} label={p.model} value={task.model} options={models.map(model => ({ value: model, label: model }))}
            onChange={model => onChange({ ...task, model })} customLabel={p.customModel} emptyLabel={p.noModel}
            invalid={errorsFor('model').length > 0} {...(errorsFor('model').length ? { describedBy: id('model-error') } : {})} />
          {fieldError('model')}
        </div>
      </div>
      <fieldset className="mission-fieldset">
        <legend>{p.dependsOn}</legend>
        {others.length
          ? <div className="mission-dep-chips">
            {others.map(other => (
              <button key={other.key} type="button" className="chip-button" aria-pressed={task.dependsOn.includes(other.id)} onClick={() => onToggle(other.id)}>
                {other.title.trim() || other.id}<span className="muted small"> · {other.id}</span>
              </button>
            ))}
            {task.dependsOn.filter(dependency => !plan.tasks.some(other => other.id === dependency)).map(dependency => (
              <button key={`missing:${dependency}`} type="button" className="chip-button mission-dep-missing" aria-pressed="true" onClick={() => onToggle(dependency)}>
                {dependency}<Icon name="close" />
              </button>
            ))}
          </div>
          : <p className="muted small">{p.noOtherTasks}</p>}
        {fieldError('dependsOn')}
      </fieldset>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={id('timeout')}>{p.timeout}</label>
          <input id={id('timeout')} type="number" min={1} max={600} step={1} value={task.timeoutSeconds} {...invalid('timeout')}
            onChange={event => onChange({ ...task, timeoutSeconds: int(event.target.value, task.timeoutSeconds) })} />
          {fieldError('timeout')}
        </div>
        <div className="field">
          <label htmlFor={id('steps')}>{p.maxSteps}</label>
          <input id={id('steps')} type="number" min={1} max={20} step={1} value={task.maxSteps} {...invalid('maxSteps')}
            onChange={event => onChange({ ...task, maxSteps: int(event.target.value, task.maxSteps) })} />
          {fieldError('maxSteps')}
        </div>
      </div>
    </section>
  );
}

/** Editable plan: DAG overview, one task editor, inline validation, then launch. */
export function MissionPlanEditor({ t, agents, session, connections, pairs, initial, onBack, onLaunched }: {
  t: Messages;
  agents: AgentHostApi;
  session: SessionSummary;
  connections: readonly ConnectionView[];
  pairs: AllowedPairs;
  initial: DraftPlan;
  onBack(): void;
  onLaunched(run: HostMissionRun): void;
}) {
  const p = t.missions.plan;
  const ids = { heading: useId(), title: useId(), concurrency: useId(), budget: useId() };
  const [plan, setPlan] = useState(initial);
  const [selectedKey, setSelectedKey] = useState(initial.tasks[0]?.key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const issues = validatePlan(plan, pairs);
  const selected = plan.tasks.find(task => task.key === selectedKey) ?? plan.tasks[0];
  const nameOf = (connectionId: string) => connections.find(item => item.id === connectionId)?.name ?? connectionId;
  const updateTask = (key: string, change: (task: DraftTask) => DraftTask) => setPlan(current => ({ ...current, tasks: current.tasks.map(task => task.key === key ? change(task) : task) }));
  const planIssues = issues.filter(issue => !issue.taskKey);
  const launch = async () => {
    if (issues.length || busy) return;
    setBusy(true); setError(null);
    const request = requestFromDraft(plan);
    try {
      const run = await agents.startNativeMission(session.id, request);
      rememberSubmitted(run.id, request);
      onLaunched(run);
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };
  const fieldIssue = (code: PlanIssue['code'][]) => planIssues.filter(issue => code.includes(issue.code)).map(issue => p.errors[issue.code]).join(' ');
  const budget = plan.budget ?? emptyBudget();
  const budgetField = (field: keyof DraftBudget, code: PlanIssue['code'], label: string, max: number) => {
    const message = fieldIssue([code]);
    return (
      <div className="field mission-narrow-field">
        <label htmlFor={`${ids.budget}-${field}`}>{label}</label>
        <input id={`${ids.budget}-${field}`} type="number" inputMode="numeric" min={1} max={max} step={1} placeholder={p.noLimit} value={budget[field]}
          aria-invalid={Boolean(message) || undefined} {...(message ? { 'aria-describedby': `${ids.budget}-${field}-error` } : {})}
          onChange={event => setPlan({ ...plan, budget: { ...budget, [field]: event.target.value } })} />
        {message && <span id={`${ids.budget}-${field}-error`} className="field-error small" role="alert">{message}</span>}
      </div>
    );
  };

  return (
    <section className="card mission-review" aria-labelledby={ids.heading}>
      <header className="mission-review-head">
        <h2 id={ids.heading} className="mission-heading">{p.heading}</h2>
        <span className="badge" data-source={plan.source}><Icon name={plan.source === 'manual' ? 'edit' : 'spark'} />{p.source[plan.source]}</span>
        {plan.leadModel && <span className="badge"><code>{p.leadModel(plan.leadModel)}</code></span>}
      </header>
      {plan.note && <p className="note"><Icon name="alert" />{plan.note}</p>}
      <div className="form-grid">
        <div className="field">
          <label htmlFor={ids.title}>{p.title}</label>
          <input id={ids.title} type="text" maxLength={240} value={plan.title} aria-invalid={Boolean(fieldIssue(['titleRequired', 'titleInvalid'])) || undefined}
            onChange={event => setPlan({ ...plan, title: event.target.value })} />
          {fieldIssue(['titleRequired', 'titleInvalid']) && <span className="field-error small" role="alert">{fieldIssue(['titleRequired', 'titleInvalid'])}</span>}
        </div>
        <div className="field mission-narrow-field">
          <label htmlFor={ids.concurrency}>{p.concurrency}</label>
          <input id={ids.concurrency} type="number" min={1} max={8} step={1} value={plan.maxConcurrency} aria-invalid={Boolean(fieldIssue(['concurrency'])) || undefined}
            onChange={event => setPlan({ ...plan, maxConcurrency: int(event.target.value, plan.maxConcurrency) })} />
          {fieldIssue(['concurrency']) && <span className="field-error small" role="alert">{fieldIssue(['concurrency'])}</span>}
        </div>
      </div>

      <fieldset className="mission-fieldset mission-budget">
        <legend>{p.budget}</legend>
        <p className="muted small">{p.budgetHint}</p>
        <div className="form-grid">
          {budgetField('durationMinutes', 'budgetDuration', p.budgetDuration, MAX_BUDGET_MINUTES)}
          {budgetField('maxTokens', 'budgetTokens', p.budgetTokens, 100_000_000)}
          {budgetField('maxTaskTokens', 'budgetTaskTokens', p.budgetTaskTokens, 100_000_000)}
        </div>
      </fieldset>

      <div className="mission-graph-head">
        <h3>{p.graph}</h3>
        <button type="button" className="button small" disabled={plan.tasks.length >= MAX_TASKS}
          onClick={() => { const task = blankTask(plan.tasks, pairs); setPlan({ ...plan, tasks: [...plan.tasks, task] }); setSelectedKey(task.key); }}>
          <Icon name="plus" />{p.add}
        </button>
      </div>
      <MissionDag t={t} label={p.graphLabel} selectedKey={selected?.key} onSelect={setSelectedKey}
        nodes={plan.tasks.map(task => ({
          key: task.key, id: task.id, title: task.title.trim(), dependsOn: task.dependsOn,
          invalid: issues.some(issue => issue.taskKey === task.key),
          meta: <>{task.role && <span className="chip">{task.role}</span>}<span>{nameOf(task.connectionId)}</span><code>{task.model}</code></>,
        }))} />

      {selected && <TaskEditor key={selected.key} t={t} plan={plan} task={selected} pairs={pairs} connections={connections}
        issues={issues.filter(issue => issue.taskKey === selected.key)}
        onChange={next => updateTask(selected.key, () => next)}
        onRename={next => setPlan(current => renameTask(current, selected.key, next))}
        onToggle={dependency => setPlan(current => toggleDependency(current, selected.key, dependency))}
        onRemove={() => { const index = plan.tasks.findIndex(task => task.key === selected.key); const next = removeTask(plan, selected.key); setPlan(next); setSelectedKey(next.tasks[Math.max(0, index - 1)]?.key); }} />}

      <p className="note"><Icon name="shield" />{p.readOnly}</p>
      {issues.length > 0 && (
        <div className="mission-issues" role="status">
          <p><Icon name="alert" />{p.issues(issues.length)}</p>
          <ul>
            {issues.map((issue, index) => {
              const task = plan.tasks.find(item => item.key === issue.taskKey);
              const text = `${task ? `${task.title.trim() || task.id}: ` : ''}${p.errors[issue.code]}${issue.detail ? ` (${issue.detail})` : ''}`;
              return <li key={index}>{task ? <button type="button" className="link-button" onClick={() => setSelectedKey(task.key)}>{text}</button> : text}</li>;
            })}
          </ul>
        </div>
      )}
      {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
      <div className="actions">
        <button type="button" className="primary" disabled={issues.length > 0 || busy} aria-busy={busy || undefined} onClick={() => void launch()}>
          {busy ? <><Icon name="refresh" className="spin" />{p.launching}</> : <><Icon name="send" />{p.launch}</>}
        </button>
        <button type="button" disabled={busy} onClick={onBack}><Icon name="chevron" className="flip" />{p.back}</button>
      </div>
    </section>
  );
}
