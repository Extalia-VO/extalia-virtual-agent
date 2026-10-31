import type { CharacterAppearance } from '@extalia/core';
import type { PortraitActivity } from './portrait3d/model';
import type { SessionContextUsage } from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Messages } from '../../i18n';
import { errorMessage } from '../../host/remote';
import { Icon } from '../../ui/Icon';
import { OriginChip } from '../../ui/OriginMark';
import type { AgentOrigin } from '../agentOrigin';
import { useAutoGrow } from '../OfficePromptDock';
import { AppearanceEditor } from '../AppearanceEditor';
import type { CharacterAppearanceControls } from '../CharacterConversation';
import { applyPopoverPlacement, setCharacterPopoverElement } from '../scene/PopoverAnchor';
import type { LookIdentity } from '../scene/avatars/appearance';
import { ApprovalActions } from '../../approvals/ApprovalInbox';
import type { PendingApproval } from '../../approvals/model';
import { AgentPortrait } from './AgentPortrait';
import { ContextUsageLine } from './ContextUsage';
import { dockCharacterPopover, type PopoverState } from './popoverModel';

/** What the card shows about a character; facility characters simply have no session actions. */
export interface PopoverCharacter {
  id: string;
  displayName: string;
  /** v0.0.30: the full name its generated look is seeded from. */
  identity?: LookIdentity | undefined;
  /** v0.0.30: a named lead's session title (its task line). */
  task?: string | undefined;
  /** e.g. "Lead agent", "Receptionist". */
  role: string;
  project?: string | undefined;
  /** Room or resource, only when it says something useful. */
  place?: string | undefined;
  state: PopoverState;
  summary: string;
  /** v0.0.37 observed agents: the outside app, how its events arrive (translated) and the model it reported. */
  origin?: { origin: AgentOrigin; channel?: string | undefined; model: string } | undefined;
  /** v0.0.48: the lead's context in use, shown under the state line. */
  context?: SessionContextUsage | undefined;
}

/** A managed session this character can take a prompt in (a worker's goes to its lead). Observed agents and staff have none. */
export interface PopoverPrompt {
  /** A turn is running; the host refuses another prompt until it ends. */
  busy: boolean;
  /** Set when the character is a worker: the lead agent that receives the prompt. */
  lead?: string | undefined;
  send(text: string): Promise<void>;
}

