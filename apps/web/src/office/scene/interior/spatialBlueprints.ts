/**
 * Shared spatial blueprints for furniture whose visual transform must remain in
 * lockstep with semantic interaction resources. These are intentionally pure data
 * so scene components and resourceRegistry consume the same numbers.
 */

import { OFFICE_CHAIR_SEAT_BLUEPRINT } from "./furnitureSeatBlueprint";
import TEAM_POD_PROFILE from "./teamPodDesktopProfile.json";
import WORKSTATION_PROFILE from "./workstationAssetProfile.json";
import { monitorBankLayout } from "./prefabs/props/deviceGeometry";

export type XZ = readonly [number, number];

/** Library furniture and its standing interaction points share room-local coordinates. */
export const LIBRARY_BLUEPRINT = Object.freeze({
  roomCenter: [-15.65, 10.5] as XZ,
  roomSize: [8.8, 7.6] as const,
  shelves: [
    { position: [-3.9, 0, -2.1] as const, rotationY: Math.PI / 2, width: 2.7 },
    { position: [-3.9, 0, 1.2] as const, rotationY: Math.PI / 2, width: 2.7 },
    { position: [3.9, 0, -1.7] as const, rotationY: -Math.PI / 2, width: 2.7 }
  ] as const,
  /** Front-of-shelf points are ordered as two stops at each of three bookcases. */
  shelfTargets: [
    { id: "library.shelf-1", position: [-2.9, -2.7] as XZ, rotationY: -Math.PI / 2 },
    { id: "library.shelf-2", position: [-2.9, -1.5] as XZ, rotationY: -Math.PI / 2 },
    { id: "library.shelf-3", position: [-2.9, 0.6] as XZ, rotationY: -Math.PI / 2 },
    { id: "library.shelf-4", position: [-2.9, 1.8] as XZ, rotationY: -Math.PI / 2 },
    { id: "library.shelf-5", position: [2.9, -2.3] as XZ, rotationY: Math.PI / 2 },
    { id: "library.shelf-6", position: [2.9, -1.1] as XZ, rotationY: Math.PI / 2 }
  ] as const,
  deskPosition: [-0.4, 0, -0.2] as const,
  sofaPosition: [1.95, 0, 2.4] as const,
  sofaRotationY: Math.PI,
  rugPosition: [1.2, 0, 2.0] as const,
  coffeeTablePosition: [0, 0, 1.95] as const,
  plantPosition: [3.4, 0, 2.8] as const,
  lampPosition: [1.2, 0, -3.0] as const
});

/** Server room furniture and rack inspection targets share this room-local layout. */
export const SERVER_ROOM_BLUEPRINT = Object.freeze({
  roomCenter: [-8.2, 10.5] as XZ,
  roomSize: [8.2, 7.6] as const,
  deskPosition: [1.65, 0, 0.4] as const,
  /** Cabinet floor is 0.09 m above the slab, matching the raised access tiles. */
  rackPositions: [
    [-2.6, 0, -0.9],
    [-2.6, 0, 0.3],
    [-2.6, 0, 1.5]
  ] as const,
  rackRotationY: Math.PI / 2,
  /** Clear points in front of each rack door; avatars stand in front and face West towards the rack. */
  rackInspectionPoints: [
    [-1.15, -0.9],
    [-1.15, 0.3],
    [-1.15, 1.5]
  ] as const
});

/**
 * Geometry and seat placement shared by rendered single desks and the semantic
 * workstation resources. Child coordinates are local to the desk root.
 */
export const SINGLE_WORKSTATION_BLUEPRINT = Object.freeze({
  topSize: [WORKSTATION_PROFILE.desk.width, WORKSTATION_PROFILE.desk.thickness, WORKSTATION_PROFILE.desk.depth] as const,
  topY: WORKSTATION_PROFILE.desk.top - WORKSTATION_PROFILE.desk.thickness / 2,
  /** Keep a palm-rest strip before the keyboard without extending the arm target. */
  keyboardZ: 0.22,
  legXs: [-0.66, 0.66] as const,
  legSize: [0.06, 0.72, 0.58] as const,
  legY: 0.38,
  /** Close enough that a seated person's hands rest on the keyboard (forearms level, elbows bent). */
  chairPosition: [0, 0, 0.64] as const,
  chairRotationY: Math.PI,
  seatHeight: OFFICE_CHAIR_SEAT_BLUEPRINT.cushionHeight,
  /** Avatar root remains at z=0.62; the chair itself sits directly beneath it. */
  seatForward: OFFICE_CHAIR_SEAT_BLUEPRINT.rootForward,
  approachDistance: 1.2
});

