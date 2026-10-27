import type { CharacterAppearances } from '@extalia/core';
import type { AgentHostApi, HostState, ModelChoices } from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Messages } from '../i18n';
import { errorMessage } from '../host/remote';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';
import { Segmented } from '../ui/Segmented';
import { AgentPortrait } from './overlay/AgentPortrait';
import { lookIdentity } from './scene/avatars/appearance';
import {
  TEAM_MAX_ALLOWED_MODELS, TEAM_MAX_MEMBER_MODELS, TEAM_MAX_MEMBERS, TEAM_MAX_PATHS, TEAM_MAX_SOUL, TEAM_MIN_MEMBERS, addMemberPath, applyPlan, clampCount, customModel,
  filterModels, generateIdentity, manualMember, planReasons, markEdited, moveItem, plainMembers, restrictModels, teamApi, teamForSave, teamFromSpec, teamProblem, toggleAllowedModel, toggleMemberModel,
  workspaceTeamSupported, type AgentTeam, type DraftMember, type EditedField, type MemberAccess, type MemberGender, type TeamDialogScope, type TeamPlan, type TeamSpec,
} from './team';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Everything outside `keep` is inert while the dialog is open (including a session dialog underneath). */
function useInertOutside(keep: HTMLElement) {
  useLayoutEffect(() => {
    const changed = [...document.body.children].filter((element): element is HTMLElement =>
      element instanceof HTMLElement && element !== keep && !element.inert && element.tagName !== 'SCRIPT');
    for (const element of changed) element.inert = true;
    return () => { for (const element of changed) element.inert = false; };
  }, [keep]);
}

function draftsFrom(team: AgentTeam | undefined): DraftMember[] {
  return (team?.members ?? []).map(member => ({ ...member, models: [...member.models] }));
}

/** v0.0.30: workspace-relative paths as removable chips plus an input (Enter or comma adds). */
function PathChips({ t, id, label, help, paths, disabled, onChange }: {
  t: Messages['team']; id: string; label: string; help: string; paths: readonly string[] | undefined; disabled: boolean; onChange(paths: string[]): void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<'invalid' | 'duplicate' | 'full'>();
  const add = () => {
    const parts = value.split(',').map(part => part.trim()).filter(Boolean);
    if (!parts.length) return;
    let next = [...(paths ?? [])];
    for (const part of parts) {
      const result = addMemberPath(next, part);
      if ('error' in result) { setError(result.error); return; }
      next = result.paths;
    }
    onChange(next); setValue(''); setError(undefined);
  };
  return <div className="team-field team-paths">
    <label htmlFor={id} className="team-label">{label}</label>
    {paths && paths.length > 0 && <ul className="team-chips team-path-chips" aria-label={label}>
      {paths.map(path => <li key={path} className="team-chip team-path-chip"><code title={path}>{path}</code>
        <button type="button" className="team-chip-button" aria-label={t.removePath(path)} title={t.removePath(path)} disabled={disabled}
          onClick={() => onChange((paths ?? []).filter(item => item !== path))}><Icon name="close" /></button></li>)}
    </ul>}
    <div className="team-custom">
      <input id={id} type="text" value={value} placeholder={t.pathPlaceholder} disabled={disabled || (paths?.length ?? 0) >= TEAM_MAX_PATHS} spellCheck={false} autoComplete="off"
        aria-invalid={error ? true : undefined} aria-describedby={`${id}-help`}
        onChange={event => { setValue(event.target.value); setError(undefined); }}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); add(); } }} />
      <button type="button" className="button small" disabled={disabled || !value.trim()} onClick={add}><Icon name="plus" />{t.customAdd}</button>
    </div>
    <p id={`${id}-help`} className={error ? 'field-error team-help' : 'team-help'} role={error ? 'alert' : undefined}>{error ? t.pathErrors[error] : help}</p>
  </div>;
}

