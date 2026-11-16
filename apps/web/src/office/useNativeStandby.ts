import { useMemo } from 'react';
import type { AgentHostApi, SessionSummary } from '@extalia/platform';
import type { OfficeAgent, PresenceTeams } from './presence';
import { NativeStandbyRotation } from './nativeStandby';

// Keep fairness through page navigation, scoped to the host/profile/view. Nothing
// is persisted and disconnected hosts can be collected with their cache.
const rotations = new WeakMap<AgentHostApi, Map<string, NativeStandbyRotation>>();
const MAX_SCOPES = 16;

export function useNativeStandby(agents: AgentHostApi | undefined, scope: string, presences: readonly OfficeAgent[],
  sessions: readonly SessionSummary[], teams: PresenceTeams, now: number, readySessionIds: ReadonlySet<string>, readyTeamIds?: ReadonlySet<string>): OfficeAgent[] {
  const rotation = useMemo(() => {
    if (!agents) return new NativeStandbyRotation();
    let scopes = rotations.get(agents);
    if (!scopes) { scopes = new Map(); rotations.set(agents, scopes); }
    let current = scopes.get(scope);
    if (!current) current = new NativeStandbyRotation();
    scopes.delete(scope); scopes.set(scope, current);
    while (scopes.size > MAX_SCOPES) scopes.delete(scopes.keys().next().value!);
    return current;
  }, [agents, scope]);
  return useMemo(() => rotation.project({ presences, sessions, teams, now,
    readySessionIds: new Set([...readySessionIds].filter(id => teams.has(id) && (!readyTeamIds || readyTeamIds.has(id)))),
  }), [rotation, presences, sessions, teams, now, readySessionIds, readyTeamIds]);
}
