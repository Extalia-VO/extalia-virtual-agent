import { relocateRoomPoint } from "./roomRelocation";
import { F1_LAYOUT, F2_LAYOUT, F3_LAYOUT, F3_TERRACE } from "./floor1Layout";
import { OFFICE_STAIRCASE, OFFICE_STAIR_LAYOUT, type Point3 } from "../layout";
import { EXECUTIVE_STUDIO_BLUEPRINT, EXECUTIVE_OFFICE_BLUEPRINT, LIBRARY_BLUEPRINT, TEAM_WORKSPACE_ORIGIN, OUTDOOR_FACILITIES_BLUEPRINT } from "./spatialBlueprints";

export type CampusFloor = 1 | 2 | 3;

export interface CampusRoom {
  id: string;
  label: string;
  floor: CampusFloor;
  center: Point3;
  size: [number, number];
  /** Exterior facilities use campus circulation rather than an indoor doorway. */
  exterior?: boolean;
  /** Centre of the corridor-facing doorway/portal. */
  door: Point3;
}

export interface RoomPortal {
  roomId: string;
  floor: CampusFloor;
  /** Safe point in the corridor immediately outside the room. */
  outside: Point3;
  /** Door threshold. */
  threshold: Point3;
  /** Safe point immediately inside the room. */
  inside: Point3;
}

