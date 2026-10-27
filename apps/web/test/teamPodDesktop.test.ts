import { describe, expect, it } from 'vitest';
import { DoubleSide, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { createTeamPodDesktopGeometry, TEAM_POD_DESKTOP, teamPodDesktopMargin, teamPodDesktopOutline } from '../src/office/scene/interior/teamPodDesktopGeometry';
import { deskInputPlacement, deskLayout, KEYBOARD_DIMENSIONS, MOUSE_PAD, rotateXZ } from '../src/office/scene/interior/deskLayout';
import { OFFICE_RESOURCES } from '../src/office/scene/interior/resourceRegistry';
import { TEAM_POD_SEAT } from '../src/office/scene/interior/spatialBlueprints';
import { OFFICE_CHAIR_SEAT_BLUEPRINT } from '../src/office/scene/interior/furnitureSeatBlueprint';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { TeamPod4 } from '../src/office/scene/interior/prefabs/workstations/TeamPod4';
import { Monitor } from '../src/office/scene/interior/prefabs/props/Monitor';
import { LaptopStand, LAPTOP_STAND } from '../src/office/scene/interior/prefabs/props/DeskOrganizers';
import { MONITOR } from '../src/office/scene/interior/prefabs/props/deviceGeometry';

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const e = node as Element;
  return [e, ...elements(e.props.children as ReactNode)];
}
function rectangle(center: readonly number[], yaw: number, width: number, depth: number): readonly (readonly [number, number])[] {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => {
    const [x, z] = rotateXZ(sx! * width/2, sz! * depth/2, yaw);
    return [center[0]! + x, center[2]! + z] as const;
  });
}
function separation(a: ReturnType<typeof rectangle>, b: ReturnType<typeof rectangle>): number {
  let gap = -Infinity;
  for (const polygon of [a, b]) for (let i = 0; i < 2; i++) {
    const p = polygon[i]!, q = polygon[i+1]!;
    const length = Math.hypot(q[0]-p[0], q[1]-p[1]), nx = -(q[1]-p[1])/length, nz = (q[0]-p[0])/length;
    const pa = a.map(([x,z]) => x*nx+z*nz), pb = b.map(([x,z]) => x*nx+z*nz);
    gap = Math.max(gap, Math.min(...pb)-Math.max(...pa), Math.min(...pa)-Math.max(...pb));
  }
  return gap;
}

