import { relocateRoomPoint } from "./roomRelocation";
import type { Point3 } from "../layout";
type HumanoidSeatPoseProfile = "MEETING_UPRIGHT" | "OFFICE_UPRIGHT" | "SOFA_RELAXED" | "ARMCHAIR_RELAXED" | "BAR_STOOL";
import type { CampusFloor } from "./worldRegistry";
import { BARTENDER_BAR_BLUEPRINT, LIBRARY_BLUEPRINT, LOUNGE_FURNITURE_BLUEPRINT, MEETING_BLUEPRINTS, MEETING_INTERACTION_TARGETS, RECEPTION_DESK_BLUEPRINT, SERVER_ROOM_BLUEPRINT, SINGLE_WORKSTATION_BLUEPRINT, TEAM_POD_LAYOUT, TEAM_POD_SEAT, TEAM_POD_STATIONS, TEAM_WORKSPACE_ORIGIN, TEAM_WORKSPACE_TOUCHDOWNS, TEAM_WORKSPACE_LOUNGES, meetingSeatLayout } from "./spatialBlueprints";
import { ARMCHAIR_SEAT_BLUEPRINT, SOFA_SEAT_BLUEPRINT } from "./furnitureSeatBlueprint";
import { F3_TERRACE } from "./floor1Layout";
import { EXECUTIVE_ROOM_LAYOUTS, MEETING_ROOM_LAYOUTS, type ExecutiveRoomId } from "./roomRedesignLayout";
import { FITNESS_BLUEPRINT, OUTDOOR_FACILITIES_BLUEPRINT } from "./spatialBlueprints";

/** Static semantic seats/workstations in the rendered Office office. */
export type ResourceActivity = "work" | "meeting" | "guest" | "reading" | "shelf" | "lounge" | "watching" | "bar" | "gaming" | "recreation" | "fitness-cardio" | "fitness-cycle" | "fitness-strength" | "fitness-seated-strength" | "fitness-stretch" | "presenting" | "screen-control" | "coffee";
export type ResourceKind = "workstation" | "meeting-seat" | "guest-seat" | "lounge-seat" | "bartender-station" | "recreation-station" | "fitness-station" | "display-station" | "meeting-presenter" | "archive-station" | "cafe-counter";
export type SeatStyle = "office" | "meeting" | "guest" | "sofa" | "armchair" | "barstool" | "bench" | "patio" | "none";

export interface ResourceInteraction {
  seatStyle: SeatStyle;
  seatPoseProfile: HumanoidSeatPoseProfile | null;
  /** Cushion/top height above this floor in metres. */
  seatHeight: number;
  /** Where a walker stages before the controlled sit/stand transition. */
  approachSide: "front" | "behind" | "none";
  approachDistance: number;
  /** Optional chair-local X/Z staging offset for seats with blocked front/back access. */
  approachOffset?: readonly [number, number];
  /** Where a seated avatar steps clear before continuing its route. */
  exitSide: "front" | "behind" | "none";
  exitDistance: number;
  exitOffset?: readonly [number, number];
  sitDurationMs: number;
  standDurationMs: number;
}

export interface SpatialResource {
  id: string;
  roomId: string;
  floor: CampusFloor;
  kind: ResourceKind;
  activity: ResourceActivity;
  capacity: 1;
  /** Root position of the avatar when fully interacting with the resource. */
  position: Point3;
  /** Facing direction of the avatar at the resource. */
  rotationY: number;
  interaction: ResourceInteraction;
}

/** Static furniture footprint metadata; these are never allocatable seats. */
export interface SpatialFootprint {
  id: string;
  roomId: string;
  floor: CampusFloor;
  center: Point3;
  size: readonly [number, number];
  rotationY: number;
}

type XZ = readonly [number, number];

const FLOOR_HEIGHT = 6.4;
const OFFICE_SEAT_FORWARD = 0.04;

function rotateXZ(x: number, z: number, yaw: number): XZ {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [x * c + z * s, -x * s + z * c];
}

function worldXZ(parent: XZ, yaw: number, local: XZ): XZ {
  const [dx, dz] = rotateXZ(local[0], local[1], yaw);
  return [parent[0] + dx, parent[1] + dz];
}

