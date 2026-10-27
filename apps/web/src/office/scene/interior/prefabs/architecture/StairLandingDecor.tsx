import { FLOOR_HEIGHT, OFFICE_STAIR_LAYOUT, OFFICE_BUILDING } from "../../../layout";
import { useSolarEnvironment } from "../../../Environment";
import { FixtureSpotLight } from "./FixtureSpotLight";

const LIGHT_COLOR = "#fff0db";
const LAMP_DYNAMIC = { officeMaterialDynamic: "stair-arrival-lamp:interior:#fff0db:factor*1.5" };

/** Common north-wall pocket, west of the corridor spine and the complete arrival bridge. */
export const STAIR_DECOR_LAYOUT = Object.freeze({
  planter: [OFFICE_STAIR_LAYOUT.corridorX - 1.55, 0, OFFICE_BUILDING.north + 0.62] as [number, number, number],
  lamp: [OFFICE_STAIR_LAYOUT.corridorX - 0.85, 0, OFFICE_BUILDING.north + 0.34] as [number, number, number],
  art: [OFFICE_STAIR_LAYOUT.corridorX - 1.45, 2.15, OFFICE_BUILDING.north + 0.07] as [number, number, number],
  planterRadius: 0.32,
  lampRadius: 0.18,
  artWidth: 1.4
});

function StairLandingLamp({ floor }: { floor: 1 | 2 | 3 }) {
  const { state } = useSolarEnvironment();
  const factor = state.factors.interiorLightFactor;
  return <group position={STAIR_DECOR_LAYOUT.lamp} name={`stair-arrival-lamp-f${floor}`}>
    <mesh position={[0, 0.035, 0]}><cylinderGeometry args={[0.16, 0.18, 0.07, 16]} />
      <meshStandardMaterial color="#343c3e" metalness={0.6} roughness={0.4} /></mesh>
    <mesh position={[0, 0.92, 0]}><cylinderGeometry args={[0.018, 0.018, 1.78, 10]} />
      <meshStandardMaterial color="#9b927d" metalness={0.7} roughness={0.35} /></mesh>
    <mesh position={[0, 1.82, 0]}><cylinderGeometry args={[0.13, 0.17, 0.16, 16]} />
      <meshStandardMaterial color="#666b67" metalness={0.45} roughness={0.5} /></mesh>
    <mesh position={[0, 1.735, 0]} userData={LAMP_DYNAMIC}>
      <cylinderGeometry args={[0.15, 0.15, 0.012, 16]} />
      <meshStandardMaterial color="#f4efe6" emissive={LIGHT_COLOR} emissiveIntensity={factor * 1.5} toneMapped={false} roughness={0.45} />
    </mesh>
    <FixtureSpotLight position={[0, 1.72, 0]} aim={[0, 0.04, 0.28]} intensity={42 * factor}
      color={LIGHT_COLOR} distance={4.2} angle={1.08} floorY={(floor - 1) * FLOOR_HEIGHT} name={`stair-arrival-pool-f${floor}`} />
  </group>;
}

function StairArtLight() {
  const { state } = useSolarEnvironment();
  const factor = state.factors.interiorLightFactor;
  return <group position={[0, 0.6, 0.24]} userData={{ officeCollision: false }}>
    <mesh position={[0, 0, -0.11]}><boxGeometry args={[0.07, 0.05, 0.22]} />
      <meshStandardMaterial color="#8b826d" metalness={0.65} roughness={0.45} /></mesh>
    <mesh><boxGeometry args={[0.68, 0.045, 0.075]} />
      <meshStandardMaterial color="#8b826d" metalness={0.65} roughness={0.45} /></mesh>
    <mesh position={[0, -0.026, 0]} userData={{ officeMaterialDynamic: "stair-art-lens:interior:#fff0db:factor*1.2" }}>
      <boxGeometry args={[0.6, 0.012, 0.055]} /><meshStandardMaterial color="#eee5d7" emissive={LIGHT_COLOR}
        emissiveIntensity={factor * 1.2} toneMapped={false} roughness={0.4} />
    </mesh>
    <FixtureSpotLight name="stair-arrival-art-wash" position={[0, -0.032, 0.14]}
      aim={[0, -1.65, 0.28]} intensity={factor * 16} distance={3.2} angle={1.08} color={LIGHT_COLOR} />
  </group>;
}

/** Mount inside the corresponding floor group; positions are floor-local, floor selects the world slab. */
export function StairLandingDecor({ floor = 1 }: { floor?: 1 | 2 | 3 }) {
  const accent = ["#708b7b", "#71808b", "#9b8c75"][floor - 1];
  return <group name={`stair-arrival-decor-f${floor}`}>
    {/* Conservative planter/foliage radius 0.32 m leaves 1.23 m to corridor centre x=16.8.
        Lamp edge leaves 0.67 m. Both exceed the 0.58 m swept-body corridor reserve;
        all footprints end west of floorConnectionX=17.9 and bridgeWestEdge=18.2. */}
    <group position={STAIR_DECOR_LAYOUT.planter} name="stair-arrival-planter">
      <mesh position={[0, 0.26, 0]}><cylinderGeometry args={[0.27, 0.21, 0.52, 16]} />
        <meshStandardMaterial color="#cec8ba" roughness={0.86} /></mesh>
      <mesh position={[0, 0.515, 0]}><cylinderGeometry args={[0.245, 0.245, 0.018, 16]} />
        <meshStandardMaterial color="#514536" roughness={1} /></mesh>
      <mesh position={[0, 0.96, 0]}><cylinderGeometry args={[0.012, 0.018, 0.87, 8]} />
        <meshStandardMaterial color="#5b6846" roughness={0.9} /></mesh>
      {Array.from({ length: 7 }, (_, i) => {
        const angle = i * 2.4;
        return <mesh key={i} position={[Math.cos(angle) * 0.105, 0.75 + i * 0.1, Math.sin(angle) * 0.105]}
          rotation={[0.25, angle, 0.4]} scale={[0.105, 0.19, 0.075]}>
          <sphereGeometry args={[1, 8, 6]} />
          <meshStandardMaterial color={i % 2 ? "#526b52" : "#748566"} roughness={0.92} />
        </mesh>;
      })}
    </group>
    <StairLandingLamp floor={floor} />
    <group position={STAIR_DECOR_LAYOUT.art} name="stair-arrival-wall-art">
      <StairArtLight />
      <mesh><boxGeometry args={[1.4, 0.85, 0.045]} />
        <meshStandardMaterial color="#887e6b" metalness={0.2} roughness={0.64} /></mesh>
      <mesh position={[0, 0, 0.026]}><boxGeometry args={[1.32, 0.77, 0.012]} />
        <meshStandardMaterial color="#eeeae0" roughness={0.94} /></mesh>
      <mesh position={[-0.25, -0.065, 0.036]}><boxGeometry args={[0.38, 0.46, 0.008]} />
        <meshStandardMaterial color={accent} roughness={0.94} /></mesh>
      <mesh position={[0.23, 0.04, 0.036]}><circleGeometry args={[0.23, 20]} />
        <meshStandardMaterial color="#c5b89c" roughness={0.94} /></mesh>
      <mesh position={[0.09, -0.22, 0.042]}><boxGeometry args={[0.72, 0.045, 0.008]} />
        <meshStandardMaterial color="#4d5b56" roughness={0.94} /></mesh>
    </group>
  </group>;
}
