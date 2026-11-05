/** Finite backdrop shared by the skyline mesh and the Building camera's outward zoom limit. */
export const CITY_GROUND = Object.freeze({ radius: 250, y: -0.8, segments: 72 });
/**
 * Skyline street grid (CampusSkyline): 7 m streets every 24 m, offset 12 m from the origin, laid on
 * the city ground. Streets stop at `clear` (the campus, neighborhood and civic park); outside it they
 * continue the neighborhood's ring and cross streets, so district traffic can leave and enter there.
 */
export const CITY_STREETS = Object.freeze({
  block: 24, width: 7, offset: 12, y: CITY_GROUND.y + 0.02, height: 0.03,
  clear: Object.freeze({ minX: -106, maxX: 106, minZ: -144, maxZ: 126 }),
});
/** Asphalt top of a skyline street. */
export const CITY_STREET_TOP = CITY_STREETS.y + CITY_STREETS.height / 2;