function interactionFor(style: SeatStyle): ResourceInteraction {
  switch (style) {
    case "bench":
    case "patio":
      return { seatStyle: style, seatPoseProfile: "MEETING_UPRIGHT", seatHeight: 0.47, approachSide: "front", approachDistance: 0.95, exitSide: "front", exitDistance: 0.95, sitDurationMs: 900, standDurationMs: 820 };
    case "office":
      return { seatStyle: style, seatPoseProfile: "OFFICE_UPRIGHT", seatHeight: SINGLE_WORKSTATION_BLUEPRINT.seatHeight, approachSide: "behind", approachDistance: SINGLE_WORKSTATION_BLUEPRINT.approachDistance, exitSide: "behind", exitDistance: SINGLE_WORKSTATION_BLUEPRINT.approachDistance, sitDurationMs: 850, standDurationMs: 760 };
    case "guest":
      return { seatStyle: style, seatPoseProfile: "MEETING_UPRIGHT", seatHeight: 0.55, approachSide: "behind", approachDistance: 1.0, exitSide: "behind", exitDistance: 1.0, sitDurationMs: 860, standDurationMs: 760 };
    case "meeting":
      return { seatStyle: style, seatPoseProfile: "MEETING_UPRIGHT", seatHeight: 0.55, approachSide: "behind", approachDistance: 1.0, exitSide: "behind", exitDistance: 1.0, sitDurationMs: 860, standDurationMs: 760 };
    case "sofa":
      return { seatStyle: style, seatPoseProfile: "SOFA_RELAXED", seatHeight: SOFA_SEAT_BLUEPRINT.cushionHeight, approachSide: "front", approachDistance: SOFA_SEAT_BLUEPRINT.approachDistance, exitSide: "front", exitDistance: SOFA_SEAT_BLUEPRINT.approachDistance, sitDurationMs: 1000, standDurationMs: 900 };
    case "armchair":
      return { seatStyle: style, seatPoseProfile: "ARMCHAIR_RELAXED", seatHeight: ARMCHAIR_SEAT_BLUEPRINT.cushionHeight, approachSide: "front", approachDistance: ARMCHAIR_SEAT_BLUEPRINT.approachDistance, exitSide: "front", exitDistance: ARMCHAIR_SEAT_BLUEPRINT.approachDistance, sitDurationMs: 950, standDurationMs: 850 };
    case "barstool":
      return { seatStyle: style, seatPoseProfile: "BAR_STOOL", seatHeight: 0.76, approachSide: "behind", approachDistance: 1.0, exitSide: "behind", exitDistance: 1.0, sitDurationMs: 900, standDurationMs: 820 };
    default:
      return { seatStyle: "none", seatPoseProfile: null, seatHeight: 0, approachSide: "none", approachDistance: 0, exitSide: "none", exitDistance: 0, sitDurationMs: 0, standDurationMs: 0 };
  }
}

function resource(
  id: string,
  roomId: string,
  floor: CampusFloor,
  kind: ResourceKind,
  activity: ResourceActivity,
  x: number,
  z: number,
  rotationY = Math.PI,
  seatStyle: SeatStyle = "office"
): SpatialResource {
  return {
    id,
    roomId,
    floor,
    kind,
    activity,
    capacity: 1,
    position: [x, (floor - 1) * FLOOR_HEIGHT, z],
    rotationY,
    interaction: interactionFor(seatStyle)
  };
}

/**
 * Convert a rendered chair child into the avatar root pose. `chairPosition` and
 * `chairRotationY` are local to `parentPosition` / `parentRotationY`.
 */
function chairResource(
  id: string,
  roomId: string,
  floor: CampusFloor,
  kind: ResourceKind,
  activity: ResourceActivity,
  parentPosition: XZ,
  parentRotationY: number,
  chairPosition: XZ,
  chairRotationY: number,
  seatStyle: Exclude<SeatStyle, "none"> = "office"
): SpatialResource {
  const chairCenter = worldXZ(parentPosition, parentRotationY, chairPosition);
  const yaw = parentRotationY + chairRotationY;
  const upholstered = seatStyle === "sofa" ? SOFA_SEAT_BLUEPRINT
    : seatStyle === "armchair" ? ARMCHAIR_SEAT_BLUEPRINT : null;
  const rootForward = upholstered?.avatarRootForwardOffset ?? OFFICE_SEAT_FORWARD;
  // The rendered cushion center is now the input anchor. Correct by its local
  // Z offset so the established furniture-local avatar root stays unchanged.
  const rootAdjustment = rootForward - (upholstered ? chairPosition[1] : 0);
  const root = worldXZ(chairCenter, yaw, [0, rootAdjustment]);
  return resource(id, roomId, floor, kind, activity, root[0], root[1], yaw, seatStyle);
}

function withStagingOffset(seat: SpatialResource, offset: readonly [number, number]): SpatialResource {
  return { ...seat, interaction: {
    ...seat.interaction,
    approachOffset: offset,
    exitOffset: offset
  } };
}

/** SingleWorkstation / TouchdownDesk: use the exact rendered chair child transform. */
function deskResource(
  id: string,
  roomId: string,
  floor: CampusFloor,
  deskX: number,
  deskZ: number,
  deskRotationY = 0
): SpatialResource {
  return chairResource(id, roomId, floor, "workstation", "work", [deskX, deskZ], deskRotationY,
    [SINGLE_WORKSTATION_BLUEPRINT.chairPosition[0], SINGLE_WORKSTATION_BLUEPRINT.chairPosition[2]],
    SINGLE_WORKSTATION_BLUEPRINT.chairRotationY, "office");
}

