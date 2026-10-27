import { OFFICE_BUILDING } from '../layout';
import { F3_TERRACE } from './floor1Layout';
import type { CampusRoom } from './worldRegistry';

export interface RoomEnvelopeSides {
  north: boolean;
  south: boolean;
  west: boolean;
  east: boolean;
}

/** Only coincident perimeter planes qualify; walls facing corridors remain internal. */
export function classifyRoomEnvelope(room: Pick<CampusRoom, 'floor' | 'center' | 'size'>): RoomEnvelopeSides {
  const [x, , z] = room.center;
  const [width, depth] = room.size;
  if (![x, z, width, depth].every(Number.isFinite) || width <= 0 || depth <= 0) {
    return { north: false, south: false, west: false, east: false };
  }
  const tolerance = 0.06;
  const south = room.floor === 3 ? F3_TERRACE.north : OFFICE_BUILDING.south;
  return {
    north: Math.abs(z - depth / 2 - OFFICE_BUILDING.north) <= tolerance,
    south: Math.abs(z + depth / 2 - south) <= tolerance,
    west: Math.abs(x - width / 2 - OFFICE_BUILDING.west) <= tolerance,
    east: Math.abs(x + width / 2 - OFFICE_BUILDING.east) <= tolerance,
  };
}
