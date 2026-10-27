import {
  canBoardElevator, canExitElevator, confirmElevatorBoarded, confirmElevatorExited, getElevatorGeometry,
  getElevatorStandingPosition, getElevatorWaitingSlot, releaseElevator, requestElevator,
} from '../prefabs/architecture/elevatorController';
import type { ElevatorAccess } from './mover';

const doors = Object.fromEntries((['A', 'B'] as const).map(id => {
  const geometry = getElevatorGeometry(id);
  return [id, Object.freeze({ x: geometry.doorX, z: geometry.z })];
})) as Record<'A' | 'B', { readonly x: number; readonly z: number }>;

/** Riders use the same controller that drives the rendered glass cabs and doors. */
export const liveElevatorAccess: ElevatorAccess = {
  request: (riderId, from, to, elevatorId) => { requestElevator({ riderId, from, to, elevatorId }, elevatorId); },
  waitingSlot: (riderId, elevatorId) => getElevatorWaitingSlot(riderId, elevatorId),
  canBoard: (riderId, elevatorId) => canBoardElevator(riderId, elevatorId),
  standingPosition: (riderId, elevatorId) => getElevatorStandingPosition(riderId, elevatorId),
  confirmBoarded: (riderId, elevatorId) => confirmElevatorBoarded(riderId, elevatorId),
  canExit: (riderId, elevatorId) => canExitElevator(riderId, elevatorId),
  confirmExited: (riderId, elevatorId) => confirmElevatorExited(riderId, elevatorId),
  release: (riderId, elevatorId) => { releaseElevator(riderId, elevatorId); },
  door: elevatorId => doors[elevatorId],
};
