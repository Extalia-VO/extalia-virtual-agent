import { useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { Object3D } from 'three';
import { walkingClearanceFor } from './naturalClearance';

/** Refresh only after render-tree edits (including a local Blender asset replacing its backup). */
export function NaturalWalkingClearance({ owner }: { owner: object }) {
  const scene = useThree(state => state.scene);
  useEffect(() => {
    const field = walkingClearanceFor(owner);
    const watched = new Set<Object3D>();
    const dirty = () => { pending = true; };
    let pending = true;
    const refresh = () => {
      if (!pending) return;
      pending = false;
      const roots: Object3D[] = [];
      scene.traverse(node => { if (/^furnished-floor-[123]$/.test(node.name) || node.name === 'extalia-expanded-pedestrian-campus') roots.push(node); });
      const current = new Set<Object3D>();
      for (const root of roots) root.traverse(node => {
        current.add(node);
        if (!watched.has(node)) { node.addEventListener('childadded', dirty); node.addEventListener('childremoved', dirty); watched.add(node); }
      });
      for (const node of watched) if (!current.has(node)) { node.removeEventListener('childadded', dirty); node.removeEventListener('childremoved', dirty); watched.delete(node); }
      field.rebuild(roots);
    };
    // The callback is kept outside React state; no redraw or per-frame tree scan is required.
    updates.set(owner, refresh);
    return () => { updates.delete(owner); watched.forEach(node => { node.removeEventListener('childadded', dirty); node.removeEventListener('childremoved', dirty); }); field.clear(); };
  }, [owner, scene]);
  useFrame(() => updates.get(owner)?.(), -2);
  return null;
}
const updates = new WeakMap<object, () => void>();
