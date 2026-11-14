import type { CharacterAppearances, Effort } from '@extalia/core';
import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type RefObject } from 'react';
import type { Messages } from '../i18n';
import { errorMessage } from '../host/remote';
import { ComboBox } from '../ui/ComboBox';
import { Select } from '../ui/Select';
import { Icon } from '../ui/Icon';
import { modelComboOptions, normalizeOptions, optionsChange, workspaceTargets, type PromptModelChoices, type PromptOptions } from './promptTarget';
import { sessionAgentName } from './presence';
import { dockTeamStatus, teamDialogScope, teamForNewSession, teamSpecPreview, teamSupported, workspaceTeamSupported, type AgentTeam, type TeamSessionOptions, type TeamSpecPreview } from './team';
import { TeamSetupDialog } from './TeamSetupDialog';
import { modelChoicesKey, sessionRuntime } from '../chat/sessionRuntime';
import { formatBytes, sendPromptWithAttachments, uploadAttachments, type PendingAttachment } from '../chat/attachments';
import { LONG_PASTE_THRESHOLD, MESSAGE_TEXT_LIMIT, longTextFiles, pastedValue } from '../chat/longTextPaste';

/** Hosts before v0.0.27 lack per-session model/effort; everything here is feature-detected so they keep working. */
interface OptionsHost {
  modelChoices?: (workspaceId: string, sessionId?: string) => Promise<PromptModelChoices>;
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
interface DockAttachment extends PendingAttachment {
  /** A complete imported group can still provide the prompt's team spec. */
  promptText?: string;
  promptKeys?: readonly string[];
}

/** What a workspace's runtime offers; `choices` is undefined while loading, on failure, or when the host cannot choose per session. */
export function useModelChoices(agents: AgentHostApi, workspaceId: string | undefined, sessionId?: string, scopeKey?: string) {
  const host = optionsHost(agents);
  const supported = typeof host.modelChoices === 'function';
  const key = JSON.stringify([workspaceId, sessionId, scopeKey]);
  const [result, setResult] = useState<{ key: string; choices?: PromptModelChoices }>();
  useEffect(() => {
    const load = optionsHost(agents).modelChoices;
    if (!workspaceId || typeof load !== 'function') return;
    let live = true;
    load.call(agents, workspaceId, sessionId).then(choices => { if (live) setResult({ key, choices }); }, () => { if (live) setResult({ key }); });
    return () => { live = false; };
  }, [agents, workspaceId, sessionId, key]);
  const current = result && result.key === key ? result : undefined;
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
export function OfficePromptDock({ t, agents, state, workspaceId, compact = false, targetSessionId, note, onTarget, onState, onStarted, onOpenSettings, officeNames, savedLooks, onLearningTarget }: {
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
  /** The shared learning owner portals its view here; the dock measures the resulting height. */
  onLearningTarget?: (target: HTMLDivElement | null) => void;
}) {
  const workspaces = state.workspaces.filter(item => item.mode !== 'observe');
  const c = t.officeUx.composer;
  const id = useId();
  const root = useRef<HTMLElement>(null);
  const [chosen, setChosen] = useState(workspaceId ?? workspaces[0]?.id ?? '');
  const [text, setText] = useState('');
  const [chips, setChips] = useState<DockAttachment[]>([]);
  const chipsRef = useRef(chips);
  useLayoutEffect(() => { chipsRef.current = chips; }, [chips]);
  const [notice, setNotice] = useState<string>();
  const draftText = [...chips.filter(chip => chip.promptKeys?.every(key => chips.some(item => item.key === key))).map(chip => chip.promptText ?? ''), text].filter(Boolean).join('\n\n');
  const prompt = [chips.length ? t.composer.longTextPrompt(chips.map(chip => chip.name).join(', ')) : '', text.trim()].filter(Boolean).join('\n\n');
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
    if (!draftText.trim()) return;
    const timer = window.setTimeout(() => setSpec({ text: draftText, ...(teamSpecPreview(draftText) ? { preview: teamSpecPreview(draftText)! } : {}) }), SPEC_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draftText]);
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
  // Follow the active workspace without filtering the Office roster.
  const [filter, setFilter] = useState(workspaceId);
  if (filter !== workspaceId) { setFilter(workspaceId); setChosen(workspaceId ?? workspaces[0]?.id ?? ''); }

  const target = targetSessionId ? state.sessions.find(item => item.id === targetSessionId && item.control === 'managed') : undefined;
  // A targeted session decides the workspace; otherwise the dock's own choice (or active Office workspace).
  const workspace = workspaces.find(item => item.id === (target?.workspaceId ?? chosen)) ?? workspaces[0];
  const targets = workspaceTargets(state.sessions, workspace?.id);
  if (target && !targets.some(item => item.id === target.id)) targets.unshift(target);
  // v0.0.30: sessions are named by their lead's full name (the title stays as the task line).
  const titleOf = (session: SessionSummary) => sessionAgentName(session, c.untitled);
  const taskOf = (session: SessionSummary) => { const title = session.title.trim(); return title && title !== titleOf(session) ? title : undefined; };
  const modelScope = modelChoicesKey(state, workspace, target);
  const { supported, choices } = useModelChoices(agents, workspace?.id, target?.id, modelScope);
  // A send belongs to this exact context, even after switching away and back.
  const contextKey = JSON.stringify([workspace?.id, workspaceId, targetSessionId, sessionRuntime(workspace, target),
    target ? target.connectionId : workspace?.providerProfileId, target?.runtime?.profile ?? workspace?.runtimeProfileId]);
  const [context, setContext] = useState(() => ({ agents, key: contextKey }));
  if (context.key !== contextKey || context.agents !== agents) setContext({ agents, key: contextKey });
  const currentContext = useRef(context);
  const binding = useRef<{ context: typeof context; sessionId: string } | undefined>(undefined);
  const sending = useRef(false);
  useLayoutEffect(() => {
    if (currentContext.current !== context) {
      binding.current = undefined;
      setChips(current => current.map(chip => ({ ...chip, attachmentId: undefined, error: undefined, status: 'ready' })));
    }
    currentContext.current = context;
    return () => { if (currentContext.current === context) currentContext.current = { ...context }; };
  }, [context]);
  const efforts = choices?.efforts ?? [];
  const modelOptions = useMemo(() => modelComboOptions(choices, {
    useDefault: c.modelDefault, defaultBadge: t.workspace.hermesModelScan.defaultBadge, otherGroup: t.workspace.hermesModelScan.otherGroup,
  }), [choices, c, t.workspace.hermesModelScan]);

  // The controls start from what the target uses: a continued session's own override, defaults for a new one.
  const targetKey = target ? JSON.stringify([target.id, target.options?.model, target.options?.effort]) : `new:${modelScope}`;
  const [shownKey, setShownKey] = useState('');
  if (shownKey !== targetKey) {
    const current = normalizeOptions(target?.options);
    setShownKey(targetKey); setModel(current.model ?? ''); setEffort(current.effort ?? DEFAULT_EFFORT); setError(undefined);
  }

  const wanted: PromptOptions = normalizeOptions({ model, ...(effort !== DEFAULT_EFFORT && (!choices || efforts.includes(effort as Effort)) ? { effort: effort as Effort } : {}) });
  const targetBusy = Boolean(target?.running);
  const teams = teamSupported(agents);
  const defaults = workspaceTeamSupported(agents);
  const workspaceTeam = defaults ? workspace?.team : undefined;
  // The team reviewed from this prompt's subagent block (new session only; cleared when the text changes or is sent).
  const reviewedTeam = !target && reviewed && reviewed.text === draftText ? reviewed.team : undefined;
  const teamStatus = dockTeamStatus({ target, workspace, workspaceDefaults: defaults });
  const dialogScope = teamDialogScope({ sessionId: target?.id, fromPrompt: teamOpen === 'spec', workspaceDefaults: defaults });
  // v0.0.32: a prompt's team applies to Hermes sessions too (Hermes delegates with its own tool, on one model).
  const hermesTarget = sessionRuntime(workspace, target) === 'hermes';
  const preview = spec.text === draftText ? spec.preview : undefined;
  const reviewedNow = Boolean(preview && reviewedTeam);

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (busy || targetBusy || event.clipboardData.files.length) return;
    const incoming = event.clipboardData.getData('text/plain');
    const field = event.currentTarget;
    const next = pastedValue(text, incoming, field.selectionStart, field.selectionEnd);
    if (!incoming || next.length <= LONG_PASTE_THRESHOLD) return;
    event.preventDefault();
    const files = typeof agents.uploadAttachment === 'function' ? longTextFiles(next, chipsRef.current) : undefined;
    if (!files) { setText(next); setNotice(t.composer.longTextFailed); return; }
    const keys = files.map(file => file.name);
    const added = files.map((file, index): DockAttachment => ({
      key: file.name, file, name: file.name, mimeType: file.type, size: file.size, kind: 'text', status: 'ready',
      ...(index === 0 ? { promptText: next, promptKeys: keys } : {}),
    }));
    setChips(current => [...current, ...added]);
    setText(''); setNotice(t.composer.longTextAttached);
  }

