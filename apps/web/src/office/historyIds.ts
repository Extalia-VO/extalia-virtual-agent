import type { SessionSummary } from '@extalia/platform';

/** At most this many observed sessions load event history for the Office. */
export const OBSERVED_HISTORY_LIMIT = 24;

/**
 * Sessions whose event history the Office loads: running or selected managed
 * sessions, plus the most recent observed sessions that are actively watched
 * (paused or unavailable observations have no live activity to show).
 * v0.0.47: `retained` managed sessions keep their history after their turn ends: their mission workers are still in
 * the office (lingering as Ready or Error before they leave, or with an unknown outcome).
 */
export function officeHistoryIds(sessions: readonly SessionSummary[], selectedSessionId?: string, observedLimit = OBSERVED_HISTORY_LIMIT, retained: ReadonlySet<string> = new Set()): string[] {
  const managed = sessions.filter(session => session.control === 'managed' && (session.running || session.id === selectedSessionId || retained.has(session.id))).map(session => session.id);
  const observed = sessions
    .filter(session => session.control === 'observed' && session.observation?.watching && session.observation.status === 'watching')
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
    .slice(0, observedLimit).map(session => session.id);
  return [...managed, ...observed];
}
