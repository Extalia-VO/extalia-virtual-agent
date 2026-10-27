import type { CharacterAppearances, Effort } from '@extalia/core';
import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Messages } from '../i18n';
import { errorMessage } from '../host/remote';
import { ComboBox } from '../ui/ComboBox';
import { Select } from '../ui/Select';
import { Icon } from '../ui/Icon';
import { modelComboOptions, normalizeOptions, optionsChange, workspaceTargets, type PromptModelChoices, type PromptOptions } from './promptTarget';
import { sessionAgentName } from './presence';
import { dockTeamStatus, teamDialogScope, teamForNewSession, teamSpecPreview, teamSupported, workspaceTeamSupported, type AgentTeam, type TeamSessionOptions, type TeamSpecPreview } from './team';
import { TeamSetupDialog } from './TeamSetupDialog';

/** Hosts before v0.0.27 lack per-session model/effort; everything here is feature-detected so they keep working. */
interface OptionsHost {
  modelChoices?: (workspaceId: string) => Promise<PromptModelChoices>;
  setSessionOptions?: (sessionId: string, options: PromptOptions) => Promise<unknown>;
}
const optionsHost = (agents: AgentHostApi) => agents as unknown as OptionsHost;

/** The dock grows from its corner once per page load; later mounts (route changes, re-shows) appear in place. */
let entrancePlayed = false;
const DEFAULT_EFFORT = 'default';
const NEW_TARGET = 'new';
const MAX_LINES = 6;
/** v0.0.30: how long typing pauses before the prompt is checked for a team spec. */
const SPEC_DEBOUNCE_MS = 250;

/** What a workspace's runtime offers; `choices` is undefined while loading, on failure, or when the host cannot choose per session. */
export function useModelChoices(agents: AgentHostApi, workspaceId: string | undefined) {
  const host = optionsHost(agents);
  const supported = typeof host.modelChoices === 'function';
  const [result, setResult] = useState<{ key: string; choices?: PromptModelChoices }>();
  useEffect(() => {
    const load = optionsHost(agents).modelChoices;
    if (!workspaceId || typeof load !== 'function') return;
    let live = true;
    load.call(agents, workspaceId).then(choices => { if (live) setResult({ key: workspaceId, choices }); }, () => { if (live) setResult({ key: workspaceId }); });
    return () => { live = false; };
  }, [agents, workspaceId]);
  const current = result && result.key === workspaceId ? result : undefined;
  return { supported, choices: current?.choices };
}

/** Grows a textarea with its content between one and `maxLines` lines (no resize handle). */
export function useAutoGrow(text: string, maxLines = MAX_LINES) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const area = ref.current;
    if (!area) return;
    const style = getComputedStyle(area);
    const line = parseFloat(style.lineHeight) || 20;
    const chrome = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const max = line * maxLines + chrome;
    area.style.height = 'auto';
    const full = area.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    area.style.height = `${Math.min(full, max)}px`;
    area.style.overflowY = full > max ? 'auto' : 'hidden';
  }, [text, maxLines]);
  return ref;
}

