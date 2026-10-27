import { ExtrudeGeometry, Shape } from 'three';
import profile from './teamPodDesktopProfile.json';

/** Shared by the Blender authoring script, the fallback surface and support checks. */
export const TEAM_POD_DESKTOP = Object.freeze(profile);

/** Four inward circular bays; the avatar/chair corners are outside the solid desktop. */
export function teamPodDesktopOutline(): readonly (readonly [number, number])[] {
  const { halfExtent: s, bayRadius: r, arcSegments: segments } = TEAM_POD_DESKTOP;
  const quadrant: [number, number][] = [[s, 0]];
  for (let i = 0; i <= segments; i++) {
    const angle = i / segments * Math.PI / 2;
    quadrant.push([s - r * Math.sin(angle), s - r * Math.cos(angle)]);
  }
  quadrant.push([0, s]);
  const outline: [number, number][] = [];
  for (let turn = 0; turn < 4; turn++) for (const [x, z] of quadrant.slice(0, -1)) {
    outline.push(turn === 0 ? [x, z] : turn === 1 ? [-z, x] : turn === 2 ? [-x, -z] : [z, -x]);
  }
  return outline;
}

/** Signed distance from the nearest straight edge or circular seat-bay boundary. */
export function teamPodDesktopMargin(x: number, z: number): number {
  const { halfExtent: s, bayRadius: r } = TEAM_POD_DESKTOP;
  return Math.min(s - Math.abs(x), s - Math.abs(z), Math.hypot(s - Math.abs(x), s - Math.abs(z)) - r);
}

export function createTeamPodDesktopGeometry(): ExtrudeGeometry {
  const points = teamPodDesktopOutline();
  const shape = new Shape();
  shape.moveTo(...points[0]!);
  for (const point of points.slice(1)) shape.lineTo(...point);
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, { depth: TEAM_POD_DESKTOP.thickness, bevelEnabled: false });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, TEAM_POD_DESKTOP.top, 0);
  return geometry;
}

/** A single rounded divider in the +X direction; rotate copies around the central post. */
export function createTeamPodDividerGeometry(): ExtrudeGeometry {
  const { dividerStart: a, dividerEnd: b, dividerBottom: bottom, dividerTop: top, dividerCornerRadius: r } = TEAM_POD_DESKTOP;
  const shape = new Shape();
  shape.moveTo(a + r, bottom);
  shape.lineTo(b - r, bottom);
  shape.absarc(b - r, bottom + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(b, top - r);
  shape.absarc(b - r, top - r, r, 0, Math.PI / 2, false);
  shape.lineTo(a + r, top);
  shape.absarc(a + r, top - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(a, bottom + r);
  shape.absarc(a + r, bottom + r, r, Math.PI, 3 * Math.PI / 2, false);
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, { depth: TEAM_POD_DESKTOP.dividerThickness, bevelEnabled: false, curveSegments: 6 });
  geometry.translate(0, 0, -TEAM_POD_DESKTOP.dividerThickness / 2);
  return geometry;
}