function sofaResources(
  idPrefix: string,
  roomId: string,
  floor: CampusFloor,
  sofaX: number,
  sofaZ: number,
  rotationY: number,
  activity: ResourceActivity = "lounge"
): SpatialResource[] {
  return SOFA_SEAT_BLUEPRINT.seatCenters.map(({ x, z }, index) =>
    chairResource(`${idPrefix}-${index + 1}`, roomId, floor, "lounge-seat", activity,
      [sofaX, sofaZ], rotationY, [x, z], 0, "sofa"));
}

function armchairResource(
  id: string,
  roomId: string,
  floor: CampusFloor,
  x: number,
  z: number,
  rotationY: number,
  activity: ResourceActivity = "lounge"
): SpatialResource {
  return chairResource(id, roomId, floor, "lounge-seat", activity, [x, z], rotationY,
    [ARMCHAIR_SEAT_BLUEPRINT.seatCenter.x, ARMCHAIR_SEAT_BLUEPRINT.seatCenter.z], 0, "armchair");
}

function meetingResources(roomId: "meeting-a" | "meeting-b") {
  const blueprint = MEETING_BLUEPRINTS[roomId];
  const furnitureCenter: XZ = [
    blueprint.roomCenter[0] + blueprint.furnitureLocal[0],
    blueprint.roomCenter[1] + blueprint.furnitureLocal[1]
  ];
  return meetingSeatLayout(blueprint.seats, blueprint.tableLength, blueprint.tableWidth).slice(0, blueprint.seats).map((chair, index) =>
    chairResource(`${roomId}.seat-${index + 1}`, roomId, 2, "meeting-seat", "meeting",
      furnitureCenter, 0, [chair.position[0], chair.position[2]], chair.rotationY, "meeting"));
}

const pods = TEAM_POD_LAYOUT.flatMap(({ id: podId, position: [cx, cz], rotationY }) => TEAM_POD_STATIONS.map((station) => {
  const seat = chairResource(`engineering.${podId}.${station.id}`, "engineering", 1, "workstation", "work",
    [TEAM_WORKSPACE_ORIGIN[0] + cx, TEAM_WORKSPACE_ORIGIN[1] + cz],
    rotationY + station.rotationY, TEAM_POD_SEAT.chairPosition, TEAM_POD_SEAT.chairRotationY, "office");
  if ((podId === "pod-a" || podId === "pod-b") && station.id === "seat-ne") return withStagingOffset(seat, [0.9, -0.9]);
  return (podId === "pod-c" || podId === "pod-d") && station.id === "seat-sw"
    ? withStagingOffset(seat, [0.32, -1.24]) : withStagingOffset(seat, [-0.9, -0.9]);
}));

const touchdownDesks = TEAM_WORKSPACE_TOUCHDOWNS.map(({ id, position, rotationY }) => {
  const [x, z] = worldXZ(TEAM_WORKSPACE_ORIGIN, 0, position);
  return deskResource(id, "engineering", 1, x, z, rotationY);
});

function executiveDeskResources(roomId: ExecutiveRoomId) {
  const layout = EXECUTIVE_ROOM_LAYOUTS[roomId];
  const floor = roomId === "executive" ? 2 : 3;
  const parent: XZ = [layout.roomCenter[0] + layout.desk.position[0], layout.roomCenter[1] + layout.desk.position[2]];
  const seat = layout.desk.leaderSeat;
  return [
    withStagingOffset(chairResource(roomId === "executive" ? "executive.leader" : "executive-studio.ceo",
      roomId, floor, "workstation", "work", parent, layout.desk.rotationY,
      [seat.position[0], seat.position[2]], seat.rotationY, "office"), layout.desk.leaderStaging),
    ...layout.desk.guestSeats.map(guest => withStagingOffset(chairResource(guest.id, roomId, floor,
      "guest-seat", "guest", parent, layout.desk.rotationY,
      [guest.position[0], guest.position[2]], guest.rotationY, "guest"), layout.desk.guestStaging))
  ];
}
const executiveSeats = executiveDeskResources("executive");
const studioExecutiveSeats = executiveDeskResources("executive-studio");

const bartenderBarWorld = worldXZ(BARTENDER_BAR_BLUEPRINT.loungeOrigin, 0,
  [BARTENDER_BAR_BLUEPRINT.rootPosition[0], BARTENDER_BAR_BLUEPRINT.rootPosition[2]]);
const bartenderServiceWorld = worldXZ(bartenderBarWorld, BARTENDER_BAR_BLUEPRINT.rotationY,
  [BARTENDER_BAR_BLUEPRINT.serviceTarget.position[0], BARTENDER_BAR_BLUEPRINT.serviceTarget.position[2]]);
const bartenderStation = resource("lounge.bartender", "lounge", 1, "bartender-station", "bar",
  bartenderServiceWorld[0], bartenderServiceWorld[1],
  BARTENDER_BAR_BLUEPRINT.rotationY + BARTENDER_BAR_BLUEPRINT.serviceTarget.rotationY, "none");
