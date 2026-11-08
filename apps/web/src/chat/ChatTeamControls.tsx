import type { Workspace } from '@extalia/core';
import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { useId } from 'react';
import type { Messages } from '../i18n';
import { TeamSetupDialog } from '../office/TeamSetupDialog';
import { Icon } from '../ui/Icon';
import type { ChatTeamController } from './chatTeam';

/** Persistent setup lives beside the composer, with explicit session/default ownership. */
export function ChatTeamControls({ t, agents, state, workspace, session, running, control }: {
  t: Messages; agents: AgentHostApi; state: HostState; workspace: Workspace; session?: SessionSummary;
  running: boolean; control: ChatTeamController;
}) {
  const id = useId();
  const m = t.chat.team;
  if (control.readOnly || !control.supported) return <div className="chat-team-controls chat-team-unsupported">
    <Icon name="users" /><p>{control.readOnly ? m.observed : m.unsupported}</p>
  </div>;
  const { team, loading, busy, error, enableBlock } = control;
  const active = Boolean(team?.enabled && team.members.length);
  const status = loading ? m.loading : error ? m.unavailable : !team?.members.length ? m.empty : active ? m.active : m.inactive;
  const blocked = enableBlock && enableBlock !== 'empty';
  const help = loading ? m.loading : error ? m.loadHelp : enableBlock === 'empty' ? m.setupFirst
    : enableBlock === 'limits' ? m.limits : enableBlock === 'routing' ? t.team.hermesCustomRouting
      : enableBlock === 'size' ? m.tooLarge : control.hermes ? t.team.hermesSharedModel : m.retained;
  const names = new Set(state.sessions.map(item => item.agentName).filter((name): name is string => Boolean(name)));
  return <section className="chat-team-controls" aria-labelledby={`${id}-title`} aria-busy={busy || loading}>
    <div className="chat-team-heading">
      <span id={`${id}-title`} className="chat-team-title"><Icon name="users" />{m.title}</span>
      <span className="chat-team-status" data-active={active && !loading && !error || undefined} role="status">{status}{team?.members.length && !loading && !error ? ` · ${m.members(team.members.length)}` : ''}</span>
      <span className="chat-team-scope">{session ? m.sessionScope : m.workspaceScope}</span>
    </div>
    <div className="chat-team-actions">
      <button type="button" className="button small" disabled={busy || loading} onClick={control.openSetup}>
        <Icon name="settings" />{m.setup}
      </button>
      <button type="button" role="switch" aria-checked={active} aria-label={m.switchLabel} aria-describedby={`${id}-help`}
        className="button small chat-team-switch" data-active={active || undefined}
        disabled={busy || loading || Boolean(error) || (!active && Boolean(enableBlock))} onClick={() => void control.toggle(!active)}>
        {busy ? <Icon name="refresh" className="spin" /> : <span className="chat-team-switch-track" aria-hidden="true"><span /></span>}
        {active ? m.deactivate : m.activate}
      </button>
      {(error || blocked) && <button type="button" className="button small" disabled={busy || loading} onClick={control.retry}><Icon name="refresh" />{m.retry}</button>}
    </div>
    <p id={`${id}-help`} className="chat-team-help">{help}</p>
    <p className="chat-team-help chat-team-ownership">{session ? running ? m.nextTurn : m.sessionHelp : m.workspaceHelp}</p>
    {control.hermes && <p className="chat-team-help">{m.hermesRuntime}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {control.open && <TeamSetupDialog t={t} agents={agents} workspaceId={workspace.id} workspaceName={workspace.name}
      scope={session ? 'session' : 'workspace'} sessionId={session?.id} leadName={session?.agentName} pending={team}
      officeNames={names} onSaved={control.onSaved} onState={control.onDialogState} onClose={control.closeSetup} />}
  </section>;
}
