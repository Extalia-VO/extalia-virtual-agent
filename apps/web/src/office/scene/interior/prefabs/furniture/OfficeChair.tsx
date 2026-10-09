/** The seated person faces local +Z. The floor and seat anchors are shared by every workstation. */
export function OfficeChair({
  position = [0, 0, 0],
  rotationY = 0,
  highBack = false,
  color = "#516368"
}: {
  position?: [number, number, number];
  rotationY?: number;
  highBack?: boolean;
  color?: string;
}) {
  const backHeight = highBack ? 0.91 : 0.66;
  const frame = "#303b3c";
  const metal = "#77817f";

  return (
    <group position={position} rotation={[0, rotationY, 0]} userData={{ officeSeat: true }}>
      {/* Upholstered seat, piped edge and a thin under-seat shell. */}
      <mesh castShadow position={[0, 0.425, 0]}>
        <boxGeometry args={[0.61, 0.075, 0.58]} />
        <meshStandardMaterial color={frame} roughness={0.68} />
      </mesh>
      <mesh castShadow position={[0, 0.49, 0.015]}>
        <boxGeometry args={[0.58, 0.115, 0.55]} />
        <meshStandardMaterial color={color} roughness={0.92} />
      </mesh>
      <mesh position={[0, 0.475, 0.294]}>
        <boxGeometry args={[0.53, 0.025, 0.012]} />
        <meshStandardMaterial color="#83928d" roughness={0.78} />
      </mesh>

      {/* Slim surround makes the upholstered back read as a separate, contoured part. */}
      <mesh castShadow position={[0, 0.6 + backHeight / 2, -0.28]} rotation={[-0.08, 0, 0]}>
        <boxGeometry args={[0.61, backHeight, 0.085]} />
        <meshStandardMaterial color={frame} roughness={0.7} />
      </mesh>
      <mesh castShadow position={[0, 0.6 + backHeight / 2, -0.222]} rotation={[-0.08, 0, 0]}>
        <boxGeometry args={[0.53, backHeight - 0.085, 0.035]} />
        <meshStandardMaterial color={color} roughness={0.96} />
      </mesh>
      <mesh position={[0, 0.81, -0.199]}>
        <boxGeometry args={[0.44, 0.1, 0.028]} />
        <meshStandardMaterial color="#697b78" roughness={0.95} />
      </mesh>
      {highBack && (
        <mesh castShadow position={[0, 1.56, -0.28]}>
          <boxGeometry args={[0.34, 0.12, 0.09]} />
          <meshStandardMaterial color={color} roughness={0.94} />
        </mesh>
      )}

      {[-0.35, 0.35].map((x) => (
        <group key={x}>
          <mesh castShadow position={[x, 0.7, -0.08]}>
            <boxGeometry args={[0.04, 0.33, 0.045]} />
            <meshStandardMaterial color={metal} metalness={0.53} roughness={0.39} />
          </mesh>
          <mesh castShadow position={[x, 0.865, 0.035]}>
            <boxGeometry args={[0.085, 0.05, 0.33]} />
            <meshStandardMaterial color={frame} roughness={0.67} />
          </mesh>
        </group>
      ))}

      <mesh castShadow position={[0, 0.25, 0]}>
        <cylinderGeometry args={[0.048, 0.048, 0.4, 12]} />
        <meshStandardMaterial color={metal} metalness={0.62} roughness={0.37} />
      </mesh>
      <mesh castShadow position={[0, 0.405, 0]}>
        <cylinderGeometry args={[0.17, 0.12, 0.055, 16]} />
        <meshStandardMaterial color={frame} roughness={0.6} />
      </mesh>
      {Array.from({ length: 5 }).map((_, i) => (
        <group key={i} rotation={[0, (i / 5) * Math.PI * 2, 0]}>
          <mesh castShadow position={[0, 0.09, 0.215]}>
            <boxGeometry args={[0.065, 0.045, 0.43]} />
            <meshStandardMaterial color={frame} metalness={0.32} roughness={0.46} />
          </mesh>
          <mesh castShadow position={[0, 0.045, 0.43]}>
            <cylinderGeometry args={[0.046, 0.046, 0.06, 10]} />
            <meshStandardMaterial color="#242b2d" roughness={0.58} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

export function ExecutiveChair(
  props: Omit<Parameters<typeof OfficeChair>[0], "highBack">
) {
  return <OfficeChair {...props} highBack color="#d8d0c1" />;
}

export function GuestChair({
  position = [0, 0, 0],
  rotationY = 0
}: {
  position?: [number, number, number];
  rotationY?: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]} userData={{ officeSeat: true }}>
      <mesh castShadow position={[0, 0.425, 0]}>
        <boxGeometry args={[0.62, 0.06, 0.58]} />
        <meshStandardMaterial color="#62584e" roughness={0.78} />
      </mesh>
      <mesh castShadow position={[0, 0.49, 0.02]}>
        <boxGeometry args={[0.58, 0.115, 0.53]} />
        <meshStandardMaterial color="#d5c8b5" roughness={0.93} />
      </mesh>
      <mesh castShadow position={[0, 0.88, -0.26]} rotation={[-0.09, 0, 0]}>
        <boxGeometry args={[0.61, 0.65, 0.1]} />
        <meshStandardMaterial color="#d5c8b5" roughness={0.93} />
      </mesh>
      <mesh position={[0, 0.85, -0.195]}>
        <boxGeometry args={[0.51, 0.015, 0.006]} />
        <meshStandardMaterial color="#ad9d8c" roughness={0.94} />
      </mesh>
      {[-0.24, 0.24].flatMap((x) =>
        [-0.22, 0.22].map((z) => (
          <mesh key={`${x}-${z}`} castShadow position={[x, 0.21, z]}>
            <cylinderGeometry args={[0.024, 0.028, 0.42, 8]} />
            <meshStandardMaterial color="#515f5e" metalness={0.4} roughness={0.47} />
          </mesh>
        ))
      )}
    </group>
  );
}
