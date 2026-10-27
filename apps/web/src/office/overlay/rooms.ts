import type { Point3 } from '../scene/layout';
import { OFFICE_ROOMS } from '../scene/interior/worldRegistry';

/** Vertical distance between floors in the scene, in metres. */
const FLOOR_HEIGHT = 6.4;

export type RoomFloor = 1 | 2 | 3;

/** A room (or outdoor area) of the campus, ready for search, the room picker and the camera. */
export interface OverlayRoom {
  id: string;
  /** Name in the app language; the registry's English label when no translation exists. */
  label: string;
  /** The registry label, so English terms still match under another language. */
  registryLabel: string;
  floor: RoomFloor;
  outdoor: boolean;
  /** Floor level at the room's horizontal centre. */
  point: Point3;
  /** Room footprint in metres (x, z). */
  size: readonly [number, number];
}

export function overlayRooms(names: Readonly<Record<string, string>>): OverlayRoom[] {
  return OFFICE_ROOMS.map(room => ({
    id: room.id,
    label: names[room.id] ?? room.label,
    registryLabel: room.label,
    floor: room.floor,
    outdoor: Boolean(room.exterior),
    point: [room.center[0], (room.floor - 1) * FLOOR_HEIGHT, room.center[2]],
    size: room.size,
  }));
}

export interface RoomGroup {
  key: 'floor-1' | 'floor-2' | 'floor-3' | 'outdoor';
  /** Absent for the outdoor campus. */
  floor?: RoomFloor;
  rooms: OverlayRoom[];
}

/** Indoor rooms by floor, then the outdoor campus. Empty groups are left out. */
export function groupRooms(rooms: readonly OverlayRoom[]): RoomGroup[] {
  const groups: RoomGroup[] = ([1, 2, 3] as const).map(floor => ({
    key: `floor-${floor}` as const, floor, rooms: rooms.filter(room => !room.outdoor && room.floor === floor),
  }));
  groups.push({ key: 'outdoor', rooms: rooms.filter(room => room.outdoor) });
  return groups.filter(group => group.rooms.length > 0);
}

/** The floor view that shows a room: the campus view for outdoor areas. */
export function roomView(room: Pick<OverlayRoom, 'floor' | 'outdoor'>): RoomFloor | 'campus' {
  return room.outdoor ? 'campus' : room.floor;
}
