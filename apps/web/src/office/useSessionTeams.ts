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
export function useSessionTeams(agents: AgentHostApi | undefined, sessions: readonly SessionSummary[], events: readonly ExtaliaEvent[]): PresenceTeams {
  const supported = Boolean(agents && teamSupported(agents));
  const keys = useMemo(() => {
    if (!supported) return '';
    const spawned = new Map<string, number>();
    for (const event of events) if (event.body.type === 'subagent.spawned') spawned.set(event.sessionId, (spawned.get(event.sessionId) ?? 0) + 1);
    return sessions.filter(session => session.control === 'managed' && session.team)
      .map(session => sessionTeamPresenceKey(session, spawned.get(session.id) ?? 0)).sort().join('\n');
  }, [supported, sessions, events]);
  const [teams, setTeams] = useState<ReadonlyMap<string, readonly PresenceMember[]>>(() => new Map());
  useEffect(() => {
    if (!agents || !keys) return;
    let live = true;
    const requests = keys.split('\n').map(key => { const [id, runtime] = key.split('|'); return { id: id!, runtime }; });
    const api = teamApi(agents);
    void Promise.all(requests.map(({ id, runtime }) => api.get(id).then(team => [id, presenceTeamMembers(team, { control: 'managed', ...(runtime === 'hermes' ? { runtime: { id: 'hermes', profile: '' } } : {}) })] as const, () => [id, undefined] as const))).then(results => {
      if (!live) return;
      setTeams(current => {
        const next = new Map<string, readonly PresenceMember[]>();
        for (const [id, members] of results) {
          // A failed fetch keeps what was known before.
          const list = members ?? current.get(id);
          if (list) next.set(id, list);
        }
        return next;
      });
    });
    return () => { live = false; };
  }, [agents, keys]);
  return keys ? teams : NO_TEAMS;
}
