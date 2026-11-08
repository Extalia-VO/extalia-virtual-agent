import { describe, expect, it } from 'vitest';
import catalog from '../src/office/scene/campusGreenery.json';
import { floorPlanterScale, planterModelHeight, PLANTER_BOUNDS } from '../src/office/scene/interior/planterLayout';
import { deskInputPlacement, deskLayout, MOUSE_PAD, SINGLE_DESK_SLOTS } from '../src/office/scene/interior/deskLayout';
import { EXECUTIVE_ROOM_LAYOUTS, MEETING_ROOM_LAYOUTS } from '../src/office/scene/interior/roomRedesignLayout';
import { F3_TERRACE } from '../src/office/scene/interior/floor1Layout';
import { SINGLE_WORKSTATION_BLUEPRINT } from '../src/office/scene/interior/spatialBlueprints';

const plants = catalog.greenery.filter(entry => entry.kind === 'plant');

describe('decorative planter composition', () => {
  it('keeps room and terrace foliage modest even when an older call site asks for oversized props', () => {
    for (const model of plants) for (const yaw of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      const scale = floorPlanterScale(1.55), height = planterModelHeight(model.id, 'floor', yaw);
      expect(height * scale).toBeLessThanOrEqual(1.1);
      expect(model.width * height / model.height * scale).toBeLessThanOrEqual(.75);
      const sculptural = planterModelHeight(model.id, 'sculptural', yaw);
      expect(sculptural).toBeLessThanOrEqual(1.08);
      expect(model.width * sculptural / model.height).toBeLessThanOrEqual(.720001);
    }
    expect(planterModelHeight(undefined, 'floor')).toBe(PLANTER_BOUNDS.floor.height);
  });

  it('uses one botanical accent per desk and leaves input and front working areas clear', () => {
    const [width, , depth] = SINGLE_WORKSTATION_BLUEPRINT.topSize;
    let planted = 0;
    for (let i = 0; i < 200; i++) {
      const layout = deskLayout(`planter-review.station-${i}`);
      expect(layout.accessories.filter(kind => kind === 'plant' || kind === 'flower-vase').length).toBeLessThanOrEqual(1);
      expect(layout.accessories.slice(2).every(kind => kind === null)).toBe(true);
      const input = deskInputPlacement([0, .8, .245], 0, .785, layout);
      layout.accessories.forEach((kind, slotIndex) => {
        if (kind !== 'plant') return;
        planted++;
        const slot = SINGLE_DESK_SLOTS[slotIndex]!;
        expect(slotIndex).toBeLessThan(2);
        expect(Math.abs(slot.position[0]) + .1).toBeLessThan(width / 2);
        expect(Math.abs(slot.position[1]) + .1).toBeLessThan(depth / 2);
        // Plant foliage stays beyond the mouse pad's near edge, even on full-board layouts.
        expect(Math.hypot(slot.position[0] - input.pad[0], slot.position[1] - input.pad[2]))
          .toBeGreaterThan(Math.hypot(MOUSE_PAD.width, MOUSE_PAD.depth) / 2 + .1);
      });
    }
    expect(planted).toBeGreaterThan(20);
  });

  it('frames room edges without intruding into entry aisles or moving beyond the room walls', () => {
    const radius = .36;
    for (const room of Object.values(EXECUTIVE_ROOM_LAYOUTS)) for (const [x, , z] of room.plants) {
      expect(Math.abs(x) + radius).toBeLessThan(room.roomSize[0] / 2);
      expect(Math.abs(z) + radius).toBeLessThan(room.roomSize[1] / 2);
      expect(Math.abs(x - room.entryAisle.center[0]) - radius).toBeGreaterThan(room.entryAisle.size[0] / 2);
    }
    for (const room of Object.values(MEETING_ROOM_LAYOUTS)) for (const [x, , z] of room.planters) {
      expect(Math.abs(x) + radius).toBeLessThan(room.roomSize[0] / 2);
      expect(Math.abs(z) + radius).toBeLessThan(room.roomSize[1] / 2);
      expect(Math.abs(x - room.entryAisle.center[0]) - radius).toBeGreaterThan(room.entryAisle.size[0] / 2);
    }
  });

  it('keeps terrace pots inside the guard and outside both maintenance stair arrival zones', () => {
    const radius = .37;
    for (const [x, , z] of F3_TERRACE.planters) {
      expect(x - radius).toBeGreaterThan(F3_TERRACE.west + F3_TERRACE.guardInset);
      expect(x + radius).toBeLessThan(F3_TERRACE.east - F3_TERRACE.guardInset);
      expect(z - radius).toBeGreaterThan(F3_TERRACE.north);
      expect(z + radius).toBeLessThan(F3_TERRACE.south - F3_TERRACE.guardInset);
      if (x < -17.5) {
        expect(z - radius).toBeGreaterThan(15.6);
        expect(z + radius).toBeLessThan(18.2 - .75);
      }
      expect(x + radius < F3_TERRACE.passageWest || x - radius > F3_TERRACE.passageEast).toBe(true);
    }
  });
});
