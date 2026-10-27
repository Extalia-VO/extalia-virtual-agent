import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoxGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, Raycaster, Vector3, type BufferGeometry } from 'three';
import { buildFacadeEnvelope } from '../src/office/scene/CampusBuildingShell';
import { CAMPUS_ENTRY_LAYOUT, FLOOR_HEIGHT, OFFICE_BUILDING } from '../src/office/scene/layout';
import { F1_EMERGENCY_EXIT, F3_TERRACE } from '../src/office/scene/floor1Layout';
import { GLASS_ELEVATORS } from '../src/office/scene/prefabs/architecture/elevatorController';

type Point = readonly [number, number, number];
interface Sample { name: string; origin: Point; direction: Point; distance: number }

// This covers the exported visual envelope and its generated mullions. Other
// campus fixtures and scene collision/navigation systems are outside this test.
describe('assembled facade circulation portals', () => {
  const assembled = new Group();
  const geometries = new Set<BufferGeometry>();
  const material = new MeshBasicMaterial({ side: DoubleSide });
  const raycaster = new Raycaster();

  beforeAll(() => {
    const envelope = buildFacadeEnvelope();
    // ContinuousEnvelope is already authored in world metres. The renderer
    // mirrors X and translates to the building centre, without scaling Z again.
    assembled.position.x = OFFICE_BUILDING.centerX;
    assembled.scale.x = -1;
    for (const name of ['spandrel', 'cap', 'glow', 'glass'] as const) {
      const geometry = envelope[name]; geometries.add(geometry);
      const mesh = new Mesh(geometry, material); mesh.name = name; assembled.add(mesh);
    }
    const mullionGeometry = new BoxGeometry(0.075, 1.4, 0.11); geometries.add(mullionGeometry);
    for (const { at, y, angle } of envelope.mullions) {
      const mesh = new Mesh(mullionGeometry, material);
      mesh.name = 'mullion'; mesh.position.set(at[0], y, at[1]); mesh.rotation.y = -angle;
      assembled.add(mesh);
    }
    assembled.updateMatrixWorld(true);
  });

  afterAll(() => {
    assembled.clear();
    for (const geometry of geometries) geometry.dispose();
    geometries.clear(); material.dispose();
  });

  function intersections(sample: Sample) {
    raycaster.set(new Vector3(...sample.origin), new Vector3(...sample.direction));
    raycaster.near = 0; raycaster.far = sample.distance;
    return raycaster.intersectObject(assembled, true);
  }

  it('keeps entrance, both lifts on every floor, emergency exit and terrace clear at walking heights', () => {
    const samples: Sample[] = [];
    const heights = [0.2, 1.2, 2.2];
    for (const dx of [-1, 0, 1]) for (const y of heights) {
      samples.push({ name: `entrance x-offset=${dx}, height=${y}`,
        origin: [CAMPUS_ENTRY_LAYOUT.centerX + dx, y, CAMPUS_ENTRY_LAYOUT.shellFrontZ - 3], direction: [0, 0, 1], distance: 4 });
    }
    for (const lift of GLASS_ELEVATORS) for (const floor of [0, 1, 2]) for (const height of heights) for (const dz of [-0.5, 0, 0.5]) {
      samples.push({ name: `lift ${lift.id}, floor=${floor + 1}, height=${height}, z-offset=${dz}`,
        origin: [OFFICE_BUILDING.east + 1, floor * FLOOR_HEIGHT + height, lift.z + dz], direction: [-1, 0, 0], distance: 3 });
    }
    for (const dz of [-0.7, 0, 0.7]) for (const y of heights) {
      samples.push({ name: `emergency exit z-offset=${dz}, height=${y}`,
        origin: [OFFICE_BUILDING.west - 2, y, F1_EMERGENCY_EXIT.center[2] + dz], direction: [1, 0, 0], distance: 4 });
    }
    for (const dx of [-1, 0, 1]) for (const height of heights) {
      samples.push({ name: `terrace x-offset=${dx}, height=${height}`,
        origin: [F3_TERRACE.door.center[0] + dx, 2 * FLOOR_HEIGHT + height, F3_TERRACE.north + 2], direction: [0, 0, -1], distance: 4 });
    }
    expect(samples).toHaveLength(81);
    for (const sample of samples) {
      expect(intersections(sample).map(hit => ({ mesh: hit.object.name, at: hit.point.toArray() })), sample.name).toEqual([]);
    }
  });

  it('detects adjacent closed facade surfaces as controls for every portal group', () => {
    const samples: Sample[] = [
      { name: 'beside entrance', origin: [CAMPUS_ENTRY_LAYOUT.centerX + 2.6, 1.2, CAMPUS_ENTRY_LAYOUT.shellFrontZ - 3], direction: [0, 0, 1], distance: 4 },
      { name: 'between lift portals', origin: [OFFICE_BUILDING.east + 1, 1.2, (GLASS_ELEVATORS[0].z + GLASS_ELEVATORS[1].z) / 2], direction: [-1, 0, 0], distance: 3 },
      { name: 'beside emergency exit', origin: [OFFICE_BUILDING.west - 2, 1.2, F1_EMERGENCY_EXIT.center[2] - 2], direction: [1, 0, 0], distance: 4 },
      { name: 'beside terrace door', origin: [F3_TERRACE.door.center[0] + 3, 2 * FLOOR_HEIGHT + 1.2, F3_TERRACE.north + 2], direction: [0, 0, -1], distance: 4 },
    ];
    for (const sample of samples) expect(intersections(sample).length, sample.name).toBeGreaterThan(0);
  });
});
