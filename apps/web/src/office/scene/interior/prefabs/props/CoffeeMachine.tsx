export function CoffeeMachine({
  position = [0, 0, 0]
}: {
  position?: [number, number, number];
}) {
  return (
    <group position={position}>
      <mesh position={[0, 0.26, 0]}>
        <boxGeometry args={[0.42, 0.52, 0.38]} />
        <meshStandardMaterial color="#3f484d" metalness={0.35} roughness={0.45} />
      </mesh>
      <mesh position={[0, 0.35, 0.195]}>
        <boxGeometry args={[0.22, 0.1, 0.015]} />
        <meshStandardMaterial color="#8db3b2" />
      </mesh>
    </group>
  );
}
