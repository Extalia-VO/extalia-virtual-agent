import { InteriorPart } from '../../InteriorPart';
import PROFILE from '../../interiorAssetProfile.json';
import { useSolarEnvironment } from "../../../Environment";
import { FixtureSpotLight } from "../architecture/FixtureSpotLight";
import { ceilingPendantDrop } from "../architecture/ceilingMounting";
import { useStructuralCeiling } from "../architecture/StructuralCeilingContext";

type Vec3 = [number, number, number];

/** Framed abstract art. The picture faces local +Z; position is its wall center. */
export function WallArt({
  position = [0, 0, 0], rotationY = 0, width = 1.05, height = 0.72,
  frameColor = "#b58a62", groundColor = "#eee7dc", accentColor = "#55756c"
}: {
  position?: Vec3; rotationY?: number; width?: number; height?: number;
  frameColor?: string; groundColor?: string; accentColor?: string;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}><InteriorPart model="wall-art" modelScale={[width/PROFILE.wallArt.width,height/PROFILE.wallArt.height,1]}>
      <mesh>
        <boxGeometry args={[width, height, 0.07]} />
        <meshStandardMaterial color={frameColor} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0, 0.038]}>
        <boxGeometry args={[width - 0.1, height - 0.1, 0.012]} />
        <meshStandardMaterial color={groundColor} roughness={0.85} />
      </mesh>
      <mesh position={[-width * 0.12, -height * 0.04, 0.05]} rotation={[0, 0, -0.36]}>
        <circleGeometry args={[Math.min(width, height) * 0.34, 24]} />
        <meshStandardMaterial color={accentColor} roughness={0.95} />
      </mesh>
      <mesh position={[width * 0.19, height * 0.08, 0.057]} rotation={[0, 0, 0.38]}>
        <circleGeometry args={[Math.min(width, height) * 0.21, 20]} />
        <meshStandardMaterial color="#c88f69" roughness={0.9} />
      </mesh>
      <mesh position={[width * 0.03, -height * 0.24, 0.06]} rotation={[0, 0, -0.12]}>
        <boxGeometry args={[width * 0.52, height * 0.045, 0.008]} />
        <meshStandardMaterial color="#d8b86d" roughness={0.9} />
      </mesh>
    </InteriorPart></group>
  );
}

/** Thin area rug. Position marks the supporting floor, with a 6 mm pile above it. */
export function AreaRug({
  position = [0, 0, 0], rotationY = 0, width = 2.8, depth = 1.9,
  color = "#c9b9a4", borderColor = "#a58d76"
}: {
  position?: Vec3; rotationY?: number; width?: number; depth?: number;
  color?: string; borderColor?: string;
}) {
  return (
    <group name="office-area-rug" position={position} rotation={[0, rotationY, 0]} userData={{ officeCollision: false }}>
      <mesh position={[0, 0.0025, 0]} receiveShadow>
        <boxGeometry args={[width, 0.005, depth]} />
        <meshStandardMaterial color={borderColor} roughness={1} />
      </mesh>
      <mesh position={[0, 0.003, 0]} receiveShadow>
        <boxGeometry args={[width - 0.12, 0.006, depth - 0.12]} />
        <meshStandardMaterial color={color} roughness={1} />
      </mesh>
      <mesh position={[0, 0.0055, 0]}>
        <boxGeometry args={[width * 0.58, 0.001, 0.025]} />
        <meshStandardMaterial color="#e2d6c5" roughness={1} />
      </mesh>
    </group>
  );
}

