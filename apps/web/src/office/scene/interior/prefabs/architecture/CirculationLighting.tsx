import { useSolarEnvironment } from "../../../Environment";
import { F3_LAYOUT } from "../../floor1Layout";
import { FLOOR_HEIGHT, OFFICE_BUILDING, OFFICE_STAIR_LAYOUT } from "../../../layout";
import { FixtureSpotLight } from "./FixtureSpotLight";
import { ceilingMountsForFloor, raisedDownlightAngle, raisedDownlightIntensity, raisedDownlightRange } from "./ceilingMounting";

type Row = {
  id: string; center: [number, number]; size: [number, number]; axis: "x" | "z"; stops: number[];
  /** `false` when the row sits inside a room that already has its own ceiling soffit. */
  ceiling?: boolean;
  /** Optional expanded irradiance bounds so open-plan hall/stair cones are not hard-clipped at soffit edges. */
  lightZone?: [number, number];
  /** Optional floor-local target elevation and world floorY override (e.g. ceiling over stairwell void). */
  targetY?: number;
  floorY?: number;
  intensity?: number;
  range?: number;
};
const ARRIVAL: Row = {
  id: "stair-arrival-bridge", center: [18.2, -16.55], size: [14.4, 4.8], lightZone: [14.4, 9.2],
  axis: "x", stops: [13.2, 16.5, 19.8, 23.2], intensity: 44, range: 5.8
};
const SOUTH_STOPS = [-19.5, -15, -10.5, -6, -1.5, 3, 7.5, 12, 16.5, 21, 24];
const NORTH_3 = (F3_LAYOUT.sanctuary.north + F3_LAYOUT["multi-engine"].south) / 2;
const SOUTH_3 = (F3_LAYOUT.flex.south + F3_LAYOUT["executive-studio"].north) / 2;

/**
 * East core hall between the stair opening and the glass elevators. Without these the floor from the
 * stair foot to the elevator doors fell dark at night (the east corridor and the elevator landing
 * spots stop short of it). The row starts south of the upper-floor stair void.
 */
const CORE_WEST = OFFICE_STAIR_LAYOUT.westEdge, CORE_EAST = OFFICE_BUILDING.east;
const CORE_NORTH = OFFICE_STAIR_LAYOUT.voidSouthZ + 0.05;
function coreHall(south: number, stops: number[], ceiling = true): Row {
  const depth = south - CORE_NORTH;
  return { id: "east-core-hall", center: [(CORE_WEST + CORE_EAST) / 2, (CORE_NORTH + south) / 2],
    size: [CORE_EAST - CORE_WEST, depth], lightZone: [11.2, depth + 4.8], axis: "z", stops, ceiling, intensity: 42, range: 5.8 };
}

/** The four-metre apron west of the spine is circulation too, beyond the spine lenses' useful cone. */
function eastApron(south: number, ceiling = true): Row {
  const north = -16.6;
  return { id: "east-room-apron", center: [13, (north + south) / 2], size: [4, south - north],
    lightZone: [8, south - north + 4.8], axis: "z", stops: [-15, -11, -7, -3, 1, ...(south > 8 ? [5, 9] : [4.5])],
    ceiling, intensity: 30, range: 5.6 };
}