/** CEO room shell, desk root, and guest seat anchors share these transforms. */
export const EXECUTIVE_OFFICE_BLUEPRINT = Object.freeze({
  roomCenter: [-13, -9.5] as XZ,
  roomSize: [18, 9.2] as const,
  workstationLocal: [-4.4, 0, 0] as const,
  workstationRotationY: Math.PI / 2,
  leaderSeat: { position: [0.25, 0, -0.85] as const, rotationY: 0 },
  guestSeats: [
    { id: "executive.guest-1", position: [-0.45, 0, 1.0] as const, rotationY: Math.PI },
    { id: "executive.guest-2", position: [1.15, 0, 1.0] as const, rotationY: Math.PI }
  ]
});

/** Lobby reception geometry and avatar seat stay aligned to the shared lobby origin. */
export const RECEPTION_DESK_BLUEPRINT = Object.freeze({
  worldPosition: [0, -8.15] as XZ,
  rotationY: 0,
  staffOffsetX: -0.95,
  chairOffsetZ: -0.7,
  counterOffsetZ: -1.95,
  featureWallOffsetZ: 0.3,
  approachOffset: [-2.35, -0.25] as XZ,
  /** Twin displays, centred on the chair (the counter is rendered inside the chair's staffOffsetX group); Z relative to the counter. */
  monitorOffsetsX: monitorBankLayout(2, .50).map(display => display.position[0]),
  monitorOffsetZ: 0.54,
  /** Counter-local shelf, behind the solid transaction body (rear edge z=.38). */
  workShelfCenter: [0.1, 0.74, 0.71] as const,
  workShelfSize: [2, 0.04, 0.64] as const
});

/** Executive studio on Floor 3 (South Wing Penthouse Suite); all poses are room-local. */
export const EXECUTIVE_STUDIO_BLUEPRINT = Object.freeze({
  roomCenter: [-10.0, 8.45] as XZ,
  roomSize: [18.0, 9.3] as const,
  deskLocal: [-4.4, 0, 0] as const,
  workstationRotationY: Math.PI / 2,
  leaderSeat: { position: [0.25, 0, -0.85] as const, rotationY: 0 },
  guestSeats: [
    { id: "executive-studio.guest-1", position: [-0.45, 0, 1.0] as const, rotationY: Math.PI },
    { id: "executive-studio.guest-2", position: [1.15, 0, 1.0] as const, rotationY: Math.PI }
  ]
});

/** Fitness equipment and usable targets share room-local coordinates; centre aisle is 3.2 m clear. */
export const FITNESS_BLUEPRINT = Object.freeze({
  roomCenter: [9, 8.45] as XZ,
  roomSize: [20, 7.3] as const,
  mainAisleWidth: 3.2,
  treadmills: [
    { id: "fitness.treadmill-1", position: [-8.3, 0, 1.3] as const, rotationY: 0 },
    { id: "fitness.treadmill-2", position: [-5.9, 0, 1.3] as const, rotationY: 0 }
  ],
  treadmillTarget: [0, 0.35] as XZ,
  treadmillDeckHeight: 0.128,
  matSurfaceHeight: 0.12,
  bikes: [
    { id: "fitness.bike-1", position: [-8.3, 0, -1.3] as const, rotationY: Math.PI },
    { id: "fitness.bike-2", position: [-5.9, 0, -1.3] as const, rotationY: Math.PI }
  ],
  bikeSeat: [0, 0.28] as XZ,
  bikeSeatHeight: 0.88,
  bikeStagingOffset: [1.1, 0] as XZ,
  dumbbellRack: { id: "fitness.dumbbell-rack", position: [7, 0, -2.85] as const,
    rotationY: 0, width: 3.4, target: [7, -1.45] as XZ },
  yogaMats: [
    { id: "fitness.yoga-mat-1", position: [3.1, 0, 1.75] as const, color: "#6d8e81" },
    { id: "fitness.yoga-mat-2", position: [5.7, 0, 1.75] as const, color: "#799aaa" },
    { id: "fitness.yoga-mat-3", position: [8.3, 0, 1.75] as const, color: "#baa784" }
  ],
  weightBench: { id: "fitness.weight-bench", position: [-3.1, 0, 1.2] as const, rotationY: 0 },
  cableRow: { id: "fitness.cable-row", position: [3.1, 0, -1.4] as const, rotationY: 0 },
  strengthSeatHeight: 0.55,
  strengthSeat: [0, 0] as XZ,
  strengthStagingOffset: [1.1, 0] as XZ,
  cableHandle: [0, 0.94, 0.45] as const,
  freeweights: { id: "fitness.freeweights", target: [9, -0.45] as XZ, rotationY: Math.PI },
  storagePosition: [-3.1, 0, -2.95] as const
});

