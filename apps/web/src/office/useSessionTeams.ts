import type { AgentHostApi, AgentTeam, SessionSummary } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import { useEffect, useMemo, useState } from 'react';
import type { PresenceMember, PresenceTeams } from './presence';
import { teamApi, teamSupported } from './team';

const NO_TEAMS: PresenceTeams = new Map();

/** Configured Native member models are display hints until runtime events report the actual model. */
export function presenceTeamMembers(team: AgentTeam | undefined, session: Pick<SessionSummary, 'control' | 'runtime'>): PresenceMember[] {
  const native = session.control === 'managed' && session.runtime?.id !== 'hermes';
  return (team?.members ?? []).map(member => {
    const model = native ? member.models[0] ?? (member.connectionId
      ? team?.connections?.find(connection => connection.connectionId === member.connectionId)?.allowedModels[0]
      : undefined) : undefined;
    return { id: member.id, name: member.name, ...(member.gender !== undefined ? { gender: member.gender } : {}), ...(model ? { model } : {}) };
  });
}

/** A persisted team revision invalidates cached member metadata even when its size stays the same. */
export function sessionTeamPresenceKey(session: SessionSummary, spawned = 0): string {
  return `${session.id}|${session.runtime?.id ?? 'extalia-native'}|${session.team?.enabled}|${session.team?.size}|${session.team?.updatedAt ?? ''}|${spawned}`;
}

/**
 * v0.0.30 ui: the members (names and explicit genders) of every shown session
 * that has a subagent team, so subagents are named and dressed from the team.
 * A session's team is fetched again when its summary changes or a new subagent
 * is spawned in it (the lead's `manage_team` or a team set from a prompt).
 * Hosts without teams return an empty map.
 */
export function useSessionTeamSnapshot(agents: AgentHostApi | undefined, sessions: readonly SessionSummary[], events: readonly ExtaliaEvent[], scope = '') {
  const supported = Boolean(agents && teamSupported(agents));
  const keys = useMemo(() => {
    if (!supported) return '';
    const spawned = new Map<string, number>();
    for (const event of events) if (event.body.type === 'subagent.spawned') spawned.set(event.sessionId, (spawned.get(event.sessionId) ?? 0) + 1);
    return sessions.filter(session => session.control === 'managed' && session.team)
      .map(session => sessionTeamPresenceKey(session, spawned.get(session.id) ?? 0)).sort().join('\n');
  }, [supported, sessions, events]);
  const requests = useMemo(() => keys ? keys.split('\n').map(key => {
    const [id, runtime] = key.split('|'); return { id: id!, runtime, key };
  }) : [], [keys]);
  const [cache, setCache] = useState<{ agents?: AgentHostApi; scope?: string; teams: PresenceTeams; signatures: ReadonlyMap<string, string> }>(
    () => ({ teams: NO_TEAMS, signatures: new Map() }));
  useEffect(() => {
    if (!agents || !requests.length) return;
    let live = true;
    const api = teamApi(agents);
    void Promise.all(requests.map(({ id, runtime, key }) => api.get(id).then(team => [id, key, presenceTeamMembers(team, { control: 'managed', ...(runtime === 'hermes' ? { runtime: { id: 'hermes', profile: '' } } : {}) })] as const, () => [id, key, undefined] as const))).then(results => {
      if (!live) return;
      setCache(current => {
        const sameSource = current.agents === agents && current.scope === scope;
        const previous = sameSource ? current.teams : NO_TEAMS;
        const next = new Map<string, readonly PresenceMember[]>();
        const signatures = new Map<string, string>();
        for (const [id, key, members] of results) {
          // Preserve display metadata after an error, but never certify a changed
          // roster revision or a different host/profile from that old metadata.
          const list = members ?? previous.get(id);
          if (list) next.set(id, list);
          if (members !== undefined || (sameSource && current.signatures.get(id) === key)) signatures.set(id, key);
        }
        return { agents, scope, teams: next, signatures };
      });
    });
    return () => { live = false; };
  }, [agents, requests, scope]);
  return useMemo(() => {
    const sameSource = cache.agents === agents && cache.scope === scope;
    const wanted = new Set(requests.map(request => request.id));
    return {
      teams: sameSource && requests.length ? new Map([...cache.teams].filter(([id]) => wanted.has(id))) : NO_TEAMS,
      readySessionIds: new Set(sameSource ? requests.filter(request => cache.signatures.get(request.id) === request.key).map(request => request.id) : []),
    };
  }, [cache, agents, requests, scope]);
}

/** Legacy display-only callers may retain the last metadata while a same-source revision refreshes. */
export function useSessionTeams(agents: AgentHostApi | undefined, sessions: readonly SessionSummary[], events: readonly ExtaliaEvent[]): PresenceTeams {
  return useSessionTeamSnapshot(agents, sessions, events).teams;
}
