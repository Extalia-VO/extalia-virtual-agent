/**
 * Shared local-space seat data for procedural upholstered furniture.
 * Visual meshes and semantic resources use the same dimensions and anchors.
 */
export const SOFA_SEAT_BLUEPRINT = Object.freeze({
  cushionSize: [0.91, 0.22, 0.67] as const,
  seatCenters: [
    { x: -0.47, y: 0.43, z: 0.055 },
    { x: 0.47, y: 0.43, z: 0.055 }
  ] as const,
  cushionHeight: 0.54,
  avatarRootForwardOffset: 0.10,
  approachDistance: 1.05
});

export const ARMCHAIR_SEAT_BLUEPRINT = Object.freeze({
  cushionSize: [0.66, 0.23, 0.65] as const,
  seatCenter: { x: 0, y: 0.45, z: 0.07 },
  cushionHeight: 0.565,
  avatarRootForwardOffset: 0.10,
  approachDistance: 1.0
});
