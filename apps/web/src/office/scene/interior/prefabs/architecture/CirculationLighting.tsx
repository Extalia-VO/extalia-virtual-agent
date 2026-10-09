import { useSolarEnvironment } from "../../../Environment";
import { F3_LAYOUT } from "../../floor1Layout";
import { FixtureSpotLight } from "./FixtureSpotLight";
import { ceilingMountsForFloor, raisedDownlightAngle, raisedDownlightIntensity, raisedDownlightRange } from "./ceilingMounting";

type Row = { id: string; center: [number, number]; size: [number, number]; axis: "x" | "z"; stops: number[] };
const ARRIVAL: Row = { id: "stair-arrival-bridge", center: [18, -17.15], size: [14, 3.5], axis: "x", stops: [13.4, 18, 23] };
const SOUTH_STOPS = [-19.5, -15, -10.5, -6, -1.5, 3, 7.5, 12, 16.5, 21, 24];
const NORTH_3 = (F3_LAYOUT.sanctuary.north + F3_LAYOUT["multi-engine"].south) / 2;
const SOUTH_3 = (F3_LAYOUT.flex.south + F3_LAYOUT["executive-studio"].north) / 2;

/** Real circulation paths, separate from room lighting and stair voids. */
export const CIRCULATION_LIGHT_ROWS: Record<1 | 2 | 3, readonly Row[]> = {
  1: [ARRIVAL,
    { id: "shared-facilities-corridor", center: [2, 10], size: [46, 2.8], axis: "x", stops: SOUTH_STOPS },
    { id: "east-circulation", center: [16.8, -3], size: [3.6, 27.2], axis: "z", stops: [-16, -12, -8, -4, 0, 4, 8, 10] }],
  2: [ARRIVAL,
    { id: "executive-collaboration-corridor", center: [-5, -8.2], size: [32, 3.2], axis: "x", stops: [-19.5, -15, -10.5, -6, -1.5, 3, 7.5, 10] },
    { id: "knowledge-review-corridor", center: [2, 9], size: [46, 3.2], axis: "x", stops: SOUTH_STOPS },
    { id: "east-circulation", center: [16.8, -3.5], size: [3.6, 26], axis: "z", stops: [-16, -12, -8, -4, 0, 4, 8] }],
  3: [ARRIVAL,
    { id: "studio-lab-corridor", center: [-1.2, NORTH_3], size: [39.6, 3.3], axis: "x", stops: [-19.5, -15, -10.5, -6, -1.5, 3, 7.5, 12, 17] },
    { id: "research-terrace-corridor", center: [2, SOUTH_3], size: [46, 3.2], axis: "x", stops: SOUTH_STOPS },
    { id: "east-circulation", center: [16.8, -8], size: [3.6, 21], axis: "z", stops: [-16, -12, -8, -4, 0] },
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
            aim={[0, -anchorY, 0]} intensity={raisedDownlightIntensity(factor * 24, 2.757, sourceY, 0, 5.2)}
            distance={raisedDownlightRange(5.2, 2.757, sourceY)}
            angle={raisedDownlightAngle(1, 2.757, sourceY)} color="#fff0db" />
        </group>;
      })}
    </group>)}
  </group>;
}
