import { useMemo } from 'react';
import { AdditiveBlending, BufferGeometry, Float32BufferAttribute, FrontSide, Matrix4, Vector3 } from 'three';
import type { GlowLayers } from './screenLightBudget';

/**
 * Bloom-free glow: one additive, vertex-coloured mesh per lit screen.
 *  - a soft halo ring around the panel (a cheap stand-in for bloom), and
 *  - an optional light pool on the desk in front of it (keyboard, hands, nearby paper).
 * Colour falls off per vertex (white at the panel edge, black at the rim); additive blending turns
 * black into "adds nothing". No texture, no light, one draw call, geometry shared by panel size.
 * Both layers are single-sided and face forward/up: from behind a wall display nothing of the glow
 * shows, so it never reads as light shining through the panel or the wall it hangs on.
 */

export interface DeskPool {
  /** Centre of the pool in the screen's local frame. */
  center: readonly [number, number, number];
  /** Tilt about X, so a pool laid on a desk stays level when its screen is a tilted laptop lid. */
  rotationX?: number;
  width: number;
  depth: number;
}

const FALLOFF = [1, 0.5, 0.16, 0] as const;

function ringGeometry(width: number, height: number, depth: number, spread: number, scale: number, positions: number[], colors: number[], indices: number[]) {
  const z = depth / 2 + 0.0015;
  const rings = FALLOFF.map((value, i) => {
    const grow = spread * (i / (FALLOFF.length - 1)) ** 0.85;
    return { hx: width / 2 + grow, hy: height / 2 + grow, value };
  });
  const base = positions.length / 3;
  for (const { hx, hy, value } of rings) {
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      positions.push(sx * hx, sy * hy, z);
      colors.push(value * scale, value * scale, value * scale);
    }
  }
  for (let ring = 0; ring < rings.length - 1; ring++) {
    for (let edge = 0; edge < 4; edge++) {
      const a = base + ring * 4 + edge, b = base + ring * 4 + (edge + 1) % 4;
      const c = base + (ring + 1) * 4 + (edge + 1) % 4, d = base + (ring + 1) * 4 + edge;
      // Counter-clockwise seen from the front (+Z): the halo is culled from behind the panel.
      indices.push(a, c, b, a, d, c);
    }
  }
}

function poolGeometry(pool: DeskPool, positions: number[], colors: number[], indices: number[]) {
  const segments = 20;
  const levels = [0, 0.4, 0.75, 1] as const;
  const values = [1, 0.62, 0.2, 0] as const;
  const transform = new Matrix4().makeTranslation(pool.center[0], pool.center[1], pool.center[2])
    .multiply(new Matrix4().makeRotationX(pool.rotationX ?? 0));
  const base = positions.length / 3;
  const point = new Vector3();
  // Centre vertex, then rings; the ellipse is stretched towards the user (+Z in the screen frame).
  levels.forEach((level, ring) => {
    const count = ring === 0 ? 1 : segments;
    for (let i = 0; i < count; i++) {
      const angle = (i / segments) * Math.PI * 2;
      point.set(Math.cos(angle) * level * pool.width / 2, 0, Math.sin(angle) * level * pool.depth / 2).applyMatrix4(transform);
      positions.push(point.x, point.y, point.z);
      colors.push(values[ring]!, values[ring]!, values[ring]!);
    }
  });
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;
    // Counter-clockwise seen from above (+Y): the pool lies on the desk and is culled from below.
    indices.push(base, base + 1 + next, base + 1 + i);
    for (let ring = 1; ring < levels.length - 1; ring++) {
      const inner = base + 1 + (ring - 1) * segments;
      const outer = inner + segments;
      indices.push(inner + i, outer + next, outer + i, inner + i, inner + next, outer + next);
    }
  }
}

const geometries = new Map<string, BufferGeometry>();

/** Shared by every screen of the same size and pool; never disposed (a few dozen small buffers). */
export function glowGeometry(width: number, height: number, depth: number, pool?: DeskPool): BufferGeometry {
  const r = (n: number) => Math.round(n * 1000);
  const key = [r(width), r(height), r(depth), pool ? [...pool.center.map(r), r(pool.rotationX ?? 0), r(pool.width), r(pool.depth)] : 'none'].join('/');
  let geometry = geometries.get(key);
  if (!geometry) {
    const positions: number[] = [], colors: number[] = [], indices: number[] = [];
    // With a desk pool the shared opacity follows the stronger pool layer, so the halo is scaled down to its share.
    ringGeometry(width, height, depth, Math.min(width, height) * 0.5, pool ? 0.68 : 1, positions, colors, indices);
    if (pool) poolGeometry(pool, positions, colors, indices);
    geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    geometries.set(key, geometry);
  }
  return geometry;
}

/** Light-colour glow around a screen that is on. `color` is the content's peak-normalised colour. */
export function ScreenGlow({ width, height, depth, color, layers, brightness, pool }: {
  width: number; height: number; depth: number;
  color: readonly [number, number, number];
  layers: GlowLayers;
  /** 0..1 from the content's luminance and the panel's backlight. */
  brightness: number;
  pool?: DeskPool | undefined;
}) {
  const geometry = useMemo(() => glowGeometry(width, height, depth, pool), [width, height, depth, pool]);
  const tint = useMemo(() => {
    // Lift the content colour towards white so a saturated page does not paint a coloured fog.
    const lift = (value: number) => 0.25 + 0.75 * Math.max(0, Math.min(1, value));
    return [lift(color[0]), lift(color[1]), lift(color[2])] as const;
  }, [color]);
  const opacity = (pool ? layers.pool : layers.halo) * brightness;
  if (opacity < 0.01) return null;
  return (
    <mesh geometry={geometry} renderOrder={3} userData={{ officeDynamic: true, officeGlow: true }} raycast={() => null}>
      <meshBasicMaterial
        color={[tint[0], tint[1], tint[2]]}
        vertexColors
        transparent
        opacity={opacity}
        blending={AdditiveBlending}
        side={FrontSide}
        depthWrite={false}
        toneMapped={false}
        fog={false}
      />
    </mesh>
  );
}
