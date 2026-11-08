import type { Workspace } from '@extalia/core';
import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { useLayoutEffect, useRef, useState } from 'react';
import type { Messages } from '../i18n';
import { errorMessage } from '../host/remote';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';
import { createMissionSession, MissionSetupChanged, missionSetupIssue } from './missionSetup';

/** Workspace-first entry. Creating a session never plans or launches a task. */
export function MissionSessionSetup({ t, agents, state, workspace, session, sessions, onWorkspace, onSession, onState, onCreated, onOpenSettings, onOpenChat }: {
  t: Messages; agents: AgentHostApi; state: HostState; workspace: Workspace | undefined;
  session: SessionSummary | undefined; sessions: readonly SessionSummary[];
  onWorkspace(id: string): void; onSession(session: SessionSummary): void;
  onState(state: HostState): void; onCreated(session: SessionSummary): void;
  onOpenSettings?: (() => void) | undefined; onOpenChat(): void;
}) {
  const m = t.missions;
  const issue = missionSetupIssue(state, workspace);
  const [pending, setPending] = useState<AgentHostApi | null>(null);
  const [error, setError] = useState<string>();
  const [knownHost, setKnownHost] = useState(agents);
  if (knownHost !== agents) { setKnownHost(agents); setPending(null); setError(undefined); }
  const owner = useRef({ active: true, generation: 0, pending: false });
  useLayoutEffect(() => {
    const current = owner.current;
    current.active = true;
    return () => { current.active = false; current.pending = false; current.generation++; };
  }, [agents]);
  const creating = pending === agents;
  const create = async () => {
    if (!workspace || issue || creating || owner.current.pending) return;
    const generation = ++owner.current.generation;
    const current = () => owner.current.active && generation === owner.current.generation;
    owner.current.pending = true;
    setPending(agents); setError(undefined);
    try { await createMissionSession({ agents, workspaceId: workspace.id, current, onState, onCreated }); }
    catch (failure) { if (current()) setError(failure instanceof MissionSetupChanged ? m.setupChanged : errorMessage(failure)); }
    finally { if (current()) { owner.current.pending = false; setPending(null); } }
  };
  return <section className="card mission-session" aria-label={m.project}>
    {state.workspaces.length > 0 && <Select label={m.project} value={workspace?.id ?? ''} disabled={creating} placeholder={m.project}
      options={state.workspaces.map(item => {
        const reason = missionSetupIssue(state, item);
        return { value: item.id, label: item.name, ...(reason ? { description: m.setupIssues[reason] } : {}) };
      })} onChange={onWorkspace} />}
    {sessions.length > 0 && <Select label={m.session} placeholder={m.session} value={session?.id ?? ''} disabled={creating}
      options={sessions.map(item => ({ value: item.id, label: item.title || item.agentName || m.untitled, ...(item.running ? { badge: m.busyBadge } : {}) }))}
      onChange={id => { const next = sessions.find(item => item.id === id); if (next) onSession(next); }} />}
    {issue && <p className="muted small" role="status">{m.setupIssues[issue]}</p>}
    {session?.running && <p className="warning small" role="status"><Icon name="alert" />{m.sessionBusy}</p>}
    {!issue && <>
      <button type="button" className={`button ${session ? 'small' : 'primary'}`} disabled={creating} onClick={() => void create()}>
        <Icon name={creating ? 'refresh' : 'plus'} className={creating ? 'spin' : ''} />{creating ? m.creatingSession : m.createSession}
      </button>
      <p className="muted small">{m.newSessionHint}</p>
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {onOpenSettings && <button type="button" className="button small" onClick={onOpenSettings}><Icon name="settings" />{m.configure}</button>}
    <button type="button" className="button small" onClick={onOpenChat}><Icon name="chat" />{t.nav.chat}</button>
  </section>;
}
