/** Shared world-space F1 room boundaries; furnishings retain room-local anchors. */
function room(west: number, east: number, north: number, south: number) {
  return Object.freeze({ west, east, north, south,
    center: [(west + east) / 2, (north + south) / 2] as const,
    size: [east - west, south - north] as const });
}

export const F1_LAYOUT = Object.freeze({
  lobby: room(-21, 11, -19, -11),
  engineering: room(-21, 11, -11, 8.6),
  lounge: room(11, 25, -11, 8.6),
  library: room(-21, -12.2, 11.4, 19),
  operations: room(-12.2, -4, 11.4, 19),
  "source-control": room(-4, 4.2, 11.4, 19),
  qa: room(4.2, 12.4, 11.4, 19),
  entertainment: room(12.4, 25, 11.4, 19)
});

export const F1_EMERGENCY_EXIT = Object.freeze({
  center: [-21, 0, 10] as const,
  width: 1.8,
  inside: [-20.1, 0, 10] as const,
  outside: [-22.2, 0, 10] as const
});

export const F2_LAYOUT = Object.freeze({
  executive: room(-21, -3, -19, -9.8),
  "mission-control": room(-3, 11, -19, -9.8),
  "meeting-a": room(-21, -5, -6.6, 7.4),
  "meeting-b": room(-5, 11, -6.6, 7.4),
  knowledge: room(-21, -9.5, 10.6, 19),
  review: room(-9.5, 2, 10.6, 19),
  architecture: room(2, 15.5, 10.6, 19),
  archive: room(15.5, 25, 10.6, 19)
});

export const F3_LAYOUT = Object.freeze({
  "sky-lounge": room(-21, -10.5, -19, -12.8),
  "multi-engine": room(-8.5, 11, -19, -12.8),
  sanctuary: room(-21, -11, -9.5, 0.5),
  flex: room(-11, -1, -9.5, 0.5),
  research: room(-1, 11, -9.5, 0.5),
  "executive-studio": room(-21, -3, 3.7, 13),
  fitness: room(5, 25, 5.7, 13)
});

/** Open sky above the rear F3 deck; shared by the roof, doors, furniture and seats. */
export const F3_TERRACE = Object.freeze({
  ...room(-21, 25, 13, 19),
  door: Object.freeze({ center: [1, 0, 13] as const, width: 2.4, height: 2.65 }),
  entryWest: -3,
  entryEast: 5,
  passageWest: -0.5,
  passageEast: 2.5,
  guardInset: 0.15,
  sofas: [
    { id: "rooftop-terrace.sofa-west", position: [-12, 0, 14.8] as const, rotationY: 0 },
    { id: "rooftop-terrace.sofa-east", position: [14, 0, 14.8] as const, rotationY: 0 }
  ],
  armchairs: [
    { id: "rooftop-terrace.armchair-1", position: [-15, 0, 17.3] as const, rotationY: Math.PI },
    { id: "rooftop-terrace.armchair-2", position: [-9, 0, 17.3] as const, rotationY: Math.PI },
    { id: "rooftop-terrace.armchair-3", position: [11, 0, 17.3] as const, rotationY: Math.PI },
    { id: "rooftop-terrace.armchair-4", position: [17, 0, 17.3] as const, rotationY: Math.PI }
  ],
  tables: [[-12, 0, 17.1], [14, 0, 17.1]] as const,
  // The west pair stands between the two stair arrivals (the Blender stair lands at z 13.6-16.1, the
  // three.js backup at its z 18.2 gate), so neither foot of the maintenance stair is blocked.
  planters: [[-19.6, 0, 16.95], [-17.7, 0, 16.95], [-5, 0, 17.8],
    [7, 0, 17.8], [23.6, 0, 14.5], [23.6, 0, 17.6]] as const
});