/** Office room anchors match rendered RoomShell centers and their corridor-facing doors. */
const AUTHORED_ROOMS: CampusRoom[] = [
  ...OUTDOOR_FACILITIES_BLUEPRINT.zones.map(zone => ({ id: zone.id, label: zone.label,
    floor: 1 as const, exterior: true, center: [zone.center[0], 0, zone.center[1]] as Point3,
    size: [...zone.size] as [number, number], door: [zone.door[0], 0, zone.door[1]] as Point3 })),
  { id: "lobby", label: "Lobby / Grand Arrival", floor: 1, center: [-4.25, 0, -11.1], size: [30.5, 6.7], door: [3.9, 0, -7.75] },
  { id: "engineering", label: "Engineering Hall", floor: 1, center: [TEAM_WORKSPACE_ORIGIN[0], 0, TEAM_WORKSPACE_ORIGIN[1]], size: [27.0, 11.5], door: [TEAM_WORKSPACE_ORIGIN[0], 0, -6.95] },
  { id: "library", label: "Library / Skills", floor: 1,
    center: [LIBRARY_BLUEPRINT.roomCenter[0], 0, LIBRARY_BLUEPRINT.roomCenter[1]],
    size: [...LIBRARY_BLUEPRINT.roomSize],
    door: [LIBRARY_BLUEPRINT.roomCenter[0], 0,
      LIBRARY_BLUEPRINT.roomCenter[1] - LIBRARY_BLUEPRINT.roomSize[1] / 2] },
  { id: "operations", label: "Operations / Server", floor: 1, center: [-8.2, 0, 10.5], size: [7.2, 7], door: [-8.2, 0, 7] },
  { id: "source-control", label: "Source Control Lab", floor: 1, center: [-0.8, 0, 10.5], size: [7.6, 7], door: [-0.8, 0, 7] },
  { id: "qa", label: "QA / Test Lab", floor: 1, center: [6.8, 0, 10.5], size: [7.6, 7], door: [6.8, 0, 7] },
  { id: "entertainment", label: "Entertainment", floor: 1, center: [15.0, 0, 10.5], size: [8.8, 7], door: [15.0, 0, 7] },
  { id: "lounge", label: "Lounge / Pantry", floor: 1, center: [14.2, 0, -0.9], size: [9.6, 11.4], door: [14.2, 0, 4.5] },
  { id: "staircase", label: "Floating Staircase & LED", floor: 1,
    center: [OFFICE_STAIRCASE.x, 1.8, OFFICE_STAIRCASE.z],
    size: [OFFICE_STAIR_LAYOUT.eastEdge - OFFICE_STAIR_LAYOUT.westEdge,
      OFFICE_STAIRCASE.runPerFlight + OFFICE_STAIRCASE.landingDepth + OFFICE_STAIRCASE.midLandingDepth],
    door: [OFFICE_STAIR_LAYOUT.floorConnectionX, 0,
      OFFICE_STAIR_LAYOUT.bridgeNorthZ + OFFICE_STAIR_LAYOUT.landingLaneInset] },

  { id: "executive", label: "Executive / CEO", floor: 2,
    center: [EXECUTIVE_OFFICE_BLUEPRINT.roomCenter[0], 6.4, EXECUTIVE_OFFICE_BLUEPRINT.roomCenter[1]],
    size: [...EXECUTIVE_OFFICE_BLUEPRINT.roomSize],
    door: [EXECUTIVE_OFFICE_BLUEPRINT.roomCenter[0], 6.4,
      EXECUTIVE_OFFICE_BLUEPRINT.roomCenter[1] + EXECUTIVE_OFFICE_BLUEPRINT.roomSize[1] / 2] },
  { id: "mission-control", label: "Mission Control", floor: 2, center: [2.0, 6.4, -9.0], size: [18.0, 6.2], door: [2.0, 6.4, -5.9] },
  { id: "architecture", label: "Architecture / Strategy", floor: 2, center: [-14.0, 6.4, -0.8], size: [10.0, 7.0], door: [-14.0, 6.4, -4.3] },
  { id: "meeting-a", label: "Meeting Room A", floor: 2, center: [-3.25, 6.4, -0.8], size: [11.5, 7.0], door: [-3.25, 6.4, -4.3] },
  { id: "archive", label: "Archive", floor: 2, center: [6.75, 6.4, -0.8], size: [8.5, 7.0], door: [6.75, 6.4, -4.3] },
  { id: "knowledge", label: "Knowledge Room", floor: 2, center: [-13.25, 6.4, 8.2], size: [11.5, 7.0], door: [-13.25, 6.4, 4.7] },
  { id: "review", label: "Review / Security", floor: 2, center: [-1.5, 6.4, 8.2], size: [12.0, 7.0], door: [-1.5, 6.4, 4.7] },
  { id: "meeting-b", label: "Meeting Room B", floor: 2, center: [11.75, 6.4, 8.2], size: [14.5, 7.0], door: [11.75, 6.4, 4.7] },

  { id: "executive-studio", label: "Executive Studio", floor: 3,
    center: [EXECUTIVE_STUDIO_BLUEPRINT.roomCenter[0], 12.8, EXECUTIVE_STUDIO_BLUEPRINT.roomCenter[1]],
    size: [...EXECUTIVE_STUDIO_BLUEPRINT.roomSize],
    door: [EXECUTIVE_STUDIO_BLUEPRINT.roomCenter[0], 12.8,
      EXECUTIVE_STUDIO_BLUEPRINT.roomCenter[1] - EXECUTIVE_STUDIO_BLUEPRINT.roomSize[1] / 2] },
  { id: "multi-engine", label: "Multi-Engine Lab", floor: 3, center: [1.25, 12.8, -9], size: [19.5, 6.2], door: [1.25, 12.8, -5.9] },
  { id: "sanctuary", label: "Knowledge Sanctuary", floor: 3, center: [-14.0, 12.8, -0.8], size: [10.0, 7.0], door: [-14.0, 12.8, -4.3] },
  { id: "flex", label: "General / Flex Work", floor: 3, center: [-4.0, 12.8, -0.8], size: [10.0, 7.0], door: [-4.0, 12.8, -4.3] },
  { id: "research", label: "Research Area", floor: 3, center: [6.0, 12.8, -0.8], size: [10.0, 7.0], door: [6.0, 12.8, -4.3] },
  { id: "sky-lounge", label: "Sky Lounge / Rooftop", floor: 3, center: [-13.75, 12.8, -9.0], size: [10.5, 6.2], door: [-13.75, 12.8, -5.9] },
  { id: "fitness", label: "Fitness / Wellness", floor: 3, center: [9.0, 12.8, 8.45], size: [20.0, 7.3], door: [9.0, 12.8, 4.8] },
  { id: "rooftop-terrace", label: "Open Air Relaxation Terrace", floor: 3,
    center: [F3_TERRACE.center[0], 12.8, F3_TERRACE.center[1]], size: [...F3_TERRACE.size],
    door: [F3_TERRACE.door.center[0], 12.8, F3_TERRACE.door.center[2]] }
];