/** Suspended decorative pendant. Position is the canopy point at the ceiling. */
export function PendantLight({
  position = [0, 0, 0], drop = 0.72, color = "#d9c6a6"
}: { position?: Vec3; drop?: number; color?: string }) {
  const { state } = useSolarEnvironment();
  const interiorFactor = state.factors.interiorLightFactor;
  const emissiveIntensity = interiorFactor > 0 ? 0.5 + interiorFactor * 3.5 : 0;
  const { ceilingY } = useStructuralCeiling();
  const mountedDrop = ceilingPendantDrop(position[1], drop, ceilingY);

  return (
    <group position={[position[0], ceilingY, position[2]]}>
      <mesh name="structural-pendant-canopy" position={[0, -0.025, 0]}>
        <cylinderGeometry args={[0.09, 0.09, 0.05, 16]} />
        <meshStandardMaterial color="#777c76" metalness={0.55} roughness={0.4} />
      </mesh>
      <mesh position={[0, -mountedDrop / 2, 0]}>
        <cylinderGeometry args={[0.012, 0.008, mountedDrop, 8]} />
        <meshStandardMaterial color="#777c76" metalness={0.45} roughness={0.48} />
      </mesh>
      <InteriorPart model="pendant-light" position={[0, -mountedDrop, 0]}>
      <mesh>
        <cylinderGeometry args={[0.14, 0.4, 0.22, 24, 1, true]} />
        <meshStandardMaterial color={color} roughness={0.58} side={2} />
      </mesh>
      <mesh position={[0, -0.105, 0]} userData={{ officeDynamic: true }}>
        <cylinderGeometry args={[0.24, 0.24, 0.012, 24]} />
        <meshStandardMaterial
          color="#ffffff"
          emissive="#ffeacc"
          emissiveIntensity={emissiveIntensity}
          roughness={0.2}
          toneMapped={false}
        />
      </mesh>
      </InteriorPart>
      <FixtureSpotLight name="decorative-pendant-downlight" position={[0, -mountedDrop - 0.12, 0]}
        aim={[0, -ceilingY + 0.8, 0]} intensity={interiorFactor * 26} distance={4.5} angle={0.95} color="#ffeacc" />
    </group>
  );
}

/** Small wall plaque; place by its center with the face toward local +Z. */
export function RoomSign({
  position = [0, 0, 0], rotationY = 0, width = 0.9, label = "MEETING ROOM",
  color = "#526e65"
}: { position?: Vec3; rotationY?: number; width?: number; label?: string; color?: string }) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh>
        <boxGeometry args={[width, 0.28, 0.045]} />
        <meshStandardMaterial color="#c4b59e" roughness={0.75} />
      </mesh>
      <mesh position={[0, 0, 0.025]}>
        <boxGeometry args={[width - 0.045, 0.225, 0.012]} />
        <meshStandardMaterial color={color} roughness={0.78} />
      </mesh>
      {/* A simple raised nameplate bar keeps the sign legible at scene scale. */}
      <mesh position={[0, 0, 0.035]}>
        <boxGeometry args={[Math.min(width * 0.68, label.length * 0.035), 0.025, 0.006]} />
        <meshStandardMaterial color="#f4eee2" roughness={0.8} />
      </mesh>
    </group>
  );
}

/** Compact desk vignette with a book stack and ceramic bud vase. */
export function DeskObjects({
  position = [0, 0, 0], scale = 1
}: { position?: Vec3; scale?: number }) {
  return (
    <group position={position} scale={scale}><InteriorPart model="decor-vignette">
      <mesh position={[-0.11, 0.035, 0]} rotation={[0, 0, -0.025]}>
        <boxGeometry args={[0.34, 0.07, 0.24]} />
        <meshStandardMaterial color="#687d75" roughness={0.86} />
      </mesh>
      <mesh position={[-0.09, 0.1, 0]} rotation={[0, 0, 0.03]}>
        <boxGeometry args={[0.3, 0.055, 0.22]} />
        <meshStandardMaterial color="#d5b98d" roughness={0.85} />
      </mesh>
      <mesh position={[0.2, 0.09, 0]}>
        <cylinderGeometry args={[0.09, 0.12, 0.18, 14]} />
        <meshStandardMaterial color="#d6c7b4" roughness={0.52} />
      </mesh>
      <mesh position={[0.2, 0.235, 0]}>
        <cylinderGeometry args={[0.018, 0.025, 0.13, 8]} />
        <meshStandardMaterial color="#6f8c72" roughness={0.9} />
      </mesh>
      <mesh position={[0.16, 0.29, 0]} rotation={[0, 0, -0.45]}>
        <sphereGeometry args={[0.055, 10, 8]} />
        <meshStandardMaterial color="#789879" roughness={0.9} />
      </mesh>
    </InteriorPart></group>
  );
}
