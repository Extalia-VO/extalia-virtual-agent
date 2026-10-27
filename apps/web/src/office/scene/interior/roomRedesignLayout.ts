import { EXECUTIVE_STUDIO_BLUEPRINT, EXECUTIVE_OFFICE_BLUEPRINT, MEETING_BLUEPRINTS, meetingSeatLayout } from "./spatialBlueprints";

export type ExecutiveRoomId = "executive" | "executive-studio";
export type MeetingRoomId = "meeting-a" | "meeting-b";

/** Room-local transforms shared by the visible interiors and interaction resources.
 * The entry stays on the existing shell; the centre aisle must remain unobstructed. */
function executiveLayout(roomId: ExecutiveRoomId) {
  const blueprint = roomId === "executive" ? EXECUTIVE_OFFICE_BLUEPRINT : EXECUTIVE_STUDIO_BLUEPRINT;
  return {
    roomCenter: blueprint.roomCenter,
    roomSize: blueprint.roomSize,
    desk: {
      position: [-4.4, 0, 0] as const,
      rotationY: blueprint.workstationRotationY,
      leaderSeat: blueprint.leaderSeat,
      guestSeats: blueprint.guestSeats,
      leaderStaging: [1.2, -0.6] as const,
      guestStaging: [-0.2, -1.2] as const,
      rug: { position: [-4.7, 0.105, 0] as const, size: [6.6, 6.4] as const }
    },
    lounge: {
      position: [3.4, 0, 0] as const,
      sofa: {
        position: [0, 0, -1.5] as const, rotationY: 0,
        // A three-cushion bench keeps the existing three allocatable VIP seats.
        seatXs: [-0.8, 0, 0.8] as const, seatLocalZ: 0.08,
        seatHeight: 0.43, seatDepth: 0.82, avatarRootForwardOffset: 0.10,
        size: [2.8, 1.0] as const, stagingDistance: 1.05
      },
      // Straight front entries clear each chair arm instead of cutting across it.
      armchairs: [
        { id: `${roomId}.lounge-chair-1`, position: [-2.1, 0, 0.35] as const, rotationY: Math.PI / 2, stagingOffset: [0, 1.05] as const },
        { id: `${roomId}.lounge-chair-2`, position: [1.65, 0, 1.7] as const, rotationY: Math.PI, stagingOffset: [0, 1.05] as const }
      ],
      coffeeTable: { position: [0.35, 0, 0.7] as const, size: [1.15, 0.65] as const },
      rug: { position: [0, 0.105, 0] as const, size: [5.9, 5.3] as const }
    },
    credenza: { position: [6.4, 0, -3.9] as const, rotationY: 0, size: [3.6, 0.65] as const },
    storage: { position: [8.5, 0, 1] as const, rotationY: -Math.PI / 2, size: [3.7, 0.55] as const },
    plants: [[-8.1, 0, -3.7], [7.8, 0, 3.6]] as const,
    fixtures: {
      deskLamp: [-4.1, 0.74, 1.6] as const,
      cornerLamp: [7.8, 0, -2.8] as const,
      standLamp: [6.8, 0, 2.8] as const
    },
    // The central arrival lane connects the unchanged doorway to both zones.
    entryAisle: { center: [-0.3, 0] as const, size: [2.8, blueprint.roomSize[1]] as const }
  };
}

export const EXECUTIVE_ROOM_LAYOUTS = Object.freeze({
  executive: executiveLayout("executive"),
  "executive-studio": executiveLayout("executive-studio")
});

function meetingLayout(roomId: MeetingRoomId) {
  const blueprint = MEETING_BLUEPRINTS[roomId];
  return {
    ...blueprint,
    roomSize: [16, 14] as const,
    chairs: meetingSeatLayout(blueprint.seats, blueprint.tableLength, blueprint.tableWidth).slice(0, blueprint.seats),
    rug: { position: [0.55, 0.105, 0.25] as const, size: [blueprint.tableLength + 2.1, 5.5] as const },
    // Furniture below is room-local; presentation targets remain furniture-local.
    credenza: { position: [4.9, 0, 5.9] as const, rotationY: Math.PI, size: [3.6, 0.65] as const },
    planters: [[7.05, 0, -5.9], [-6.9, 0, 5.85]] as const,
    fixtures: { standLamp: [7.0, 0, 4.8] as const },
    entryAisle: { center: [0, -4.9] as const, size: [3, 3.8] as const }
  };
}

export const MEETING_ROOM_LAYOUTS = Object.freeze({
  "meeting-a": meetingLayout("meeting-a"),
  "meeting-b": meetingLayout("meeting-b")
});