const bartenderStools = BARTENDER_BAR_BLUEPRINT.stools.map((stool) =>
  chairResource(stool.resourceId, "lounge", 1, "guest-seat", "guest", bartenderBarWorld,
    BARTENDER_BAR_BLUEPRINT.rotationY, [stool.position[0], stool.position[2]], stool.rotationY, "barstool"));
const bartenderCounterCenter = worldXZ(bartenderBarWorld, BARTENDER_BAR_BLUEPRINT.rotationY, [
  BARTENDER_BAR_BLUEPRINT.frontCounter.footprint.center[0],
  BARTENDER_BAR_BLUEPRINT.frontCounter.position[2] + BARTENDER_BAR_BLUEPRINT.frontCounter.footprint.center[1]
]);

/** Navigation/debug metadata is kept outside OFFICE_RESOURCES to avoid allocation. */
const AUTHORED_OBSTACLES: readonly SpatialFootprint[] = [{
  id: "lounge.bartender-counter",
  roomId: "lounge",
  floor: 1,
  center: [bartenderCounterCenter[0], 0, bartenderCounterCenter[1]],
  size: BARTENDER_BAR_BLUEPRINT.frontCounter.footprint.size,
  rotationY: BARTENDER_BAR_BLUEPRINT.rotationY
},
{
  id: "archive.display-west",
  roomId: "archive",
  floor: 2,
  center: [2.45, 6.4, -0.2],
  size: [0.72, 4.35],
  rotationY: Math.PI / 2
},
{
  id: "archive.display-east",
  roomId: "archive",
  floor: 2,
  center: [11.05, 6.4, -0.2],
  size: [0.72, 3.55],
  rotationY: -Math.PI / 2
},
{
  id: "archive.bookshelf",
  roomId: "archive",
  floor: 2,
  center: [4.55, 6.4, -3.95],
  size: [2.7, 0.48],
  rotationY: 0
}];

const redesignedFootprints: SpatialFootprint[] = [
  ...Object.entries(EXECUTIVE_ROOM_LAYOUTS).flatMap(([roomId, layout]) => {
    const floor = roomId === "executive" ? 2 : 3;
    const footprint = (id: string, position: readonly [number, number, number], size: readonly [number, number], rotationY = 0): SpatialFootprint => ({
      id: `${roomId}.${id}`, roomId, floor, center: [layout.roomCenter[0] + position[0], (floor - 1) * FLOOR_HEIGHT,
        layout.roomCenter[1] + position[2]], size, rotationY
    });
    const deskFootprint = (id: string, local: XZ, size: readonly [number, number]) => {
      const position = worldXZ([layout.desk.position[0], layout.desk.position[2]], layout.desk.rotationY, local);
      return footprint(id, [position[0], 0, position[1]], size, layout.desk.rotationY);
    };
    return [
      deskFootprint("desk-top", [0.03, 0.03], [4.54, 1.2]),
      deskFootprint("desk-return", [-1.715, -1.46], [1.05, 2.03]),
      deskFootprint("desk-cabinet", [0.1, -3.15], [5.2, 0.5]),
      footprint("credenza-body", layout.credenza.position, layout.credenza.size, layout.credenza.rotationY),
      footprint("storage-body", layout.storage.position, layout.storage.size, layout.storage.rotationY),
      footprint("coffee-table", [layout.lounge.position[0] + layout.lounge.coffeeTable.position[0], 0,
        layout.lounge.position[2] + layout.lounge.coffeeTable.position[2]], layout.lounge.coffeeTable.size)
    ];
  }),
  ...Object.entries(MEETING_ROOM_LAYOUTS).flatMap(([roomId, layout]): SpatialFootprint[] => [
    { id: `${roomId}.table`, roomId, floor: 2,
      center: [layout.roomCenter[0] + layout.furnitureLocal[0], FLOOR_HEIGHT, layout.roomCenter[1] + layout.furnitureLocal[1]],
      size: [layout.tableLength, layout.tableWidth], rotationY: 0 },
    { id: `${roomId}.credenza-body`, roomId, floor: 2,
      center: [layout.roomCenter[0] + layout.credenza.position[0], FLOOR_HEIGHT, layout.roomCenter[1] + layout.credenza.position[2]],
      size: layout.credenza.size, rotationY: layout.credenza.rotationY }
  ])
];

export const OFFICE_OBSTACLES: readonly SpatialFootprint[] = [...AUTHORED_OBSTACLES, ...redesignedFootprints].map(item => ({ ...item,
  center: relocateRoomPoint(item.roomId, item.center) }));

// ---------------------------------------------------------------------------
// Resource positions below are derived from the CURRENT rendered furniture
// transforms. They are avatar interaction roots, not furniture origins.
// ---------------------------------------------------------------------------

const lobbySofa = sofaResources("lobby.sofa", "lobby", 1, -14.35, -9.75, Math.PI);
const engineeringWestSofa = worldXZ(TEAM_WORKSPACE_ORIGIN, 0,
  [TEAM_WORKSPACE_LOUNGES.westSofa.position[0], TEAM_WORKSPACE_LOUNGES.westSofa.position[2]]);
