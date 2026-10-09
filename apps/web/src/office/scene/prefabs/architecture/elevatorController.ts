/** Independent on-demand cabs with reserved standing places and one doorway token. */
import { FLOOR_HEIGHT, OFFICE_BUILDING } from "../../layout";

export type ElevatorFloor = 1 | 2 | 3;
export type ElevatorId = "A" | "B";
export type ElevatorPhase = "idle" | "dispatching" | "opening" | "boarding" | "closing" | "riding" | "alighting";
export const ELEVATOR_FLOOR_HEIGHT = FLOOR_HEIGHT;
export const ELEVATOR_CAPACITY = 3;
/** Back places fill first. The center aisle stays clear for the doorway. */
export const ELEVATOR_STANDING_SLOTS = [[0.675, -0.9], [0.675, 0.9], [-0.475, 0.9]] as const;
const geometry = {
  x: OFFICE_BUILDING.east + 1.925, doorX: OFFICE_BUILDING.east + 0.15, approachX: OFFICE_BUILDING.east - 1.1, doorWidth: 1.4,
  shaftWidth: 3, shaftDepth: 3, cabWidth: 2.6, cabDepth: 2.6, cabHeight: 2.45,
  travelSecondsPerFloor: 3.2, doorSeconds: 0.85
} as const;
// Center the complete pair on the building depth, retaining a 40 cm shaft gap.
const elevatorCenterZ = (OFFICE_BUILDING.north + OFFICE_BUILDING.south) / 2;
const elevatorHalfSpacing = (geometry.shaftDepth + 0.4) / 2;
export const GLASS_ELEVATORS = [
  { ...geometry, id: "A", z: elevatorCenterZ - elevatorHalfSpacing },
  { ...geometry, id: "B", z: elevatorCenterZ + elevatorHalfSpacing }
] as const;
export const GLASS_ELEVATOR = GLASS_ELEVATORS[0]!;
export function getElevatorGeometry(id: ElevatorId = "A") { return GLASS_ELEVATORS[id === "A" ? 0 : 1]!; }