/**
 * v0.0.29: sets up the subagent team of a lead agent. Opened from the prompt
 * dock (for new sessions or the targeted one), the lead's session dialog and
 * Settings → Workspaces. v0.0.47: `scope` says what is edited — a session's own
 * team (saved on the host, with "Save as workspace default"), the workspace's
 * default team (saved on the host at once; new sessions copy it), or a draft for
 * the one new session a prompt starts (handed back through `onSaved`).
 * Modal like `AgentSessionDialog`: portal, inert outside, focus trap, Escape.
 */
export function TeamSetupDialog({ t, agents, workspaceId, workspaceName, scope: requestedScope, sessionId, leadName, initialGoal, pending, spec, discord = false, officeNames, savedLooks, onSaved, onState, onClose }: {
  t: Messages;
  agents: AgentHostApi;
  workspaceId: string;
  /** v0.0.47: shown in the workspace-default title. */
  workspaceName?: string | undefined;
  /** v0.0.47: what is edited; defaults to the session's team with `sessionId`, else a draft. */
  scope?: TeamDialogScope | undefined;
  /** The lead session; `undefined` sets up the team for a session not started yet. */
  sessionId?: string | undefined;
  leadName?: string | undefined;
  /** Prefills the goal (the dock's prompt text). */
  initialGoal?: string | undefined;
  /** The draft or workspace default team shown at first (not for `session`). */
  pending?: AgentTeam | undefined;
  /** v0.0.30: a team written into the prompt; merged (by name) into the shown team for review. */
  spec?: TeamSpec | undefined;
  /** v0.0.30: the prompt asks for live Discord reporting (not supported yet; a note says so). */
  discord?: boolean | undefined;
  /** v0.0.30: every name already used in the office; generated names avoid them. */
  officeNames?: ReadonlySet<string> | undefined;
  /** v0.0.30: saved looks by character id, so portraits match the office. */
  savedLooks?: CharacterAppearances | undefined;
  onSaved(team: AgentTeam | null): void;
  /** v0.0.47: the host state after the workspace default changed. */
  onState?: ((state: HostState) => void) | undefined;
  onClose(): void;
}) {
  const m = t.team;
  const scope: TeamDialogScope = sessionId ? 'session' : requestedScope === 'workspace' ? 'workspace' : 'draft';
  const defaults = workspaceTeamSupported(agents);
  const id = useId();
  const api = teamApi(agents);
  const [host] = useState(() => Object.assign(document.createElement('div'), { className: 'team-dialog-root' }));
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });

  // v0.0.30: names in the office outside this team, and the prompt's team merged into what is shown.
  const othersThan = (team: AgentTeam | undefined) => [...(officeNames ?? [])].filter(name => !team?.members.some(member => member.name.toLowerCase() === name.toLowerCase()));
  const [outside, setOutside] = useState(() => othersThan(pending));
  const withSpec = (team: AgentTeam | undefined): AgentTeam | undefined => {
    if (!spec) return team;
    const result = teamFromSpec(spec, team, othersThan(team), sessionId ?? workspaceId);
    return 'team' in result ? result.team : team;
  };
  const [initial] = useState(() => sessionId ? undefined : withSpec(pending));
  const [loading, setLoading] = useState(Boolean(sessionId));
  const [existing, setExisting] = useState(Boolean(pending));
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [goal, setGoal] = useState(spec?.goal || (spec ? '' : initialGoal?.trim()) || initial?.goal || '');
  const [rules, setRules] = useState<string[]>(initial?.rules ?? []);
  const [count, setCount] = useState(initial?.members.length || 3);
  const [allowed, setAllowed] = useState<string[]>(initial?.allowedModels ?? []);
  const [members, setMembers] = useState<DraftMember[]>(() => draftsFrom(initial));
  const [plan, setPlan] = useState<Pick<TeamPlan, 'source' | 'note'>>();
  const [busy, setBusy] = useState<'plan' | 'save' | 'remove' | 'default'>();
  const [savedDefault, setSavedDefault] = useState(false);
  const [error, setError] = useState<string>();
  const [attempted, setAttempted] = useState(false);
  const [custom, setCustom] = useState('');
  // v0.0.39: filters the models that can still be ticked (long router catalogs); why the plan chose each member's models.
  const [query, setQuery] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [customError, setCustomError] = useState<keyof typeof m.customErrors>();
  const [choices, setChoices] = useState<ModelChoices>();
  const [dragFrom, setDragFrom] = useState<number>();
  const [dragOver, setDragOver] = useState<number>();
  const memberDrag = useRef<{ member: string; from: number }>(undefined);
  const planButton = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    document.body.appendChild(host);
    return () => { host.remove(); };
  }, [host]);
  useInertOutside(host);

  // Controls are disabled while loading or planning, which drops focus to the page; bring it back when they return.
  const working = Boolean(busy) || loading;
  useEffect(() => {
    if (working) return;
    const node = dialog.current;
    if (!node || (node.contains(document.activeElement) && document.activeElement !== node)) return;
    const target = members.length && planButton.current && !planButton.current.disabled ? planButton.current : node.querySelector<HTMLElement>('.team-dialog-body input:not([disabled])');
    target?.focus({ preventScroll: true });
  }, [working]); // eslint-disable-line react-hooks/exhaustive-deps

  // Models the workspace offers (Native: the endpoint's list; Hermes: the profile's). v0.0.32: none is
  // ticked for a new team, so "Plan with AI" chooses the models; the user may tick them instead.
  useEffect(() => {
    const load = (agents as unknown as { modelChoices?: (workspace: string) => Promise<ModelChoices> }).modelChoices;
    if (typeof load !== 'function') return;
    let live = true;
    load.call(agents, workspaceId).then(result => { if (live) setChoices(result); }, () => undefined);
    return () => { live = false; };
  }, [agents, workspaceId]);

  // An existing lead session's saved team.
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    teamApi(agents).get(sessionId).then(saved => {
      if (!live) return;
      if (saved) { setExisting(true); setOutside(othersThan(saved)); }
      const team = withSpec(saved);
      if (!team) return;
      setEnabled(team.enabled); setAllowed([...team.allowedModels]); setMembers(draftsFrom(team)); setRules(team.rules ?? []);
      if (team.members.length) setCount(clampCount(team.members.length));
      setGoal(current => current || team.goal || '');
    }, failure => { if (live) setError(errorMessage(failure)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [agents, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus the first control; Escape and Tab are handled before the session dialog underneath sees them.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => (dialog.current?.querySelector<HTMLElement>('.team-dialog-body input:not([disabled])') ?? dialog.current)?.focus({ preventScroll: true }));
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Tab') return;
      // An open select list handles its own keys.
      if (document.querySelector('[role="listbox"]')) return;
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return; }
      if (!dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => !element.closest('[hidden]'));
      const first = focusable[0], last = focusable.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      if (!dialog.current.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(frame); window.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected) requestAnimationFrame(() => opener.focus({ preventScroll: true }));
    };
  }, []);

  const hermes = choices?.runtime === 'hermes';
  const offered = [...new Set([...(choices?.defaultModel ? [choices.defaultModel] : []), ...(choices?.models ?? [])])];
  const listed = [...allowed, ...offered.filter(model => !allowed.includes(model))];
  const unticked = offered.filter(model => !allowed.includes(model));
  const available = filterModels(offered, allowed, query);
  // v0.0.30: names are unique in the whole office, not only in this team.
  const clash = (member: DraftMember) => outside.some(name => name.trim().toLowerCase() === member.name.trim().toLowerCase());
  const problem = teamProblem({ enabled, allowedModels: allowed, members }, hermes) ?? (members.some(clash) ? 'names' : undefined);

  function changeAllowed(next: string[]) {
    setAllowed(next);
    setMembers(current => current.map((member, index) => {
      const models = restrictModels(member.models, next, index, member.role);
      return models.join('\n') === member.models.join('\n') ? member : { ...member, models };
    }));
  }
  function addCustom() {
    const result = customModel(allowed, custom);
    if ('error' in result) { setCustomError(result.error); return; }
    changeAllowed([...allowed, result.model]); setCustom(''); setCustomError(undefined);
  }
  function updateMember(memberId: string, field: EditedField, change: Partial<DraftMember>) {
    setMembers(current => current.map(member => member.id === memberId ? { ...member, ...change, edited: markEdited(member, field) } : member));
  }
  function setMembersAndCount(next: DraftMember[]) {
    setMembers(next);
    if (next.length) setCount(clampCount(next.length));
  }

  async function runPlan() {
    if (working) return;
    setBusy('plan'); setError(undefined);
    try {
      // v0.0.32: the goal and the models are optional; without models the plan chooses them and they are ticked here.
      const result = await api.plan(workspaceId, { goal: goal.trim(), count, allowedModels: [...allowed], ...(members.length ? { members: plainMembers(members) } : {}) });
      const next = applyPlan(members, allowed, result, outside);
      if (next.allowed.join('\n') !== allowed.join('\n')) setAllowed(next.allowed);
      setMembers(next.members);
      setReasons(planReasons(result, next.members));
      setPlan({ source: result.source, ...(result.note ? { note: result.note } : {}) });
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(undefined); }
  }

  async function save() {
    setAttempted(true);
    if (working || problem) return;
    const team = teamForSave({ enabled, allowedModels: allowed, members, goal, rules });
    if (scope === 'draft') { onSaved(team); close.current(); return; }
    setBusy('save'); setError(undefined);
    try {
      if (scope === 'workspace') {
        const state = await api.saveDefault(workspaceId, team);
        onState?.(state);
        onSaved(state.workspaces.find(item => item.id === workspaceId)?.team ?? team);
      } else {
        const saved = await api.save(sessionId!, team);
        onSaved(saved ?? team);
      }
      close.current();
    } catch (failure) { setError(errorMessage(failure)); setBusy(undefined); }
  }

  /** v0.0.47: a session's team (as edited here) becomes the default for new sessions; the session itself is saved with Save. */
  async function saveAsDefault() {
    setAttempted(true);
    if (working || problem) return;
    setBusy('default'); setError(undefined); setSavedDefault(false);
    try {
      onState?.(await api.saveDefault(workspaceId, teamForSave({ enabled, allowedModels: allowed, members, goal, rules })));
      setSavedDefault(true);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(undefined); }
  }

  async function remove() {
    if (working) return;
    if (scope === 'draft') { onSaved(null); close.current(); return; }
    setBusy('remove'); setError(undefined);
    try {
      if (scope === 'workspace') onState?.(await api.saveDefault(workspaceId, null));
      else await api.save(sessionId!, null);
      onSaved(null); close.current();
    } catch (failure) { setError(errorMessage(failure)); setBusy(undefined); }
  }

  const onModelDrop = (event: DragEvent, to: number) => {
    event.preventDefault();
    if (dragFrom !== undefined && to < allowed.length) changeAllowed(moveItem(allowed, dragFrom, to));
    setDragFrom(undefined); setDragOver(undefined);
  };
  /** One model row: ticked models (by priority) can be dragged and moved; the others can be ticked. */
  const renderModel = (model: string) => {
    const rank = allowed.indexOf(model);
    const on = rank >= 0;
    return <li key={model} className="team-model" data-on={on || undefined} data-over={on && dragOver === rank && dragFrom !== rank ? true : undefined}
      data-dragging={on && dragFrom === rank ? true : undefined}
      draggable={on && !working} title={on ? m.dragHint : undefined}
      onDragStart={event => { if (!on) return; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', model); setDragFrom(rank); }}
      onDragOver={event => { if (on && dragFrom !== undefined) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOver(rank); } }}
      onDragLeave={() => setDragOver(current => current === rank ? undefined : current)}
      onDrop={event => onModelDrop(event, rank)}
      onDragEnd={() => { setDragFrom(undefined); setDragOver(undefined); }}>
      {on && <span className="team-grip" aria-hidden="true">⋮⋮</span>}
      <label className="team-model-check">
        <input type="checkbox" checked={on} disabled={working || (!on && allowed.length >= TEAM_MAX_ALLOWED_MODELS)} aria-label={m.allow(model)}
          onChange={event => changeAllowed(toggleAllowedModel(allowed, model, event.target.checked))} />
        {on && <span className="team-rank">{m.priority(rank + 1)}</span>}
        <code>{model}</code>
      </label>
      {on && <span className="team-model-move">
        <button type="button" className="icon-button small" aria-label={m.moveUp(model)} title={m.moveUp(model)} disabled={working || rank === 0}
          onClick={() => changeAllowed(moveItem(allowed, rank, rank - 1))}><Icon name="chevron" className="up" /></button>
        <button type="button" className="icon-button small" aria-label={m.moveDown(model)} title={m.moveDown(model)} disabled={working || rank === allowed.length - 1}
          onClick={() => changeAllowed(moveItem(allowed, rank, rank + 1))}><Icon name="chevron" className="down" /></button>
      </span>}
    </li>;
  };
  const seedOf = (memberId: string) => sessionId ? `${sessionId}:${memberId}` : memberId;
  /** Names a member may not take: the office's (minus this team's own) and the other members'. */
  const takenFor = (member: DraftMember) => [...outside, ...members.filter(other => other !== member).map(other => other.name)];
  const discordNote = discord || /\bdiscord\b/i.test([goal, ...rules].join('\n'));
  const planLabel = busy === 'plan' ? m.planning : members.length ? m.replan(count) : m.plan;
  const shownProblem = attempted || members.length ? problem : undefined;

  return createPortal(<div className="team-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close.current(); }}>
    <div ref={dialog} className="team-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-subtitle`} tabIndex={-1} aria-busy={working || undefined}>
      <header className="team-dialog-head">
        <span className="team-dialog-mark" aria-hidden="true"><Icon name="users" /></span>
        <div className="team-dialog-heading">
          <h2 id={`${id}-title`}>{m.title}</h2>
          <p id={`${id}-subtitle`}>{scope === 'session' ? m.subtitleSession(leadName ?? '') : scope === 'workspace' ? m.subtitleWorkspace(workspaceName ?? '') : m.subtitleNew}</p>
        </div>
        <button type="button" className="icon-button team-dialog-close" aria-label={m.close} title={`${m.close} (Esc)`} onClick={() => close.current()}><Icon name="close" /></button>
      </header>
      <div className="team-dialog-body">
        <p className="note team-dialog-notice team-scope-note" data-scope={scope}><Icon name={scope === 'workspace' ? 'folder' : scope === 'session' ? 'chat' : 'plus'} />
          <span>{scope === 'workspace' ? m.scopeWorkspace : scope === 'session' ? m.scopeSession : m.scopeDraft}</span></p>
        {hermes && <p className="note team-dialog-notice team-hermes-note" role="note"><Icon name="alert" /><span>{m.hermesModels}</span></p>}
        {spec && <p className="note team-dialog-notice team-spec-notice" role="status"><Icon name="spark" /><span>{m.fromPrompt(spec.members.length)}</span></p>}
        {discordNote && <p className="note team-dialog-notice" role="note"><Icon name="alert" /><span>{m.discord}</span></p>}
        {loading && <p className="muted team-dialog-loading" role="status">{m.loading}</p>}
        <label className="switch team-switch">
          <input type="checkbox" role="switch" checked={enabled} disabled={working} onChange={event => setEnabled(event.target.checked)} aria-describedby={`${id}-enabled-help`} />
          <span className="switch-track" aria-hidden="true" />
          <span>{m.enabled}</span>
        </label>
        <p id={`${id}-enabled-help`} className="team-help">{m.enabledHelp}</p>

        <div className="team-grid">
          <div className="team-field team-goal">
            <label htmlFor={`${id}-goal`}>{m.goal}</label>
            <textarea id={`${id}-goal`} rows={3} value={goal} placeholder={m.goalPlaceholder} disabled={working} maxLength={4000}
              aria-describedby={`${id}-goal-help`} onChange={event => setGoal(event.target.value)} />
            <p id={`${id}-goal-help`} className="team-help">{m.goalHelp}</p>
            <div className="team-count" role="group" aria-labelledby={`${id}-count-label`}>
              <span id={`${id}-count-label`} className="team-label">{m.count}</span>
              <button type="button" className="icon-button small" aria-label={m.fewer} title={m.fewer} disabled={working || count <= TEAM_MIN_MEMBERS}
    onClick={() => setCount(value => clampCount(value - 1))}><span aria-hidden="true">−</span></button>
              <input type="number" inputMode="numeric" min={TEAM_MIN_MEMBERS} max={TEAM_MAX_MEMBERS} value={count} disabled={working} aria-labelledby={`${id}-count-label`}
    onChange={event => setCount(clampCount(Number(event.target.value)))} />
              <button type="button" className="icon-button small" aria-label={m.more} title={m.more} disabled={working || count >= TEAM_MAX_MEMBERS}
    onClick={() => setCount(value => clampCount(value + 1))}><Icon name="plus" /></button>
            </div>
          </div>

          <fieldset className="team-field team-models" aria-describedby={`${id}-models-help`}>
            <legend className="team-label">{m.models}</legend>
            <p id={`${id}-models-help`} className="team-help">{m.modelsHelp}</p>
            {!listed.length && <p className="team-help">{m.modelsEmpty}</p>}
            {allowed.length > 0 && <ul className="team-model-list team-model-selected" aria-label={m.selectedModels}>
              {allowed.map(renderModel)}
            </ul>}
            {unticked.length > 0 && <div className="team-model-filter">
              <Icon name="search" />
              <input id={`${id}-filter`} type="search" value={query} placeholder={m.filterPlaceholder} aria-label={m.filterLabel} disabled={working} spellCheck={false} autoComplete="off"
    aria-describedby={`${id}-filter-count`} aria-controls={`${id}-available`} onChange={event => setQuery(event.target.value)}
    onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); } }} />
              <span id={`${id}-filter-count`} className="team-help" aria-live="polite">{m.filterCount(available.length, unticked.length)}</span>
            </div>}
            {unticked.length > 0 && <ul id={`${id}-available`} className="team-model-list team-model-available" aria-label={m.availableModels}>
              {available.map(renderModel)}
            </ul>}
            {query.trim() && unticked.length > 0 && !available.length && <p className="team-help">{m.filterNone}</p>}
            <div className="team-custom">
              <label htmlFor={`${id}-custom`} className="visually-hidden">{m.customLabel}</label>
              <input id={`${id}-custom`} type="text" value={custom} placeholder={m.customPlaceholder} disabled={working} spellCheck={false} autoComplete="off"
    aria-invalid={customError ? true : undefined} aria-describedby={customError ? `${id}-custom-error` : undefined}
    onChange={event => { setCustom(event.target.value); setCustomError(undefined); }}
    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addCustom(); } }} />
              <button type="button" className="button small" disabled={working || !custom.trim()} onClick={addCustom}><Icon name="plus" />{m.customAdd}</button>
            </div>
            {customError && <p id={`${id}-custom-error`} className="field-error team-help" role="alert">{m.customErrors[customError]}</p>}
          </fieldset>
        </div>

        {rules.length > 0 && <section className="team-rules" aria-labelledby={`${id}-rules`}>
          <h3 id={`${id}-rules`} className="team-label">{m.rules}</h3>
          <ol>{rules.map((rule, index) => <li key={index}>{rule}</li>)}</ol>
        </section>}

        <section className="team-members" aria-labelledby={`${id}-members`}>
          <div className="team-members-head">
            <h3 id={`${id}-members`}>{m.members}{members.length ? <span className="chip">{members.length}</span> : null}</h3>
            {plan && <span className="team-source" data-source={plan.source}><Icon name={plan.source === 'model' ? 'spark' : 'tool'} />{plan.source === 'model' ? m.sourceModel : m.sourceHeuristic}</span>}
            <div className="team-members-actions">
              <button type="button" className="button small" disabled={working || members.length >= TEAM_MAX_MEMBERS}
    onClick={() => setMembersAndCount([...members, manualMember(members, allowed, m.defaultRole, undefined, outside)])}><Icon name="plus" />{m.addMember}</button>
              <button ref={planButton} type="button" className="button small primary team-plan" disabled={working}
    title={[goal.trim() ? '' : m.planNoGoal, allowed.length ? '' : m.planNoModels].filter(Boolean).join(' ') || m.planHelp} onClick={() => void runPlan()}>
    <Icon name={busy === 'plan' ? 'refresh' : 'spark'} className={busy === 'plan' ? 'spin' : ''} />{planLabel}
              </button>
            </div>
          </div>
          {plan?.note && <p className="team-help team-note">{plan.note}</p>}
          {members.length > 0 && <p className="team-help">{m.planHelp}</p>}
          {!members.length && !loading && <p className="team-empty">{m.membersEmpty}</p>}
          <ul className="team-member-list">
            {members.map((member, index) => {
              const rest = allowed.filter(model => !member.models.includes(model));
              return <li key={member.id} className="team-member" aria-label={`${m.member(index + 1)}: ${member.name}`}>
    <div className="team-member-head">
      <AgentPortrait characterId={seedOf(member.id)} appearance={savedLooks?.[seedOf(member.id)]} identity={lookIdentity(member.name, member.gender)} />
      <div className="team-member-name">
        <label htmlFor={`${id}-${member.id}-name`} className="team-label">{m.name}</label>
        <input id={`${id}-${member.id}-name`} type="text" value={member.name} maxLength={40} disabled={working}
          aria-invalid={shownProblem === 'names' && (!member.name.trim() || clash(member) || members.some(other => other !== member && other.name.trim().toLowerCase() === member.name.trim().toLowerCase())) || undefined}
          onChange={event => updateMember(member.id, 'name', { name: event.target.value })} />
      </div>
      <button type="button" className="icon-button small" aria-label={`${m.regenerateName}: ${member.name}`} title={m.regenerateName} disabled={working}
        onClick={() => updateMember(member.id, 'name', generateIdentity([...takenFor(member), member.name], `${member.id}:${Date.now()}`, member.gender))}>
        <Icon name="refresh" /></button>
      <button type="button" className="icon-button small team-member-remove" aria-label={m.removeMember(member.name)} title={m.removeMember(member.name)} disabled={working}
        onClick={() => setMembersAndCount(members.filter(other => other !== member))}><Icon name="trash" /></button>
    </div>
    <Segmented<MemberGender | ''> legend={m.gender} className="team-gender" value={member.gender ?? ''}
      options={[{ value: 'female', label: m.genders.female }, { value: 'male', label: m.genders.male }]}
      onChange={gender => { if (gender) updateMember(member.id, 'gender', { gender }); }} />
    <div className="team-field">
      <label htmlFor={`${id}-${member.id}-role`} className="team-label">{m.role}</label>
      <input id={`${id}-${member.id}-role`} type="text" value={member.role} maxLength={60} disabled={working}
        aria-invalid={shownProblem === 'roles' && !member.role.trim() || undefined}
        onChange={event => updateMember(member.id, 'role', { role: event.target.value })} />
    </div>
    <div className="team-field">
      <label htmlFor={`${id}-${member.id}-task`} className="team-label">{m.task}</label>
      <textarea id={`${id}-${member.id}-task`} rows={2} value={member.task ?? ''} maxLength={1000} placeholder={m.taskPlaceholder} disabled={working}
        onChange={event => updateMember(member.id, 'task', { task: event.target.value })} />
    </div>
    <div className="team-field">
      <label htmlFor={`${id}-${member.id}-soul`} className="team-label">{m.soul}</label>
      <textarea id={`${id}-${member.id}-soul`} rows={3} value={member.soul ?? ''} maxLength={TEAM_MAX_SOUL} placeholder={m.soulPlaceholder} disabled={working}
        onChange={event => updateMember(member.id, 'soul', { soul: event.target.value })} />
    </div>
    <Segmented<MemberAccess> legend={m.access} className="team-access" value={member.access ?? 'read'}
      options={[{ value: 'read', label: m.accessRead }, { value: 'write', label: m.accessWrite }]}
      hint={member.access === 'write' ? m.accessWriteHelp : m.accessReadHelp}
      onChange={access => updateMember(member.id, 'access', { access })} />
    {member.access === 'write' && <PathChips t={m} id={`${id}-${member.id}-scope`} label={m.scope} help={m.scopeHelp} paths={member.scope} disabled={working}
      onChange={scope => updateMember(member.id, 'scope', { scope })} />}
    <PathChips t={m} id={`${id}-${member.id}-forbidden`} label={m.forbidden} help={m.forbiddenHelp} paths={member.forbidden} disabled={working}
      onChange={forbidden => updateMember(member.id, 'forbidden', { forbidden })} />
    <div className="team-field">
      <span id={`${id}-${member.id}-models`} className="team-label">{m.memberModels}</span>
      <ol className="team-chips" aria-labelledby={`${id}-${member.id}-models`}>
        {member.models.map((model, rank) => <li key={model} className="team-chip" data-first={rank === 0 || undefined} draggable={!working}
          onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', model); memberDrag.current = { member: member.id, from: rank }; }}
          onDragOver={event => { if (memberDrag.current?.member === member.id) event.preventDefault(); }}
          onDrop={event => {
            event.preventDefault();
            const drag = memberDrag.current; memberDrag.current = undefined;
            if (drag?.member === member.id) updateMember(member.id, 'models', { models: moveItem(member.models, drag.from, rank) });
          }}>
          <span className="team-chip-rank" aria-hidden="true">{rank + 1}</span>
          <code>{model}</code>
          {rank > 0 && <button type="button" className="team-chip-button" aria-label={m.moveEarlier(model)} title={m.moveEarlier(model)} disabled={working}
            onClick={() => updateMember(member.id, 'models', { models: moveItem(member.models, rank, rank - 1) })}><Icon name="chevron" className="left" /></button>}
          {member.models.length > 1 && <button type="button" className="team-chip-button" aria-label={m.removeModel(model)} title={m.removeModel(model)} disabled={working}
            onClick={() => updateMember(member.id, 'models', { models: toggleMemberModel(member.models, model, allowed, false) })}><Icon name="close" /></button>}
        </li>)}
      </ol>
      {reasons[member.id] && !member.edited?.includes('models') && <p className="team-help team-model-reason">{m.modelReason(reasons[member.id]!)}</p>}
      {rest.length > 0 && member.models.length < TEAM_MAX_MEMBER_MODELS && <div className="team-add-fallback">
        <Select aria-label={`${m.addFallback}: ${member.name}`} value="" placeholder={m.addFallback} disabled={working}
          options={rest.map(model => ({ value: model, label: model, icon: 'plus' as const }))}
          onChange={model => updateMember(member.id, 'models', { models: toggleMemberModel(member.models, model, allowed, true) })} />
      </div>}
    </div>
              </li>;
            })}
          </ul>
        </section>
      </div>
      <footer className="team-dialog-foot">
        <div className="team-dialog-messages" aria-live="polite">
          {shownProblem && <p className="field-error">{m.problems[shownProblem]}</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
          {savedDefault && !error && <p className="team-help team-saved-default" role="status"><Icon name="check" />{m.savedAsDefault}</p>}
        </div>
        {existing && <button type="button" className="button small team-remove" disabled={working} onClick={() => void remove()}><Icon name="trash" />{scope === 'workspace' ? m.removeDefault : m.remove}</button>}
        {scope === 'session' && defaults && <button type="button" className="button small team-save-default" disabled={working} onClick={() => void saveAsDefault()}>
          {busy === 'default' ? <Icon name="refresh" className="spin" /> : <Icon name="folder" />}{m.saveAsDefault}</button>}
        <button type="button" className="button" disabled={busy === 'save' || busy === 'remove'} onClick={() => close.current()}>{m.cancel}</button>
        <button type="button" className="button primary" disabled={working} onClick={() => void save()}>
          {busy === 'save' ? <><Icon name="refresh" className="spin" />{m.saving}</> : <><Icon name="check" />{m.save}</>}
        </button>
      </footer>
    </div>
  </div>, host);
}
