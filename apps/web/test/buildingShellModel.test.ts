import { describe, expect, it } from 'vitest';
import { MeshStandardMaterial } from 'three';
import canvasSource from '../src/office/scene/OfficeCanvas.tsx?raw';
import elevatorSource from '../src/office/scene/prefabs/architecture/GlassElevator.tsx?raw';
import buildingSource from '../src/office/scene/BuildingShellModel.tsx?raw';
import terraceSource from '../src/office/scene/interior/prefabs/architecture/RooftopTerrace.tsx?raw';
import { F3_TERRACE } from '../src/office/scene/interior/floor1Layout';
import { MODEL_LINTEL, roleOf } from '../src/office/scene/BuildingShellModel';
import { EXTALIA_SIGNAGE_LAYOUT } from '../src/office/scene/prefabs/architecture/extaliaSignageLayout';

const named = (name: string, transparent = false) => Object.assign(new MeshStandardMaterial({ transparent }), { name });

describe('building model with the three.js backup', () => {
  it('gives the Blender materials their live roles', () => {
    expect(roleOf(named('Glass.001', true))).toBe('glass');
    expect(roleOf(named('Review - front blue curtain', true))).toBe('glass');
    expect(roleOf(named('Accent.001'))).toBe('accent');
    expect(roleOf(named('Cladding'))).toBe('solid');
    expect(roleOf(named('Frame'))).toBe('solid');
    expect(roleOf(named('Review - laminated balustrade glass', true))).toBe('glass');
  });

  it('lets the Blender terrace balustrade replace the three.js rails, with the stair foot kept clear', () => {
    expect(terraceSource).toContain('useCampusModelReady("terrace")');
    expect(terraceSource).toContain('{!guardFromModel && <group name="terrace-procedural-guard" userData={{ officeDynamic: true }}><StaticCampusBatch>');
    // The Blender stair lands at z 13.25-14.95 and the backup stair at its z 18.2 gate: no planter in either.
    for (const [x, , z] of F3_TERRACE.planters) {
      if (x > -18.9 + 1.4) continue;
      expect(z < 13 || z > 15.6).toBe(true);
      expect(Math.abs(z - 18.2)).toBeGreaterThan(1);
    }
  });

  it('mounts the building through the model-or-backup switch, not the three.js shell directly', () => {
    expect(canvasSource).toContain('<CampusBuilding />');
    expect(canvasSource).not.toContain('<CampusBuildingShell />');
    for (const part of ['<CampusRoofUtilities />', '<CampusRoofStair view={view} />', '<CampusElevatorFrames />', '<CampusTerraceGuard />']) expect(canvasSource).toContain(part);
    expect(canvasSource).not.toContain('<RoofUtilities />');
    expect(canvasSource).not.toContain('<RoofMaintenanceStair />');
  });

  it('keeps the moving parts in the app: model fan rotors on the app motors, lift cabs and doors in GlassElevator', () => {
    expect(buildingSource).toContain('AC_FAN_ROTOR_');
    expect(buildingSource).toContain('<RoofFanMotion rotors={rotors} />');
    // The lift shaft and landing frames step aside only in the whole-building views, never the doors.
    expect(elevatorSource).toContain('useCampusModelReady("elevators") && allFloors');
    expect(elevatorSource).toMatch(/<\/StaticCampusBatch><\/group>\s*<group position=\{\[doorX - x, 0, 0\]\}/);
  });

  it('hangs the entrance lettering on the model canopy sign, in front of the facade and lower than the backup fascia', () => {
    expect(MODEL_LINTEL.frontZ).toBeLessThan(EXTALIA_SIGNAGE_LAYOUT.lintel.frontZ + 0.5);
    expect(MODEL_LINTEL.y).toBeLessThan(EXTALIA_SIGNAGE_LAYOUT.lintel.y);
    expect(MODEL_LINTEL.y).toBeGreaterThan(3);
  });
});