const engineeringSofa = sofaResources("engineering.sofa", "engineering", 1,
  engineeringWestSofa[0], engineeringWestSofa[1], TEAM_WORKSPACE_LOUNGES.westSofa.rotationY);
const loungeReadingOrigin = worldXZ(BARTENDER_BAR_BLUEPRINT.loungeOrigin, 0,
  [LOUNGE_FURNITURE_BLUEPRINT.readingOrigin[0], LOUNGE_FURNITURE_BLUEPRINT.readingOrigin[2]]);
const loungeSofaPosition = worldXZ(loungeReadingOrigin, 0,
  [LOUNGE_FURNITURE_BLUEPRINT.sofa.position[0], LOUNGE_FURNITURE_BLUEPRINT.sofa.position[2]]);
const loungeSofa = sofaResources("lounge.sofa", "lounge", 1,
  loungeSofaPosition[0], loungeSofaPosition[1], LOUNGE_FURNITURE_BLUEPRINT.sofa.rotationY);
const engineeringBreakoutChairs = TEAM_WORKSPACE_LOUNGES.eastChairs.map((chair, index) => {
  const [x, z] = worldXZ(TEAM_WORKSPACE_ORIGIN, 0, [chair.position[0], chair.position[2]]);
  return withStagingOffset(armchairResource(chair.id, "engineering", 1, x, z, chair.rotationY),
    [0, index === 0 ? -1.25 : -1.4]);
});
const engineeringWestChairPosition = worldXZ(TEAM_WORKSPACE_ORIGIN, 0,
  [TEAM_WORKSPACE_LOUNGES.westChair.position[0], TEAM_WORKSPACE_LOUNGES.westChair.position[2]]);
const loungeArmchairs = LOUNGE_FURNITURE_BLUEPRINT.armchairs.map((chair) => {
  const [x, z] = worldXZ(loungeReadingOrigin, 0, [chair.position[0], chair.position[2]]);
  return armchairResource(chair.id, "lounge", 1, x, z, chair.rotationY);
});
const loungeDiningChairs = LOUNGE_FURNITURE_BLUEPRINT.diningChairs.map((position, index) => {
  const [x, z] = worldXZ(BARTENDER_BAR_BLUEPRINT.loungeOrigin, 0, [position[0], position[2]]);
  return withStagingOffset(chairResource(`lounge.dining-${index + 1}`, "lounge", 1, "guest-seat", "guest",
    [x, z], 0, [0, 0], Math.PI, "armchair"), [0, -1.2]);
});
const entertainmentSofa = sofaResources("entertainment.sofa", "entertainment", 1, 13.15, 12.4, Math.PI, "watching");
const skySofa = sofaResources("sky-lounge.sofa", "sky-lounge", 3, -15.5, -10.0, Math.PI);
const librarySofaPosition = worldXZ(LIBRARY_BLUEPRINT.roomCenter, 0,
  [LIBRARY_BLUEPRINT.sofaPosition[0], LIBRARY_BLUEPRINT.sofaPosition[2]]);
const librarySofa = sofaResources("library.sofa", "library", 1,
  librarySofaPosition[0], librarySofaPosition[1], LIBRARY_BLUEPRINT.sofaRotationY, "reading");

const libraryShelfTargets = LIBRARY_BLUEPRINT.shelfTargets.map((target) => {
  const position = worldXZ(LIBRARY_BLUEPRINT.roomCenter, 0, target.position);
  return resource(target.id, "library", 1, "archive-station", "shelf",
    position[0], position[1], target.rotationY, "none");
});
const libraryDeskPosition = worldXZ(LIBRARY_BLUEPRINT.roomCenter, 0,
  [LIBRARY_BLUEPRINT.deskPosition[0], LIBRARY_BLUEPRINT.deskPosition[2]]);

function meetingPresenterResources(roomId: "meeting-a" | "meeting-b") {
  const blueprint = MEETING_BLUEPRINTS[roomId];
  const furnitureCenter: XZ = [
    blueprint.roomCenter[0] + blueprint.furnitureLocal[0],
    blueprint.roomCenter[1] + blueprint.furnitureLocal[1]
  ];
  const targets = MEETING_INTERACTION_TARGETS[roomId];
  return (["presenter", "display"] as const).map((targetId) => {
    const target = targets[targetId];
    return resource(`${roomId}.${targetId}`, roomId, 2,
      targetId === "presenter" ? "meeting-presenter" : "display-station", "presenting",
      furnitureCenter[0] + target.position[0], furnitureCenter[1] + target.position[2], target.rotationY, "none");
  });
}

