/**
 * Entertainment room (F1) layout, room-local (12.6 × 7.6 m, origin at the room centre).
 * North (-Z) is the solid corridor wall with the central door; south and east are
 * exterior glazing. West half: TV lounge; east half: game corner. Shared by the
 * rendered suite and the seat/station targets so both stay in step.
 */
export const ENTERTAINMENT_LAYOUT = Object.freeze({
  /** Authored room centre before relocation (resource coordinates use this frame). */
  authoredCenter: [15.0, 10.5] as const,
  tvX: -3.4,
  wallZ: -3.67,
  sofa: [-4.0, 1.3] as const,
  armchair: [-1.7, 0.9] as const,
  table: [-3.4, -0.9] as const,
  miniBar: [-5.65, -2.3] as const,
  arcades: [3.6, 4.55] as const,
  arcadeZ: -3.38,
  foosball: [4.0, 1.0] as const
});

/** Room-local point → authored resource coordinates (relocated with the room later). */
export function entertainmentPoint(x: number, z: number): [number, number] {
  const [cx, cz] = ENTERTAINMENT_LAYOUT.authoredCenter;
  return [cx + x, cz + z];
}
