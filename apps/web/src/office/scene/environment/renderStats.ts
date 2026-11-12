let officeFps: number | null = null;
const listeners = new Set<() => void>();

/** Publish measured foreground throughput once per sampling window, never per frame. */
export function publishOfficeFps(fps: number | null): void {
  const next = fps !== null && Number.isFinite(fps) && fps >= 0 ? Math.round(fps) : null;
  if (next === officeFps) return;
  officeFps = next;
  listeners.forEach(listener => listener());
}

export function getOfficeFps(): number | null { return officeFps; }

export function subscribeOfficeFps(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