function executiveLoungeResources(roomId: ExecutiveRoomId) {
  const layout = EXECUTIVE_ROOM_LAYOUTS[roomId];
  const floor = roomId === "executive" ? 2 : 3;
  const parent: XZ = [layout.roomCenter[0] + layout.lounge.position[0], layout.roomCenter[1] + layout.lounge.position[2]];
  const sofa = layout.lounge.sofa;
  return {
    sofa: sofa.seatXs.map((x, index) => {
      const seat = chairResource(`${roomId}.lounge-sofa-${index + 1}`, roomId, floor, "lounge-seat", "lounge",
        [parent[0] + sofa.position[0], parent[1] + sofa.position[2]], sofa.rotationY,
        [x, sofa.seatLocalZ], 0, "sofa");
      return { ...seat, interaction: { ...seat.interaction, seatHeight: sofa.seatHeight,
        approachSide: "front" as const, approachDistance: sofa.stagingDistance,
        exitSide: "front" as const, exitDistance: sofa.stagingDistance } };
    }),
    armchairs: layout.lounge.armchairs.map(chair => withStagingOffset(armchairResource(chair.id, roomId,
      floor, parent[0] + chair.position[0], parent[1] + chair.position[2], chair.rotationY), chair.stagingOffset))
  };
}
const executiveVip = executiveLoungeResources("executive");
const executiveVipSofa = executiveVip.sofa;
const executiveVipArmchairs = executiveVip.armchairs;
const studioLounge = executiveLoungeResources("executive-studio");
const studioLoungeSofa = studioLounge.sofa;
const studioLoungeArmchairs = studioLounge.armchairs;

function fitnessResource(id: string, activity: ResourceActivity, local: XZ, rotationY: number,
  seatStyle: SeatStyle = "none") {
  const [x, z] = worldXZ(FITNESS_BLUEPRINT.roomCenter, 0, local);
  return resource(id, "fitness", 3, "fitness-station", activity, x, z, rotationY, seatStyle);
}

const fitnessResources = [
  ...FITNESS_BLUEPRINT.treadmills.map(station => fitnessResource(station.id, "fitness-cardio",
    worldXZ([station.position[0], station.position[2]], station.rotationY, FITNESS_BLUEPRINT.treadmillTarget),
    station.rotationY + Math.PI)),
  ...FITNESS_BLUEPRINT.bikes.map(station => {
    const bike = fitnessResource(station.id, "fitness-cycle",
      worldXZ([station.position[0], station.position[2]], station.rotationY, FITNESS_BLUEPRINT.bikeSeat), station.rotationY + Math.PI, "office");
    return withStagingOffset({ ...bike, interaction: { ...bike.interaction, seatHeight: FITNESS_BLUEPRINT.bikeSeatHeight,
      approachSide: "front" as const, approachDistance: 1.15,
      exitSide: "front" as const, exitDistance: 1.15 } }, FITNESS_BLUEPRINT.bikeStagingOffset);
  }),
  fitnessResource(FITNESS_BLUEPRINT.dumbbellRack.id, "fitness-strength", FITNESS_BLUEPRINT.dumbbellRack.target, Math.PI),
  ...FITNESS_BLUEPRINT.yogaMats.map(station => fitnessResource(station.id, "fitness-stretch",
    [station.position[0], station.position[2]], Math.PI)),
  ...[FITNESS_BLUEPRINT.weightBench, FITNESS_BLUEPRINT.cableRow].map(station => {
    const bench = fitnessResource(station.id, "fitness-seated-strength",
      worldXZ([station.position[0], station.position[2]], station.rotationY, FITNESS_BLUEPRINT.strengthSeat), station.rotationY, "office");
    return withStagingOffset({ ...bench, interaction: { ...bench.interaction,
      seatHeight: FITNESS_BLUEPRINT.strengthSeatHeight } }, FITNESS_BLUEPRINT.strengthStagingOffset);
  }),
  fitnessResource(FITNESS_BLUEPRINT.freeweights.id, "fitness-strength", FITNESS_BLUEPRINT.freeweights.target,
    FITNESS_BLUEPRINT.freeweights.rotationY)
];

const entertainmentScreen = resource("entertainment.tv-control", "entertainment", 1,
  "display-station", "screen-control", 12.55, 8.5, Math.PI, "none");

const archiveInteractions = [
  resource("archive.display-west", "archive", 2, "archive-station", "shelf", 3.35, -0.2, -Math.PI / 2, "none"),
  resource("archive.display-east", "archive", 2, "archive-station", "shelf", 10.15, -0.2, Math.PI / 2, "none"),
  resource("archive.bookshelf", "archive", 2, "archive-station", "shelf", 4.55, -3.05, Math.PI, "none")
];

const outdoor = OUTDOOR_FACILITIES_BLUEPRINT;

/** Exterior avatar roots stay on the navigation plane; seat height includes the rendered ground offset. */
function outdoorSeat(id: string, roomId: string, parent: readonly [number, number, number],
  parentYaw: number, local: XZ, yaw: number, height: number, style: "bench" | "patio" = "bench",
  behind = false): SpatialResource {
  const [x, z] = worldXZ([parent[0], parent[2]], parentYaw, local);
  const seat = resource(id, roomId, 1, "lounge-seat", "lounge",
    x, z, parentYaw + yaw, style);
  return { ...seat, interaction: { ...seat.interaction, seatHeight: parent[1] + height,
    approachSide: behind ? "behind" : "front", exitSide: behind ? "behind" : "front" } };
}

