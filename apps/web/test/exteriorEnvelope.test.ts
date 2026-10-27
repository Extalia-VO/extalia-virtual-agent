import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as ReactTypes from 'react';
import type { ReactElement } from 'react';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { EnvelopeWall, ExteriorEnvelopeProvider } from '../src/office/scene/interior/ExteriorEnvelopeContext';
import { FurnishedFloors } from '../src/office/scene/FurnishedFloors';
import { StaticCampusBatch } from '../src/office/scene/StaticCampusBatch';

const lifecycle = vi.hoisted(() => ({ hidden: false, root: null as Group | null, effect: undefined as (() => void | (() => void)) | undefined }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof ReactTypes>(),
  useContext: () => lifecycle.hidden,
  useState: () => [0, () => {}],
  useCallback: (callback: unknown) => callback,
  useRef: () => ({ current: lifecycle.root }),
  useLayoutEffect: (effect: () => void | (() => void)) => { lifecycle.effect = effect; },
}));

function batch(root: Group) {
  lifecycle.root = root;
  StaticCampusBatch({ children: null });
  const cleanup = lifecycle.effect?.();
  return typeof cleanup === 'function' ? cleanup : undefined;
}
function props(exterior: boolean) {
  return (EnvelopeWall({ exterior, name: 'test:north', children: 'wall' }) as ReactElement<{
    visible?: boolean; userData?: Record<string, unknown>; children: unknown;
  }>).props;
}

describe('room perimeter visibility with floor batching', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { cleanups.reverse().forEach(cleanup => cleanup()); cleanups.length = 0; });

  it('gives perimeter ownership to the skin only in the campus view', () => {
    for (const view of ['campus', 'stack', 1, 2, 3] as const) {
      const tree = FurnishedFloors({ view, agents: [], language: 'en' });
      expect(tree.type).toBe(ExteriorEnvelopeProvider);
      expect(tree.props.hidden).toBe(view === 'campus');
    }
  });

  it('toggles exterior surfaces without leaving a merged copy in the floor', () => {
    lifecycle.hidden = false;
    const standalone = props(true);
    const wall = new Group(), floor = new Group(), assembly = new Group();
    wall.userData = standalone.userData!; wall.visible = standalone.visible!;
    floor.add(wall); wall.add(assembly);
    const geometry = new BoxGeometry(2, 2.7, 0.1), material = new MeshStandardMaterial();
    assembly.add(new Mesh(geometry, material), new Mesh(geometry, material));
    cleanups.push(() => { geometry.dispose(); material.dispose(); });
    const wallCleanup = batch(assembly); if (wallCleanup) cleanups.push(wallCleanup);
    const floorCleanup = batch(floor); if (floorCleanup) cleanups.push(floorCleanup);
    expect(assembly.userData.staticBatchStats.mergedMeshes).toBe(2);
    expect(floor.userData.staticBatchStats.mergedMeshes).toBe(0);
    const drawn = () => { let n = 0; floor.traverseVisible(o => { if ((o as Mesh).isMesh) n++; }); return n; };
    expect(drawn()).toBe(1);
    for (const hidden of [true, false, true, false]) {
      lifecycle.hidden = hidden;
      wall.visible = props(true).visible!;
      expect(drawn()).toBe(hidden ? 0 : 1);
    }
  });

  it('leaves interior partitions outside the perimeter visibility boundary', () => {
    lifecycle.hidden = true;
    expect(props(false).children).toBe('wall');
    expect(props(false).visible).toBeUndefined();
    expect(props(false).userData).toBeUndefined();
    expect(props(true).visible).toBe(false);
    lifecycle.hidden = false;
    expect(props(true).visible).toBe(true);
  });
});
