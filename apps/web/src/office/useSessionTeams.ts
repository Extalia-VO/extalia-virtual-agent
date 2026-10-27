import type { AgentHostApi, SessionSummary } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import { useEffect, useMemo, useState } from 'react';
import type { PresenceMember, PresenceTeams } from './presence';
import { teamApi, teamSupported } from './team';

const NO_TEAMS: PresenceTeams = new Map();

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
      .map(session => `${session.id}|${session.team!.enabled}|${session.team!.size}|${spawned.get(session.id) ?? 0}`).sort().join('\n');
  }, [supported, sessions, events]);
  const [teams, setTeams] = useState<ReadonlyMap<string, readonly PresenceMember[]>>(() => new Map());
  useEffect(() => {
    if (!agents || !keys) return;
    let live = true;
    const ids = keys.split('\n').map(key => key.split('|')[0]!);
    const api = teamApi(agents);
    void Promise.all(ids.map(id => api.get(id).then(team => [id, team?.members ?? []] as const, () => [id, undefined] as const))).then(results => {
      if (!live) return;
      setTeams(current => {
        const next = new Map<string, readonly PresenceMember[]>();
        for (const [id, members] of results) {
          // A failed fetch keeps what was known before.
          const list = members ?? current.get(id);
          if (list) next.set(id, list.map(member => ({ id: member.id, name: member.name, ...((member as { gender?: unknown }).gender !== undefined ? { gender: (member as { gender?: unknown }).gender } : {}) })));
        }
        return next;
      });
    });
    return () => { live = false; };
  }, [agents, keys]);
  return keys ? teams : NO_TEAMS;
}
