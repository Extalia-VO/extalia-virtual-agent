import type { AgentHostApi, HostMissionRun, HostState } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { missionInfo, type OfficeMissionInfo, type OfficeMissions } from './missionPresence';

/** Mission events after which a retained record may have changed (a worker announced, started or ended; the mission ended). */
const SIGNAL: ReadonlySet<string> = new Set(['subagent.spawned', 'task.assigned', 'task.completed', 'turn.completed', 'turn.failed']);
/** Coalesce a burst of mission events (a 12-task launch) into one read per session. */
const READ_DELAY_MS = 250;
const EMPTY: OfficeMissions = new Map();

/**
 * v0.0.47 (ADR 0016): per session with native mission events, a signature that changes whenever its retained
 * mission records may have changed: correlated lifecycle events, plus whether the session still runs.
 */
export function missionSignatures(events: readonly ExtaliaEvent[], running: ReadonlySet<string> = new Set()): Map<string, string> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (!event.correlationId || !SIGNAL.has(event.body.type) || event.source.channel === 'import') continue;
    counts.set(event.sessionId, (counts.get(event.sessionId) ?? 0) + 1);
  }
  return new Map([...counts].map(([sessionId, count]) => [sessionId, `${count}:${running.has(sessionId) ? 1 : 0}`]));
}

/**
 * Retained native mission records of the sessions whose events mention missions, by mission id, read with
 * `listNativeMissions` (feature-detected) and re-read after mission events. Failures leave the events as the
 * only source: presence then shows what the events say, nothing more.
 */
export function useOfficeMissions(agents: AgentHostApi | undefined, state: HostState | null, events: readonly ExtaliaEvent[]): OfficeMissions {
  const running = useMemo(() => new Set((state?.sessions ?? []).filter(session => session.running).map(session => session.id)), [state?.sessions]);
  const signatures = useMemo(() => missionSignatures(events, running), [events, running]);
  const key = JSON.stringify([...signatures].sort(([a], [b]) => a.localeCompare(b)));
  const [runs, setRuns] = useState<ReadonlyMap<string, readonly HostMissionRun[]>>(() => new Map());
  const read = useRef(new Map<string, string>());
  const latest = useRef(new Map<string, number>());
  useEffect(() => {
    if (!agents || typeof agents.listNativeMissions !== 'function') return;
    const wanted = new Map<string, string>(JSON.parse(key) as [string, string][]);
    const due = [...wanted].filter(([sessionId, signature]) => read.current.get(sessionId) !== signature);
    if (!due.length) return;
    const timer = setTimeout(() => {
      for (const [sessionId, signature] of due) {
        read.current.set(sessionId, signature);
        const ticket = (latest.current.get(sessionId) ?? 0) + 1;
        latest.current.set(sessionId, ticket);
        agents.listNativeMissions(sessionId).then(list => {
          // Only the newest read of a session lands; it is kept even if the effect re-ran meanwhile.
          if (latest.current.get(sessionId) === ticket) setRuns(current => new Map(current).set(sessionId, list));
        }, () => { if (read.current.get(sessionId) === signature) read.current.delete(sessionId); });
      }
    }, READ_DELAY_MS);
    return () => clearTimeout(timer);
  }, [agents, key]);
  const connections = state?.connections;
  return useMemo(() => {
    if (!runs.size) return EMPTY;
    const name = (id: string) => connections?.find(connection => connection.id === id)?.name;
    const result = new Map<string, OfficeMissionInfo>();
    for (const list of runs.values()) for (const run of list) result.set(run.id, missionInfo(run, name));
    return result;
  }, [runs, connections]);
}
