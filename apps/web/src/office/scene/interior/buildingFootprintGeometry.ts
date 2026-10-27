import { BufferGeometry, Float32BufferAttribute } from 'three';

export type BuildingFootprintProfile = 'lower' | 'upper';
type Point = readonly [number, number];
interface BuildingRectangle {
  size: readonly [number, number];
  origin: readonly [number, number];
  rotationY?: number;
  profile: BuildingFootprintProfile;
}

const RADIUS = 1.78;
const EPSILON = 1e-8;
const MIN_AREA = 1e-8;

function footprint(rear: number): readonly Point[] {
  const corners = [[-19.15, -17.205, Math.PI], [23.15, -17.205, Math.PI * 1.5],
    [23.15, rear, 0], [-19.15, rear, Math.PI * 0.5]] as const;
  return Object.freeze(corners.flatMap(([x, z, start]) => Array.from({ length: 17 }, (_, step): Point => {
    const angle = start + step * Math.PI / 32;
    return Object.freeze([x + RADIUS * Math.cos(angle), z + RADIUS * Math.sin(angle)] as const);
  })));
}
const FOOTPRINTS = { lower: footprint(17.15), upper: footprint(11.15) };

/** Convex, inscribed CCW world-XZ polygon, with sixteen segments per rounded corner. */
export function buildingFootprintPolygon(profile: BuildingFootprintProfile): readonly Point[] {
  if (profile !== 'lower' && profile !== 'upper') throw new RangeError('Unknown building footprint profile');
  return FOOTPRINTS[profile];
}

function distance(point: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  return (dx * (point[1] - a[1]) - dz * (point[0] - a[0])) / Math.hypot(dx, dz);
}

/** Tolerance is an outward distance in metres from each polygon half-plane. */
export function isInsideBuildingFootprint(x: number, z: number, profile: BuildingFootprintProfile, tolerance = EPSILON): boolean {
  const polygon = buildingFootprintPolygon(profile);
  if (![x, z, tolerance].every(Number.isFinite) || tolerance < 0) return false;
  return polygon.every((a, index) => distance([x, z], a, polygon[(index + 1) % polygon.length]!) >= -tolerance);
}

function signedArea(points: readonly Point[]): number {
  const anchor = points[0];
  if (!anchor) return 0;
  let twice = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i]!, b = points[i + 1]!;
    twice += (a[0] - anchor[0]) * (b[1] - anchor[1]) - (a[1] - anchor[1]) * (b[0] - anchor[0]);
  }
  return twice / 2;
}

function clean(points: readonly Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const last = result.at(-1);
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) > EPSILON) result.push(point);
  }
  if (result.length > 1 && Math.hypot(result[0]![0] - result.at(-1)![0], result[0]![1] - result.at(-1)![1]) <= EPSILON) result.pop();
  let changed = true;
  while (changed && result.length >= 3) {
    changed = false;
    for (let i = 0; i < result.length; i++) {
      const a = result[(i + result.length - 1) % result.length]!, b = result[i]!, c = result[(i + 1) % result.length]!;
      const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) <= EPSILON * (ab + bc)) {
        result.splice(i, 1); changed = true; break;
      }
    }
  }
  return result;
}

/** Clip a translated/Y-rotated rectangle; return local-XZ CCW points without a repeated endpoint. */
export function clipBuildingRectangle({ size, origin, rotationY = 0, profile }: BuildingRectangle): readonly Point[] {
  const [width, depth] = size, [ox, oz] = origin;
  if (![width, depth, ox, oz, rotationY].every(Number.isFinite) || width <= 0 || depth <= 0) {
    throw new RangeError('Building rectangle requires positive finite dimensions and a finite transform');
  }
  const boundary = buildingFootprintPolygon(profile);
  const cos = Math.cos(rotationY), sin = Math.sin(rotationY);
  let polygon: Point[] = ([[-width / 2, -depth / 2], [width / 2, -depth / 2],
    [width / 2, depth / 2], [-width / 2, depth / 2]] as Point[])
    .map(([x, z]) => [ox + cos * x + sin * z, oz - sin * x + cos * z]);
  for (let edge = 0; edge < boundary.length && polygon.length; edge++) {
    const a = boundary[edge]!, b = boundary[(edge + 1) % boundary.length]!;
    const output: Point[] = [];
    let previous = polygon.at(-1)!, previousDistance = distance(previous, a, b);
    for (const current of polygon) {
      const currentDistance = distance(current, a, b);
      const previousInside = previousDistance >= -EPSILON, currentInside = currentDistance >= -EPSILON;
      if (previousInside !== currentInside) {
        const t = Math.max(0, Math.min(1, previousDistance / (previousDistance - currentDistance)));
        output.push([previous[0] + t * (current[0] - previous[0]), previous[1] + t * (current[1] - previous[1])]);
      }
      if (currentInside) output.push(current);
      previous = current; previousDistance = currentDistance;
    }
    polygon = clean(output);
  }
  const local = clean(polygon.map(([x, z]): Point => [cos * (x - ox) - sin * (z - oz), sin * (x - ox) + cos * (z - oz)]));
  const area = signedArea(local);
  if (local.length < 3 || Math.abs(area) <= MIN_AREA) return [];
  if (area < 0) local.reverse();
  return local;
}

/** Closed local-Y prism (0..thickness), sharp cap/edge normals and unstretched rectangle-top UVs. */
export function createBuildingFootprintGeometry(options: BuildingRectangle & { thickness: number }): BufferGeometry | null {
  const { thickness, size: [width, depth] } = options;
  if (!Number.isFinite(thickness) || thickness <= 0) throw new RangeError('Building prism requires positive finite thickness');
  const polygon = clipBuildingRectangle(options);
  if (!polygon.length) return null;
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  const count = polygon.length;
  for (const [height, normalY] of [[thickness, 1], [0, -1]] as const) {
    for (const [x, z] of polygon) {
      positions.push(x, height, z); normals.push(0, normalY, 0);
      uvs.push(0.5 + x / width, 0.5 - z / depth);
    }
  }
  // CCW in XZ points down in Y-up 3D, hence the reversed top-cap triangles.
  for (let i = 1; i < count - 1; i++) {
    indices.push(0, i + 1, i, count, count + i, count + i + 1);
  }
  let travelled = 0;
  for (let i = 0; i < count; i++) {
    const a = polygon[i]!, b = polygon[(i + 1) % count]!;
    const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
    const offset = positions.length / 3;
    for (const [point, height, along] of [[a, 0, travelled], [b, 0, travelled + length],
      [b, thickness, travelled + length], [a, thickness, travelled]] as const) {
      positions.push(point[0], height, point[1]); normals.push(dz / length, 0, -dx / length);
      uvs.push(along / width, height / depth);
    }
    indices.push(offset, offset + 2, offset + 1, offset, offset + 3, offset + 2);
    travelled += length;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}
