/** Characters, furniture feet, door thresholds and route points share this finished-floor datum. */
export const FINISHED_FLOOR_Y = 0;
/** Keep the original slab underside/ceiling line while reserving space for the finish above it. */
export const FLOOR_FINISH_DEPTH = 0.08;
export const FLOOR_STRUCTURE_DEPTH = 0.32;
export const FLOOR_SLAB_THICKNESS = FLOOR_STRUCTURE_DEPTH - FLOOR_FINISH_DEPTH;
export const FLOOR_SLAB_CENTER_Y = -(FLOOR_STRUCTURE_DEPTH + FLOOR_FINISH_DEPTH) / 2;
/** The general underlayer sits just below room/corridor finishes, avoiding coplanar surfaces. */
export const FLOOR_UNDERLAY_TOP_Y = -0.002;
