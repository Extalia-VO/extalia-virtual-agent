import { events, type RootStore } from '@react-three/fiber';
import type { Intersection, Object3D } from 'three';

/** Rendering visibility belongs to the entire ancestry, including the selected floor. */
export function isSceneObjectVisible(object: Object3D): boolean {
  for (let node: Object3D | null = object; node; node = node.parent) if (node.visible === false) return false;
  return true;
}

/** Three's false return stops descendant raycasts before touching hidden rigs. */
export function visibleCharacterRaycast(this: Object3D): false | undefined {
  return isSceneObjectVisible(this) ? undefined : false;
}

/** Three raycasts hidden subtrees too; discard them before pointer events bubble. */
export function visibleSceneHits(hits: Intersection[]): Intersection[] {
  return hits.filter(hit => isSceneObjectVisible(hit.object));
}

/** Keep default pointer computation, ordering and capture; hidden floors never intercept hover/clicks. */
export function officePointerEvents(store: RootStore) {
  const pointer = events(store);
  return { ...pointer, filter: (hits: Intersection[], state: ReturnType<RootStore['getState']>) =>
    visibleSceneHits(pointer.filter ? pointer.filter(hits, state) : hits) };
}