/** Parent transform for the large Floor 1 team workspace RoomShell/group. */
export const TEAM_WORKSPACE_ORIGIN: XZ = [-6.0, -1.2];

/** Touchdown desks are authored in TEAM_WORKSPACE_ORIGIN-local XZ coordinates. */
export const TEAM_WORKSPACE_TOUCHDOWNS = Object.freeze([
  {
    id: "engineering.touchdown-1",
    location: "floor-1.team-workspace.touchdown-1",
    position: [12.5, 9.3] as XZ,
    rotationY: Math.PI
  },
  {
    id: "engineering.touchdown-2",
    location: "floor-1.team-workspace.touchdown-2",
    position: [12.5, -9.3] as XZ,
    rotationY: 0
  }
]);

/** Shared geometry/interaction coordinates for the four pods on Floor 1. */
export const TEAM_POD_LAYOUT = Object.freeze([
  { id: "pod-a", position: [-5.1, -4.4] as XZ, rotationY: 0 },
  { id: "pod-b", position: [5.1, -4.4] as XZ, rotationY: 0 },
  { id: "pod-c", position: [-5.1, 4.4] as XZ, rotationY: 0 },
  { id: "pod-d", position: [5.1, 4.4] as XZ, rotationY: 0 }
]);

/** Breakout furniture stays at the perimeter, clear of the pod and doorway aisles. */
export const TEAM_WORKSPACE_LOUNGES = Object.freeze({
  westSofa: { position: [-13.0, 0, 4.5] as const, rotationY: Math.PI / 2 },
  westChair: { position: [-10.6, 0, 2.5] as const, rotationY: -Math.PI / 2 },
  eastChairs: [
    { id: "engineering.lounge-1", position: [10.6, 0, 5.7] as const, rotationY: Math.PI / 2 },
    { id: "engineering.lounge-2", position: [13.4, 0, 5.7] as const, rotationY: -Math.PI / 2 }
  ] as const
});

/** Lounge furniture is authored relative to BARTENDER_BAR_BLUEPRINT.loungeOrigin. */
export const LOUNGE_FURNITURE_BLUEPRINT = Object.freeze({
  readingOrigin: [-3.0, 0, 3.8] as const,
  sofa: { position: [-1.45, 0, 0] as const, rotationY: Math.PI / 2 },
  armchairs: [
    { id: "lounge.armchair-1", position: [1.35, 0, -0.9] as const, rotationY: -Math.PI / 2 },
    { id: "lounge.armchair-2", position: [1.35, 0, 0.9] as const, rotationY: -Math.PI / 2 }
  ] as const,
  coffeeTable: { position: [0.05, 0, 0] as const, rotationY: Math.PI / 2 },
  readingLamp: [-1.45, 0, -1.45] as const,
  readingPlant: [-1.45, 0, 1.45] as const,
  // Keep the middle of the east frontage clear for both elevator doors and queues.
  diningTable: [3.8, 0.52, 6.5] as const,
  // Leave a standing/turning lane between the table and fixed chair fronts.
  diningChairs: [
    [2.1, 0, 8.3], [3.8, 0, 8.3], [5.5, 0, 8.3]
  ] as const,
  westCornerLamp: [-6.35, 0, 8.8] as const,
  diningCornerLamp: [6.35, 0, 8.8] as const
});

