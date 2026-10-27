import { ArchitecturePart } from "../../ArchitecturePart";
import PROFILE from "../../architectureAssetProfile.json";

export function SolidWall({
  size,
  position = [0, 0, 0],
  color = "#f7f5f0"
}: {
  size: [number, number, number];
  position?: [number, number, number];
  color?: string;
}) {
  const [width, height, depth] = size;
  const alongZ = depth > width;
  const length = alongZ ? depth : width;
  const thickness = alongZ ? width : depth;
  const fullHeightPanel = length > 1 && height > 1.8 && thickness < 0.3;
  const profile = PROFILE.models["architecture-solid-wall"];
  return (
    <group position={position}>
      {fullHeightPanel ? (
        <group rotation={[0, alongZ ? Math.PI / 2 : 0, 0]}>
          <ArchitecturePart model="architecture-solid-wall" wallColor={color}
            modelScale={[length / profile.width, height / profile.height, thickness / profile.depth]}>
            <mesh castShadow receiveShadow>
              <boxGeometry args={[length, height, thickness]} />
              <meshStandardMaterial color={color} roughness={0.94} />
            </mesh>
            <mesh position={[0, -height / 2 + 0.88, thickness / 2 + 0.007]}>
              <boxGeometry args={[length - 0.06, 0.025, 0.012]} />
              <meshStandardMaterial color="#dbd3c5" roughness={0.84} />
            </mesh>
            <mesh position={[0, height / 2 - 0.13, thickness / 2 + 0.007]}>
              <boxGeometry args={[length - 0.06, 0.027, 0.012]} />
              <meshStandardMaterial color="#e0d8cb" roughness={0.84} />
            </mesh>
          </ArchitecturePart>
        </group>
      ) : (
        <mesh castShadow receiveShadow>
          <boxGeometry args={size} />
          <meshStandardMaterial color={color} roughness={0.94} />
        </mesh>
      )}
    </group>
  );
}
