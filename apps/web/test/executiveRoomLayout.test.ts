import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { EXECUTIVE_ROOM_LAYOUTS } from '../src/office/scene/interior/roomRedesignLayout';
import { EXECUTIVE_DESK_TOP } from '../src/office/scene/interior/deskLayout';
import { OFFICE_OBSTACLES } from '../src/office/scene/interior/resourceRegistry';
import { roomById } from '../src/office/scene/interior/worldRegistry';
import { ExecutiveRoomInterior } from '../src/office/scene/interior/prefabs/interiors/ExecutiveRoomInterior';
import { ExecutiveWorkstation } from '../src/office/scene/interior/prefabs/workstations/ExecutiveWorkstation';
import { PLANTER_BOUNDS } from '../src/office/scene/interior/planterLayout';

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}

for (const roomId of ['executive', 'executive-studio'] as const) describe(`${roomId} wall and decor`, () => {
  const layout = EXECUTIVE_ROOM_LAYOUTS[roomId];
  const cabinet = layout.desk.cabinet;
  const rotate = (x: number, z: number) => new Vector3(x, 0, z).applyAxisAngle(new Vector3(0, 1, 0), layout.desk.rotationY)
    .add(new Vector3(...layout.desk.position));

  it('anchors the actual workstation cabinet and its navigation footprint to the feature wall', () => {
    const tree = ExecutiveRoomInterior({ roomId, screens: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }] });
    const desk = elements(tree).find(element => element.type === ExecutiveWorkstation)!;
    expect(desk.props.cabinetPosition).toEqual(cabinet.position);
    const workstation = ExecutiveWorkstation(desk.props as Parameters<typeof ExecutiveWorkstation>[0]);
    const rendered = elements(workstation).find(element => typeof element.type === 'function' && element.type.name === 'ExecutiveLuxuryCabinet')!;
    expect(rendered.props.position).toEqual(cabinet.position);
    // Rear cap extends .27 m behind the cabinet origin; panel ribs project .0625 m inward.
    const back = rotate(cabinet.position[0], cabinet.position[2] - .27);
    expect(back.x - (layout.westPanel.position[0] + .0625)).toBeCloseTo(.02);
    const room = roomById(roomId)!;
    const center = rotate(cabinet.position[0] + cabinet.footprintOffset[0], cabinet.position[2] + cabinet.footprintOffset[1]);
    const footprint = OFFICE_OBSTACLES.find(item => item.id === `${roomId}.desk-cabinet`)!;
    expect(footprint.center[0]).toBeCloseTo(room.center[0] + center.x);
    expect(footprint.center[2]).toBeCloseTo(room.center[2] + center.z);
    expect(footprint.size).toEqual(cabinet.footprintSize);
    expect(center.x - cabinet.footprintSize[1] / 2).toBeCloseTo(back.x);
  });

  it('keeps modest plants and the reading lamp inside walls and away from the cabinet and entry', () => {
    const radius = PLANTER_BOUNDS.sculptural.width / 2;
    const center = rotate(cabinet.position[0], cabinet.position[2]);
    for (const [x, , z] of layout.plants) {
      expect(Math.abs(x) + radius).toBeLessThan(layout.roomSize[0] / 2 - .05);
      expect(Math.abs(z) + radius).toBeLessThan(layout.roomSize[1] / 2 - .05);
      expect(Math.abs(x - layout.entryAisle.center[0]) - radius).toBeGreaterThan(layout.entryAisle.size[0] / 2);
      const gapX = Math.max(0, Math.abs(x - center.x) - cabinet.footprintSize[1] / 2);
      const gapZ = Math.max(0, Math.abs(z - center.z) - cabinet.footprintSize[0] / 2);
      expect(Math.hypot(gapX, gapZ)).toBeGreaterThan(radius + .1);
      const lamp = layout.fixtures.standLamp;
      expect(Math.hypot(x - lamp[0], z - lamp[2])).toBeGreaterThan(radius + .28 + .25);
    }
  });

  it('mounts the paired sconces on exposed panel ends clear of the cabinet', () => {
    const center = rotate(cabinet.position[0], cabinet.position[2]);
    for (const [x, y, z] of layout.fixtures.wallSconces) {
      expect(x + .015).toBeCloseTo(layout.westPanel.position[0] + .0625);
      expect(Math.abs(z) + .08).toBeLessThan(layout.westPanel.width / 2);
      expect(Math.abs(z - center.z) - .08).toBeGreaterThan(cabinet.footprintSize[0] / 2);
      expect(y - .22).toBeGreaterThan(PLANTER_BOUNDS.sculptural.height);
    }
  });

  it('supports the task lamp on the desktop clear of its edges', () => {
    const [x, y, z] = layout.fixtures.deskLamp;
    expect(y).toBe(EXECUTIVE_DESK_TOP);
    const local = new Vector3(x, 0, z).sub(new Vector3(...layout.desk.position))
      .applyAxisAngle(new Vector3(0, 1, 0), -layout.desk.rotationY);
    expect(Math.abs(local.x) + .12).toBeLessThan(2.24);
    expect(Math.abs(local.z) + .12).toBeLessThan(.57);
  });
});
