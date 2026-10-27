/**
 * Shared local-space seat data for procedural upholstered furniture.
 * Visual meshes and semantic resources use the same dimensions and anchors.
 */
export const SOFA_SEAT_BLUEPRINT = Object.freeze({
  cushionSize: [0.91, 0.20, 0.67] as const,
  seatCenters: [
    { x: -0.47, y: 0.33, z: 0.055 },
    { x: 0.47, y: 0.33, z: 0.055 }
  ] as const,
  cushionHeight: 0.43,
  avatarRootForwardOffset: 0.10,
  seatFront: 0.67 / 2 - 0.10,
  approachDistance: 1.05
});

export const ARMCHAIR_SEAT_BLUEPRINT = Object.freeze({
  cushionSize: [0.66, 0.23, 0.65] as const,
  seatCenter: { x: 0, y: 0.335, z: 0.07 },
  cushionHeight: 0.45,
  avatarRootForwardOffset: 0.10,
  seatFront: 0.65 / 2 - 0.10,
  approachDistance: 1.0
});

/** Shared workstation chair dimensions and anchors (metres, chair-local). */
export const OFFICE_CHAIR_SEAT_BLUEPRINT = Object.freeze({
  cushionSize: [0.50, 0.11, 0.46] as const,
  cushionCenter: [0, 0.405, 0.015] as const,
  frameSize: [0.53, 0.06, 0.50] as const,
  frameCenter: [0, 0.365, 0] as const,
  cushionHeight: 0.46,
  rootForward: 0.02,
  seatFront: 0.46 / 2 + 0.015 - 0.02,
  taskBackHeight: 0.66,
  executiveBackHeight: 0.84,
  armOuterWidth: 0.64,
  armPadTop: 0.71,
  armPadSize: [0.08, 0.05, 0.30] as const,
  armPadZ: 0.035,
  backZ: -0.24,
  backThickness: 0.075,
  baseDiameter: 0.72
});

/** Guest chairs share the work-chair sitting height with a slightly wider cushion. */
export const GUEST_CHAIR_SEAT_BLUEPRINT = Object.freeze({
  cushionSize: [0.52, 0.11, 0.48] as const,
  cushionCenter: [0, 0.405, 0.02] as const,
  cushionHeight: 0.46,
  rootForward: 0.04,
  seatFront: 0.48 / 2 + 0.02 - 0.04
});
