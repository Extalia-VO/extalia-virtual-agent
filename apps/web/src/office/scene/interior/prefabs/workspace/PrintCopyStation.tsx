export function PrintCopyStation({
  position = [0, 0, 0],
  rotationY = 0
}: {
  position?: [number, number, number];
  rotationY?: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* Multifunction copier */}
      <group position={[-0.72, 0, 0]}>
        <mesh position={[0, 0.54, 0]}>
          <boxGeometry args={[0.82, 1.08, 0.72]} />
          <meshStandardMaterial color="#d9dcdd" roughness={0.76} />
        </mesh>
        <mesh position={[0, 1.14, -0.02]}>
          <boxGeometry args={[0.74, 0.16, 0.62]} />
          <meshStandardMaterial color="#303a40" roughness={0.48} />
        </mesh>
        <mesh position={[0.18, 1.21, 0.32]} rotation={[-0.25, 0, 0]}>
          <boxGeometry args={[0.22, 0.12, 0.03]} />
          <meshStandardMaterial
            color="#4b7886"
            emissive="#17313a"
            emissiveIntensity={0.45}
          />
        </mesh>
      </group>

      {/* Supply cabinet / paper storage */}
      <mesh position={[0.42, 0.48, 0]}>
        <boxGeometry args={[1.05, 0.96, 0.62]} />
        <meshStandardMaterial color="#c9c5bc" roughness={0.88} />
      </mesh>

      {/* Desktop printer on supply cabinet */}
      <group position={[0.42, 1.04, 0]}>
        <mesh>
          <boxGeometry args={[0.58, 0.30, 0.46]} />
          <meshStandardMaterial color="#4a555b" roughness={0.55} />
        </mesh>
        <mesh position={[0, 0.20, -0.03]}>
          <boxGeometry args={[0.46, 0.10, 0.34]} />
          <meshStandardMaterial color="#e1e3e3" roughness={0.7} />
        </mesh>
      </group>

      {/* Recycle bin */}
      <mesh position={[1.25, 0.31, 0.04]}>
        <cylinderGeometry args={[0.24, 0.20, 0.62, 12]} />
        <meshStandardMaterial color="#738188" roughness={0.82} />
      </mesh>
    </group>
  );
}
