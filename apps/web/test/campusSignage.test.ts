import { describe, expect, it } from 'vitest';
import signageSource from '../src/office/scene/prefabs/architecture/ExtaliaSignage.tsx?raw';
import { CAMPUS_ENTRY_LAYOUT, CAMPUS_FRONT_APPROACH } from '../src/office/scene/layout';
import { officeNavigation, waypointPosition } from '../src/office/scene/movement/navGraph';
import {
  APPROACH_CLEARANCE_X, EXTALIA_SIGNAGE_LAYOUT, boardFootprintX
} from '../src/office/scene/prefabs/architecture/extaliaSignageLayout';

const { lintel, board } = EXTALIA_SIGNAGE_LAYOUT;

describe('campus entrance signage placement', () => {
  it('keeps the front board beside the arrival walkway, never in the walk corridor', () => {
    const [west, east] = boardFootprintX();
    // The board stands on the -x side of the walkway, clear of the walkway, its lamps and bollards.
    expect(east).toBeLessThan(-APPROACH_CLEARANCE_X);
    expect(west).toBeGreaterThan(-24);
    // It is on the lawn between the road ramp and the paved forecourt, not on the plaza or the ramp.
    const halfDepth = board.footprint[1] / 2 + 0.3;
    expect(board.z + halfDepth).toBeLessThan(CAMPUS_FRONT_APPROACH.plazaFrontZ);
    expect(board.z - halfDepth).toBeGreaterThan(CAMPUS_FRONT_APPROACH.rampStartZ);
  });

  it('leaves the straight arrival axis from the road to the lobby door clear', () => {
    const [west, east] = boardFootprintX();
    const navigation = officeNavigation();
    const entry = waypointPosition(navigation.entryId, navigation)!;
    // Characters spawn at the road edge and walk this axis to the lobby door.
    expect(entry[0]).toBe(CAMPUS_ENTRY_LAYOUT.centerX);
    expect(entry[0]! < west || entry[0]! > east).toBe(true);
    expect(CAMPUS_ENTRY_LAYOUT.roadSpawnZ).toBeLessThan(board.z);
    expect(entry[2]!).toBeGreaterThan(board.z);
  });

  it('signs the entrance with the lockup on the canopy fascia only (no separate emblem plate)', () => {
    expect(lintel.x).toBe(CAMPUS_ENTRY_LAYOUT.centerX);
    // In front of the facade, at the canopy fascia over the door.
    expect(lintel.frontZ).toBeLessThan(CAMPUS_ENTRY_LAYOUT.shellFrontZ);
    expect(lintel.y).toBeGreaterThan(3.4);
    expect(lintel.y).toBeLessThan(4.4);
    expect(Object.keys(EXTALIA_SIGNAGE_LAYOUT)).not.toContain('emblem');
    expect(signageSource).not.toContain('EntranceEmblem');
  });

  it('lights the signage with emissive faces and halo planes, not GPU lights', () => {
    expect(signageSource.match(/<(pointLight|spotLight|directionalLight|rectAreaLight)\b/g) ?? []).toHaveLength(0);
  });
});
