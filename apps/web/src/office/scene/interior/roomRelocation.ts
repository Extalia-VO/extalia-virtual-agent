import type { Point3 } from "../layout";

/** One translation applied to rendered room contents and every semantic target. */
export const ROOM_RELOCATIONS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  lobby: [-0.75, -3.9], engineering: [1, 0],
  library: [-0.95, 4.7], operations: [0.1, 4.7], "source-control": [0.9, 4.7], qa: [1.5, 4.7], entertainment: [3.7, 4.7],
  executive: [1, -4.9], "mission-control": [2, -5.4], architecture: [22.75, 15.6],
  "meeting-a": [-9.75, 1.2], archive: [13.5, 15.6], knowledge: [-2, 6.6], review: [-2.25, 6.6], "meeting-b": [-8.75, -7.8],
  "executive-studio": [-2, -0.1], "multi-engine": [0, -6.9], sanctuary: [-2, -3.7], flex: [-2, -3.7],
  research: [-1, -3.7], "sky-lounge": [-2, -6.9], fitness: [6, 0.9], lounge: [3.8, -0.3]
});
export function relocateRoomPoint(roomId: string, point: readonly [number, number, number]): Point3 {
  const [dx, dz] = ROOM_RELOCATIONS[roomId] ?? [0, 0];
  return [point[0] + dx, point[1], point[2] + dz];
}
