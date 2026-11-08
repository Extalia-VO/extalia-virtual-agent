import catalog from '../campusGreenery.json';

/** Finished sizes include foliage, rather than scaling differently shaped pots by height alone. */
export const PLANTER_BOUNDS = Object.freeze({
  floor: { height: .95, width: .65 },
  sculptural: { height: 1.08, width: .72 },
  desk: { height: .24, width: .20 },
});
type PlanterRole = keyof typeof PLANTER_BOUNDS;
const dimensions = new Map(catalog.greenery.filter(entry => entry.kind === 'plant').map(entry => [entry.id, entry]));
// Twice the furthest X/Z distance from the shipped GLBs' pot origins, rounded upward to 1 mm.
// Their pot origins are base-centred, while catalog widths describe rounded AABB extents.
// Using the origin-centred diameter keeps a lopsided crown inside a centred placement slot.
const ORIGIN_DIAMETERS: Readonly<Record<string, number>> = {
  'plant-marble-pot': .567,
  'plant-round-pot': .584,
  'plant-aloe-double': .511,
};

/** An origin-centred circular envelope stays inside the allotted space at every rotation. */
export function planterModelHeight(id: string | undefined, role: PlanterRole, _yaw = 0): number {
  const bounds = PLANTER_BOUNDS[role], model = id ? dimensions.get(id) : undefined;
  if (!model) return bounds.height;
  const width = Math.max(model.width, ORIGIN_DIAMETERS[model.id] ?? model.width);
  return Math.min(bounds.height, bounds.width * model.height / width);
}

/** Existing room accents may vary modestly; terrace props cannot turn into oversized shrubs. */
export function floorPlanterScale(requested: number): number {
  return Number.isFinite(requested) ? Math.max(0, Math.min(1.12, requested)) : 1;
}
