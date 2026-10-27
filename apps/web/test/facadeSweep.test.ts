import { describe, expect, it } from 'vitest';
import { ExtrudeGeometry, Vector3 } from 'three';
import { cutPath, pathLength, pointsAlong, roundCorners, sweepBand, thickPolyline, type Plan } from '../src/office/scene/facadeSweep';

const square: Plan[] = [[-5, -4], [5, -4], [5, 4], [-5, 4]];

describe('facade sweep', () => {
  it('rounds corners with arcs of the given radius and keeps the ends', () => {
    const path = roundCorners(square, 1, 8);
    expect(path[0]).toEqual([-5, -4]);
    expect(path.at(-1)).toEqual([-5, 4]);
    // The first corner's arc stays 1 m from its centre (4, -3) and inside the sharp corner.
    const arc = path.filter(([x, z]) => x > 3.9 && z < -2.9);
    expect(arc.length).toBeGreaterThan(5);
    for (const [x, z] of arc) expect(Math.hypot(x - 4, z + 3)).toBeCloseTo(1, 6);
    // Shorter than the sharp path by 2·(2 − π/2) per rounded corner.
    expect(pathLength(path)).toBeCloseTo(pathLength(square) - 2 * (2 - Math.PI / 2), 1);
  });

  it('cuts openings out of straight runs, leaving the rest of the path continuous', () => {
    const path = roundCorners(square, 1);
    const pieces = cutPath(path, [{ axis: 'x', at: 5, from: -1, to: 1 }, { axis: 'z', at: 4, from: 0, to: 2 }]);
    expect(pieces).toHaveLength(3);
    expect(pieces[0]!.at(-1)).toEqual([5, -1]);
    expect(pieces[1]![0]).toEqual([5, 1]);
    expect(pieces[1]!.at(-1)![0]).toBeCloseTo(2, 6);
    expect(pieces[2]![0]![0]).toBeCloseTo(0, 6);
  });

  it('places mullions only along straight runs', () => {
    const points = pointsAlong(roundCorners(square, 1), 3);
    expect(points.length).toBeGreaterThan(4);
    for (const { at: [x, z] } of points) expect(Math.abs(Math.abs(x) - 5) < 1e-6 || Math.abs(Math.abs(z) - 4) < 1e-6).toBe(true);
  });

  it('sweeps a band whose face normals point away from the building', () => {
    const geometry = sweepBand(roundCorners(square, 1), 0, 1, 0.3);
    const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
    let outward = 0, checked = 0;
    for (let i = 0; i < position.count; i++) {
      const p = new Vector3().fromBufferAttribute(position, i), n = new Vector3().fromBufferAttribute(normal, i);
      // Face vertices lie on the path itself (|x| = 5 or |z| = 4 on the straight runs).
      if (Math.abs(n.y) > 0.5 || Math.abs(Math.abs(p.x) - 5) > 1e-6) continue;
      checked++;
      if (Math.sign(n.x) === Math.sign(p.x)) outward++;
    }
    expect(checked).toBeGreaterThan(0);
    expect(outward / checked).toBeGreaterThan(0.45);
    // u runs in metres along the path: the last face vertex carries the full length.
    const uv = geometry.getAttribute('uv');
    let maxU = 0;
    for (let i = 0; i < uv.count; i++) maxU = Math.max(maxU, uv.getX(i));
    expect(maxU).toBeCloseTo(pathLength(roundCorners(square, 1)), 3);
  });

  it('outlines a stepped ribbon as one mitred solid', () => {
    const shape = thickPolyline([[0, 0], [4, 0], [6, 2], [10, 2]], 0.9);
    const geometry = new ExtrudeGeometry(shape, { depth: 0.6, bevelEnabled: false });
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    expect(box.max.x - box.min.x).toBeCloseTo(10, 1);
    expect(box.max.y).toBeGreaterThan(2.4);
    expect(box.min.y).toBeLessThan(-0.4);
  });
});
