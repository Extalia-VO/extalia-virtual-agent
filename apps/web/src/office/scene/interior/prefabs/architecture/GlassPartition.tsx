function GlassPanel({ x, panelWidth, height, metal }: { x: number; panelWidth: number; height: number; metal: string }) {
    const sections = Math.max(1, Math.ceil(panelWidth / 2.45));
    return (
      <group position={[x, 0, 0]}>
        <mesh receiveShadow>
          <boxGeometry args={[panelWidth, height, 0.028]} />
          <meshPhysicalMaterial color="#c5e2e4" transparent opacity={0.2} roughness={0.12} metalness={0.02} depthWrite={false} />
        </mesh>
        {[-1, 1].map((side) => (
          <mesh key={`rail-${side}`} castShadow position={[0, side * (height / 2 - 0.04), 0.035]}>
            <boxGeometry args={[panelWidth + 0.055, 0.08, 0.09]} />
            <meshStandardMaterial color={metal} metalness={0.48} roughness={0.38} />
          </mesh>
        ))}
        {Array.from({ length: sections + 1 }).map((_, i) => (
          <mesh key={`mullion-${i}`} castShadow position={[-panelWidth / 2 + i * panelWidth / sections, 0, 0.04]}>
            <boxGeometry args={[0.065, height, 0.085]} />
            <meshStandardMaterial color={metal} metalness={0.48} roughness={0.38} />
          </mesh>
        ))}
        <mesh position={[0, -height / 2 + 0.16, 0.055]}>
          <boxGeometry args={[panelWidth, 0.17, 0.025]} />
          <meshStandardMaterial color="#819493" roughness={0.58} />
        </mesh>
      </group>
    );
  }


/** Interior glazed wall with evenly spaced mullions and an open door bay with continuous top header & transom. */
export function GlassPartition({
  width,
  height = 2.55,
  position = [0, 1.275, 0],
  rotationY = 0,
  doorGap = 0,
  doorHeight = 2.15
}: {
  width: number;
  height?: number;
  position?: [number, number, number];
  rotationY?: number;
  doorGap?: number;
  doorHeight?: number;
}) {
  const sideWidth = doorGap > 0 ? Math.max(0.4, (width - doorGap) / 2) : width;
  const metal = "#526468";


  // Transom over the door opening so the top header rail is continuous and solid
  const transomHeight = height - doorHeight;

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {doorGap > 0 ? (
        <>
          <GlassPanel height={height} metal={metal} x={-(doorGap + sideWidth) / 2} panelWidth={sideWidth} />
          <GlassPanel height={height} metal={metal} x={(doorGap + sideWidth) / 2} panelWidth={sideWidth} />

          {/* Continuous top header rail spanning across the door gap */}
          <mesh castShadow position={[0, height / 2 - 0.04, 0.035]}>
            <boxGeometry args={[doorGap + 0.06, 0.08, 0.09]} />
            <meshStandardMaterial color={metal} metalness={0.48} roughness={0.38} />
          </mesh>

          {/* Transom glass panel filling the gap between top of door and wall ceiling */}
          {transomHeight > 0.05 && (
            <group position={[0, height / 2 - transomHeight / 2, 0]}>
              <mesh receiveShadow>
                <boxGeometry args={[doorGap, transomHeight, 0.028]} />
                <meshPhysicalMaterial
                  color="#c5e2e4"
                  transparent
                  opacity={0.2}
                  roughness={0.12}
                  metalness={0.02}
                  depthWrite={false}
                />
              </mesh>
              {/* Horizontal lintel / transom bar right above the door frame */}
              <mesh castShadow position={[0, -transomHeight / 2 + 0.03, 0.035]}>
                <boxGeometry args={[doorGap + 0.04, 0.06, 0.08]} />
                <meshStandardMaterial color={metal} metalness={0.48} roughness={0.38} />
              </mesh>
            </group>
          )}
        </>
      ) : (
        <GlassPanel height={height} metal={metal} x={0} panelWidth={width} />
      )}
    </group>
  );
}