const outdoorSeats = [
  ...outdoor.plinthBenches.flatMap(bench => outdoor.seatSlots.map((x, i) =>
    outdoorSeat(`${bench.id}.seat-${i + 1}`, bench.roomId, bench.position, bench.rotationY,
      [x, 0], 0, outdoor.plinthSeatHeight))),
  ...outdoor.parkBenches.flatMap(bench => outdoor.seatSlots.map((x, i) =>
    outdoorSeat(`${bench.id}.seat-${i + 1}`, bench.roomId, bench.position, bench.rotationY,
      [x, outdoor.parkSeatCenterZ], 0, outdoor.parkSeatHeight))),
  ...outdoor.arrivalGardens.flatMap(garden => outdoor.gardenSeatSlots.map((x, i) =>
    outdoorSeat(`${garden.id}.seat-${i + 1}`, "outdoor-forecourt", garden.position, 0,
      [x, outdoor.gardenSeatZ], Math.PI, outdoor.gardenSeatHeight))),
  ...outdoor.picnicTables.flatMap(table => outdoor.picnicSeatSides.flatMap((z, side) =>
    outdoor.picnicSeatSlots.map((x, i) => outdoorSeat(`${table.id}.seat-${side * 2 + i + 1}`,
      "outdoor-cafe", table.position, table.rotationY, [x, z], z > 0 ? Math.PI : 0,
      outdoor.picnicSeatHeight, "bench", true)))),
  ...outdoor.patios.flatMap(patio => outdoor.patioChairAngles.map((a, i) =>
    outdoorSeat(`${patio.id}.seat-${i + 1}`, "outdoor-rear-patio", patio.position, 0,
      [Math.sin(a) * outdoor.patioChairRadius, Math.cos(a) * outdoor.patioChairRadius],
      a + Math.PI, outdoor.patioSeatHeight, "patio", true)))
];
const cafeCustomerPoint = worldXZ([outdoor.cafeKiosk.position[0], outdoor.cafeKiosk.position[2]],
  outdoor.cafeKiosk.rotationY, outdoor.cafeKiosk.customerTarget);
const outdoorCafeCounter = resource("outdoor.cafe-counter", "outdoor-cafe", 1, "cafe-counter", "coffee",
  cafeCustomerPoint[0], cafeCustomerPoint[1], outdoor.cafeKiosk.rotationY + Math.PI, "none");

