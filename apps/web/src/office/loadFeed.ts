/** Tiny store between the (lazy) 3D canvas, which sees the loaders, and the loading overlay, which must not import three. */
export interface LoadSnapshot { active: boolean; loaded: number; total: number; item: string }
let snapshot: LoadSnapshot = { active: false, loaded: 0, total: 0, item: '' };
const listeners = new Set<() => void>();
export function publishLoad(next: LoadSnapshot): void {
  if (next.active === snapshot.active && next.loaded === snapshot.loaded && next.total === snapshot.total && next.item === snapshot.item) return;
  snapshot = next;
  for (const listener of listeners) listener();
}
export const readLoad = (): LoadSnapshot => snapshot;
export function subscribeLoad(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
