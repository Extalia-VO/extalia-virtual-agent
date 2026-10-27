import { CAMPUS_ENTRY_LAYOUT, CAMPUS_FRONT_APPROACH, OFFICE_BUILDING } from "../../layout";

/**
 * World placement of the exterior brand signage (the door lintel lockup and
 * the forecourt board). Kept free of three.js so the clearance rules can be tested.
 *
 * The facade envelope scales the 42 x 30 m authored office by these factors; the
 * numbers below are the resulting world-space faces the signage mounts against.
 */
const DEPTH_SCALE = OFFICE_BUILDING.depth / 30;

/** Canopy front fascia (dark band at the leading edge of the suspended entrance canopy). */
const CANOPY_FASCIA_FRONT_Z = -17.91 * DEPTH_SCALE - 0.06 * DEPTH_SCALE;
const CANOPY_FASCIA_Y = 3.98;

export const EXTALIA_SIGNAGE_LAYOUT = Object.freeze({
  /** Name above the door, on the canopy fascia. */
  lintel: Object.freeze({
    x: CAMPUS_ENTRY_LAYOUT.centerX,
    y: CANOPY_FASCIA_Y,
    frontZ: CANOPY_FASCIA_FRONT_Z,
    size: 0.38,
    depth: 0.05
  }),
  /** Free-standing front board on the lawn beside the arrival walkway. */
  board: Object.freeze({
    x: -8,
    z: -39,
    /** Lawn level at the front of the campus. */
    groundY: -0.24,
    /** Optional turn towards the walkway; 0 keeps the face square to the road so the default camera reads it near head-on. */
    yawTowardsPath: 0,
    /** Footprint of the stone foot, axis aligned in the sign's own frame. */
    footprint: [6, 1.8] as const,
    face: [5.4, 2] as const,
    wordSize: 0.72
  })
});

/**
 * Approach corridor kept free of collidable meshes (see CampusExterior's navigation
 * clearance invariant): the walkway plus a margin for its lamps and bollards.
 */
export const APPROACH_CLEARANCE_X = CAMPUS_FRONT_APPROACH.width / 2 + 0.6;

/** World-space x extent of the board's stone foot, including its yaw. */
export function boardFootprintX(): [number, number] {
  const { x, yawTowardsPath, footprint } = EXTALIA_SIGNAGE_LAYOUT.board;
  const reach = Math.abs(Math.cos(yawTowardsPath)) * footprint[0] / 2 + Math.abs(Math.sin(yawTowardsPath)) * footprint[1] / 2;
  return [x - reach, x + reach];
}
