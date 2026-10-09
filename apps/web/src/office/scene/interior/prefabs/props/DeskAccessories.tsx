import { useCoffeeCupHeldAtDesk } from "../../FurnishedFloorContext";

export function MouseAndPad({
  position = [0, 0, 0],
  rotationY = 0,
  scale = 1
}: {
  position?: [number, number, number];
  rotationY?: number;
  scale?: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]} scale={scale}>
      {/* Double-layer stitched desk mat. */}
      <mesh receiveShadow>
        <boxGeometry args={[0.35, 0.012, 0.25]} />
        <meshStandardMaterial color="#222b30" roughness={0.88} />
      </mesh>
      <mesh position={[0, 0.007, 0]}>
        <boxGeometry args={[0.331, 0.003, 0.231]} />
        <meshStandardMaterial color="#34464b" roughness={0.76} />
      </mesh>
      <mesh position={[0.055, 0.035, -0.004]} receiveShadow scale={[0.056, 0.029, 0.081]}>
        <sphereGeometry args={[1, 20, 14]} />
        <meshStandardMaterial color="#3c484e" metalness={0.28} roughness={0.34} />
      </mesh>
      {/* Split buttons, center seam and scroll wheel make the pointer readable at scene scale. */}
      <mesh position={[0.041, 0.066, -0.035]} rotation={[-0.08, 0, 0]}>
        <boxGeometry args={[0.018, 0.003, 0.031]} />
        <meshStandardMaterial color="#637177" roughness={0.42} />
      </mesh>
      <mesh position={[0.069, 0.066, -0.035]} rotation={[-0.08, 0, 0]}>
        <boxGeometry args={[0.018, 0.003, 0.031]} />
        <meshStandardMaterial color="#637177" roughness={0.42} />
      </mesh>
      <mesh position={[0.055, 0.067, -0.027]}>
        <boxGeometry args={[0.008, 0.009, 0.025]} />
        <meshStandardMaterial color="#151d21" roughness={0.4} />
      </mesh>
      <mesh position={[0.055, 0.070, -0.027]}>
        <boxGeometry args={[0.007, 0.004, 0.012]} />
        <meshStandardMaterial color="#8cc7bd" emissive="#367b71" emissiveIntensity={0.35} />
      </mesh>
    </group>
  );
}

/** Small personal items keep a compact desk styled without covering its active work area. */
export function DeskAccessorySet({
  topY = 0.785,
  mousePosition = [0.48, 0, 0.18],
  mouseScale = 1,
  cup = true,
  stationery = true,
  resourceId
}: {
  topY?: number;
  mousePosition?: [number, number, number];
  mouseScale?: number;
  cup?: boolean;
  stationery?: boolean;
  resourceId?: string;
}) {
  const cupHeld = useCoffeeCupHeldAtDesk(resourceId);
  return (
    <group>
      <MouseAndPad position={[mousePosition[0], topY + 0.006, mousePosition[2]]} scale={mouseScale} />
      {cup && !cupHeld && (
        <group position={[-0.64, topY, 0.18]} userData={{ officeDynamic: true }}>
          <mesh receiveShadow position={[0, 0.055, 0]}>
            <cylinderGeometry args={[0.05, 0.046, 0.11, 20]} />
            <meshStandardMaterial color="#ddd6ca" roughness={0.28} />
          </mesh>
          <mesh position={[0, 0.108, 0]}>
            <torusGeometry args={[0.046, 0.006, 8, 20]} />
            <meshStandardMaterial color="#f1ece3" roughness={0.27} />
          </mesh>
          <mesh position={[0, 0.105, 0]}>
            <cylinderGeometry args={[0.039, 0.039, 0.003, 20]} />
            <meshStandardMaterial color="#76533b" roughness={0.26} />
          </mesh>
          <mesh position={[0.052, 0.06, 0]}>
            <torusGeometry args={[0.031, 0.007, 8, 16]} />
            <meshStandardMaterial color="#ddd6ca" roughness={0.32} />
          </mesh>
          <mesh position={[0, 0.014, 0]}>
            <cylinderGeometry args={[0.049, 0.046, 0.012, 20]} />
            <meshStandardMaterial color="#b8afa2" roughness={0.38} />
          </mesh>
        </group>
      )}
      {stationery && (
        <group position={[0.67, topY, -0.20]}>
          <mesh position={[0, 0.055, 0]}>
            <cylinderGeometry args={[0.052, 0.044, 0.11, 16]} />
            <meshStandardMaterial color="#39464a" roughness={0.52} />
          </mesh>
          {([[-0.022, 0.15, -0.01], [0.005, 0.17, 0.008], [0.025, 0.145, -0.004]] as const).map(([x, y, z], index) => (
            <group key={index} position={[x, y, z]} rotation={[0, 0, index === 1 ? 0.06 : -0.08]}>
              <mesh position={[0, -0.035, 0]}>
                <cylinderGeometry args={[0.004, 0.004, 0.14, 8]} />
                <meshStandardMaterial color={["#be7556", "#527f82", "#d2af70"][index]} roughness={0.52} />
              </mesh>
              <mesh position={[0, 0.04, 0]}>
                <coneGeometry args={[0.004, 0.018, 8]} />
                <meshStandardMaterial color="#272c2d" roughness={0.55} />
              </mesh>
            </group>
          ))}
        </group>
      )}
    </group>
  );
}
