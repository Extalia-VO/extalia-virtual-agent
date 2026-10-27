import type { Group } from "three";

export type ScreenEmitter = {
  group: Group; width: number; height: number; depth: number;
  intensity: number; color: readonly [number, number, number];
  /** Screens of one desk share a cluster and are lit by a single pooled light. */
  cluster?: string;
  /** Weight for the pooled spot lights (see `screenLightPriority`); 1 when unset. */
  priority?: number;
};
const emitters = new Set<ScreenEmitter>();
let revision = 0;
let urgentRevision = 0;
export function registerScreenEmitter(emitter: ScreenEmitter) {
  emitters.add(emitter); revision++; urgentRevision++;
  return () => { emitters.delete(emitter); revision++; urgentRevision++; };
}
export function updateScreenEmitter(urgent = false) { revision++; if (urgent) urgentRevision++; }
export const getScreenEmitters = () => emitters;
export const screenEmitterRevision = () => revision;
export const screenEmitterUrgentRevision = () => urgentRevision;
