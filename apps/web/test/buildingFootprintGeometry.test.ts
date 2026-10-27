import { describe, expect, it } from 'vitest';
import { Vector3, type BufferGeometry } from 'three';
import {
  buildingFootprintPolygon, clipBuildingRectangle, createBuildingFootprintGeometry, isInsideBuildingFootprint,
  type BuildingFootprintProfile,
} from '../src/office/scene/interior/buildingFootprintGeometry';

type Point = readonly [number, number];
function area(points: readonly Point[]): number {
  return points.reduce((sum, a, i) => {
    const b = points[(i + 1) % points.length]!;
    return sum + a[0] * b[1] - a[1] * b[0];
  }, 0) / 2;
}
function world(point: Point, origin: Point, angle: number): Point {
  return [origin[0] + Math.cos(angle) * point[0] + Math.sin(angle) * point[1],
    origin[1] - Math.sin(angle) * point[0] + Math.cos(angle) * point[1]];
}
function verifyClosed(geometry: BufferGeometry): number {
  const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
  const indices = geometry.getIndex()!;
  const edges = new Map<string, string[]>();
  const vertex = (index: number) => new Vector3().fromBufferAttribute(positions, index);
  const key = (index: number) => vertex(index).toArray().map(value => Math.round(value * 100_000)).join(',');
  let volume = 0;
  for (let i = 0; i < indices.count; i += 3) {
    const ids = [indices.getX(i), indices.getX(i + 1), indices.getX(i + 2)];
    const a = vertex(ids[0]!), b = vertex(ids[1]!), c = vertex(ids[2]!);
    const cross = b.clone().sub(a).cross(c.clone().sub(a));
    expect(cross.length()).toBeGreaterThan(1e-8);
    const normal = new Vector3().fromBufferAttribute(normals, ids[0]!);
    expect(cross.normalize().dot(normal)).toBeGreaterThan(0.99999);
    volume += a.dot(b.clone().cross(c)) / 6;
    for (let e = 0; e < 3; e++) {
      const from = key(ids[e]!), to = key(ids[(e + 1) % 3]!);
      expect(from).not.toBe(to);
      const undirected = [from, to].sort().join('|');
      edges.set(undirected, [...edges.get(undirected) ?? [], `${from}>${to}`]);
    }
  }
  for (const edge of edges.values()) {
    expect(edge).toHaveLength(2);
    const [a, b] = edge[0]!.split('>');
    expect(edge[1]).toBe(`${b}>${a}`);
  }
  return volume;
}

describe('rounded building footprint polygons', () => {
  it('uses the authored centers, conservative rounded radius and both rear profiles', () => {
    for (const profile of ['lower', 'upper'] as const) {
      const polygon = buildingFootprintPolygon(profile);
      const rear = profile === 'lower' ? 17.15 : 11.15;
      expect(area(polygon)).toBeGreaterThan(0);
      expect(Math.min(...polygon.map(point => point[0]))).toBeCloseTo(-20.93, 10);
      expect(Math.max(...polygon.map(point => point[0]))).toBeCloseTo(24.93, 10);
      expect(Math.min(...polygon.map(point => point[1]))).toBeCloseTo(-18.985, 10);
      expect(Math.max(...polygon.map(point => point[1]))).toBeCloseTo(rear + 1.78, 10);
      const centers = [[-19.15, -17.205], [23.15, -17.205], [23.15, rear], [-19.15, rear]] as const;
      for (const [corner, center] of centers.entries()) {
        const arc = polygon.slice(corner * 17, (corner + 1) * 17);
        expect(arc).toHaveLength(17);
        for (const point of arc) expect(Math.hypot(point[0] - center[0], point[1] - center[1])).toBeCloseTo(1.78, 10);
        for (let i = 0; i < arc.length - 1; i++) {
          const midpoint: Point = [(arc[i]![0] + arc[i + 1]![0]) / 2, (arc[i]![1] + arc[i + 1]![1]) / 2];
          const inset = 1.78 - Math.hypot(midpoint[0] - center[0], midpoint[1] - center[1]);
          expect(inset).toBeGreaterThan(0);
          expect(inset).toBeLessThan(0.0022);
        }
      }
      expect(polygon.every(([x, z]) => isInsideBuildingFootprint(x, z, profile))).toBe(true);
    }
    expect(isInsideBuildingFootprint(0, 16, 'lower')).toBe(true);
    expect(isInsideBuildingFootprint(0, 16, 'upper')).toBe(false);
  });

  it('treats tolerances as metres and refuses invalid coordinates or profiles', () => {
    expect(isInsideBuildingFootprint(24.931, 0, 'lower')).toBe(false);
    expect(isInsideBuildingFootprint(24.931, 0, 'lower', 0.002)).toBe(true);
    expect(isInsideBuildingFootprint(NaN, 0, 'lower')).toBe(false);
    expect(isInsideBuildingFootprint(0, 0, 'lower', -1)).toBe(false);
    expect(() => buildingFootprintPolygon('invalid' as BuildingFootprintProfile)).toThrow(RangeError);
  });
});

