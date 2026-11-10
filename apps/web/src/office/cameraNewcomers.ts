/** Track actual work arrivals; initial hydration is a baseline, not a new spawn. */
export function createCameraNewcomers() {
  let previous: Set<string> | null = null;
  let previousRoster: Set<string> | null = null;
  const arrivals = new Map<string, number>();
  const spawns = new Map<string, number>();
  return {
    spawnedIds(): string[] { return [...spawns.keys()]; },
    update(workingIds: readonly string[], ready: (id: string) => boolean, now: number, enabled: boolean, admittedIds: readonly string[] = workingIds): string[] {
      if (!enabled) { previous = null; previousRoster = null; arrivals.clear(); spawns.clear(); return []; }
      const working = new Set(workingIds);
      const roster = new Set(admittedIds);
      if (previousRoster) for (const id of roster) if (!previousRoster.has(id)) spawns.set(id, now);
      previousRoster = roster;
      if (previous) for (const id of working) if (!previous.has(id)) arrivals.set(id, now);
      previous = working;
      for (const [id, at] of arrivals) if (!working.has(id) || now - at > 30_000) arrivals.delete(id);
      for (const [id, at] of spawns) if (!roster.has(id) || now - at > 30_000) spawns.delete(id);
      return [...arrivals].reverse().filter(([id]) => ready(id)).map(([id]) => id);
    },
  };
}
