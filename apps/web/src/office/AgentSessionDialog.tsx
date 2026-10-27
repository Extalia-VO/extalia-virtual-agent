import type { CharacterAppearance, CharacterAppearances } from '@extalia/core';
import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { OriginChip } from '../ui/OriginMark';
import { CharacterConversation, type CharacterAppearanceControls } from './CharacterConversation';
import { AgentPortrait } from './overlay/AgentPortrait';
import { ContextUsageLine } from './overlay/ContextUsage';
import { popoverState } from './overlay/popoverModel';
import type { SessionDialogTab } from './overlay/officeSelection';
import type { OfficeAgent } from './presence';
import { sessionTeamSummary, teamSupported } from './team';
import { TeamSetupDialog } from './TeamSetupDialog';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Makes everything outside `keep` inert while the dialog is open (the R3F canvas
 * keeps rendering; it just stops taking focus and input) and undoes it after.
 */
function useInertOutside(keep: HTMLElement | null) {
  useLayoutEffect(() => {
    if (!keep) return;
    const changed = [...document.body.children].filter((element): element is HTMLElement =>
      element instanceof HTMLElement && element !== keep && !element.inert && element.tagName !== 'SCRIPT');
    for (const element of changed) element.inert = true;
    return () => { for (const element of changed) element.inert = false; };
  }, [keep]);
}

/**
 * Full session view opened from the agents board (or a character card): identity,
 * workspace and status above `CharacterConversation` with Messages and Activity.
 * Modal: focus is trapped, the rest of the app is inert, Escape or Close returns
 * focus to the opener (the caller restores it). A session that ends or disappears
 * while shown stays readable with an explanation. The page renders at most one,
 * keyed by character, from a single dialog slot (`officeSelection`).
 */
