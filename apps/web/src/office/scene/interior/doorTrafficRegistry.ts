import { DoorTraffic, type DoorSource } from './doorTraffic';
import { forEachDoorPortal, forEachTrackedWalker } from './occupants/movingOccupants';

/** The mounted Office's doors and walkers, read from the live registries (one scene at a time). */
const source: DoorSource = {
  forEachDoor: visit => forEachDoorPortal((id, portal) => visit(id, portal)),
  forEachWalker: visit => forEachTrackedWalker((id, position, target, updatedAt) => visit({ id, position, target, updatedAt })),
};

export const doorTraffic = new DoorTraffic(source, () => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