/** Publishes the dock's height to the stage (`--office-dock-h`) so the lead bar, toasts and board sit above it. */
function useStageReserve(element: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const node = element.current;
    const stage = node?.parentElement;
    if (!node || !stage || typeof ResizeObserver === 'undefined') return;
    const update = () => stage.style.setProperty('--office-dock-h', `${Math.round(node.offsetHeight)}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => { observer.disconnect(); stage.style.removeProperty('--office-dock-h'); };
  }, [element]);
}

/**
 * The Office composer, pinned bottom-left. It starts a new managed session or
 * continues a chosen one (an agent picked on the board, or a recent session of
 * the workspace), with an optional model and effort for that turn and the next.
 * `compact` keeps only the field until the dock is focused or has text; then workspace, target, team, model and effort appear.
 */
export function OfficePromptDock({ t, agents, state, workspaceId, compact = false, targetSessionId, note, onTarget, onState, onStarted, onOpenSettings, officeNames, savedLooks }: {
  t: Messages; agents: AgentHostApi; state: HostState; workspaceId?: string; compact?: boolean;
  /** v0.0.30: every name in the office, so generated team names stay unique. */
  officeNames?: ReadonlySet<string> | undefined;
  /** v0.0.30: saved looks by character id, for the team dialog's portraits. */
  savedLooks?: CharacterAppearances | undefined;
  /** Session the prompt continues; `undefined` starts a new one. */
  targetSessionId?: string | undefined;
  /** Explains how a selection became the target (e.g. a worker's lead). */
  note?: string | undefined;
  onTarget(sessionId: string | undefined): void;
  onState(state: HostState): void; onStarted(sessionId: string): void; onOpenSettings(): void;
}) {
  const c = t.officeUx.composer;
  const id = useId();
  const root = useRef<HTMLElement>(null);
  const [chosen, setChosen] = useState(workspaceId ?? state.workspaces[0]?.id ?? '');
  const [text, setText] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<string>(DEFAULT_EFFORT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // v0.0.47: the team chip edits the workspace default (saved on the host at once) or the targeted session; new sessions
  // copy the default host-side. Only a team reviewed from a prompt's own subagent block is kept here, for that exact text.
  const [teamOpen, setTeamOpen] = useState<'team' | 'spec' | false>(false);
  const [reviewed, setReviewed] = useState<{ text: string; team: AgentTeam }>();
  // v0.0.30 ui: a team written into the prompt (checked after a short pause in typing).
  const [spec, setSpec] = useState<{ text: string; preview?: TeamSpecPreview }>({ text: '' });
  useEffect(() => {
    // An empty prompt needs no check: a preview only shows for the exact text it was made from.
    if (!text.trim()) return;
    const timer = window.setTimeout(() => setSpec({ text, ...(teamSpecPreview(text) ? { preview: teamSpecPreview(text)! } : {}) }), SPEC_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text]);
  const area = useAutoGrow(text);
  useStageReserve(root);
  // Compact docks open while used: focus inside, or one of their menus (portalled) is open.
  const [engaged, setEngaged] = useState(false);
  const settle = () => requestAnimationFrame(() => {
    const node = root.current;
    if (!node || node.contains(document.activeElement)) return;
    if (document.querySelector('[data-radix-popper-content-wrapper], .combo-menu')) return;
    setEngaged(false);
  });
  const [entering] = useState(() => {
    if (entrancePlayed) return false;
    entrancePlayed = true;
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  // Follow the Office project filter when it changes (state adjusted during render, not in an effect).
  const [filter, setFilter] = useState(workspaceId);
  if (filter !== workspaceId) { setFilter(workspaceId); if (workspaceId) setChosen(workspaceId); }

  const target = targetSessionId ? state.sessions.find(item => item.id === targetSessionId && item.control === 'managed') : undefined;
  // A targeted session decides the workspace; otherwise the dock's own choice (or the Office filter).
  const workspace = state.workspaces.find(item => item.id === (target?.workspaceId ?? chosen)) ?? state.workspaces[0];
  const targets = workspaceTargets(state.sessions, workspace?.id);
  if (target && !targets.some(item => item.id === target.id)) targets.unshift(target);
  // v0.0.30: sessions are named by their lead's full name (the title stays as the task line).
  const titleOf = (session: SessionSummary) => sessionAgentName(session, c.untitled);
  const taskOf = (session: SessionSummary) => { const title = session.title.trim(); return title && title !== titleOf(session) ? title : undefined; };
  const { supported, choices } = useModelChoices(agents, workspace?.id);
  const efforts = choices?.efforts ?? [];
  const modelOptions = useMemo(() => modelComboOptions(choices, {
    useDefault: c.modelDefault, defaultBadge: t.workspace.hermesModelScan.defaultBadge, otherGroup: t.workspace.hermesModelScan.otherGroup,
  }), [choices, c, t.workspace.hermesModelScan]);

  // The controls start from what the target uses: a continued session's own override, defaults for a new one.
  const targetKey = target ? target.id : `new:${workspace?.id ?? ''}`;
  const [shownKey, setShownKey] = useState('');
  if (shownKey !== targetKey) {
    const current = normalizeOptions(target?.options);
    setShownKey(targetKey); setModel(current.model ?? ''); setEffort(current.effort ?? DEFAULT_EFFORT); setError(undefined);
  }

  const wanted: PromptOptions = normalizeOptions({ model, ...(effort !== DEFAULT_EFFORT && efforts.includes(effort as Effort) ? { effort: effort as Effort } : {}) });
  const targetBusy = Boolean(target?.running);
  const teams = teamSupported(agents);
  const defaults = workspaceTeamSupported(agents);
  const workspaceTeam = defaults ? workspace?.team : undefined;
  // The team reviewed from this prompt's subagent block (new session only; cleared when the text changes or is sent).
  const reviewedTeam = !target && reviewed && reviewed.text === text ? reviewed.team : undefined;
  const teamStatus = dockTeamStatus({ target, workspace, workspaceDefaults: defaults });
  const dialogScope = teamDialogScope({ sessionId: target?.id, fromPrompt: teamOpen === 'spec', workspaceDefaults: defaults });
  // v0.0.32: a prompt's team applies to Hermes sessions too (Hermes delegates with its own tool, on one model).
  const hermesTarget = target ? target.runtime?.id === 'hermes' : choices?.runtime === 'hermes';
  const preview = spec.text === text ? spec.preview : undefined;
  const reviewedNow = Boolean(preview && reviewedTeam);

  async function send() {
    const prompt = text.trim();
    if (!workspace || busy || !prompt || targetBusy) return;
    setBusy(true); setError(undefined);
    const host = optionsHost(agents);
    try {
      let sessionId: string;
      if (target) {
        sessionId = target.id;
        const change = supported ? optionsChange(target.options, wanted) : undefined;
        if (change && typeof host.setSessionOptions === 'function') await host.setSessionOptions.call(agents, sessionId, change);
      } else {
        const chosen = supported && (wanted.model || wanted.effort) ? wanted : undefined;
        // v0.0.30: a team written into the prompt goes with the new session so its members show at once (a reviewed one as saved).
        // The host applies the prompt's spec too; members merge by name, so both agree.
        const promptSpec = preview ?? (teams ? teamSpecPreview(prompt) : undefined);
        // Without a draft or a prompt team nothing is sent: the host copies the workspace's default team.
        const result = teamForNewSession({
          draft: reviewedTeam, workspaceTeam, spec: teams ? promptSpec?.spec : undefined, reviewed: reviewedNow, taken: officeNames ?? [], seed: `${workspace.id}:${prompt.length}`,
        });
        if ('error' in result) { setError(t.teamSpec.invalid(result.error)); return; }
        const team = result.team;
        const options: TeamSessionOptions | undefined = team ? { ...chosen, team } : chosen;
        sessionId = (await (options ? agents.createSession(workspace.id, options) : agents.createSession(workspace.id))).id;
        setReviewed(undefined);
      }
      await agents.sendPrompt(sessionId, prompt);
      onState(await agents.getState());
      setText('');
      // The next prompt continues the conversation that was just started; the chip says so and can be cleared.
      onTarget(sessionId);
      onStarted(sessionId);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  const specNames = preview ? preview.names.map(name => name || t.teamSpec.unnamed).join(', ') : '';

  const open = !compact || engaged || Boolean(text) || Boolean(error);
  const hint = targetBusy ? c.busy : note ?? (target ? c.hintContinue(titleOf(target)) : teamStatus?.enabled ? `${c.hintNew} ${t.team.pending}` : c.hintNew);
  const teamLabel = target ? t.team.openLabel(titleOf(target)) : defaults && workspace ? t.team.openDefault(workspace.name) : t.team.openNew;
  const label = busy ? (target ? c.sending : t.officeUx.dockStarting) : target ? c.send : t.officeUx.dockSend;
  return <section ref={root} className={`office-prompt-dock${compact ? ' is-compact' : ''}`} aria-label={t.officeUx.dockTitle}
    data-entrance={entering || undefined} data-open={open || undefined} data-target={target ? 'session' : 'new'}
    onFocus={() => setEngaged(true)} onBlur={settle}>
    {!workspace ? <div className="office-prompt-empty"><p>{t.officeUx.dockNoWorkspace}</p><button type="button" className="button" onClick={onOpenSettings}>{t.officeUx.dockOpenSettings}</button></div> :
      // Not a <form>: Radix selects inside forms add hidden native selects whose change events can reset a just-added target.
      <div className="office-prompt-form" role="group" aria-label={t.officeUx.dockTitle}>
        {/* Compact docks fold these rows away (CSS grid rows 0fr ↔ 1fr, both ways); folded rows are inert. */}
        <div className="office-prompt-fold is-top" inert={!open}><div className="office-prompt-fold-inner">
        <div className="office-prompt-head">
          <strong className="office-prompt-title"><Icon name="spark" /><span>{target ? c.targetAgent(titleOf(target)) : t.officeUx.dockTitle}</span></strong>
          <div className="office-prompt-workspace" title={`${t.officeUx.dockWorkspace}: ${workspace.name}`}>
            <Select aria-label={t.officeUx.dockWorkspace} value={workspace.id} disabled={busy}
              options={state.workspaces.map(item => ({ value: item.id, label: item.name, icon: 'folder' as const }))}
              onChange={next => { setChosen(next); if (target && target.workspaceId !== next) onTarget(undefined); }} />
          </div>
        </div>
        </div></div>
        <div className="office-prompt-input">
          <textarea ref={area} id={`${id}-prompt`} aria-label={target ? c.targetAgent(titleOf(target)) : t.officeUx.dockPlaceholder} aria-describedby={`${id}-hint`}
            placeholder={target ? c.cardPlaceholder(titleOf(target)) : t.officeUx.dockPlaceholder}
            value={text} disabled={busy} rows={1}
            onChange={event => setText(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
          <button type="button" onClick={() => void send()} className="button primary office-prompt-send" disabled={busy || !text.trim() || targetBusy} aria-label={label} title={c.shortcut}>
            <Icon name={busy ? 'refresh' : 'send'} className={busy ? 'spin' : ''} /><span>{label}</span>
          </button>
        </div>
        <div className="office-prompt-fold is-bottom" inert={!open}><div className="office-prompt-fold-inner">
        <div className="office-prompt-options">
          <div className="office-prompt-target" title={target ? [titleOf(target), taskOf(target)].filter(Boolean).join('\n') : c.targetNew}>
            <Select aria-label={c.target} value={target?.id ?? NEW_TARGET} disabled={busy}
              options={[{ value: NEW_TARGET, label: c.targetNew, icon: 'plus' as const },
                ...targets.map(session => { const task = taskOf(session); return { value: session.id, label: titleOf(session), icon: 'chat' as const, ...(task ? { description: task } : {}), ...(session.running ? { badge: t.office.running } : {}) }; })]}
              onChange={value => onTarget(value === NEW_TARGET ? undefined : value)} />
            {target && <button type="button" className="icon-button small office-prompt-clear" aria-label={c.clearTarget} title={c.clearTarget} disabled={busy}
              onClick={() => onTarget(undefined)}><Icon name="close" /></button>}
            {teams && (target || defaults) && <button type="button" className="office-prompt-team" aria-haspopup="dialog" disabled={busy} data-on={teamStatus?.enabled || undefined}
              aria-label={teamLabel} title={teamLabel}
              // A compact dock grows when focused; keep a mouse press from moving the button away before the click lands.
              onMouseDown={event => event.preventDefault()} onClick={() => setTeamOpen('team')}>
              <Icon name="users" /><span>{teamStatus?.enabled ? t.team.status(teamStatus.size) : teamStatus ? t.team.statusOff : t.team.open}</span>
            </button>}
          </div>
          {supported && <div className="office-prompt-option office-prompt-model" title={c.model}>
            <ComboBox id={`${id}-model`} label={c.model} value={model} options={modelOptions} onChange={setModel}
              placeholder={choices?.defaultModel ? c.modelDefault(choices.defaultModel) : c.modelPlaceholder}
              customLabel={t.workspace.hermesModelScan.custom} emptyLabel={t.workspace.hermesModelScan.empty} />
          </div>}
          {supported && efforts.length > 0 && <div className="office-prompt-option office-prompt-effort">
            <Select label={c.effort} id={`${id}-effort`} value={efforts.includes(effort as Effort) ? effort : DEFAULT_EFFORT} disabled={busy}
              options={[{ value: DEFAULT_EFFORT, label: c.effortDefault(choices?.defaultEffort ? c.efforts[choices.defaultEffort] ?? choices.defaultEffort : undefined) },
                ...efforts.map(value => ({ value, label: c.efforts[value] ?? value }))]}
              onChange={setEffort} />
          </div>}
        </div>
        {preview && <div className="office-prompt-spec" role="status" data-hermes={hermesTarget || undefined}>
          <span className="office-prompt-spec-chip" title={specNames}><Icon name="users" /><span>{t.teamSpec.chip(preview.names.length, specNames)}</span>
            {reviewedNow && <span className="office-prompt-spec-done"><Icon name="check" /><span className="visually-hidden">{t.teamSpec.reviewed}</span></span>}</span>
          {teams && <button type="button" className="button small office-prompt-spec-review" aria-haspopup="dialog" aria-label={t.teamSpec.reviewLabel} disabled={busy}
            onMouseDown={event => event.preventDefault()} onClick={() => setTeamOpen('spec')}>{t.teamSpec.review}</button>}
          <small className="office-prompt-spec-note">{!teams ? t.teamSpec.unsupported : target ? t.teamSpec.sendNote : t.teamSpec.sendNoteNew}{teams && hermesTarget && <> {t.teamSpec.hermesModels}</>}
            {preview.discord && <> {t.teamSpec.discord}</>}</small>
        </div>}
        <p id={`${id}-hint`} className="office-prompt-hint" aria-live="polite">
          <Icon name={targetBusy ? 'alert' : target ? 'chat' : 'plus'} /><span>{hint}</span><kbd>{c.shortcut}</kbd>
        </p>
        </div></div>
        {error && <p className="form-error" role="alert">{error}</p>}
        {teamOpen && <TeamSetupDialog key={`${teamOpen}:${target?.id ?? `new:${workspace.id}`}`} t={t} agents={agents} workspaceId={workspace.id} workspaceName={workspace.name}
          scope={dialogScope} sessionId={target?.id} leadName={target ? titleOf(target) : undefined}
          initialGoal={text} pending={dialogScope === 'workspace' ? workspaceTeam : reviewedTeam ?? workspaceTeam} officeNames={officeNames} savedLooks={savedLooks}
          {...(teamOpen === 'spec' && preview ? { spec: preview.spec, discord: preview.discord } : {})}
          onClose={() => setTeamOpen(false)} onState={onState}
          onSaved={team => {
            // A reviewed prompt team stays for this prompt only; the workspace default was saved on the host (onState).
            if (dialogScope === 'draft') { setReviewed(team ? { text, team } : undefined); return; }
            if (target) void agents.getState().then(onState, () => undefined);
          }} />}
      </div>}
  </section>;
}