export const OFFICE_ROOMS: CampusRoom[] = AUTHORED_ROOMS.map(room => {
  const layouts: Record<string, { center: readonly [number, number]; size: readonly [number, number]; north: number; south: number }> =
    room.floor === 1 ? F1_LAYOUT : room.floor === 2 ? F2_LAYOUT : F3_LAYOUT;
  const layout = layouts[room.id];
  if (layout) {
    const southEntries = ["lobby", "lounge", "executive", "mission-control", "sky-lounge", "multi-engine"];
    const y = (room.floor - 1) * 6.4;
    return { ...room, center: [layout.center[0], y, layout.center[1]], size: [...layout.size],
      door: [layout.center[0], y, southEntries.includes(room.id) ? layout.south : layout.north] };
  }
  return { ...room, center: relocateRoomPoint(room.id, room.center), door: relocateRoomPoint(room.id, room.door) };
});

const roomMap = new Map(OFFICE_ROOMS.map((room) => [room.id, room] as const));

export function roomsOnFloor(floor: CampusFloor): CampusRoom[] {
  return OFFICE_ROOMS.filter((room) => room.floor === floor);
}

export function roomById(roomId: string | undefined): CampusRoom | undefined {
  return roomId ? roomMap.get(roomId) : undefined;
}

export function isOutdoorRoom(roomId: string | undefined): boolean {
  return Boolean(roomById(roomId)?.exterior);
}

export function pointInsideRoom(point: Point3, room: CampusRoom, inset = 0): boolean {
  if (Math.abs(point[1] - room.center[1]) > 0.55) return false;
  const halfW = Math.max(0, room.size[0] / 2 - inset);
  const halfD = Math.max(0, room.size[1] / 2 - inset);
  return Math.abs(point[0] - room.center[0]) <= halfW && Math.abs(point[2] - room.center[2]) <= halfD;
}

export function roomAtPoint(point: Point3): CampusRoom | undefined {
  // Prefer the smallest matching room if future layouts introduce nested zones.
  return OFFICE_ROOMS.filter((room) => pointInsideRoom(point, room))
    .sort((a, b) => a.size[0] * a.size[1] - b.size[0] * b.size[1])[0];
}

/**
 * The portal derives from the rendered RoomShell center/door relationship.
 * Keeping this semantic data next to the room definition prevents routes from
 * guessing raw XYZ points that drift away from the physical doorway.
 */
export function roomPortal(roomOrId: CampusRoom | string, clearance = 0.72): RoomPortal {
  const room = typeof roomOrId === "string" ? roomById(roomOrId) : roomOrId;
  if (!room) throw new Error(`Unknown Office room: ${String(roomOrId)}`);
  const dx = room.door[0] - room.center[0];
  const dz = room.door[2] - room.center[2];
  const length = Math.hypot(dx, dz);
  if (length < 0.001) throw new Error(`Room door must not equal room center: ${room.id}`);
  // The wide terrace has an off-centre entrance between the CEO and fitness rooms.
  // Its threshold normal remains perpendicular to the glazed entrance wall.
  const nx = room.id === "rooftop-terrace" ? 0 : dx / length;
  const nz = room.id === "rooftop-terrace" ? -1 : dz / length;
  return {
    roomId: room.id,
    floor: room.floor,
    threshold: [...room.door] as Point3,
    inside: [room.door[0] - nx * clearance, room.door[1], room.door[2] - nz * clearance],
    outside: [room.door[0] + nx * clearance, room.door[1], room.door[2] + nz * clearance]
  };
}