/** Each entry is one real seat or one standing interaction point. */
const AUTHORED_RESOURCES: readonly SpatialResource[] = [
  ...outdoorSeats, outdoorCafeCounter,
  ...lobbySofa.map((seat) => seat.id === "lobby.sofa-1"
    ? withStagingOffset(seat, [-1.4, -0.15]) : seat),
  armchairResource("lobby.armchair-1", "lobby", 1, -11.35, -9.75, Math.PI),
  withStagingOffset(armchairResource("lobby.armchair-2", "lobby", 1, -16.55, -10.75, Math.PI * 0.65), [0, 1.6]),
  // The counter blocks the chair's front and the feature wall blocks its back.
  // Stage at the counter's open east end, then slide into the chair from its side.
  withStagingOffset(chairResource("lobby.receptionist", "lobby", 1, "workstation", "work",
    [RECEPTION_DESK_BLUEPRINT.worldPosition[0] + RECEPTION_DESK_BLUEPRINT.staffOffsetX,
      RECEPTION_DESK_BLUEPRINT.worldPosition[1]],
    RECEPTION_DESK_BLUEPRINT.rotationY,
    [0, RECEPTION_DESK_BLUEPRINT.chairOffsetZ], Math.PI, "office"),
    RECEPTION_DESK_BLUEPRINT.approachOffset),

  ...pods,
  ...touchdownDesks,
  ...engineeringBreakoutChairs,
  ...engineeringSofa,
  armchairResource("engineering.armchair", "engineering", 1,
    engineeringWestChairPosition[0], engineeringWestChairPosition[1], TEAM_WORKSPACE_LOUNGES.westChair.rotationY),

  deskResource("qa.station-1", "qa", 1, 5.1, 10.7),
  deskResource("qa.station-2", "qa", 1, 8.3, 10.7),
  deskResource("source-control.commit", "source-control", 1, -2.5, 10.7),
  deskResource("source-control.laptop", "source-control", 1, 0.85, 10.7),
  ...libraryShelfTargets,
  withStagingOffset(deskResource("library.laptop", "library", 1, libraryDeskPosition[0], libraryDeskPosition[1]), [-1.2, 0]),
  ...librarySofa,
  deskResource("operations.station-1", "operations", 1,
    SERVER_ROOM_BLUEPRINT.roomCenter[0] + SERVER_ROOM_BLUEPRINT.deskPosition[0],
    SERVER_ROOM_BLUEPRINT.roomCenter[1] + SERVER_ROOM_BLUEPRINT.deskPosition[2]),

  // Standing service point between back counter and guest-facing bar.
  bartenderStation,
  ...loungeSofa,
  ...loungeArmchairs,
  ...bartenderStools,
  ...loungeDiningChairs,

  ...entertainmentSofa.map((seat) => seat.id === "entertainment.sofa-1"
    ? withStagingOffset(seat, [-0.82, 1.0]) : seat),
  { ...armchairResource("entertainment.armchair", "entertainment", 1, 15.18, 12.65, Math.PI), activity: "watching" as const },
  entertainmentScreen,
  resource("entertainment.arcade", "entertainment", 1, "recreation-station", "gaming", 17.25, 8.7, Math.PI / 2, "none"),
  resource("entertainment.foosball-1", "entertainment", 1, "recreation-station", "recreation", 17.15, 10.05, 0, "none"),
  resource("entertainment.foosball-2", "entertainment", 1, "recreation-station", "recreation", 17.75, 12.55, Math.PI, "none"),

  ...executiveSeats,
  ...executiveVipSofa,
  ...executiveVipArmchairs,

  ...[-4.7, -1.6, 1.6, 4.7].map((x, index) => withStagingOffset(deskResource(`mission-control.station-${index + 1}`, "mission-control", 2, 2 + x, -8.55), [index === 3 ? 1.2 : -1.2, 0])),
  deskResource("architecture.laptop", "architecture", 2, -15.8, -0.3),
  ...meetingResources("meeting-a"),
  ...meetingPresenterResources("meeting-a"),
  ...archiveInteractions,
  ...meetingResources("meeting-b"),
  ...meetingPresenterResources("meeting-b"),
  deskResource("knowledge.laptop", "knowledge", 2, -12.75, 8.4),
  armchairResource("knowledge.armchair", "knowledge", 2, -10.05, 10.5, Math.PI, "reading"),
  deskResource("review.station-1", "review", 2, -4.3, 8.4),
  deskResource("review.station-2", "review", 2, 1.3, 8.4),

  ...studioExecutiveSeats,
  ...studioLoungeSofa,
  ...studioLoungeArmchairs,
  ...[-10.35, -7.75].flatMap((deskZ, row) => [-3.55, -0.55, 3.05, 6.05].map((x, col) => {
    const index = row * 4 + col + 1;
    const seat = deskResource(`multi-engine.station-${index}`, "multi-engine", 3, x, deskZ);
    if (index === 1) return withStagingOffset(seat, [1.2, 0]);
    if (index === 2 || index === 4) return withStagingOffset(seat, [-1.2, 0]);
    if (index === 5) return withStagingOffset(seat, [1.5, 0]);
    if (index === 6 || index === 8) return withStagingOffset(seat, [1.2, 0]);
    if (index === 7) return withStagingOffset(seat, [-1.25, 0]);
    return index === 3 ? withStagingOffset(seat, [1.2, 0]) : seat;
  })),
  ...[-16.5, -14, -11.5].map((x, index) => deskResource(`sanctuary.terminal-${index + 1}`, "sanctuary", 3, x, -0.45)),
  ...[-6.2, -1.8].flatMap((x, col) => [-2.3, 0.45].map((deskZ, row) => {
    const index = col * 2 + row + 1;
    return withStagingOffset(deskResource(`flex.station-${index}`, "flex", 3, x, deskZ),
      [col === 0 ? 1.05 : -1.05, 0]);
  })),
  deskResource("research.laptop-1", "research", 3, 4.0, -0.6),
  deskResource("research.laptop-2", "research", 3, 8.0, -0.6),
  ...skySofa,
  armchairResource("sky-lounge.armchair", "sky-lounge", 3, -12.0, -10.0, Math.PI),
  ...fitnessResources,
  ...F3_TERRACE.sofas.flatMap(sofa => sofaResources(sofa.id, "rooftop-terrace", 3,
    sofa.position[0], sofa.position[2], sofa.rotationY)),
  ...F3_TERRACE.armchairs.map(chair => armchairResource(chair.id, "rooftop-terrace", 3,
    chair.position[0], chair.position[2], chair.rotationY)),
];

export const OFFICE_RESOURCES: readonly SpatialResource[] = AUTHORED_RESOURCES.map(resource => ({
  ...resource, position: relocateRoomPoint(resource.roomId, resource.position)
}));

export function resourcesInRoom(roomId: string): SpatialResource[] {
  return OFFICE_RESOURCES.filter((entry) => entry.roomId === roomId);
}

export function resourceById(id: string): SpatialResource | undefined {
  return OFFICE_RESOURCES.find((entry) => entry.id === id);
}

export function resourceCapacity(roomId: string): number {
  return resourcesInRoom(roomId).reduce((total, entry) => total + entry.capacity, 0);
}