  function removeChip(chip: DockAttachment) {
    setChips(current => current.filter(item => item.key !== chip.key)); setNotice(undefined);
    const sessionId = target?.id ?? (binding.current?.context === context ? binding.current.sessionId : undefined);
    if (chip.attachmentId && sessionId && agents.removeAttachment) void agents.removeAttachment(sessionId, chip.attachmentId).catch(() => undefined);
  }

  async function send() {
    if (!workspace || busy || sending.current || !prompt || prompt.length > MESSAGE_TEXT_LIMIT || targetBusy) return;
    const sentContext = context;
    const owns = () => currentContext.current === sentContext;
    const sent = chipsRef.current;
    sending.current = true;
    setBusy(true); setError(undefined);
    const host = optionsHost(agents);
    try {
      let sessionId: string;
      if (target) {
        sessionId = target.id;
        const change = supported ? optionsChange(target.options, wanted) : undefined;
        if (change && typeof host.setSessionOptions === 'function') await host.setSessionOptions.call(agents, sessionId, change);
      } else if (binding.current?.context === sentContext) {
        sessionId = binding.current.sessionId;
      } else {
        const chosen = supported && (wanted.model || wanted.effort) ? wanted : undefined;
        // v0.0.30: a team written into the prompt goes with the new session so its members show at once (a reviewed one as saved).
        // The host applies the prompt's spec too; members merge by name, so both agree.
        const promptSpec = preview ?? (teams ? teamSpecPreview(draftText) : undefined);
        // Without a draft or a prompt team nothing is sent: the host copies the workspace's default team.
        const result = teamForNewSession({
          draft: reviewedTeam, workspaceTeam, spec: teams ? promptSpec?.spec : undefined, reviewed: reviewedNow, taken: officeNames ?? [], seed: `${workspace.id}:${draftText.length}`,
        });
        if ('error' in result) { setError(t.teamSpec.invalid(result.error)); return; }
        const team = result.team;
        const options: TeamSessionOptions | undefined = team ? { ...chosen, team } : chosen;
        sessionId = (await (options ? agents.createSession(workspace.id, options) : agents.createSession(workspace.id))).id;
        if (!owns()) return;
        binding.current = { context: sentContext, sessionId };
      }
      if (!owns()) return;
      const ids = await uploadAttachments(agents, sessionId, sent, (key, change) => {
        if (owns()) setChips(current => current.map(chip => chip.key === key ? { ...chip, ...change } : chip));
      });
      if (!owns()) return;
      await sendPromptWithAttachments(agents, sessionId, prompt, ids);
      const sentKeys = new Set(sent.map(chip => chip.key));
      setChips(current => current.filter(chip => !sentKeys.has(chip.key)));
      if (!owns()) return;
      setText(''); setNotice(undefined); setReviewed(undefined);
      const nextState = await agents.getState();
      if (!owns()) return;
      onState(nextState);
      binding.current = undefined;
      // The next prompt continues the conversation that was just started; the chip says so and can be cleared.
      onTarget(sessionId);
      onStarted(sessionId);
    } catch (failure) { if (owns()) setError(errorMessage(failure)); }
    finally { sending.current = false; setBusy(false); }
  }
  const specNames = preview ? preview.names.map(name => name || t.teamSpec.unnamed).join(', ') : '';

