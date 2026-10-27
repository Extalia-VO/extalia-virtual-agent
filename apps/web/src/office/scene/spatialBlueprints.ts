export type XZ = readonly [number, number];
export const OUTDOOR_FACILITIES_BLUEPRINT = Object.freeze({
  groundY: 0,
  /** Kept off the transverse planter-access walk at z=-28.5. */
  forecourtLamps: [
    { x: -5.2, z: -30 }, { x: 5.2, z: -30 },
    { x: -5.2, z: -22.8 }, { x: 5.2, z: -22.8 }
  ],
  zones: [
    { id: "outdoor-forecourt", label: "Forecourt garden benches", center: [0, -25] as XZ, size: [23, 7] as const, door: [0, -23] as XZ },
    { id: "outdoor-west-garden", label: "West garden seating", center: [-26, 8.5] as XZ, size: [5, 5] as const, door: [-23.5, 8.5] as XZ },
    { id: "outdoor-east-garden", label: "East garden seating", center: [33, 8.5] as XZ, size: [6, 5] as const, door: [30, 8.5] as XZ },
    { id: "outdoor-cafe", label: "Campus cafe", center: [-30.2, -22.8] as XZ, size: [8.8, 11.6] as const, door: [-25.8, -21.6] as XZ },
    { id: "outdoor-rear-patio", label: "Rear garden patio", center: [0, 27] as XZ, size: [15, 8] as const, door: [0, 23] as XZ }
  ],
  plinthBenches: [
    { id: "outdoor.forecourt-west", roomId: "outdoor-forecourt", position: [-7.6, 0, -23.2] as const, rotationY: Math.PI },
    { id: "outdoor.forecourt-east", roomId: "outdoor-forecourt", position: [7.6, 0, -23.2] as const, rotationY: Math.PI },
    { id: "outdoor.rear-bench", roomId: "outdoor-rear-patio", position: [0, 0, 28.8] as const, rotationY: Math.PI }
  ],
  parkBenches: [
    { id: "outdoor.west-bench", roomId: "outdoor-west-garden", position: [-26, 0, 8.5] as const, rotationY: Math.PI / 2 },
    { id: "outdoor.east-bench", roomId: "outdoor-east-garden", position: [33, 0, 8.5] as const, rotationY: -Math.PI / 2 }
  ],
  arrivalGardens: [
    { id: "outdoor.arrival-west", position: [-8.8, 0, -26] as const },
    { id: "outdoor.arrival-east", position: [8.8, 0, -26] as const }
  ],
  picnicTables: [
    { id: "outdoor.cafe-table-1", position: [-29, 0, -23.3] as const, rotationY: Math.PI / 2 },
    { id: "outdoor.cafe-table-2", position: [-29, 0, -19.9] as const, rotationY: Math.PI / 2 }
  ],
  patios: [
    { id: "outdoor.patio-west", position: [-5.2, 0, 25.5] as const, canopy: "#d9d3c4" },
    { id: "outdoor.patio-east", position: [5.2, 0, 25.5] as const, canopy: "#cdd3c9" }
  ],
  cafeKiosk: { position: [-33, 0, -21.6] as const, rotationY: Math.PI / 2, customerTarget: [0, 1.9] as XZ },
  cafeDeck: { position: [-30.2, 0, -21.6] as const, size: [8.8, 7.6] as const },
  gardenArt: { position: [-34.2, -0.24, -25.4] as const, rotationY: 0.5, viewPoint: [-34.2, 0, -27.5] as const },
  /** Lamps flank the seating approach instead of occupying the sit/stand aisle. */
  parkBenchLamps: [
    { x: -25, z: 10.5 },
    { x: 32, z: 10.5 }
  ],
  seatSlots: [-0.5, 0.5] as const,
  gardenSeatSlots: [-1.9, 0, 1.9] as const,
  picnicSeatSlots: [-0.48, 0.48] as const,
  picnicSeatSides: [-1.35, 1.35] as const,
  patioChairAngles: [0, Math.PI] as const,
  parkSeatCenterZ: 0.12,
  plinthSeatHeight: 0.425,
  parkSeatHeight: 0.47,
  gardenSeatZ: -1.16,
  gardenSeatHeight: 0.595,
  picnicSeatHeight: 0.465,
  patioSeatHeight: 0.47,
  patioChairRadius: 1.55
});

/** Explicit location strings can identify an outdoor zone or one particular resource. */
export function outdoorRoomForLocation(location: string): string | undefined {
  const value = location.toLowerCase();
  const zone = OUTDOOR_FACILITIES_BLUEPRINT.zones.find(zone => value.includes(zone.id));
  if (zone) return zone.id;
  if (value.includes("outdoor.cafe") || value.includes("campus-cafe")) return "outdoor-cafe";
  if (value.includes("outdoor.west")) return "outdoor-west-garden";
  if (value.includes("outdoor.east")) return "outdoor-east-garden";
  if (value.includes("outdoor.patio") || value.includes("outdoor.rear")) return "outdoor-rear-patio";
  if (value.includes("outdoor.forecourt") || value.includes("outdoor.arrival")) return "outdoor-forecourt";
  return undefined;
}
