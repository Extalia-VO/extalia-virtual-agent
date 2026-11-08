/** A focused recovery target must never silently select another mission/session. */
export function missionEntry<T extends { id: string; sessionId: string }>(runs: readonly T[], sessionId: string | undefined, missionId?: string): T | undefined {
  if (!sessionId) return undefined;
  return runs.find(run => run.sessionId === sessionId && (missionId === undefined || run.id === missionId));
}
