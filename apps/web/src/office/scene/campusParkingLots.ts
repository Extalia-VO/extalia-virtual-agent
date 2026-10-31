import LAYOUT from './campusParkingLots.json';

/**
 * Shared campus parking contract for both lots. The data is generated from the layout markers of
 * `tooling/blender/create-campus-parking.py` (Blender empties → `campus-parking.layout.json` →
 * `prepare-public-models.py` → `campusParkingLots.json`); the same script draws the east lot and
 * both access connectors in `landscape/campus-parking.glb`, so bays, aisles and entries match the
 * drawn surface exactly. Coordinates are app metres (x east, z south, y up).
 */
export interface ParkingLot {
  id: 'west' | 'east';
  bays: { id: string; x: number; z: number; yaw: number; ev: boolean }[];
  /** Centreline polyline from the entrance throat to the far end, road-level y. */
  aisle: [number, number][];
  /** Where cars leave/join a traffic lane (`from`, on the lane centre) and the lot mouth (`throat`). */
  entry: { from: [number, number]; throat: [number, number] };
  /** Surface y. */
  top: number;
  /** The TRAFFIC_LANES id cars join/leave. */
  laneId: string;
}
export type ParkingLotId = ParkingLot['id'];
export interface ParkingLotLamp { id: string; x: number; z: number; poolX: number }
export interface ParkingLotCharger { id: string; x: number; z: number; yaw: number }

interface LayoutLot extends Omit<ParkingLot, 'id'> { id: string; lamps: ParkingLotLamp[]; chargers: ParkingLotCharger[] }
const lots = LAYOUT.lots as unknown as LayoutLot[];
/** Blender stores yaw to six decimals; quarter turns snap back to exact multiples of π/2. */
const snapYaw = (yaw: number) => {
  const quarter = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
  return Math.abs(yaw - quarter) < 1e-5 ? quarter : yaw;
};
const freeze = <T>(value: T): T => Object.freeze(value);

export const PARKING_LOTS: readonly ParkingLot[] = freeze(lots.map(lot => freeze({
  id: lot.id as ParkingLotId,
  bays: freeze(lot.bays.map(({ id, x, z, yaw, ev }) => freeze({ id, x, z, yaw: snapYaw(yaw), ev }))) as ParkingLot['bays'],
  aisle: freeze(lot.aisle.map(([x, z]) => freeze([x, z] as [number, number]))) as ParkingLot['aisle'],
  entry: freeze({ from: freeze([...lot.entry.from] as [number, number]), throat: freeze([...lot.entry.throat] as [number, number]) }),
  top: lot.top,
  laneId: lot.laneId,
})));
export function parkingLot(id: ParkingLotId): ParkingLot {
  const lot = PARKING_LOTS.find(entry => entry.id === id);
  if (!lot) throw new Error(`Unknown parking lot: ${id}`);
  return lot;
}

/** Lamp posts per lot (the runtime draws them with the shared walk-lamp batch and baked pools). */
export const PARKING_LOT_LAMPS: Readonly<Record<ParkingLotId, readonly ParkingLotLamp[]>> = freeze(Object.fromEntries(
  lots.map(lot => [lot.id, freeze(lot.lamps.map(lamp => freeze({ ...lamp })))])) as unknown as Record<ParkingLotId, readonly ParkingLotLamp[]>);
/** One mobility charger at the head of every EV bay. */
export const PARKING_LOT_CHARGERS: Readonly<Record<ParkingLotId, readonly ParkingLotCharger[]>> = freeze(Object.fromEntries(
  lots.map(lot => [lot.id, freeze(lot.chargers.map(charger => freeze({ ...charger, yaw: snapYaw(charger.yaw) })))])) as unknown as Record<ParkingLotId, readonly ParkingLotCharger[]>);

/**
 * The access connector both lots share (mirrored): a level throat at the lot top, an eased ramp
 * (smoothstep) cut into the plinth down to the avenue footway level, then a 1% crossfall over the
 * footway band (dropped-kerb crossing) to the carriageway edge. `|x|` measures along the access.
 */
export const PARKING_ACCESS = freeze({ ...LAYOUT.access });
/** Triangle budget of the Blender-authored parking GLB (east lot and both connectors). */
export const PARKING_GLB_TRIANGLES: number = LAYOUT.glb.triangles;

