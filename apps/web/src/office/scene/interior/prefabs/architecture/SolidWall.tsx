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
  const fullHeightPanel = width > 1 && height > 1.8 && depth < 0.3;
  return (
    <group position={position}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={size} />
        <meshStandardMaterial color={color} roughness={0.94} />
      </mesh>
      {fullHeightPanel && <>
        <mesh position={[0, -height / 2 + 0.88, depth / 2 + 0.007]}>
          <boxGeometry args={[width - 0.06, 0.025, 0.012]} />
          <meshStandardMaterial color="#dbd3c5" roughness={0.84} />
        </mesh>
        <mesh position={[0, height / 2 - 0.13, depth / 2 + 0.007]}>
          <boxGeometry args={[width - 0.06, 0.027, 0.012]} />
          <meshStandardMaterial color="#e0d8cb" roughness={0.84} />
        </mesh>
      </>}
    </group>
  );
}
