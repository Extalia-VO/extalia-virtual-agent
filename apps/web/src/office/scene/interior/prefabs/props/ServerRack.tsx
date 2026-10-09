const SERVER_BAYS = Array.from({ length: 7 }, (_, index) => -0.76 + index * 0.25);

/** Floor-standing network rack with visible equipment, ventilation, and status LEDs. */
export function ServerRack({
  position = [0, 0, 0],
  rotationY = 0
}: {
  position?: [number, number, number];
  rotationY?: number;
}) {
  return (
    <group position={position} rotation-y={rotationY} name="server-rack">
      {/* Enclosed cabinet shell and its four structural rails. */}
      <mesh position={[0, 0, -0.01]}>
        <boxGeometry args={[0.84, 1.98, 0.88]} />
        <meshStandardMaterial color="#17232b" metalness={0.64} roughness={0.42} />
      </mesh>
      {[-0.47, 0.47].map((x) => (
        <mesh key={`rail-${x}`} position={[x, 0, 0]}>
          <boxGeometry args={[0.075, 2.18, 1.02]} />
          <meshStandardMaterial color="#34434b" metalness={0.76} roughness={0.3} />
        </mesh>
      ))}
      {[-0.99, 1.04].map((y) => (
        <mesh key={`cap-${y}`} position={[0, y, 0]}>
          <boxGeometry args={[1.0, 0.09, 1.02]} />
          <meshStandardMaterial color="#26353d" metalness={0.7} roughness={0.34} />
        </mesh>
      ))}
      <mesh position={[0, 0, -0.47]}>
        <boxGeometry args={[0.82, 2.0, 0.06]} />
        <meshStandardMaterial color="#202d34" metalness={0.55} roughness={0.48} />
      </mesh>

      {/* Seven rack-mounted switches and compute trays with real front-panel cues. */}
      {SERVER_BAYS.map((y, index) => (
        <group key={`bay-${index}`} position={[0, y, 0]}>
          <mesh position={[0, 0, 0.38]}>
            <boxGeometry args={[0.78, 0.205, 0.68]} />
            <meshStandardMaterial color={index % 2 ? "#263943" : "#30434c"} metalness={0.48} roughness={0.4} />
          </mesh>
          <mesh position={[0, 0, 0.735]}>
            <boxGeometry args={[0.76, 0.17, 0.035]} />
            <meshStandardMaterial color="#111b21" metalness={0.38} roughness={0.46} />
          </mesh>
          {/* Cooling slots across each device face. */}
          {[-0.20, -0.15, -0.10, -0.05, 0, 0.05].map((x) => (
            <mesh key={`vent-${x}`} position={[x, 0, 0.758]}>
              <boxGeometry args={[0.022, 0.085, 0.008]} />
              <meshStandardMaterial color="#6f838a" metalness={0.65} roughness={0.34} />
            </mesh>
          ))}
          <mesh position={[0.27, 0, 0.76]}>
            <boxGeometry args={[0.12, 0.1, 0.012]} />
            <meshStandardMaterial color="#202e35" metalness={0.52} roughness={0.38} />
          </mesh>
          <mesh position={[0.31, 0.018, 0.771]}>
            <boxGeometry args={[0.025, 0.025, 0.01]} />
            <meshStandardMaterial color={index % 3 === 0 ? "#39d98a" : "#39b8d8"} emissive={index % 3 === 0 ? "#1cba6a" : "#137fa8"} emissiveIntensity={0.65} toneMapped={false} />
          </mesh>
          <mesh position={[0.31, -0.025, 0.771]}>
            <boxGeometry args={[0.025, 0.018, 0.01]} />
            <meshStandardMaterial color={index === 4 ? "#ffbd58" : "#36515b"} emissive={index === 4 ? "#bd671e" : "#101b20"} emissiveIntensity={index === 4 ? 0.38 : 0.05} toneMapped={false} />
          </mesh>
        </group>
      ))}

      {/* Locking handles and casters make the cabinet read as movable data-center equipment. */}
      <mesh position={[-0.43, 0, 0.525]}>
        <boxGeometry args={[0.035, 0.52, 0.035]} />
        <meshStandardMaterial color="#91a0a5" metalness={0.86} roughness={0.22} />
      </mesh>
      <mesh position={[0.43, 0, 0.525]}>
        <boxGeometry args={[0.035, 0.52, 0.035]} />
        <meshStandardMaterial color="#91a0a5" metalness={0.86} roughness={0.22} />
      </mesh>
      {[-0.38, 0.38].flatMap((x) => [-0.4, 0.4].map((z) => (
        <mesh key={`caster-${x}-${z}`} position={[x, -0.965, z]}>
          <cylinderGeometry args={[0.055, 0.055, 0.08, 12]} />
          <meshStandardMaterial color="#18242a" metalness={0.62} roughness={0.38} />
        </mesh>
      )))}
      <mesh position={[0, 1.105, 0]}>
        <boxGeometry args={[0.55, 0.035, 0.56]} />
        <meshStandardMaterial color="#60747c" metalness={0.82} roughness={0.26} />
      </mesh>
    </group>
  );
}