  const open = !compact || engaged || Boolean(text) || chips.length > 0 || Boolean(error);
  const hint = targetBusy ? c.busy : note ?? (target ? c.hintContinue(titleOf(target)) : teamStatus?.enabled ? `${c.hintNew} ${t.team.pending}` : c.hintNew);
  const teamLabel = target ? t.team.openLabel(titleOf(target)) : defaults && workspace ? t.team.openDefault(workspace.name) : t.team.openNew;
  const label = busy ? (target ? c.sending : t.officeUx.dockStarting) : target ? c.send : t.officeUx.dockSend;
  return <section ref={root} className={`office-prompt-dock${compact ? ' is-compact' : ''}`} aria-label={t.officeUx.dockTitle}
    data-entrance={entering || undefined} data-open={open || undefined} data-target={target ? 'session' : 'new'}
    onFocus={event => { if (!(event.target as HTMLElement).closest('.learning-countdown')) setEngaged(true); }} onBlur={settle}>
    <div className="office-learning-slot" ref={onLearningTarget} />
    {!workspace ? <div className="office-prompt-empty"><p>{t.officeUx.dockNoWorkspace}</p><button type="button" className="button" onClick={onOpenSettings}>{t.officeUx.dockOpenSettings}</button></div> :
      // Not a <form>: Radix selects inside forms add hidden native selects whose change events can reset a just-added target.
      <div className="office-prompt-form" role="group" aria-label={t.officeUx.dockTitle}>
        {/* Compact docks fold these rows away (CSS grid rows 0fr ↔ 1fr, both ways); folded rows are inert. */}
        <div className="office-prompt-fold is-top" inert={!open}><div className="office-prompt-fold-inner">
        <div className="office-prompt-head">
          <strong className="office-prompt-title"><Icon name="spark" /><span>{target ? c.targetAgent(titleOf(target)) : t.officeUx.dockTitle}</span></strong>
          <div className="office-prompt-workspace" title={`${t.officeUx.dockWorkspace}: ${workspace.name}`}>
            <Select aria-label={t.officeUx.dockWorkspace} value={workspace.id} disabled={busy}
              options={workspaces.map(item => ({ value: item.id, label: item.name, icon: 'folder' as const }))}
              onChange={next => { setChosen(next); if (target && target.workspaceId !== next) onTarget(undefined); }} />
          </div>
        </div>
        </div></div>
        <div className="office-prompt-input">
          <textarea ref={area} id={`${id}-prompt`} aria-label={target ? c.targetAgent(titleOf(target)) : t.officeUx.dockPlaceholder} aria-describedby={`${id}-hint`}
            placeholder={target ? c.cardPlaceholder(titleOf(target)) : t.officeUx.dockPlaceholder}
            value={text} disabled={busy} rows={1}
            onPaste={onPaste} onChange={event => setText(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
          <button type="button" onClick={() => void send()} className="button primary office-prompt-send" disabled={busy || !prompt || prompt.length > MESSAGE_TEXT_LIMIT || targetBusy} aria-label={label} title={c.shortcut}>
            <Icon name={busy ? 'refresh' : 'send'} className={busy ? 'spin' : ''} /><span>{label}</span>
          </button>
        </div>
        {chips.length > 0 && <ul className="composer-chips">
          {chips.map(chip => <li key={chip.key} className={`composer-chip kind-text status-${chip.status}`}>
            <span className="composer-chip-icon" aria-hidden="true"><Icon name="file" /></span>
            <span className="composer-chip-text"><span className="composer-chip-name" title={chip.name}>{chip.name}</span>
              <span className="composer-chip-meta" title={chip.error}>{chip.status === 'uploading' ? t.composer.uploading : chip.status === 'failed' ? t.composer.uploadFailed : formatBytes(chip.size)}</span></span>
            <button type="button" className="composer-chip-remove" disabled={busy} aria-label={`${t.composer.removeFile} ${chip.name}`} title={t.composer.removeFile} onClick={() => removeChip(chip)}><Icon name="close" /></button>
          </li>)}
        </ul>}
        {(prompt.length > MESSAGE_TEXT_LIMIT || notice) && <p className="composer-notice" role="status">{prompt.length > MESSAGE_TEXT_LIMIT ? t.composer.longTextFailed : notice}</p>}
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
          initialGoal={draftText} pending={dialogScope === 'workspace' ? workspaceTeam : reviewedTeam ?? workspaceTeam} officeNames={officeNames} savedLooks={savedLooks}
          {...(teamOpen === 'spec' && preview ? { spec: preview.spec, discord: preview.discord } : {})}
          onClose={() => setTeamOpen(false)} onState={onState}
          onSaved={team => {
            // A reviewed prompt team stays for this prompt only; the workspace default was saved on the host (onState).
            if (dialogScope === 'draft') { setReviewed(team ? { text: draftText, team } : undefined); return; }
            if (target) void agents.getState().then(onState, () => undefined);
          }} />}
      </div>}
  </section>;
}