describe('rectangle clipping in local coordinates', () => {
  it('leaves interior rectangles unchanged, including translated and Three.js-Y-rotated ones', () => {
    for (const rotationY of [0, 0.37, Math.PI / 2, -2.1]) {
      const origin: Point = [2, -3];
      const polygon = clipBuildingRectangle({ size: [4, 6], origin, rotationY, profile: 'lower' });
      const expected = [[-2, -3], [2, -3], [2, 3], [-2, 3]] as const;
      expect(polygon).toHaveLength(4);
      polygon.forEach((point, index) => {
        expect(point[0]).toBeCloseTo(expected[index]![0], 10);
        expect(point[1]).toBeCloseTo(expected[index]![1], 10);
      });
      expect(area(polygon)).toBeCloseTo(24, 10);
    }
  });

  it('clips every corner for both profiles and arbitrary yaw without moving the rectangle frame', () => {
    for (const profile of ['lower', 'upper'] as const) {
      const rear = profile === 'lower' ? 18.2 : 12.2;
      const origins: Point[] = [[-20, -18], [24, -18], [24, rear], [-20, rear]];
      for (const origin of origins) for (const rotationY of [0, 0.27, Math.PI / 2, -1.31]) {
        const polygon = clipBuildingRectangle({ size: [4, 3], origin, rotationY, profile });
        expect(polygon.length).toBeGreaterThanOrEqual(3);
        expect(area(polygon)).toBeGreaterThan(0);
        expect(area(polygon)).toBeLessThan(12);
        for (const point of polygon) {
          expect(Math.abs(point[0])).toBeLessThanOrEqual(2 + 1e-7);
          expect(Math.abs(point[1])).toBeLessThanOrEqual(1.5 + 1e-7);
          const [x, z] = world(point, origin, rotationY);
          expect(isInsideBuildingFootprint(x, z, profile, 1e-7)).toBe(true);
        }
      }
    }
  });

  it('returns empty for disjoint, tangent-line and tangent-point intersections', () => {
    for (const origin of [[100, 0], [25.93, 0], [24.15, 19.93]] as const) {
      const options = { size: [2, 2] as const, origin, profile: 'lower' as const, thickness: 0.32 };
      expect(clipBuildingRectangle(options)).toEqual([]);
      expect(createBuildingFootprintGeometry(options)).toBeNull();
    }
    expect(() => clipBuildingRectangle({ size: [0, 2], origin: [0, 0], profile: 'lower' })).toThrow(RangeError);
    expect(() => clipBuildingRectangle({ size: [2, 2], origin: [Infinity, 0], profile: 'lower' })).toThrow(RangeError);
    expect(() => createBuildingFootprintGeometry({ size: [2, 2], origin: [0, 0], profile: 'lower', thickness: -1 })).toThrow(RangeError);
  });
});

describe('closed clipped prisms', () => {
  it('has outward winding, watertight quantized edges, finite attributes and the expected volume', () => {
    for (const profile of ['lower', 'upper'] as const) for (const rotationY of [0, 0.43, -Math.PI / 2]) {
      const options = { size: [46, 38] as const, origin: [2, 0] as const, rotationY, profile, thickness: 0.32 };
      const geometry = createBuildingFootprintGeometry(options)!;
      try {
        for (const attribute of Object.values(geometry.attributes)) expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true);
        expect(geometry.boundingBox!.min.y).toBe(0);
        expect(geometry.boundingBox!.max.y).toBeCloseTo(0.32, 6);
        const volume = verifyClosed(geometry);
        expect(volume).toBeCloseTo(area(clipBuildingRectangle(options)) * 0.32, 3);
        const position = geometry.getAttribute('position');
        for (let i = 0; i < position.count; i++) {
          const [x, z] = world([position.getX(i), position.getZ(i)], options.origin, rotationY);
          expect(isInsideBuildingFootprint(x, z, profile, 1e-5)).toBe(true);
        }
      } finally { geometry.dispose(); }
    }
  });

  it('preserves original rectangle UV density on clipped caps and keeps sharp side normals', () => {
    for (const origin of [[0, 0], [-20, -18]] as const) {
      const geometry = createBuildingFootprintGeometry({ size: [4, 6], origin, profile: 'lower', thickness: 0.08 })!;
      try {
        const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv');
        let capCount = 0, sideCount = 0;
        for (let i = 0; i < position.count; i++) {
          if (Math.abs(normal.getY(i)) === 1) {
            capCount++;
            expect(uv.getX(i)).toBeCloseTo(0.5 + position.getX(i) / 4, 6);
            expect(uv.getY(i)).toBeCloseTo(0.5 - position.getZ(i) / 6, 6);
          } else {
            sideCount++;
            expect(normal.getY(i)).toBe(0);
            expect(Math.hypot(normal.getX(i), normal.getZ(i))).toBeCloseTo(1, 6);
          }
        }
        expect(capCount).toBeGreaterThanOrEqual(8);
        expect(sideCount).toBe(capCount * 2);
        verifyClosed(geometry);
      } finally { geometry.dispose(); }
    }
  });
});