/** Real circulation paths, separate from room lighting and stair voids. */
export const CIRCULATION_LIGHT_ROWS: Record<1 | 2 | 3, readonly Row[]> = {
  1: [ARRIVAL,
    { id: "shared-facilities-corridor", center: [2, 10], size: [46, 2.8], lightZone: [46, 4.8], axis: "x", stops: SOUTH_STOPS },
    { id: "east-circulation", center: [16.8, -3], size: [3.6, 27.2], lightZone: [11.6, 30.4], axis: "z", stops: [-16, -12, -8, -4, 0, 4, 8], intensity: 40, range: 5.6 },
    eastApron(10.6, false),
    // Inside the open lounge, which already has its own ceiling.
    coreHall(8.6, [-4.4, -0.6, 3.2, 6.9], false)],
  2: [ARRIVAL,
    { id: "executive-collaboration-corridor", center: [-1.2, -8.2], size: [39.6, 3.2], lightZone: [42, 5.2], axis: "x", stops: [-19.5, -15, -10.5, -6, -1.5, 3, 7.5, 11, 14.5, 17.5] },
    { id: "knowledge-review-corridor", center: [2, 9], size: [46, 3.2], lightZone: [46, 5.2], axis: "x", stops: SOUTH_STOPS },
    { id: "east-circulation", center: [16.8, -3], size: [3.6, 27.2], lightZone: [11.6, 30.4], axis: "z", stops: [-16, -12, -8, -4, 0, 4, 8, 10.2], intensity: 40, range: 5.6 },
    eastApron(10.6),
    coreHall(7.4, [-4.4, -0.8, 2.8, 5.9])],
  3: [ARRIVAL,
    { id: "studio-lab-corridor", center: [-1.2, NORTH_3], size: [39.6, 3.3], lightZone: [42, 5.2], axis: "x", stops: [-19.5, -15, -10.5, -6, -1.5, 3, 7.5, 11, 14.5, 17.5] },
    { id: "research-terrace-corridor", center: [2, SOUTH_3], size: [46, 3.2], lightZone: [46, 5.2], axis: "x", stops: SOUTH_STOPS },
    { id: "east-circulation", center: [16.8, -6.4], size: [3.6, 24.2], lightZone: [11.6, 27.6], axis: "z", stops: [-16, -12, -8, -4, 0, 3.2, 5.2], intensity: 40, range: 5.6 },
    eastApron(5.7),
    coreHall(5.7, [-4.4, -1.1, 2.2, 4.8]),
    { id: "stair-void-ceiling-f3", center: [21.8, -10.2], size: [6.4, 8], lightZone: [10.4, 12], axis: "z",
      stops: [-13.2, -10.2, -7.2], ceiling: true, targetY: -FLOOR_HEIGHT / 2, floorY: FLOOR_HEIGHT, intensity: 48, range: 6.6 },
    { id: "terrace-door-passage", center: [1, 8.35], size: [3.2, 9.3], lightZone: [8, 11], axis: "z", stops: [4.8, 8.5, 11.9] },
    { id: "wellness-approach", center: [15, 4.7], size: [20, 2], lightZone: [22, 6.4], axis: "x", stops: [7.5, 13, 18.5, 23] }]
};

/** Low-output recessed lenses keep corridors legible while ensuring stairwell and core transitions stay well-lit. */
export function CirculationLighting({ floor }: { floor: 1 | 2 | 3 }) {
  const { state } = useSolarEnvironment();
  const factor = state.factors.interiorLightFactor;
  const { anchorY, sourceY } = ceilingMountsForFloor(floor).corridor;
  return <group name={`circulation-lighting-f${floor}`} userData={{ officeCollision: false }}>
    {CIRCULATION_LIGHT_ROWS[floor].map(row => {
      const targetY = row.targetY ?? 0;
      const baseIntensity = row.intensity ?? 36;
      const baseRange = row.range ?? 5.5;
      return <group key={row.id} name={`corridor:${row.id}`}
        position={[row.center[0], 0, row.center[1]]} userData={{ officeLightZone: row.lightZone ?? row.size }}>
        {row.stops.map((stop, i) => {
          const x = row.axis === "x" ? stop - row.center[0] : 0;
          const z = row.axis === "z" ? stop - row.center[1] : 0;
          return <group key={i} position={[x, anchorY, z]}>
            <mesh name="structural-corridor-housing" position={[0, 0.015, 0]}><cylinderGeometry args={[0.14, 0.14, 0.035, 12]} />
              <meshStandardMaterial color="#5a6464" metalness={0.45} roughness={0.5} /></mesh>
            <mesh position={[0, -0.008, 0]} userData={{ officeMaterialDynamic: "corridor-lens:interior:#fff0db:factor*1.2" }}>
              <cylinderGeometry args={[0.11, 0.11, 0.012, 12]} />
              <meshStandardMaterial color="#eee7db" emissive="#fff0db" emissiveIntensity={factor * 1.2} roughness={0.45} toneMapped={false} />
            </mesh>
            <FixtureSpotLight name={`corridor-downlight-f${floor}`} position={[0, sourceY - anchorY, 0]}
              aim={[0, targetY - anchorY, 0]}
              intensity={raisedDownlightIntensity(factor * baseIntensity, 2.757, sourceY, targetY, baseRange)}
              distance={raisedDownlightRange(baseRange, 2.757, sourceY, targetY)}
              angle={raisedDownlightAngle(1.05, 2.757, sourceY, targetY)}
              floorY={row.floorY} color="#fff0db" />
          </group>;
        })}
      </group>;
    })}
  </group>;
}
