export type BakedFixture = {
  position: [number, number, number];
  aim: [number, number, number];
  intensity: number;
  /** Linear RGB, matching the renderer's working color space. */
  color: [number, number, number];
  distance: number;
  angle: number;
  penumbra: number;
  bounds?: { west: number; east: number; north: number; south: number };
  /** A floor slab blocks illumination into the storey below the fixture. */
  floorY?: number;
  /** Upper slab bounds device light to its own storey. */
  ceilingY?: number;
  /** Exclude this inclusive x/z footprint at every height, without a margin. */
  excludeBounds?: { west: number; east: number; north: number; south: number };
  /** Inverse-square clamp radius (default 0.4 m); larger values soften a source's near field. */
  minDistance?: number;
  /**
   * Cells closer than this to the source plane (measured along the aim) receive nothing. A wall display
   * uses about one cell, so trilinear sampling cannot carry its light through the wall behind it.
   */
  frontClip?: number;
};

/** Metre cells reach the front road spawn (z -56.5) so the arrival walkway can be lit. */
export const IRRADIANCE_GRID_MIN = [-56, -0.35, -62] as const;
export const IRRADIANCE_GRID_MAX = [56, 22.4, 40] as const;
export const IRRADIANCE_GRID_DIMENSIONS = [112, 32, 102] as const;
/** Allow illumination to reach the surface of thin room partitions. */
export const IRRADIANCE_ROOM_MARGIN = 0.08;

/**
 * Bake fixture radiance and its luminance-weighted sample-to-source direction.
 * Cells are sampled at their centers; x is the fastest texture axis, then y, z.
 * There is no ambient term, surface-normal response, or intensity normalization.
 * Each fixture visits only its range box, clipped to the grid and room footprint.
 */
