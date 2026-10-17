import { useSolarEnvironment } from "../../../Environment";
import { F3_LAYOUT } from "../../floor1Layout";
import { OFFICE_BUILDING, OFFICE_STAIR_LAYOUT } from "../../../layout";
import { FixtureSpotLight } from "./FixtureSpotLight";
import { ceilingMountsForFloor, raisedDownlightAngle, raisedDownlightIntensity, raisedDownlightRange } from "./ceilingMounting";

type Row = {
  id: string; center: [number, number]; size: [number, number]; axis: "x" | "z"; stops: number[];
  /** `false` when the row sits inside a room that already has its own ceiling soffit. */
  ceiling?: boolean;
};
const ARRIVAL: Row = { id: "stair-arrival-bridge", center: [18.2, -16.55], size: [14.4, 4.8], axis: "x", stops: [13.2, 16.5, 19.8, 23.2] };
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
  return { id: "east-core-hall", center: [(CORE_WEST + CORE_EAST) / 2, (CORE_NORTH + south) / 2],
    size: [CORE_EAST - CORE_WEST, south - CORE_NORTH], axis: "z", stops, ceiling };
}

/** Real circulation paths, separate from room lighting and stair voids. */
export const CIRCULATION_LIGHT_ROWS: Record<1 | 2 | 3, readonly Row[]> = {
  1: [ARRIVAL,
    { id: "shared-facilities-corridor", center: [2, 10], size: [46, 2.8], axis: "x", stops: SOUTH_STOPS },
    { id: "east-circulation", center: [16.8, -3], size: [3.6, 27.2], axis: "z", stops: [-16, -12, -8, -4, 0, 4, 8, 10] },
    // Inside the open lounge, which already has its own ceiling.
    coreHall(8.6, [-4.4, -0.6, 3.2, 6.9], false)],
  2: [ARRIVAL,
    { id: "executive-collaboration-corridor", center: [-1.2, -8.2], size: [39.6, 3.2], axis: "x", stops: [-19.5, -15, -10.5, -6, -1.5, 3, 7.5, 11, 14.5, 17.5] },
    { id: "knowledge-review-corridor", center: [2, 9], size: [46, 3.2], axis: "x", stops: SOUTH_STOPS },
    { id: "east-circulation", center: [16.8, -3], size: [3.6, 27.2], axis: "z", stops: [-16, -12, -8, -4, 0, 4, 8, 10.2] },
    coreHall(7.4, [-4.4, -0.8, 2.8, 5.9])],
  3: [ARRIVAL,
    { id: "studio-lab-corridor", center: [-1.2, NORTH_3], size: [39.6, 3.3], axis: "x", stops: [-19.5, -15, -10.5, -6, -1.5, 3, 7.5, 11, 14.5, 17.5] },
    { id: "research-terrace-corridor", center: [2, SOUTH_3], size: [46, 3.2], axis: "x", stops: SOUTH_STOPS },
    { id: "east-circulation", center: [16.8, -6.4], size: [3.6, 24.2], axis: "z", stops: [-16, -12, -8, -4, 0, 3.2, 5.2] },
    coreHall(5.7, [-4.4, -1.1, 2.2, 4.8]),
    { id: "stair-void-ceiling-f3", center: [21.8, -10.2], size: [6.4, 8], axis: "z", stops: [-13.2, -10.2, -7.2], ceiling: true },
    { id: "terrace-door-passage", center: [1, 8.35], size: [3.2, 9.3], axis: "z", stops: [4.8, 8.5, 11.9] },
    { id: "wellness-approach", center: [15, 4.7], size: [20, 2], axis: "x", stops: [7.5, 13, 18.5, 23] }]
};

/** Low-output recessed lenses keep corridors legible but quieter than 96-intensity room panels. */
export function CirculationLighting({ floor }: { floor: 1 | 2 | 3 }) {
  const { state } = useSolarEnvironment();
  const factor = state.factors.interiorLightFactor;
  const { anchorY, sourceY } = ceilingMountsForFloor(floor).corridor;
  return <group name={`circulation-lighting-f${floor}`} userData={{ officeCollision: false }}>
    {CIRCULATION_LIGHT_ROWS[floor].map(row => <group key={row.id} name={`corridor:${row.id}`}
      position={[row.center[0], 0, row.center[1]]} userData={{ officeLightZone: row.size }}>
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
            aim={[0, -anchorY, 0]} intensity={raisedDownlightIntensity(row.id === "stair-arrival-bridge" ? factor * 28 : factor * 24, 2.757, sourceY, 0, 5.2)}
            distance={raisedDownlightRange(5.2, 2.757, sourceY)}
            angle={raisedDownlightAngle(1, 2.757, sourceY)} color="#fff0db" />
        </group>;
      })}
    </group>)}
  </group>;
}
