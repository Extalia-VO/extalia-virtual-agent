import type * as ReactTypes from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Scene } from 'three';
import { StaticCampusBatch, useStaticBatchRevision } from '../src/office/scene/StaticCampusBatch';
import { ModelBatchController } from '../src/office/scene/ModelInstanceBatches';

const lifecycle = vi.hoisted(() => ({ root: null as Group | null, revision: 0,
  effect: undefined as (() => void | (() => void)) | undefined, deps: [] as unknown[],
  mode: 'batch', snapshot: undefined as { current: unknown } | undefined,
  refresh: null as (() => void) | null }));
vi.mock('react', async original => ({ ...await original<typeof ReactTypes>(),
  useRef: (initial: unknown) => lifecycle.mode === 'batch' ? { current: lifecycle.root } : lifecycle.snapshot ??= { current: initial },
  useState: () => [lifecycle.revision, (next: (value: number) => number) => { lifecycle.revision = next(lifecycle.revision); }],
  useCallback: (callback: unknown) => callback,
  useContext: () => lifecycle.refresh,
  useLayoutEffect: (effect: typeof lifecycle.effect, deps: unknown[]) => { lifecycle.effect = effect; lifecycle.deps = deps; },
}));
beforeEach(() => { lifecycle.root = null; lifecycle.revision = 0; lifecycle.effect = undefined;
  lifecycle.mode = 'batch'; lifecycle.snapshot = undefined; lifecycle.refresh = null; });

describe('static batches follow asynchronous visual replacements', () => {
  it('removes baked fallback buffers on refresh without remounting the assembly or disposing library geometry', () => {
    const parent = new Group(), wrapper = new Group(), geometry = new BoxGeometry(1, 1, 1), material = new MeshStandardMaterial();
    const a = new Mesh(geometry, material), b = new Mesh(geometry, material);
    a.position.x = -1; b.position.x = 1; wrapper.add(a, b); parent.add(wrapper); lifecycle.root = parent;
    const disposal = vi.spyOn(geometry, 'dispose');
    let cleanup: void | (() => void) = undefined;
    try {
      const tree = StaticCampusBatch({ children: null }); cleanup = lifecycle.effect!();
      expect(parent.userData.staticBatchStats.mergedMeshes).toBe(2);
      expect(a.visible).toBe(false); expect(a.userData.officeBatchSource).toBe(true);
      const authored = new Mesh(geometry, material);
      wrapper.clear(); wrapper.userData.officeDynamic = true; wrapper.add(authored);
      tree.props.value();
      if (typeof cleanup === 'function') cleanup();
      StaticCampusBatch({ children: null }); cleanup = lifecycle.effect!();
      expect(lifecycle.deps).toEqual([false, 1]);
      expect(parent.children[0]).toBe(wrapper);
      expect(parent.userData.staticBatchStats.mergedMeshes).toBe(0);
      expect(a.visible).toBe(true); expect(a.userData.officeBatchSource).toBeUndefined();
      expect(authored.visible).toBe(true); expect(disposal).not.toHaveBeenCalled();
      expect(parent.children.filter(child => child !== wrapper).every(child => child.children.length === 0)).toBe(true);
    } finally { if (typeof cleanup === 'function') cleanup(); geometry.dispose(); material.dispose(); }
  });

  it('keeps an independently owned nested batch out of its outer batch', () => {
    const parent = new Group(), nested = new Group(), geometry = new BoxGeometry(1, 1, 1), material = new MeshStandardMaterial();
    lifecycle.root = nested;
    StaticCampusBatch({ children: null });
    const innerCleanup = lifecycle.effect!();
    expect(nested.userData.officeStaticBatch).toBe(true);
    nested.add(new Mesh(geometry, material), new Mesh(geometry, material)); parent.add(nested);
    lifecycle.root = parent; let cleanup: void | (() => void) = undefined;
    try {
      StaticCampusBatch({ children: null }); cleanup = lifecycle.effect!();
      expect(parent.userData.staticBatchStats.mergedMeshes).toBe(0);
      expect(nested.children.every(child => child.visible)).toBe(true);
    } finally { if (typeof cleanup === 'function') cleanup(); if (typeof innerCleanup === 'function') innerCleanup(); geometry.dispose(); material.dispose(); }
  });

  it('notifies the nearest owner only when the visual snapshot changes', () => {
    lifecycle.mode = 'snapshot'; const refresh = vi.fn(); lifecycle.refresh = refresh;
    useStaticBatchRevision(null); lifecycle.effect!(); expect(refresh).not.toHaveBeenCalled();
    const loaded = {};
    useStaticBatchRevision(loaded); lifecycle.effect!(); expect(refresh).toHaveBeenCalledTimes(1);
    useStaticBatchRevision(loaded); lifecycle.effect!(); expect(refresh).toHaveBeenCalledTimes(1);
    useStaticBatchRevision(null); lifecycle.effect!(); expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('batches fixed authored frames while animated door leaves retain their moving parents', () => {
    const scene = new Scene(), floor = new Group(), geometry = new BoxGeometry(1, 1, .05), material = new MeshStandardMaterial();
    scene.add(floor); lifecycle.root = floor;
    const frames = [new Mesh(geometry, material), new Mesh(geometry, material)];
    const pivots = [new Group(), new Group()];
    const leaves = pivots.map(pivot => {
      pivot.userData = { officeDynamic: true, interiorAuthored: true };
      const leaf = new Mesh(geometry, material); leaf.position.x = .5; pivot.add(leaf); floor.add(pivot); return leaf;
    });
    floor.add(...frames);
    const controller = new ModelBatchController(scene); let cleanup: void | (() => void) = undefined;
    try {
      StaticCampusBatch({ children: null }); cleanup = lifecycle.effect!();
      expect(floor.userData.staticBatchStats.mergedMeshes).toBe(2);
      expect(frames.every(frame => !frame.visible && frame.userData.officeBatchSource)).toBe(true);
      expect(leaves.every(leaf => leaf.visible && !leaf.userData.officeBatchSource)).toBe(true);
      scene.updateMatrixWorld(true); controller.update(0);
      expect(scene.userData.modelInstanceBatchStats.sources).toBe(2);
      pivots[0]!.rotation.y = Math.PI / 2; scene.updateMatrixWorld(true); controller.update(16);
      const batch = scene.children.find(child => child.name === 'loaded-model-instance-batch')!;
      expect(batch).toBeDefined();
      expect(leaves[0]!.matrixWorld.elements[14]).toBeCloseTo(-.5);
      expect(frames[0]!.matrixWorld.elements[14]).toBe(0);
    } finally { controller.dispose(); if (typeof cleanup === 'function') cleanup(); geometry.dispose(); material.dispose(); }
  });
});
