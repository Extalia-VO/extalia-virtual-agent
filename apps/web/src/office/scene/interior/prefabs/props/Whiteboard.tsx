export function Whiteboard({
  position = [0, 0, 0],
  rotationY = 0,
  width = 2.0
}: {
  position?: [number, number, number];
  rotationY?: number;
  width?: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh>
        <boxGeometry args={[width + 0.1, 1.25, 0.085]} />
        <meshStandardMaterial color="#a6aaa3" roughness={0.52} metalness={0.18} />
      </mesh>
      <mesh position={[0, 0.035, 0.047]}>
        <boxGeometry args={[width - 0.03, 1.12, 0.012]} />
        <meshStandardMaterial color="#f7f8f7" roughness={0.35} />
      </mesh>
      <mesh position={[0, -0.63, 0.04]}>
        <boxGeometry args={[width + 0.02, 0.055, 0.12]} />
        <meshStandardMaterial color="#b3b7b1" roughness={0.52} metalness={0.16} />
      </mesh>
      <mesh position={[0, -0.59, 0.105]}>
        <boxGeometry args={[width * 0.15, 0.018, 0.025]} />
        <meshStandardMaterial color="#777e79" roughness={0.6} />
      </mesh>
      {[
        { x: -width * 0.23, y: 0.12, w: 0.35, color: "#d99186" },
        { x: 0, y: -0.1, w: 0.48, color: "#8faac0" },
        { x: width * 0.25, y: 0.18, w: 0.28, color: "#b5c993" }
      ].map((note, i) => (
        <mesh key={i} position={[note.x, note.y, 0.057]}>
          <boxGeometry args={[note.w, 0.025, 0.004]} />
          <meshStandardMaterial color={note.color} roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}