const smoothstep = (t: number) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };
/** Surface y of the drawn access at `|x|` (level throat, ramp, crossing, road); identical to the Blender profile. */
export function accessSurfaceY(x: number): number {
  const u = Math.abs(x), { throat, bandStart, roadEdge, top, walkTop, roadTop } = PARKING_ACCESS;
  if (u <= throat) return top;
  if (u <= bandStart) return top + (walkTop - top) * smoothstep((u - throat) / (bandStart - throat));
  if (u <= roadEdge) return walkTop + (roadTop - walkTop) * (u - bandStart) / (roadEdge - bandStart);
  return roadTop;
}
/**
 * Drivable surface y at (x, z) for a car of `lot`: the lot top inside the lot, the access profile in
 * the access corridor between the throat and the road edge, the road top beyond it.
 */
export function parkingSurfaceY(lot: Pick<ParkingLot, 'entry' | 'top'>, x: number, z: number): number {
  const [tx, tz] = lot.entry.throat;
  const outward = Math.sign(lot.entry.from[0] - tx) * (x - tx);
  if (outward <= 0 || Math.abs(z - tz) > PARKING_ACCESS.halfWidth + PARKING_ACCESS.returnRadius) return lot.top;
  return accessSurfaceY(x);
}

export interface PlanRect { x0: number; x1: number; z0: number; z1: number }
/**
 * Plinth cut-outs for both access ramps (carriageway plus retaining walls), from the throat to the
 * plinth edge: the campus plinth and turf leave these open so the ramp can descend below them.
 */
export const PARKING_ACCESS_NOTCHES: readonly PlanRect[] = freeze(PARKING_LOTS.map(lot => {
  const { halfWidth, wall, throat, plinthEdge } = PARKING_ACCESS, side = Math.sign(lot.entry.throat[0]), z = lot.entry.throat[1];
  return freeze({ x0: side < 0 ? -plinthEdge : throat, x1: side < 0 ? -throat : plinthEdge, z0: z - halfWidth - wall, z1: z + halfWidth + wall });
}));
/**
 * Keep-out footprints for landscape planting and turf detail: each lot's paved court, footway and
 * planting bed plus its access apron and ramp.
 */
export const PARKING_FOOTPRINTS: Readonly<Record<ParkingLotId, readonly PlanRect[]>> = freeze({
  west: freeze([{ x0: -51.5, x1: -33.5, z0: -15, z1: 20 }, { x0: -45.5, x1: -39.3, z0: -31.8, z1: -12 }, { x0: -52, x1: -39.3, z0: -31.8, z1: -25.2 }]),
  east: freeze([{ x0: 37.4, x1: 52, z0: -31.8, z1: 27 }]),
});
export function insideParkingFootprint(x: number, z: number, radius = 0): boolean {
  return Object.values(PARKING_FOOTPRINTS).some(rects => rects.some(rect =>
    x + radius > rect.x0 && x - radius < rect.x1 && z + radius > rect.z0 && z - radius < rect.z1));
}

/** `outer` minus axis-aligned `holes`, as disjoint rectangles (x strips split along z). */
export function rectsWithout(outer: PlanRect, holes: readonly PlanRect[]): PlanRect[] {
  const xs = [...new Set([outer.x0, outer.x1, ...holes.flatMap(hole => [hole.x0, hole.x1])])]
    .filter(x => x >= outer.x0 && x <= outer.x1).sort((a, b) => a - b);
  const out: PlanRect[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const x0 = xs[i]!, x1 = xs[i + 1]!, mid = (x0 + x1) / 2;
    const cuts = holes.filter(hole => hole.x0 < mid && hole.x1 > mid).map(hole => [Math.max(outer.z0, hole.z0), Math.min(outer.z1, hole.z1)] as const)
      .sort((a, b) => a[0] - b[0]);
    let z = outer.z0;
    for (const [a, b] of cuts) { if (a > z) out.push({ x0, x1, z0: z, z1: a }); z = Math.max(z, b); }
    if (z < outer.z1) out.push({ x0, x1, z0: z, z1: outer.z1 });
  }
  return out;
}
