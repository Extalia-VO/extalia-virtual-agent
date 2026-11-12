import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Scene, Vector3 } from 'three';
import { ModelBatchController } from '../src/office/scene/ModelInstanceBatches';
import { TEAM_POD_STRUCTURE_FOOTPRINT } from '../src/office/scene/interior/teamPodDesktopGeometry';
import { WalkingClearance, walkingClearanceFor } from '../src/office/scene/movement/naturalClearance';
import { getMovingOccupantsSnapshot, getNearbyMovingOccupantsSnapshot, trackMovingOccupant } from '../src/office/scene/interior/occupants/movingOccupants';
import type { Point3 } from '../src/office/scene/layout';

function cube(size: [number, number, number], position: [number, number, number]) {
  const mesh = new Mesh(new BoxGeometry(...size), new MeshBasicMaterial()); mesh.position.set(...position); return mesh;
}
describe('render-derived walking clearance', () => {
  it('retains actual batch-owned chair collisions after metadata refresh and releases hidden sources', () => {
    const scene = new Scene(), geometry = new BoxGeometry(.7, 1.1, .7), material = new MeshBasicMaterial();
    const chairs = [0, 3].map(x => {
      const group = new Group(), mesh = new Mesh(geometry, material);
      group.position.set(x, 0, 0); group.userData = { interiorAuthored: true, officeSeat: true };
      mesh.position.y = .55; mesh.userData.officeInstanceable = true;
      group.add(mesh); scene.add(group); return mesh;
    });
    scene.updateMatrixWorld(true);
    const controller = new ModelBatchController(scene), field = new WalkingClearance();
    try {
      controller.update(0);
      expect(chairs[0]!.visible).toBe(false);
      chairs.forEach(mesh => { mesh.userData = { officeInstanceable: true }; });
      controller.update(16); field.rebuild([scene]);
      expect(field.colliderCount).toBe(2);
      expect(field.segmentClear([-1, 0, 0], [1, 0, 0])).toBe(false);
      chairs[0]!.visible = false; controller.update(32); field.rebuild([scene]);
      expect(field.colliderCount).toBe(1);
      expect(field.segmentClear([-1, 0, 0], [1, 0, 0])).toBe(true);
    } finally { controller.dispose(); }
    expect(chairs[0]!.visible).toBe(false);
    expect(chairs[1]!.visible).toBe(true);
  });
  it('sweeps the body around transformed concave pod bays while preserving the solid structure and neighboring furniture', () => {
    for (const yaw of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
      const root = new Group(), pod = new Group(), field = new WalkingClearance();
      pod.position.set(-5, 6.4, -1.2); pod.rotation.y = yaw;
      pod.userData.officeCollisionFootprint = TEAM_POD_STRUCTURE_FOOTPRINT;
      // Its rendered tabletop has a square bounding box despite four empty corner bays.
      pod.add(cube([3, .06, 3], [0, .77, 0]));
      root.add(pod, cube([100, .16, 100], [0, 6.32, 0]));
      field.rebuild([root]);
      const at = (x: number, z: number): Point3 => new Vector3(x, 0, z).applyMatrix4(pod.matrixWorld).toArray();
      expect(field.segmentClear(at(1.64, 1.64), at(2.56, 1.29), .29)).toBe(true);
      expect(field.segmentClear(at(1.12, 1.12), at(1.12, 1.12), .29)).toBe(true);
      expect(field.segmentClear(at(1.1, 1.1), at(1.1, 1.1), .29)).toBe(false);
      expect(field.segmentClear(at(0, 0), at(0, 0), .29)).toBe(false);
      expect(field.segmentClear(at(1.4, 0), at(1.4, 0), .29)).toBe(false);
      expect(field.segmentClear(at(2, 2), at(-2, -2), .29)).toBe(false);
      const obstruction = new Group(); obstruction.position.copy(pod.position); obstruction.rotation.y = yaw;
      obstruction.add(cube([.2, 1, .2], [2.1, .5, 1.47])); root.add(obstruction); field.rebuild([root]);
      expect(field.segmentClear(at(1.64, 1.64), at(2.56, 1.29), .29)).toBe(false);
    }
  });
  it('lets a body straddle an authored ground doorway without opening nearby walls or upper-floor edges', () => {
    const portal = { center: [0, 0, -19] as Point3, yaw: Math.PI, clearWidth: 2.4 };
    const root = new Group(), field = new WalkingClearance(() => [portal]);
    field.rebuild([root]);
    const baseline = new WalkingClearance(); baseline.rebuild([root]);
    expect(baseline.segmentClear([0, 0, -18.695], [.85, 0, -18.695], .31)).toBe(false);
    expect(field.segmentClear([0, 0, -18.695], [.85, 0, -18.695], .31)).toBe(true);
    expect(field.segmentClear([0, 0, -18.695], [1.05, 0, -18.695], .31)).toBe(false);
    expect(field.segmentClear([4, 0, -18.695], [4.5, 0, -18.695], .31)).toBe(false);
    // A valid aperture never removes actual solid geometry.
    root.add(cube([2.4, 2, .1], [0, 1, -18.7])); field.rebuild([root]);
    expect(field.segmentClear([0, 0, -18.695], [.85, 0, -18.695], .31)).toBe(false);
    root.clear(); root.add(cube([100, .16, 100], [0, 6.32, 0])); field.rebuild([root]);
    const upper = new WalkingClearance(() => [{ ...portal, center: [0, 6.4, -19] }]); upper.rebuild([root]);
    expect(upper.segmentClear([0, 6.4, -18.695], [.85, 6.4, -18.695], .31)).toBe(false);
  });
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
