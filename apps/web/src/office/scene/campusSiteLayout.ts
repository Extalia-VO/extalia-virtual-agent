import { CAMPUS_ENTRY_LAYOUT, CAMPUS_FRONT_APPROACH } from "./layout";

/** One frontage axis shared with the neighborhood road and entrance landscaping. */
export const FRONT_APPROACH = Object.freeze({
  x: CAMPUS_ENTRY_LAYOUT.centerX,
  ...CAMPUS_FRONT_APPROACH,
  roadCenterZ: -60,
  roadWidth: 7,
});
