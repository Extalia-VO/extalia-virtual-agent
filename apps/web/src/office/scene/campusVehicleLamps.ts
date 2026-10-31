import type { BufferGeometry } from 'three';
import type { VehicleSpec } from './campusMobilityLayout';

/**
 * Model-space lamp anchors for a moving car (+Z forward, wheels on y=0, +X is the car's left).
 * Each anchor is the area-weighted centre of one side's lens surfaces nearest the bumper,
 * with `z` at that lens's outermost edge, so road light starts at the actual lamps.
 */
export interface LampAnchor { x: number; y: number; z: number }
/** `[left (+X), right (-X)]` for head and tail lamps. */
export interface VehicleLampAnchors { head: readonly [LampAnchor, LampAnchor]; tail: readonly [LampAnchor, LampAnchor] }

/** Lens surfaces within this depth of the bumper count as the lamp (ignores mirror and side markers). */
export const LAMP_SLAB = .4;

type LampSpec = Pick<VehicleSpec, 'length' | 'track' | 'wheel'>;

/** Bounded lateral position: between a third and a half of the wheel track from the centreline. */
const lateral = (x: number, side: 1 | -1, track: number) => side * Math.max(.3 * track, Math.min(.5 * track, Math.abs(x)));

/**
 * Derive both head and both tail lamp anchors from the baked lamp geometry (its `mobilityTail`
 * flag splits the lens roles). A side without lens surfaces mirrors the other; a model without
 * any falls back to the measured proportions.
 */
export function vehicleLampAnchors(lamp: BufferGeometry, spec: LampSpec): VehicleLampAnchors {
  const position = lamp.getAttribute('position');
  const tail = lamp.getAttribute('mobilityTail');
  const index = lamp.index;
  const triangles = Math.floor((index ? index.count : position.count) / 3);
  const vertex = (t: number, corner: number) => index ? index.getX(t * 3 + corner) : t * 3 + corner;
  const anchor = (rear: boolean, side: 1 | -1): LampAnchor | undefined => {
    let edge = rear ? Infinity : -Infinity;
    const member = (t: number) => {
      const a = vertex(t, 0), b = vertex(t, 1), c = vertex(t, 2);
      if ((tail ? tail.getX(a) > .5 : false) !== rear) return false;
      return (position.getX(a) + position.getX(b) + position.getX(c)) * side > 0;
    };
    for (let t = 0; t < triangles; t++) {
      if (!member(t)) continue;
      for (let corner = 0; corner < 3; corner++) {
        const z = position.getZ(vertex(t, corner));
        edge = rear ? Math.min(edge, z) : Math.max(edge, z);
      }
    }
    if (!Number.isFinite(edge)) return undefined;
    let area = 0, x = 0, y = 0;
    for (let t = 0; t < triangles; t++) {
      if (!member(t)) continue;
      const a = vertex(t, 0), b = vertex(t, 1), c = vertex(t, 2);
      const cz = (position.getZ(a) + position.getZ(b) + position.getZ(c)) / 3;
      if (Math.abs(cz - edge) > LAMP_SLAB) continue;
      const ux = position.getX(b) - position.getX(a), uy = position.getY(b) - position.getY(a), uz = position.getZ(b) - position.getZ(a);
      const vx = position.getX(c) - position.getX(a), vy = position.getY(c) - position.getY(a), vz = position.getZ(c) - position.getZ(a);
      // Degenerate slivers still count a little so a single-line lamp keeps a position.
      const weight = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2 + 1e-6;
      area += weight;
      x += weight * (position.getX(a) + position.getX(b) + position.getX(c)) / 3;
      y += weight * (position.getY(a) + position.getY(b) + position.getY(c)) / 3;
    }
    return { x: lateral(x / area, side, spec.track), y: y / area, z: edge };
  };
  const pair = (rear: boolean): [LampAnchor, LampAnchor] => {
    const left = anchor(rear, 1), right = anchor(rear, -1);
    const fallback = left ?? (right && { ...right, x: -right.x })
      ?? { x: .33 * spec.track, y: spec.wheel + .36, z: (rear ? -1 : 1) * spec.length / 2 };
    return [left ?? fallback, right ?? { ...fallback, x: -fallback.x }];
  };
  return { head: pair(false), tail: pair(true) };
}

export interface CarPose { x: number; y: number; z: number; yaw: number }
export interface WorldPoint { x: number; y: number; z: number }

/** World position of a model-space point on a car pose (yaw about +Y; +Z is forward). */
export function carPoint(pose: CarPose, local: LampAnchor, forward = 0, out: WorldPoint = { x: 0, y: 0, z: 0 }): WorldPoint {
  const sin = Math.sin(pose.yaw), cos = Math.cos(pose.yaw), z = local.z + forward;
  out.x = pose.x + local.x * cos + z * sin;
  out.y = pose.y + local.y;
  out.z = pose.z - local.x * sin + z * cos;
  return out;
}

/** Road decal sizes (metres). Beams start just under the bumper and fade out within 13 m. */
export const BEAM_LENGTH = 13, BEAM_WIDTH = 3.6, BEAM_TUCK = .15;
/** Rear glow: a small pool under each tail lamp reaching at most 1.4 m behind the bumper. */
export const REAR_POOL_LENGTH = 1.4, REAR_POOL_WIDTH = 1.3, REAR_POOL_TUCK = .1;
/** Decals sit just above the asphalt (markings are 5 mm proud); polygon offset handles the rest. */
export const DECAL_LIFT = .02;

/** Road-light levels: per beam (two overlap ahead of the car) and per rear pool (brighter braking). */
export function headlightPoolLevels(power: number, visible: boolean, braking: boolean, out = { head: 0, tail: 0 }) {
  const p = visible ? Math.max(0, Math.min(1, power)) : 0;
  out.head = .22 * p; out.tail = (braking ? .34 : .13) * p;
  return out;
}

/** Camera-facing glare at each lamp: world size and level (tail brighter while braking). */
export const HEAD_GLARE_SIZE = .7, TAIL_GLARE_SIZE = .42, BRAKE_GLARE_SIZE = .58;
export function lampGlareLevels(power: number, visible: boolean, braking: boolean, out = { head: 0, tail: 0, tailSize: TAIL_GLARE_SIZE }) {
  const p = visible ? Math.max(0, Math.min(1, power)) : 0;
  out.head = .95 * p; out.tail = (braking ? .85 : .42) * p; out.tailSize = braking ? BRAKE_GLARE_SIZE : TAIL_GLARE_SIZE;
  return out;
}

/** Real headlight spots: from the lamp pair's centre at lamp height, aimed 12 m down the car's centreline. */
export const SPOT_REACH = 12;
export const HEADLIGHT_SPOT = Object.freeze({ intensity: 60, distance: 24, angle: .3, penumbra: .7, decay: 1, color: '#fff1dc' });
export function headlightSpotAim(pose: CarPose, lamps: VehicleLampAnchors, roadTop: number) {
  const [left, right] = lamps.head;
  const centre = { x: 0, y: (left.y + right.y) / 2, z: Math.max(left.z, right.z) };
  const position = carPoint(pose, centre, .05);
  const aim = carPoint(pose, { x: 0, y: 0, z: centre.z + SPOT_REACH }, 0);
  aim.y = roadTop;
  return { position, aim };
}
