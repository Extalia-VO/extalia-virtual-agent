import type { SessionSummary } from '@extalia/platform';
import type { OfficeAgent } from './presence';

export type OfficeSourceFilter = 'all' | 'native' | 'hermes' | 'observed' | 'unassigned';

export const OFFICE_SOURCE_FILTERS: readonly OfficeSourceFilter[] = [
  'all',
  'native',
  'hermes',
  'observed',
  'unassigned',
];

export type OfficeDisplayMode = '3d' | '2d';

/** Classifies a session into its source runtime family for shared Office filtering. */
export function sessionSourceKind(session: Pick<SessionSummary, 'control' | 'runtime'>): 'observed' | 'hermes' | 'native' {
  if (session.control === 'observed') return 'observed';
  if (session.runtime?.id === 'hermes') return 'hermes';
  return 'native';
}

function matchesSourceFilter(session: SessionSummary, source: OfficeSourceFilter): boolean {
  switch (source) {
    case 'all':
      return true;
    case 'unassigned':
      return session.workspaceId === null;
    case 'observed':
      return session.control === 'observed';
    case 'hermes':
      return session.control === 'managed' && session.runtime?.id === 'hermes';
    case 'native':
      return session.control === 'managed' && !session.runtime;
  }
}

/** Deduplicates sessions by id (preserving order) and applies the selected source filter. */
export function filterOfficeSessions(
  sessions: readonly SessionSummary[],
  filter: { source: OfficeSourceFilter },
): SessionSummary[] {
  const seenIds = new Set<string>();
  const filtered: SessionSummary[] = [];
  for (const session of sessions) {
    if (seenIds.has(session.id)) continue;
    seenIds.add(session.id);
    if (matchesSourceFilter(session, filter.source)) filtered.push(session);
  }
  return filtered;
}

function agentIdentityKey(agent: OfficeAgent): string {
  return agent.sessionId && agent.agentId ? `${agent.sessionId}:${agent.agentId}` : agent.id;
}

function prefersCandidate(existing: OfficeAgent, candidate: OfficeAgent): boolean {
  const existingActive = !existing.earlier;
  const candidateActive = !candidate.earlier;
  if (candidateActive !== existingActive) return candidateActive;
  const existingActivity = existing.lastActivityAt ?? '';
  const candidateActivity = candidate.lastActivityAt ?? '';
  return candidateActivity > existingActivity;
}

/**
 * Guarantees at most one character/avatar per canonical agent identity (`sessionId:agentId`),
 * preferring non-earlier and higher-activity entries while preserving order.
 */
export function deduplicateOfficeAgents(agents: readonly OfficeAgent[]): OfficeAgent[] {
  const result: OfficeAgent[] = [];
  const indexByKey = new Map<string, number>();
  for (const agent of agents) {
    const key = agentIdentityKey(agent);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, result.length);
      result.push(agent);
      continue;
    }
    const existing = result[existingIndex]!;
    if (prefersCandidate(existing, agent)) result[existingIndex] = agent;
  }
  return result;
}

/** Resolves the effective display mode, forcing 2D whenever WebGL/3D rendering has failed. */
export function resolveOfficeDisplayMode(preferred: OfficeDisplayMode, renderFailed: boolean): OfficeDisplayMode {
  return renderFailed ? '2d' : preferred;
}
