import type { Workspace } from '@extalia/core';
import type { AgentHostApi, AgentTeam, HostState, ModelChoices, SessionSummary } from '@extalia/platform';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import { teamMemberLimit, teamSupported, workspaceTeamSupported } from '../office/team';
import { modelChoicesKey, sessionRuntime } from './sessionRuntime';

/** Switching delegation off never removes the reviewed roster or its connection grants. */
export function toggleChatTeam(team: AgentTeam | undefined, enabled: boolean): AgentTeam | undefined {
  return team && (!enabled || team.members.length > 0) ? { ...team, enabled } : undefined;
}

/** Profile-custom routing and unknown Hermes limits cannot promise a supported team. */
export function chatTeamEnableBlock(team: AgentTeam | undefined, hermes: boolean, choices?: ModelChoices): 'empty' | 'limits' | 'routing' | 'size' | undefined {
  if (!team?.members.length) return 'empty';
  if (!hermes) return undefined;
  if (!choices?.hermesDelegation || choices.runtime !== 'hermes') return 'limits';
  if (choices.hermesDelegation.modelRouting === 'profile-custom') return 'routing';
  if (team.members.length > teamMemberLimit(true, choices.hermesDelegation)) return 'size';
  return undefined;
}

export function useChatTeam({ agents, state, workspace, session, onState }: {
  agents: AgentHostApi; state: HostState; workspace?: Workspace; session?: SessionSummary; onState(state: HostState): void;
}) {
  const workspaceId = workspace?.id;
  const sessionId = session?.id;
  const readOnly = session?.control === 'observed';
  const supported = !readOnly && teamSupported(agents) && (sessionId ? typeof agents.getSessionTeam === 'function' : workspaceTeamSupported(agents));
  const catalogKey = modelChoicesKey(state, workspace, session);
  const scope = useMemo(() => ({ agents, workspaceId, sessionId, catalogKey, readOnly }), [agents, workspaceId, sessionId, catalogKey, readOnly]);
  const current = useRef<typeof scope | undefined>(scope);
  const sequence = useRef(0);
  const summaryKey = JSON.stringify(session?.team ?? null);
  const [loaded, setLoaded] = useState<{ scope: typeof scope; summaryKey: string; team?: AgentTeam; error?: string }>();
  const [savedDefault, setSavedDefault] = useState<{ scope: typeof scope; base: Workspace['team']; team?: AgentTeam }>();
  const [catalog, setCatalog] = useState<{ scope: typeof scope; choices?: ModelChoices }>();
  const [pending, setPending] = useState<typeof scope>();
  const mutation = useRef<typeof scope | undefined>(undefined);
  const [failure, setFailure] = useState<{ scope: typeof scope; message: string }>();
  const [dialog, setDialog] = useState<typeof scope>();
  const [revision, setRevision] = useState(0);
  const hermes = sessionRuntime(workspace, session) === 'hermes';
  const busy = pending === scope;
  const open = dialog === scope;
  const result = loaded?.scope === scope && loaded.summaryKey === summaryKey ? loaded : undefined;
  const team = sessionId ? result?.team : savedDefault?.scope === scope && savedDefault.base === workspace?.team ? savedDefault.team : workspace?.team;
  const loading = Boolean(supported && sessionId && !result);
  const error = failure?.scope === scope ? failure.message : result?.error;
  const choices = catalog?.scope === scope ? catalog.choices : undefined;
  const enableBlock = chatTeamEnableBlock(team, hermes, choices);

  useLayoutEffect(() => {
    current.current = scope;
    return () => { if (current.current === scope) current.current = undefined; };
  }, [scope]);
  useEffect(() => {
    if (!supported || !sessionId) return;
    const request = ++sequence.current;
    let live = true;
    agents.getSessionTeam(sessionId).then(team => {
      if (live && current.current === scope && sequence.current === request) setLoaded({ scope, summaryKey, ...(team ? { team } : {}) });
    }, failure => {
      if (live && current.current === scope && sequence.current === request) setLoaded({ scope, summaryKey, error: errorMessage(failure) });
    });
    return () => { live = false; };
  }, [agents, scope, sessionId, summaryKey, supported, revision]);
  useEffect(() => {
    if (!supported || !hermes || !workspaceId) return;
    let live = true;
    agents.modelChoices(workspaceId, sessionId).then(choices => {
      if (live && current.current === scope) setCatalog({ scope, choices });
    }, () => { if (live && current.current === scope) setCatalog({ scope }); });
    return () => { live = false; };
  }, [agents, scope, workspaceId, sessionId, supported, hermes, revision]);

  async function toggle(enabled: boolean) {
    if (current.current !== scope || !supported || !workspaceId || mutation.current === scope || loading || error || (enabled && enableBlock)) return;
    const next = toggleChatTeam(team, enabled);
    if (!next) return;
    const request = ++sequence.current;
    mutation.current = scope;
    setPending(scope); setFailure(undefined);
    try {
      if (sessionId) {
        const saved = await agents.saveSessionTeam(sessionId, next);
        if (current.current !== scope || sequence.current !== request) return;
        setLoaded({ scope, summaryKey, ...(saved ? { team: saved } : {}) });
        const refreshed = await agents.getState().catch(() => undefined);
        if (refreshed && current.current === scope && sequence.current === request) onState(refreshed);
      } else {
        const refreshed = await agents.saveWorkspaceTeam(workspaceId, next);
        if (current.current !== scope || sequence.current !== request) return;
        setSavedDefault({ scope, base: workspace?.team, team: refreshed.workspaces.find(item => item.id === workspaceId)?.team });
        onState(refreshed);
      }
    } catch (failure) {
      if (current.current === scope && sequence.current === request) setFailure({ scope, message: errorMessage(failure) });
    } finally {
      if (mutation.current === scope) mutation.current = undefined;
      if (current.current === scope) setPending(undefined);
    }
  }

  return {
    team, supported, readOnly, hermes, loading, busy, open, error, enableBlock, choices,
    isUpdating: () => mutation.current === scope,
    openSetup: () => { if (current.current === scope && !busy && !loading) { setFailure(undefined); setDialog(scope); } },
    closeSetup: () => { if (current.current === scope) setDialog(undefined); },
    onSaved: (team: AgentTeam | null) => {
      if (current.current !== scope) return;
      ++sequence.current;
      setFailure(undefined);
      if (sessionId) {
        setLoaded({ scope, summaryKey, ...(team ? { team } : {}) });
        void agents.getState().then(refreshed => { if (current.current === scope) onState(refreshed); }).catch(() => undefined);
      } else setSavedDefault({ scope, base: workspace?.team, ...(team ? { team } : {}) });
    },
    onDialogState: (next: HostState) => { if (current.current === scope) onState(next); },
    retry: () => { setFailure(undefined); setLoaded(undefined); setCatalog(undefined); setRevision(value => value + 1); },
    toggle,
  };
}

export type ChatTeamController = ReturnType<typeof useChatTeam>;
