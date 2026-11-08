/** Track actual work arrivals; initial hydration is a baseline, not a new spawn. */
export function createCameraNewcomers() {
  let previous: Set<string> | null = null;
  const arrivals = new Map<string, number>();
  return {
    update(workingIds: readonly string[], ready: (id: string) => boolean, now: number, enabled: boolean): string[] {
      if (!enabled) { previous = null; arrivals.clear(); return []; }
      const working = new Set(workingIds);
      if (previous) for (const id of working) if (!previous.has(id)) arrivals.set(id, now);
      previous = working;
      for (const [id, at] of arrivals) if (!working.has(id) || now - at > 30_000) arrivals.delete(id);
      return [...arrivals].reverse().filter(([id]) => ready(id)).map(([id]) => id);
    },
  };
}