/** Inline "Message <name>…" field: Enter sends into the character's own session, Shift+Enter adds a line. */
function QuickPrompt({ t, name, prompt }: { t: Messages; name: string; prompt: PopoverPrompt }) {
  const c = t.officeUx.composer;
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string>();
  const area = useAutoGrow(text, 4);
  const hintId = useId();
  useEffect(() => {
    if (phase !== 'sent') return;
    const timer = window.setTimeout(() => setPhase('idle'), 2400);
    return () => window.clearTimeout(timer);
  }, [phase]);
  const send = async () => {
    const value = text.trim();
    if (!value || phase === 'sending' || prompt.busy) return;
    setPhase('sending'); setError(undefined);
    try { await prompt.send(value); setText(''); setPhase('sent'); } catch (failure) { setError(errorMessage(failure)); setPhase('idle'); }
  };
  const hint = prompt.busy ? c.cardBusy : prompt.lead ? c.viaSubagent(name, prompt.lead) : c.cardHint;
  return <form className="character-popover-prompt" data-busy={prompt.busy || undefined} onSubmit={event => { event.preventDefault(); void send(); }}>
    <div className="character-popover-prompt-field">
      <textarea ref={area} rows={1} value={text} aria-label={c.cardLabel(name)} aria-describedby={hintId} placeholder={c.cardPlaceholder(prompt.lead ?? name)}
        disabled={phase === 'sending' || prompt.busy} onChange={event => { setText(event.target.value); if (phase === 'sent') setPhase('idle'); }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      <button type="submit" className="character-popover-send" aria-label={phase === 'sending' ? c.sending : c.send} title={c.shortcut}
        disabled={!text.trim() || phase === 'sending' || prompt.busy}><Icon name={phase === 'sending' ? 'refresh' : 'send'} className={phase === 'sending' ? 'spin' : ''} /></button>
    </div>
    <p id={hintId} className="character-popover-prompt-hint" aria-live="polite">
      {phase === 'sent' ? <><Icon name="check" />{c.sent}</> : phase === 'sending' ? c.sending : hint}
    </p>
    {error && <p className="form-error" role="alert">{error}</p>}
  </form>;
}

const SHORTCUTS = { m: 'message', a: 'activity', f: 'follow', e: 'appearance' } as const;
/** Presses here belong to the scene or to the card's own floating parts and never dismiss it. */
const KEEP_OPEN = '[data-radix-popper-content-wrapper], [role="listbox"], [aria-modal="true"]';

/**
 * Small card for a character clicked in the office: who it is, what it is doing
 * in one sentence, and what to do next. `PopoverAnchor` keeps it beside the
 * character every frame. Message/Activity only exist when there is a session.
 * Key it by character id so another character starts fresh.
 */
export function CharacterPopover({ t, character, appearance, look, activity, following, suspended = false, prompt, approval, onMessage, onActivity, onFollow, onLocate, onClose }: {
  t: Messages;
  character: PopoverCharacter;
  /** Saved/previewed look for the portrait. */
  look?: CharacterAppearance | undefined;
  activity?: PortraitActivity | undefined;
  appearance?: CharacterAppearanceControls | undefined;
  following: boolean;
  /** A dialog above the card owns keyboard and pointer input. */
  suspended?: boolean;
  /** Quick prompt into the character's managed session; absent for observed agents and facility staff. */
  prompt?: PopoverPrompt | undefined;
  /** v0.0.48: the approval this character waits for, answered inline (the same handlers as the inbox). */
  approval?: PendingApproval | undefined;
  onMessage?: (() => void) | undefined;
  onActivity?: (() => void) | undefined;
  onFollow?: (() => void) | undefined;
  onLocate(): void;
  onClose(): void;
}) {
  const p = t.characterPopover;
  const root = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [editing, setEditing] = useState(false);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  const paused = useRef(suspended);
  useEffect(() => { paused.current = suspended; });

  useLayoutEffect(() => {
    setCharacterPopoverElement(root.current);
    return () => setCharacterPopoverElement(null);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || paused.current) return;
      // An open select list closes first.
      if (document.querySelector('[role="listbox"]')) return;
      event.preventDefault();
      close.current();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (paused.current || !(target instanceof Element) || root.current?.contains(target)) return;
      // Presses on the scene may be camera drags; the scene closes the card on a real miss.
      if (target instanceof HTMLCanvasElement || target.closest(KEEP_OPEN)) return;
      close.current();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer, true); };
  }, []);

  // Focus the first action once the anchor has placed the card; dock it if no scene places it (e.g. WebGL failed).
  useEffect(() => {
    let second = 0;
    const firstFrame = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const element = root.current;
        const stage = element?.offsetParent as HTMLElement | null;
        if (element && stage && element.dataset.anchored === 'pending') {
          applyPopoverPlacement(element, dockCharacterPopover([element.offsetWidth, element.offsetHeight], [stage.clientWidth, stage.clientHeight]));
        }
        first.current?.focus({ preventScroll: true });
      });
    });
    return () => { cancelAnimationFrame(firstFrame); cancelAnimationFrame(second); };
  }, []);

  const act = (action: (typeof SHORTCUTS)[keyof typeof SHORTCUTS]) => {
    if (action === 'message') onMessage?.();
    else if (action === 'activity') onActivity?.();
    else if (action === 'follow') onFollow?.();
    else if (appearance) setEditing(value => !value);
  };
  const onShortcut = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if ((event.target as HTMLElement).closest('input, textarea, select, [role="combobox"], [role="listbox"]')) return;
    const action = SHORTCUTS[event.key.toLowerCase() as keyof typeof SHORTCUTS];
    if (!action) return;
    event.preventDefault();
    act(action);
  };

  const hasPrimary = Boolean(onMessage || onActivity);
  return <div ref={root} className="character-popover" role="dialog" aria-labelledby={titleId} data-anchored="pending" data-side="above"
    data-state={character.state} data-editing={editing || undefined} onKeyDown={onShortcut}>
    <div className="character-popover-card">
      <div className="character-popover-away" role="note">
        <span>{p.notInView}</span>
        <button type="button" onClick={onLocate}><Icon name="search" />{p.locate}</button>
      </div>
      <header className="character-popover-head">
        <AgentPortrait characterId={character.id} appearance={look} identity={character.identity} activity={activity} />
        <div className="character-popover-identity">
          <strong id={titleId}>{character.displayName}</strong>
          <span>{character.role}{character.project ? <> · <span className="character-popover-project">{character.project}</span></> : null}</span>
          {character.task && <span className="character-popover-task" title={character.task}>{character.task}</span>}
          {character.origin && <span className="agent-origin-line"><OriginChip origin={character.origin.origin} channel={character.origin.channel} showChannel />
            <code className="agent-origin-model" title={character.origin.model}>{character.origin.model}</code></span>}
        </div>
        <button type="button" className="icon-button small character-popover-close" aria-label={p.close(character.displayName)} onClick={onClose}><Icon name="close" /></button>
      </header>
      <section className="character-popover-now" aria-label={p.now} aria-live="polite">
        <p className="character-popover-state"><span className="character-popover-dot" aria-hidden="true" /><strong>{p.states[character.state]}</strong></p>
        {character.context && <p className="character-popover-context"><ContextUsageLine t={t} context={character.context} label /></p>}
        <p className="character-popover-summary">{character.summary}</p>
        {character.place && <p className="character-popover-place"><Icon name="pin" /><span className="visually-hidden">{p.place}: </span>{character.place}</p>}
      </section>
      {approval && <div className="character-popover-approval">
        <p><Icon name="shield" /><span>{approval.action}</span></p>
        <ApprovalActions t={t} approval={approval} compact />
      </div>}
      {editing && appearance ? <AppearanceEditor t={t.appearance} characterId={character.id} identity={appearance.identity} saved={appearance.saved} uniform={appearance.uniform} defaults={appearance.defaults}
        onPreview={appearance.onPreview} onSave={appearance.onSave} onClose={() => { setEditing(false); requestAnimationFrame(() => first.current?.focus({ preventScroll: true })); }} />
        : <>
          {prompt && <QuickPrompt t={t} name={character.displayName} prompt={prompt} />}
          {hasPrimary && <div className="character-popover-primary">
            {onMessage && <button ref={first} type="button" data-focus-key="popover:message" aria-keyshortcuts="M" aria-haspopup="dialog" onClick={onMessage}>
              <Icon name="chat" /><span>{p.message}</span><kbd aria-hidden="true">M</kbd></button>}
            {onActivity && <button ref={onMessage ? undefined : first} type="button" data-focus-key="popover:activity" aria-keyshortcuts="A" aria-haspopup="dialog" onClick={onActivity}>
              <Icon name="logs" /><span>{p.activity}</span><kbd aria-hidden="true">A</kbd></button>}
          </div>}
          {(onFollow || appearance) && <div className="character-popover-secondary">
            {onFollow && <button ref={hasPrimary ? undefined : first} type="button" aria-pressed={following} aria-keyshortcuts="F" title={t.officeOverlay.follow.hint} onClick={onFollow}>
              <Icon name="crosshair" /><span>{following ? t.officeOverlay.follow.stop : t.officeOverlay.follow.start}</span><kbd aria-hidden="true">F</kbd></button>}
            {appearance && <button ref={hasPrimary || onFollow ? undefined : first} type="button" aria-expanded={editing} aria-keyshortcuts="E" onClick={() => setEditing(true)}>
              <Icon name="edit" /><span>{p.appearance}</span><kbd aria-hidden="true">E</kbd></button>}
          </div>}
        </>}
    </div>
  </div>;
}