export function AgentSessionDialog({ t, language, agents, state, onState, session, agent, role, workspace, look, appearance, tab, onTab, onClose, onLocate, onOpenInChat, onOpenMissions, onSelectCharacter, officeNames, savedLooks }: {
  t: Messages;
  language: string;
  agents: AgentHostApi;
  state: HostState;
  onState(next: HostState): void;
  /** Live session and character; `undefined` once they are gone. */
  session: SessionSummary | undefined;
  agent: OfficeAgent | undefined;
  role: string;
  workspace?: string | undefined;
  look?: CharacterAppearance | undefined;
  appearance?: CharacterAppearanceControls | undefined;
  tab: SessionDialogTab;
  onTab(tab: SessionDialogTab): void;
  onClose(): void;
  onLocate?: (() => void) | undefined;
  onOpenInChat?: ((session: SessionSummary) => void) | undefined;
  /** v0.0.43 missions: shown for managed Extalia Native sessions only. */
  onOpenMissions?: ((session: SessionSummary) => void) | undefined;
  /** Another character of the session, e.g. a worker picked from the team list. */
  onSelectCharacter?: ((characterId: string) => void) | undefined;
  /** v0.0.30: every name in the office, so new team names stay unique. */
  officeNames?: ReadonlySet<string> | undefined;
  /** v0.0.30: saved looks by character id, for the team dialog's portraits. */
  savedLooks?: CharacterAppearances | undefined;
}) {
  const d = t.sessionDialog;
  const titleId = useId();
  const [host] = useState(() => Object.assign(document.createElement('div'), { className: 'session-dialog-root' }));
  const dialog = useRef<HTMLDivElement>(null);
  // The last known session, character and context stay on screen after they end.
  const [last, setLast] = useState({ session, agent, role, workspace });
  if (session && agent && (session !== last.session || agent !== last.agent || role !== last.role || workspace !== last.workspace)) setLast({ session, agent, role, workspace });
  const shownSession = session ?? last.session;
  const shownAgent = agent ?? last.agent;
  const shownRole = session && agent ? role : last.role;
  const shownWorkspace = session ? workspace : last.workspace;
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  // v0.0.29 team-ui: the lead's subagent team setup, layered over this dialog.
  const [teamOpen, setTeamOpen] = useState(false);

  useLayoutEffect(() => {
    document.body.appendChild(host);
    return () => { host.remove(); };
  }, [host]);
  useInertOutside(host);

  useEffect(() => {
    // Start in the composer when there is one, otherwise on the dialog itself.
    const frame = requestAnimationFrame(() => {
      const composer = dialog.current?.querySelector<HTMLTextAreaElement>('#composer-input:not([disabled])');
      (composer ?? dialog.current)?.focus({ preventScroll: true });
    });
    // Capture: Escape closes this dialog before anything behind it (the character card, select lists) sees it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (document.querySelector('[role="listbox"]')) return;
        event.preventDefault(); event.stopPropagation(); close.current(); return;
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => !element.closest('[hidden]'));
      const first = focusable[0], last = focusable.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      if (!dialog.current.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', onKey, true); };
  }, []);

  if (!shownAgent) return null;
  const ended = !session ? d.removed
    : agent?.status === 'offline' && session.control === 'managed' ? d.ended : undefined;
  const status = ended ? t.chat.status.offline : t.characterPopover.states[popoverState(shownAgent)];
  const teamLead = session && !ended && session.control === 'managed' && !shownAgent.parentId && teamSupported(agents) ? session : undefined;
  const team = sessionTeamSummary(shownSession);
  return createPortal(<div className="session-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close.current(); }}>
    <div ref={dialog} className="session-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-state={ended ? 'ended' : popoverState(shownAgent)}>
      <header className="session-dialog-head">
        <AgentPortrait characterId={shownAgent.id} appearance={look} identity={shownAgent.look} activity={shownAgent} />
        <div className="session-dialog-identity">
          <h2 id={titleId}>{shownAgent.displayName}</h2>
          <p>
            {shownRole && <span>{shownRole}</span>}
            {shownAgent.title && <span className="session-dialog-task" title={shownAgent.title}>{shownAgent.title}</span>}
            {shownAgent.control === 'observed' && shownAgent.origin && <span className="agent-origin-line">
              <OriginChip origin={shownAgent.origin} channel={shownAgent.origin.channel ? t.observedOrigin.channels[shownAgent.origin.channel] : undefined} showChannel />
              <code className="agent-origin-model" title={shownAgent.model ?? t.observedOrigin.modelUnknown}>{shownAgent.model ?? t.observedOrigin.modelUnknown}</code>
            </span>}
            {shownWorkspace && <span className="session-dialog-workspace"><Icon name="folder" />{shownWorkspace}</span>}
            <span className="session-dialog-status"><span className="character-popover-dot" aria-hidden="true" />{status}</span>
            {shownAgent.context && <span className="session-dialog-context"><ContextUsageLine t={t} context={shownAgent.context} label /></span>}
          </p>
        </div>
        {teamLead && <button type="button" className="button small session-dialog-team" aria-haspopup="dialog" data-on={team?.enabled || undefined}
          aria-label={t.team.openLabel(shownAgent.displayName)} title={t.team.openLabel(shownAgent.displayName)} onClick={() => setTeamOpen(true)}>
          <Icon name="users" />{team?.enabled ? t.team.status(team.size) : team ? t.team.statusOff : t.team.open}
        </button>}
        {session && onOpenMissions && session.control === 'managed' && !session.runtime && !shownAgent.parentId && <button type="button" className="button small"
          aria-label={t.missions.linkLabel(shownAgent.displayName)} onClick={() => onOpenMissions(session)}><Icon name="mission" />{t.missions.link}</button>}
        {session && onOpenInChat && <button type="button" className="button small" onClick={() => onOpenInChat(session)}>
          <Icon name={session.control === 'observed' ? 'book' : 'chat'} />{session.control === 'observed' ? t.office.openObserved : t.office.openSession}
        </button>}
        <button type="button" className="icon-button session-dialog-close" aria-label={d.close} title={`${d.close} (Esc)`} onClick={() => close.current()}><Icon name="close" /></button>
      </header>
      <div className="session-dialog-body">
        {shownSession && <CharacterConversation key={shownAgent.id} t={t} language={language} agents={agents} state={state} session={shownSession} agent={shownAgent}
          onState={onState} appearance={ended ? undefined : appearance} tab={tab} onTab={onTab} readOnlyReason={ended}
          onLocate={ended ? undefined : onLocate} onSelectCharacter={onSelectCharacter} />}
      </div>
      {teamOpen && teamLead && <TeamSetupDialog t={t} agents={agents} workspaceId={teamLead.workspaceId} sessionId={teamLead.id} leadName={shownAgent.displayName} officeNames={officeNames} savedLooks={savedLooks}
        onClose={() => setTeamOpen(false)} onState={onState} onSaved={() => { void agents.getState().then(onState, () => undefined); }} />}
    </div>
  </div>, host);
}
