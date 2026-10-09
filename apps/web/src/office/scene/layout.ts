export type Point3 = [number, number, number];
export const FLOOR_HEIGHT = 6.4;
export const OFFICE_BUILDING = Object.freeze({ west: -21, east: 25, north: -19, south: 19, width: 46, depth: 38, centerX: 2 });
export const CAMPUS_FRONT_APPROACH = Object.freeze({ width: 6.4, plazaFrontZ: OFFICE_BUILDING.north - 10.6,
  rampStartZ: -47, roadEdgeZ: -56.5, roadTop: -0.69 });

/**
 * One source of truth for the rendered switchback stair and its semantic route.
 * OfficeScene and the navigation planner both consume these dimensions.
 */
export const OFFICE_STAIRCASE = Object.freeze({
  /** Fill the east stair bay while preserving the 3.6 m corridor to its west. */
  x: 21.8,
  /** Front stair bay leaves the central east facade clear for the elevator pair. */
  z: -11.5,
  width: 2.95,
  rise: FLOOR_HEIGHT,
  runPerFlight: 5.3,
  stepsPerFlight: 18,
  gap: 0.36,
  landingDepth: 2.4,
  /** A wider intermediate landing acts as a true passing bay for opposite traffic. */
  midLandingDepth: 2.6,
  /** Directional lanes provide 1.36 m between opposing avatar centres. */
  laneOffset: 0.68,
  /** The mid-landing is a passing bay: UP and DOWN cross on separate Z lanes. */
  midLandingUpOffset: 0.65,
  midLandingDownOffset: 1.95
});

/** Common envelope, floor opening and arrival bridge on every office level. */
export const OFFICE_STAIR_LAYOUT = Object.freeze({
  westEdge: 18.6,
  eastEdge: OFFICE_BUILDING.east,
  floorWestEdge: OFFICE_BUILDING.west,
  floorNorthEdge: OFFICE_BUILDING.north,
  floorSouthEdge: OFFICE_BUILDING.south,
  northFlightZ: OFFICE_STAIRCASE.z - OFFICE_STAIRCASE.runPerFlight / 2,
  southFlightZ: OFFICE_STAIRCASE.z + OFFICE_STAIRCASE.runPerFlight / 2,
  midLandingSouthZ: OFFICE_STAIRCASE.z + OFFICE_STAIRCASE.runPerFlight / 2 + OFFICE_STAIRCASE.midLandingDepth,
  bridgeNorthZ: OFFICE_BUILDING.north,
  bridgeSouthZ: OFFICE_STAIRCASE.z - OFFICE_STAIRCASE.runPerFlight / 2,
  bridgeWestEdge: 18.2,
  /** Upper slabs end at the rear intermediate-landing edge, never above its walking surface. */
  voidSouthZ: OFFICE_STAIRCASE.z + OFFICE_STAIRCASE.runPerFlight / 2 + OFFICE_STAIRCASE.midLandingDepth,
  floorConnectionX: 17.9,
  padOverhang: 0.07,
  guardInset: 0.035,
  landingLaneInset: 0.68,
  corridorX: 16.8
});

/** Shared physical entrance layout for the campus envelope, lobby door, and arrival route. */
export const CAMPUS_ENTRY_LAYOUT = Object.freeze({
  centerX: 0,
  shellFrontZ: OFFICE_BUILDING.north - 0.055,
  shellOpeningWidth: 3.2,
  lobbyDoorZ: OFFICE_BUILDING.north,
  lobbyDoorWidth: 2.4,
  thresholdZ: OFFICE_BUILDING.north - 0.35,
  insideZ: OFFICE_BUILDING.north + 0.9,
  roadSpawnZ: CAMPUS_FRONT_APPROACH.roadEdgeZ
});

