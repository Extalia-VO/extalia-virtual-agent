import { describe, expect, it } from 'vitest';
import { CIRCULATION_LIGHT_ROWS } from '../src/office/scene/interior/prefabs/architecture/CirculationLighting';
import { officeCeilingPatches } from '../src/office/scene/interior/prefabs/architecture/OfficeCeilings';
import { OFFICE_BUILDING, OFFICE_STAIR_LAYOUT } from '../src/office/scene/layout';
import { GLASS_ELEVATORS } from '../src/office/scene/prefabs/architecture/elevatorController';

describe('east core hall night lighting', () => {
  it('lights the floor between the stair opening and the elevators on every office floor', () => {
    for (const floor of [1, 2, 3] as const) {
      const row = CIRCULATION_LIGHT_ROWS[floor].find(entry => entry.id === 'east-core-hall');
      expect(row, `F${floor}`).toBeDefined();
      const west = row!.center[0] - row!.size[0] / 2, east = row!.center[0] + row!.size[0] / 2;
      const north = row!.center[1] - row!.size[1] / 2, south = row!.center[1] + row!.size[1] / 2;
      expect(west).toBeCloseTo(OFFICE_STAIR_LAYOUT.westEdge);
      expect(east).toBeCloseTo(OFFICE_BUILDING.east);
      // Starts south of the upper-floor stair void and spans both elevator doorways.
      expect(north).toBeGreaterThan(OFFICE_STAIR_LAYOUT.voidSouthZ);
      for (const elevator of GLASS_ELEVATORS) {
        expect(elevator.z - elevator.doorWidth / 2).toBeGreaterThan(north);
        expect(elevator.z + elevator.doorWidth / 2).toBeLessThan(south);
      }
      expect(row!.stops.length).toBeGreaterThanOrEqual(3);
      for (const stop of row!.stops) { expect(stop).toBeGreaterThan(north); expect(stop).toBeLessThan(south); }
    }
  });

  it('adds no second ceiling inside the F1 lounge, which already has one', () => {
    expect(officeCeilingPatches(1).some(patch => patch.id === 'east-core-hall')).toBe(false);
    expect(officeCeilingPatches(2).some(patch => patch.id === 'east-core-hall')).toBe(true);
    expect(officeCeilingPatches(3).some(patch => patch.id === 'east-core-hall')).toBe(true);
  });
});