describe('four-person desktop inward seating bays', () => {
  it('curves into the desktop at all four chair corners, with equal radius and room for the sitter', () => {
    const { halfExtent: s, bayRadius: radius } = TEAM_POD_DESKTOP;
    const outline = teamPodDesktopOutline();
    const quadrant = outline.filter(([x, z]) => x > 0 && z > 0);
    for (const [x, z] of quadrant) expect(Math.hypot(s - x, s - z)).toBeCloseTo(radius, 7);
    // The midpoint lies toward the centre of the desk from the straight endpoint chord: concave.
    const mid = quadrant[TEAM_POD_DESKTOP.arcSegments / 2]!;
    expect(mid[0] + mid[1]).toBeLessThan(2 * s - radius - .2);
    for (const [x, z] of outline) for (const [rx, rz] of [[-z, x], [-x, -z], [z, -x]]) {
      expect(outline.some(([a, b]) => Math.hypot(a - rx!, b - rz!) < 1e-7)).toBe(true);
    }
    expect(teamPodDesktopMargin(...TEAM_POD_SEAT.chairPosition)).toBeLessThan(-.20);
    expect(TEAM_POD_DESKTOP.top - TEAM_POD_DESKTOP.thickness - OFFICE_CHAIR_SEAT_BLUEPRINT.armPadTop).toBeCloseTo(.032, 6);
  });

  it('supports keyboards and randomized right-hand pads for every authored seat and 500 other arrangements', () => {
    const authored = OFFICE_RESOURCES.filter(r => r.id.startsWith('engineering.pod-')).map(r => r.id);
    expect(authored).toHaveLength(16);
    for (const id of [...authored, ...Array.from({ length: 500 }, (_, i) => `pod-layout-${i}`)]) {
      const placement = deskInputPlacement(TEAM_POD_SEAT.keyboardPosition, Math.PI / 4, TEAM_POD_DESKTOP.top, deskLayout(id));
      const keyboard = KEYBOARD_DIMENSIONS[placement.keyboardKind];
      for (const [center, yaw, w, d] of [[placement.keyboard, placement.keyboardYaw, keyboard.width, keyboard.depth], [placement.pad, placement.mouseYaw, MOUSE_PAD.width, MOUSE_PAD.depth]] as const) {
        // Grid the footprint: the nearest point of a concave cut can be inside an edge, not a corner.
        for (let ix = 0; ix <= 8; ix++) for (let iz = 0; iz <= 8; iz++) {
          const [dx, dz] = rotateXZ((ix / 8 - .5) * w, (iz / 8 - .5) * d, yaw);
          expect(teamPodDesktopMargin(center[0] + dx, center[2] + dz), id).toBeGreaterThan(TEAM_POD_DESKTOP.edgeRadius + .005);
        }
      }
    }
  });

  it('cuts out each seating bay while leaving a solid centre and input support in the procedural backup', () => {
    const geometry = createTeamPodDesktopGeometry();
    const material = new MeshBasicMaterial({ side: DoubleSide });
    const mesh = new Mesh(geometry, material);
    mesh.updateMatrixWorld();
    const ray = (x: number, z: number) => new Raycaster(new Vector3(x, 2, z), new Vector3(0, -1, 0)).intersectObject(mesh);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      expect(ray(sx * 1.3, sz * 1.3)).toHaveLength(0);
      expect(ray(sx * TEAM_POD_SEAT.keyboardPosition[0], sz * TEAM_POD_SEAT.keyboardPosition[2])[0]!.point.y).toBeCloseTo(TEAM_POD_DESKTOP.top, 6);
    }
    expect(ray(.02, .02)[0]!.point.y).toBeCloseTo(TEAM_POD_DESKTOP.top, 6);
    geometry.dispose(); material.dispose();
  });

  it('sets monitor and laptop stands inward with a gap from every station keyboard and mouse pad', () => {
    const pod = elements(TeamPod4({ podId: 'pod-a', floorState: { agents: [], allocations: [], language: 'en' } }));
    const stations = pod.filter(e => typeof e.type === 'function' && e.props.station);
    expect(stations).toHaveLength(4);
    for (const station of stations) {
      const stationTree = elements((station.type as (props: Record<string, unknown>) => ReactNode)(station.props));
      const set = stationTree.find(e => typeof e.type === 'function' && e.props.variant)!;
      const devices = elements((set.type as (props: Record<string, unknown>) => ReactNode)(set.props));
      const bases = devices.filter(e => e.type === Monitor).map(e => rectangle(e.props.position as number[], e.props.rotationY as number, MONITOR.baseWidth, MONITOR.baseDepth));
      for (const group of devices.filter(e => e.type === 'group' && elements(e.props.children as ReactNode).some(c => c.type === LaptopStand))) {
        bases.push(rectangle(group.props.position as number[], (group.props.rotation as number[])[1]!, LAPTOP_STAND.width, LAPTOP_STAND.depth));
      }
      expect(bases.length).toBeGreaterThan(0);
      for (let i = 0; i < 100; i++) {
        const p = deskInputPlacement(TEAM_POD_SEAT.keyboardPosition, Math.PI/4, TEAM_POD_DESKTOP.top, deskLayout(`pod-device-${i}`));
        const key = KEYBOARD_DIMENSIONS[p.keyboardKind];
        const inputs = [rectangle(p.keyboard, p.keyboardYaw, key.width, key.depth), rectangle(p.pad, p.mouseYaw, MOUSE_PAD.width, MOUSE_PAD.depth)];
        for (const base of bases) {
          for (const [x,z] of base) expect(teamPodDesktopMargin(x,z)).toBeGreaterThan(.01);
          for (const input of inputs) expect(separation(base, input), `${set.props.variant} input ${i}`).toBeGreaterThan(.025);
        }
      }
    }
  });
});