export function bakeFixtureIrradiance(fixtures: readonly BakedFixture[]): {
  radiance: Float32Array;
  direction: Uint8Array;
} {
  const [nx, ny, nz] = IRRADIANCE_GRID_DIMENSIONS;
  const [minX, minY, minZ] = IRRADIANCE_GRID_MIN;
  const sx = (IRRADIANCE_GRID_MAX[0] - minX) / nx;
  const sy = (IRRADIANCE_GRID_MAX[1] - minY) / ny;
  const sz = (IRRADIANCE_GRID_MAX[2] - minZ) / nz;
  const count = nx * ny * nz;
  const radiance = new Float32Array(count * 4);
  const direction = new Uint8Array(count * 4);
  const directionX = new Float32Array(count);
  const directionY = new Float32Array(count);
  const directionZ = new Float32Array(count);

  for (const fixture of fixtures) {
    const [px, py, pz] = fixture.position;
    const [red, green, blue] = fixture.color;
    const range = fixture.distance;
    const intensity = fixture.intensity;
    if (!(range > 0) || !(intensity > 0) ||
        !Number.isFinite(range) || !Number.isFinite(intensity) ||
        !Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz) ||
        !Number.isFinite(red) || !Number.isFinite(green) || !Number.isFinite(blue) ||
        red < 0 || green < 0 || blue < 0 ||
        !Number.isFinite(fixture.angle) || !Number.isFinite(fixture.penumbra)) continue;

    let fx = fixture.aim[0] - px;
    let fy = fixture.aim[1] - py;
    let fz = fixture.aim[2] - pz;
    const forwardLength = Math.hypot(fx, fy, fz);
    if (!(forwardLength > 0) || !Number.isFinite(forwardLength)) continue;
    fx /= forwardLength;
    fy /= forwardLength;
    fz /= forwardLength;

    const angle = Math.max(0, Math.min(Math.PI, fixture.angle));
    const penumbra = Math.max(0, Math.min(1, fixture.penumbra));
    const outerCos = Math.cos(angle);
    const innerCos = Math.cos(angle * (1 - penumbra));
    const coneWidth = innerCos - outerCos;
    const rangeSquared = range * range;
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    if (!(luminance > 0)) continue;

    const bounds = fixture.bounds;
    const west = bounds ? bounds.west - IRRADIANCE_ROOM_MARGIN : -Infinity;
    const east = bounds ? bounds.east + IRRADIANCE_ROOM_MARGIN : Infinity;
    const north = bounds ? bounds.north - IRRADIANCE_ROOM_MARGIN : -Infinity;
    const south = bounds ? bounds.south + IRRADIANCE_ROOM_MARGIN : Infinity;
    const x0 = Math.max(0, Math.ceil((Math.max(px - range, west) - minX) / sx - 0.5));
    const x1 = Math.min(nx - 1, Math.floor((Math.min(px + range, east) - minX) / sx - 0.5));
    const y0 = Math.max(0, Math.ceil((py - range - minY) / sy - 0.5));
    const y1 = Math.min(ny - 1, Math.floor((py + range - minY) / sy - 0.5));
    const z0 = Math.max(0, Math.ceil((Math.max(pz - range, north) - minZ) / sz - 0.5));
    const z1 = Math.min(nz - 1, Math.floor((Math.min(pz + range, south) - minZ) / sz - 0.5));
    const excluded = fixture.excludeBounds;
    const minDistance = fixture.minDistance !== undefined && fixture.minDistance > 0 ? fixture.minDistance : 0.4;
    const minDistanceSquared = minDistance * minDistance;
    const frontClip = fixture.frontClip !== undefined && Number.isFinite(fixture.frontClip) ? fixture.frontClip : -Infinity;

    for (let z = z0; z <= z1; z++) {
      const sampleZ = minZ + (z + 0.5) * sz;
      const dz = sampleZ - pz;
      const excludedZ = excluded !== undefined && sampleZ >= excluded.north && sampleZ <= excluded.south;
      for (let y = y0; y <= y1; y++) {
        const sampleY = minY + (y + 0.5) * sy;
        if (fixture.floorY !== undefined && sampleY < fixture.floorY - IRRADIANCE_ROOM_MARGIN) continue;
        if (fixture.ceilingY !== undefined && sampleY > fixture.ceilingY + IRRADIANCE_ROOM_MARGIN) continue;
        const dy = sampleY - py;
        const row = (z * ny + y) * nx;
        for (let x = x0; x <= x1; x++) {
          const sampleX = minX + (x + 0.5) * sx;
          if (excluded && excludedZ && sampleX >= excluded.west && sampleX <= excluded.east) continue;
          const dx = sampleX - px;
          const distanceSquared = dx * dx + dy * dy + dz * dz;
          if (distanceSquared >= rangeSquared) continue;
          // The source itself has no preferred direction; keep its finite radiance.
          const inverseDistance = distanceSquared > 0 ? 1 / Math.sqrt(distanceSquared) : 0;
          const dot = distanceSquared > 0 ? (fx * dx + fy * dy + fz * dz) * inverseDistance : 1;
          if (dot < outerCos) continue;
          if (fx * dx + fy * dy + fz * dz < frontClip) continue;
          const t = coneWidth > 0 ? Math.max(0, Math.min(1, (dot - outerCos) / coneWidth)) : 1;
          const cone = t * t * (3 - 2 * t);
          if (cone === 0) continue;
          const relativeSquared = distanceSquared / rangeSquared;
          const cutoff = Math.max(1 - relativeSquared * relativeSquared, 0);
          const energy = intensity * cone * cutoff * cutoff / Math.max(distanceSquared, minDistanceSquared);
          const cell = row + x;
          const offset = cell * 4;
          radiance[offset] = radiance[offset]! + red * energy;
          radiance[offset + 1] = radiance[offset + 1]! + green * energy;
          radiance[offset + 2] = radiance[offset + 2]! + blue * energy;
          const weight = luminance * energy * inverseDistance;
          directionX[cell] = directionX[cell]! - dx * weight;
          directionY[cell] = directionY[cell]! - dy * weight;
          directionZ[cell] = directionZ[cell]! - dz * weight;
        }
      }
    }
  }

  for (let cell = 0; cell < count; cell++) {
    const offset = cell * 4;
    const x = directionX[cell]!;
    const y = directionY[cell]!;
    const z = directionZ[cell]!;
    const length = Math.hypot(x, y, z);
    const scale = length > 0 ? 127.5 / length : 0;
    direction[offset] = Math.round(127.5 + x * scale);
    direction[offset + 1] = Math.round(127.5 + y * scale);
    direction[offset + 2] = Math.round(127.5 + z * scale);
    direction[offset + 3] = 255;
    radiance[offset + 3] = 1;
  }
  return { radiance, direction };
}