export const TEAM_POD_STATIONS = Object.freeze([
  { id: "seat-se", rotationY: 0, variant: "dual-monitor" as const },
  { id: "seat-sw", rotationY: Math.PI / 2, variant: "all-in-one" as const },
  { id: "seat-nw", rotationY: Math.PI, variant: "monitor-laptop" as const },
  { id: "seat-ne", rotationY: -Math.PI / 2, variant: "laptop" as const }
]);

export const TEAM_POD_SEAT = Object.freeze({
  /** One centred external keyboard for every device variant, in station-local metres. */
  keyboardPosition: [1.005 - TEAM_POD_PROFILE.seatInset / Math.SQRT2, 0.82, 1.005 - TEAM_POD_PROFILE.seatInset / Math.SQRT2] as const,
  // Move sitter and inputs inward together for the deeper bay, preserving their reach distance.
  chairPosition: [
    1.4 - (0.16 + TEAM_POD_PROFILE.seatInset - OFFICE_CHAIR_SEAT_BLUEPRINT.rootForward) / Math.SQRT2,
    1.4 - (0.16 + TEAM_POD_PROFILE.seatInset - OFFICE_CHAIR_SEAT_BLUEPRINT.rootForward) / Math.SQRT2
  ] as XZ,
  chairRotationY: -3 * Math.PI / 4,
  seatForward: OFFICE_CHAIR_SEAT_BLUEPRINT.rootForward,
  /** Keep the existing aisle waiting points while the seat moves into its deeper bay. */
  stagingSetback: TEAM_POD_PROFILE.seatInset,
  monitorTargets: [
    [0.32, 1.24, 0.72], [0.72, 1.24, 0.32]
  ] as readonly (readonly [number, number, number])[]
});

/**
 * Rendered bar geometry and semantic interaction anchors share these transforms.
 *
 * The bar lives in the F1 under-stair alcove: beneath the raised intermediate
 * landing (y 3.2, world z -8.85..-6.25, x 18.6..25). Root world position is
 * relocate(lounge, loungeOrigin) + rootPosition = [21.2, 0, -7.5], biased west
 * so an east-side walking lane stays open under the landing (x 19.0..23.4 bar
 * span). The back bar/shelving back panel (top 2.95 m) stays south
 * of the west flight underside (z > -8.85) and under the landing soffit
 * (~3.03 m), the counter fills the landing's south edge, and the stools face
 * north into the alcove from the open lounge. This leaves the lounge centre clear.
 */
export const BARTENDER_BAR_BLUEPRINT = Object.freeze({
  loungeOrigin: [14.2, -0.9] as XZ,
  rootPosition: [3.2, 0, -6.3] as const,
  rotationY: 0,
  /** Back bar, shelving and bottle display; compact depth fits under the landing. */
  backBar: { position: [0, 0, -1.0] as const },
  /** Hanging stemware rack; rods terminate at the landing soffit. */
  stemwareRack: { position: [0, 2.65, 0.1] as const },
  frontCounter: {
    position: [0, 0, 0.78] as const,
    bodyPosition: [0, 0.55, 0] as const,
    bodySize: [4.2, 1.1, 0.7] as const,
    /** Top footprint drives the rendered countertop bounds. */
    footprint: { center: [0, 0.02] as XZ, size: [4.4, 0.9] as const },
    countertopY: 1.12,
    countertopThickness: 0.06
  },
  stools: [
    { resourceId: "lounge.barstool-1", position: [-1.4, 0, 1.55] as const, rotationY: Math.PI, cushionColor: "#cf8e59" },
    { resourceId: "lounge.barstool-2", position: [-0.5, 0, 1.55] as const, rotationY: Math.PI, cushionColor: "#527874" },
    { resourceId: "lounge.barstool-3", position: [0.5, 0, 1.55] as const, rotationY: Math.PI, cushionColor: "#cf8e59" },
    { resourceId: "lounge.barstool-4", position: [1.4, 0, 1.55] as const, rotationY: Math.PI, cushionColor: "#527874" }
  ],
  /** Clear standing point between the back counter and guest-facing counter. */
  serviceTarget: { position: [0, 0, -0.2] as const, rotationY: 0 }
});

