import type { ExtaliaEvent } from '@extalia/protocol';
import { isAdmitted, type OfficeAgent } from '../presence';

/**
 * Office counters (v0.0.38). Every agent on the board that has not left (leads and subagents, managed and
 * observed) is counted in exactly one activity bucket, so working + waiting + errors + idle = agents present:
 * - working: thinking, planning, compacting, delegating or using tools;
 * - waiting: needs the user — an approval, or an answer to its question;
 * - errors: its last turn failed (v0.0.43: with the reason, such as out of tokens or quota), it is blocked / its
 *   source is unavailable, or (v0.0.43) an observed agent stopped responding mid-work (`stalled`): each needs a look;
 * - idle: ready, observing, paused, interrupted.
 * Agents listed under the board's "Earlier" group (`earlier`) have left and are never counted (v0.0.43).
 * v0.0.47 (ADR 0016) mission workers count like any agent while admitted: running → working, ended well → idle
 * (Ready), failed → errors, unknown task state → errors (shown "Unknown" with a warning tone, never Ready). Queued
 * and never-started workers are listed under their lead but are not in the office, so they are not counted.
 * Two more counters: running = sessions with a turn in progress (a running managed session, or an observed one
 * whose lead or subagents report live work), observed = agents watched from another app.
 */
export interface OfficeKpis {
  running: number;
  waiting: number;
  working: number;
  errors: number;
  observed: number;
  idle: number;
}

export type ActivityBucket = 'working' | 'waiting' | 'errors' | 'idle';

export const ERROR_WINDOW_MS = 60 * 60 * 1000;

/** Failed turns (not imported history) in the last hour; kept for activity summaries. */
export function failedTurnsSince(events: readonly ExtaliaEvent[], now: number, windowMs = ERROR_WINDOW_MS): number {
  const seen = new Set<string>();
  for (const event of events) {
    if (event.body.type !== 'turn.failed' || event.source.channel === 'import' || seen.has(event.id)) continue;
    const age = now - Date.parse(event.at);
    // A timestamp slightly in the future (clock skew) still counts as just now.
    if (Number.isFinite(age) && age <= windowMs) seen.add(event.id);
  }
  return seen.size;
}

/** The one bucket an agent counts in. */
export function activityBucket(agent: Pick<OfficeAgent, 'status' | 'phase' | 'pendingApprovalId'> & Partial<Pick<OfficeAgent, 'stalled' | 'mission'>>): ActivityBucket {
  if (agent.mission?.state === 'unknown') return 'errors';
  if (agent.pendingApprovalId || agent.status === 'waiting') return 'waiting';
  if (agent.phase === 'error' || agent.stalled || agent.status === 'blocked' || agent.status === 'unavailable') return 'errors';
  if (agent.status === 'working' || agent.status === 'thinking' || agent.status === 'delegating' || agent.status === 'stopping') return 'working';
  return 'idle';
}

/** v0.0.43: a presence that is in the office: not offline and not listed under "Earlier"; v0.0.47: not a mission worker that has not started. */
export const inOffice = (agent: Pick<OfficeAgent, 'status'> & Partial<Pick<OfficeAgent, 'earlier' | 'mission'>>): boolean => agent.status !== 'offline' && !agent.earlier && isAdmitted(agent);

export function officeKpis(presences: readonly OfficeAgent[], _events: readonly ExtaliaEvent[] = [], _now = Date.now()): OfficeKpis {
  const present = presences.filter(inOffice);
  const counts: Record<ActivityBucket, number> = { working: 0, waiting: 0, errors: 0, idle: 0 };
  for (const agent of present) counts[activityBucket(agent)]++;
  // A turn waiting for the user is still in progress.
  const running = new Set(present.filter(agent => agent.running || (agent.control === 'observed' && agent.live && agent.status === 'waiting')).map(agent => agent.sessionId));
  return { running: running.size, ...counts, observed: present.filter(agent => agent.control === 'observed').length };
}
