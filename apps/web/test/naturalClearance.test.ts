import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { WalkingClearance, walkingClearanceFor } from '../src/office/scene/movement/naturalClearance';
import { getMovingOccupantsSnapshot, getNearbyMovingOccupantsSnapshot, trackMovingOccupant } from '../src/office/scene/interior/occupants/movingOccupants';
import type { Point3 } from '../src/office/scene/layout';

function cube(size: [number, number, number], position: [number, number, number]) {
  const mesh = new Mesh(new BoxGeometry(...size), new MeshBasicMaterial()); mesh.position.set(...position); return mesh;
}
describe('render-derived walking clearance', () => {
  it('checks the whole swept body, including hidden batching originals, while ignoring duplicate render batches and doors', () => {
    const root = new Group(), field = new WalkingClearance();
    const wall = cube([.12, 2.7, 5], [0, 1.35, 0]); wall.visible = false; wall.userData.officeBatchSource = true; root.add(wall);
    const batch = new Group(); batch.userData.officePassable = true; batch.add(cube([100, 10, 100], [0, 0, 0])); root.add(batch);
    const door = new Group(); door.userData.officePassable = true; door.add(cube([1.6, 2.5, .1], [3, 1.25, 0])); root.add(door);
    field.rebuild([root]);
    expect(field.colliderCount).toBe(1);
    expect(field.segmentClear([-1, 0, 0], [1, 0, 0])).toBe(false);
    expect(field.segmentClear([.2, 0, -1], [.2, 0, 1], .28)).toBe(false);
    expect(field.segmentClear([.5, 0, -1], [.5, 0, 1], .28)).toBe(true);
    expect(field.segmentClear([3, 0, -1], [3, 0, 1])).toBe(true);
  });
  it('includes tabletops and low partitions, excludes floor finishes and overhead lamps, and respects transformed furniture', () => {
    const root = new Group(), table = new Group(), field = new WalkingClearance();
    root.add(cube([10, .06, 10], [0, .03, 0]), cube([2, .3, 2], [0, 2.6, 0]));
    table.position.set(3, 0, 0); table.rotation.y = Math.PI / 2; table.add(cube([2, .08, 1], [0, .78, 0])); root.add(table);
    field.rebuild([root]);
    expect(field.segmentClear([-2, 0, 0], [1, 0, 0])).toBe(true);
    expect(field.segmentClear([3, 0, -2], [3, 0, 2])).toBe(false);
    expect(field.segmentClear([2.1, 0, -2], [2.1, 0, 2])).toBe(true);
    root.add(cube([2, .9, .1], [0, .45, 0])); field.rebuild([root]);
    expect(field.segmentClear([0, 0, -1], [0, 0, 1])).toBe(false);
  });
  it('requires actual upper-floor support across the entire path and rounded perimeter', () => {
    const root = new Group(), field = new WalkingClearance(); root.visible = false; root.position.y = 6.4;
    root.add(cube([4, .16, 4], [-3, -.08, 0]), cube([4, .16, 4], [3, -.08, 0])); field.rebuild([root]);
    expect(field.segmentClear([-4, 6.4, 0], [-2, 6.4, 0])).toBe(true);
    expect(field.segmentClear([-3, 6.4, 0], [3, 6.4, 0])).toBe(false);
    expect(field.segmentClear([-1.1, 6.4, 0], [-1.1, 6.4, .5])).toBe(false);
    root.add(cube([100, .16, 100], [0, -.08, 0])); field.rebuild([root]);
    expect(field.segmentClear([24.8, 6.4, 18.6], [24.8, 6.4, 18.5])).toBe(false);
  });
  it('does not use hidden backups/templates and refreshes when a model replaces its backup', () => {
    const root = new Group(), field = new WalkingClearance(), hidden = new Group(); hidden.visible = false;
    hidden.add(cube([20, 4, 20], [0, 2, 0])); root.add(hidden); field.rebuild([root]);
    expect(field.segmentClear([-1, 0, 0], [1, 0, 0])).toBe(true);
    const replacement = cube([1, 1, 1], [0, .5, 0]); root.add(replacement); field.rebuild([root]);
    expect(field.segmentClear([-1, 0, 0], [1, 0, 0])).toBe(false);
    root.remove(replacement); field.rebuild([root]); expect(field.segmentClear([-1, 0, 0], [1, 0, 0])).toBe(true);
    field.clear(); expect(field.segmentClear([-1, 0, 0], [1, 0, 0])).toBe(false);
  });
  it('isolates mounted offices and refuses missing, vertical or invalid clearance data', () => {
    const a = {}, b = {}, field = walkingClearanceFor(a);
    expect(walkingClearanceFor(a)).toBe(field); expect(walkingClearanceFor(b)).not.toBe(field);
    expect(field.segmentClear([0, 0, 0], [1, 0, 0])).toBe(false);
    field.rebuild([new Group()]);
    expect(field.segmentClear([0, 0, 0], [1, 6.4, 0])).toBe(false);
    expect(field.segmentClear([0, 0, 0], [NaN, 0, 0])).toBe(false);
  });
});
describe('measured nearby walking velocities', () => {
  it('copies mutable positions, estimates actual velocity, and drops stopped or stale walkers', () => {
    let now = 1000; const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const position: Point3 = [0, 0, 0], target: Point3 = [10, 0, 0];
    try {
      trackMovingOccupant('velocity-walker', position, target);
      position[0] = .02; now += 20; trackMovingOccupant('velocity-walker', position, target);
      const sample = getNearbyMovingOccupantsSnapshot('observer', [0, 0, 0]).find(x => x.id === 'velocity-walker')!;
      expect(sample.velocity).toEqual([1, 0, 0]);
      position[0] = 8; expect(sample.position[0]).toBe(.02);
      now += 800; expect(getNearbyMovingOccupantsSnapshot('observer', [0, 0, 0]).some(x => x.id === 'velocity-walker')).toBe(false);
      trackMovingOccupant('velocity-walker', position, target, 'idle');
      expect(getMovingOccupantsSnapshot().find(x => x.id === 'velocity-walker')!.velocity).toEqual([0, 0, 0]);
      trackMovingOccupant('velocity-walker', null); expect(getMovingOccupantsSnapshot().some(x => x.id === 'velocity-walker')).toBe(false);
    } finally { trackMovingOccupant('velocity-walker', null); clock.mockRestore(); }
  });
});