export const MEETING_BLUEPRINTS = Object.freeze({
  "meeting-a": {
    roomCenter: [-3.25, -0.8] as XZ,
    furnitureLocal: [0.55, 0.25] as XZ,
    seats: 10,
    tableLength: 8,
    tableWidth: 2.2,
    large: true,
    presentationWall: { position: [-7.92, 1.35, -0.25] as const, size: [0.12, 2.7, 13.65] as const },
    screen: { position: [-7.845, 1.82, -0.62] as const, rotationY: Math.PI / 2, width: 3.25, height: 1.82 },
    whiteboard: { position: [-7.843, 1.65, 2.05] as const, rotationY: Math.PI / 2, width: 1.55 },
    interactionTargets: {
      // Keep the speaker stand south of the table end chair so its approach
      // pocket remains clear of both the chair back and the presentation wall.
      presenter: { position: [-6.35, 0, 2.7] as const, rotationY: -Math.PI / 2 },
      display: { position: [-7.05, 0, -0.62] as const, rotationY: -Math.PI / 2 }
    }
  },
  "meeting-b": {
    roomCenter: [11.75, 8.2] as XZ,
    furnitureLocal: [0.55, 0.25] as XZ,
    seats: 14,
    tableLength: 10,
    tableWidth: 2.2,
    large: true,
    presentationWall: { position: [-7.92, 1.35, -0.25] as const, size: [0.12, 2.7, 13.65] as const },
    screen: { position: [-7.845, 1.82, -0.62] as const, rotationY: Math.PI / 2, width: 3.25, height: 1.82 },
    whiteboard: { position: [-7.843, 1.65, 2.05] as const, rotationY: Math.PI / 2, width: 1.55 },
    interactionTargets: {
      presenter: { position: [-6.35, 0, 2.7] as const, rotationY: -Math.PI / 2 },
      display: { position: [-7.05, 0, -0.62] as const, rotationY: -Math.PI / 2 }
    }
  }
});

export type MeetingRoomBlueprint = (typeof MEETING_BLUEPRINTS)[keyof typeof MEETING_BLUEPRINTS];

/** Named positions are local to MeetingRoomFurniture and are not allocatable seats. */
export const MEETING_INTERACTION_TARGETS = Object.freeze({
  "meeting-a": MEETING_BLUEPRINTS["meeting-a"].interactionTargets,
  "meeting-b": MEETING_BLUEPRINTS["meeting-b"].interactionTargets
});

/** Seat centers are local to MeetingRoomFurniture; +Z is the entrance-side axis. */
export function meetingSeatLayout(seats: number, tableLength: number, tableWidth = 1.65) {
  const perSide = Math.max(2, Math.ceil((seats - 2) / 2));
  const sideXs = Array.from({ length: perSide }).map((_, i) =>
    -tableLength / 2 + 0.8 + (i * (tableLength - 1.6)) / Math.max(1, perSide - 1)
  );
  return [
    ...sideXs.flatMap((x) => [
      { position: [x, 0, tableWidth / 2 + 0.725] as [number, number, number], rotationY: Math.PI },
      { position: [x, 0, -tableWidth / 2 - 0.725] as [number, number, number], rotationY: 0 }
    ]),
    { position: [-tableLength / 2 - 0.75, 0, 0] as [number, number, number], rotationY: Math.PI / 2 },
    { position: [tableLength / 2 + 0.75, 0, 0] as [number, number, number], rotationY: -Math.PI / 2 }
  ];
}

/** Rendered campus furniture and its usable poses share world coordinates. */
// Exterior rendering and resource contacts consume one campus contract.
export { OUTDOOR_FACILITIES_BLUEPRINT, outdoorRoomForLocation } from "../spatialBlueprints";
