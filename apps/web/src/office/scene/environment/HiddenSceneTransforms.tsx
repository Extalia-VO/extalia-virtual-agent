import { useLayoutEffect } from 'react';
import { useThree } from '@react-three/fiber';
import type { Object3D } from 'three';

/** Skip renderer traversal of explicitly owned hidden branches. Simulation and
 * direct world-space queries keep their normal methods outside the render pass. */
export function installHiddenSceneTransforms(scene: Object3D): () => void {
  const original = scene.updateMatrixWorld;
  const children = new Map<Object3D, () => void>();
  let traversing = false;
  const add = (child: Object3D) => {
    if (child.userData.officeSkipHiddenRenderTransforms !== true || children.has(child)) return;
    const originalChild = child.updateMatrixWorld;
    const own = Object.hasOwn(child, 'updateMatrixWorld');
    const updateChild: Object3D['updateMatrixWorld'] = function (force) {
      if (!traversing || child.visible) originalChild.call(child, force);
    };
    child.updateMatrixWorld = updateChild;
    children.set(child, () => {
      if (child.updateMatrixWorld !== updateChild) return;
      if (own) child.updateMatrixWorld = originalChild;
      else delete (child as Partial<Object3D>).updateMatrixWorld;
    });
  };
  const added = ({ child }: { child: Object3D }) => add(child);
  const removed = ({ child }: { child: Object3D }) => { children.get(child)?.(); children.delete(child); };
  const update: Object3D['updateMatrixWorld'] = function (force) {
    const previous = traversing;
    traversing = true;
    try {
      original.call(scene, force);
    } finally {
      traversing = previous;
    }
  };
  const own = Object.hasOwn(scene, 'updateMatrixWorld');
  scene.children.forEach(add);
  scene.addEventListener('childadded', added);
  scene.addEventListener('childremoved', removed);
  scene.updateMatrixWorld = update;
  return () => {
    scene.removeEventListener('childadded', added);
    scene.removeEventListener('childremoved', removed);
    for (const restore of children.values()) restore();
    children.clear();
    if (scene.updateMatrixWorld !== update) return;
    if (own) scene.updateMatrixWorld = original;
    else delete (scene as Partial<Object3D>).updateMatrixWorld;
  };
}

export function HiddenSceneTransforms() {
  const scene = useThree(state => state.scene);
  useLayoutEffect(() => installHiddenSceneTransforms(scene), [scene]);
  return null;
}
