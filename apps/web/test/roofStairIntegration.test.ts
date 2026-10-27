import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { OpenDoor } from '../src/office/scene/interior/prefabs/architecture/OpenDoor';
import { StaticCampusBatch } from '../src/office/scene/StaticCampusBatch';
import { CampusRoofStair } from '../src/office/scene/BuildingShellModel';
import type * as CampusModelTypes from '../src/office/scene/campusModels';
import {
  MAINTENANCE_STAIR_LAYOUT, MODEL_MAINTENANCE_STAIR_LAYOUT, MaintenanceStairLighting,
  RoofMaintenanceStair, RoofMaintenanceStairStructure, maintenanceStairLightSources,
} from '../src/office/scene/prefabs/architecture/RoofMaintenanceStair';

const status = vi.hoisted(() => ({ ready: false }));
vi.mock('../src/office/scene/campusModels', async importOriginal => ({
  ...await importOriginal<typeof CampusModelTypes>(),
  useCampusModelReady: () => status.ready,
}));

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return [];
    return [child as ReactElement<Record<string, unknown>>, ...elements(child.props.children)];
  });
}

function gates(modelShown: boolean) {
  return elements(RoofMaintenanceStair({ modelShown })).filter(element => element.type === OpenDoor);
}

describe('roof stair model and app-owned access', () => {
  beforeEach(() => { status.ready = false; });

  it('retains two real traffic-driven gates and one fixture set in both rendering modes', () => {
    for (const modelShown of [false, true]) {
      const tree = elements(RoofMaintenanceStair({ modelShown }));
      // Identity checks select the animated interior OpenDoor implementation, not the static facade copy.
      const doors = tree.filter(element => element.type === OpenDoor);
      expect(doors).toHaveLength(2);
      expect(doors.map(door => door.props.role)).toEqual(['terrace-gate', 'roof-gate']);
      for (const door of doors) {
        expect(door.props).toMatchObject({ floor: 3, roomId: 'roof-maintenance', width: 1.2, height: 1.12, rotationY: Math.PI / 2, glass: true });
      }
      const lighting = tree.filter(element => element.type === MaintenanceStairLighting);
      expect(lighting).toHaveLength(1);
      expect(lighting[0]!.props.modelShown).toBe(modelShown);
      expect(tree.filter(element => element.type === RoofMaintenanceStairStructure)).toHaveLength(modelShown ? 0 : 1);
      expect(tree.filter(element => element.type === StaticCampusBatch)).toHaveLength(modelShown ? 0 : 1);
    }
  });

  it('uses evaluated model landings without moving the procedural fallback threshold', () => {
    expect(gates(false)[0]!.props.position).toEqual([...MAINTENANCE_STAIR_LAYOUT.terraceGate]);
    expect(MAINTENANCE_STAIR_LAYOUT.terraceGate[2]).toBe(18.2);
    expect(gates(true).map(gate => gate.props.position)).toEqual([[-20.72, 12.8, 14.1], [-21.35, 19.33, 6.2]]);
    const modelGates = gates(true);
    for (const [index, [north, south]] of [[13.25, 14.95], [5.35, 7.05]].entries()) {
      const position = modelGates[index]!.props.position as number[];
      const halfFrame = (modelGates[index]!.props.width as number) / 2 + 0.08;
      expect(position[2]! - halfFrame).toBeGreaterThan(north!);
      expect(position[2]! + halfFrame).toBeLessThan(south!);
    }
    // Keep the lower leaf off the inner stair rail plane (X -21.35).
    expect(MODEL_MAINTENANCE_STAIR_LAYOUT.terraceGate[0]).toBeGreaterThan(-21.35 + 0.5);
  });

  it('keeps app access independent of model readiness and removes it from hidden floor views', () => {
    for (const ready of [false, true]) {
      status.ready = ready;
      for (const view of ['campus', 'stack', 3] as const) {
        const tree = elements(CampusRoofStair({ view }));
        const access = tree.filter(element => element.type === RoofMaintenanceStair);
        expect(access).toHaveLength(1);
        expect(access[0]!.props.modelShown).toBe(ready);
        // Model load/failure boundaries never own app gates or duplicate their fallback.
        const model = tree.find(element => element.props.name === 'roof-stair');
        expect(model?.props.backup).toBeNull();
      }
      expect(CampusRoofStair({ view: 1 })).toBeNull();
      expect(CampusRoofStair({ view: 2 })).toBeNull();
    }
  });

  it('anchors exactly five fixtures to the selected flight and landing thresholds', () => {
    for (const modelShown of [false, true]) {
      const layout = modelShown ? MODEL_MAINTENANCE_STAIR_LAYOUT : MAINTENANCE_STAIR_LAYOUT;
      const sources = maintenanceStairLightSources(modelShown);
      expect(sources).toHaveLength(5);
      for (const [index, t] of [0.2, 0.5, 0.8].entries()) {
        const source = sources[index]!;
        expect(source.position[2]).toBeCloseTo(layout.southZ - (layout.southZ - layout.northZ) * t);
        expect(source.aim[0]).toBe(layout.x);
        expect(source.aim[1]).toBeCloseTo(layout.lowerY + (layout.roofY - layout.lowerY) * t + 0.04);
        expect(source.position[1]).toBeCloseTo(source.aim[1] + 0.88);
        if (modelShown) expect(source.position[0]).toBe(-23);
      }
      expect(sources[3]!.aim).toEqual([...layout.terraceGate]);
      expect(sources[4]!.aim).toEqual([...layout.roofGate]);
      expect(sources[4]!.position[0]).toBeCloseTo(modelShown ? -21.46 : layout.landingEast - 0.16);
    }
  });
});
