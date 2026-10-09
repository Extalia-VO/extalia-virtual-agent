/** Floor-height aluminum glazing with a warmer timber sill and transom. */
export function WindowWall({
  width,
  height = 2.7,
  position = [0, 1.35, 0],
  rotationY = 0,
  panels = 4
}: {
  width: number;
  height?: number;
  position?: [number, number, number];
  rotationY?: number;
  panels?: number;
}) {
  const frame = 0.075;
  const count = Math.max(1, panels);
  const panelW = width / count;
  const metal = "#61777a";

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {Array.from({ length: count }).map((_, i) => (
        <group key={i} position={[-width / 2 + panelW * (i + 0.5), 0, 0]}>
          <mesh position={[0, 0, 0]}>
            <boxGeometry args={[panelW - frame * 0.8, height - frame * 1.5, 0.025]} />
            <meshPhysicalMaterial color="#b7d8d8" transparent opacity={0.27} roughness={0.09} metalness={0.02} depthWrite={false} />
          </mesh>
          <mesh position={[-panelW * 0.2, height * 0.18, 0.022]} rotation={[0, 0, -0.12]}>
            <planeGeometry args={[panelW * 0.11, height * 0.38]} />
            <meshBasicMaterial color="#ffffff" transparent opacity={0.11} depthWrite={false} />
          </mesh>
        </group>
      ))}
      {[-1, 1].map((side) => (
        <mesh key={`horizontal-${side}`} castShadow position={[0, side * (height / 2 - frame / 2), 0.04]}>
          <boxGeometry args={[width, frame, 0.085]} />
          <meshStandardMaterial color={metal} metalness={0.52} roughness={0.36} />
        </mesh>
      ))}
      {Array.from({ length: count + 1 }).map((_, i) => (
        <mesh key={`mullion-${i}`} castShadow position={[-width / 2 + i * panelW, 0, 0.042]}>
          <boxGeometry args={[frame, height, 0.09]} />
          <meshStandardMaterial color={metal} metalness={0.52} roughness={0.36} />
        </mesh>
      ))}
      <mesh castShadow position={[0, -height * 0.13, 0.048]}>
        <boxGeometry args={[width, 0.045, 0.075]} />
        <meshStandardMaterial color="#8a9d9b" metalness={0.32} roughness={0.4} />
      </mesh>
      <mesh castShadow receiveShadow position={[0, -height / 2 + 0.04, 0.13]}>
        <boxGeometry args={[width + 0.2, 0.09, 0.3]} />
        <meshStandardMaterial color="#bda889" roughness={0.76} />
      </mesh>
    </group>
  );
}
