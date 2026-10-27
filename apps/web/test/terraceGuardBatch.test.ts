import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as ReactTypes from 'react';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { StaticCampusBatch } from '../src/office/scene/StaticCampusBatch';

const lifecycle = vi.hoisted(() => ({ root: null as Group | null, effect: undefined as (() => void | (() => void)) | undefined }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof ReactTypes>(),
  useRef: () => ({ current: lifecycle.root }),
  useState: () => [0, () => {}],
  useCallback: (callback: unknown) => callback,
  useLayoutEffect: (effect: () => void | (() => void)) => { lifecycle.effect = effect; },
}));

function batch(root: Group) {
  lifecycle.root = root;
  StaticCampusBatch({ children: null });
  const cleanup = lifecycle.effect?.();
  return typeof cleanup === 'function' ? cleanup : undefined;
}

describe('replaceable terrace guard batching', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { cleanups.reverse().forEach(cleanup => cleanup()); cleanups.length = 0; });

  it('removes the merged fallback glass when the loaded model replaces its guard', () => {
    const floor = new Group();
    const guard = new Group();
    guard.userData.officeDynamic = true;
    const assembly = new Group();
    guard.add(assembly); floor.add(guard);
    const material = new MeshStandardMaterial({ transparent: true, opacity: 0.23 });
    const geometry = new BoxGeometry(4, 1.1, 0.028);
    const a = new Mesh(geometry, material), b = new Mesh(geometry, material);
    b.position.x = 4;
    assembly.add(a, b);
    cleanups.push(() => { geometry.dispose(); material.dispose(); });

    // R3F mounts the child batch before the surrounding floor batch.
    const removeGuardBatch = batch(assembly);
    const removeFloorBatch = batch(floor);
    if (removeFloorBatch) cleanups.push(removeFloorBatch);
    expect(assembly.userData.staticBatchStats.mergedMeshes).toBe(2);
    expect(floor.userData.staticBatchStats.mergedMeshes).toBe(0);
    expect(a.visible).toBe(false);

    // The model-ready render unmounts the guard, including its merged buffers.
    removeGuardBatch?.();
    floor.remove(guard);
    const visible: Mesh[] = [];
    floor.traverse(node => { if ((node as Mesh).isMesh && node.visible) visible.push(node as Mesh); });
    expect(visible).toHaveLength(0);
    expect(a.visible).toBe(true); // Cleanup restores originals before the removed subtree is discarded.
  });
});
