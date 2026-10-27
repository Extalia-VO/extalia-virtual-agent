import { InteriorPart } from '../../InteriorPart';
export function Plant({
  position = [0, 0, 0],
  scale = 1
}: {
  position?: [number, number, number];
  scale?: number;
}) {
  const leaves = [
    { position: [-0.14, 0.68, 0.02] as [number, number, number], rotation: [0, 0, -0.42] as [number, number, number], scale: [0.13, 0.25, 0.11] as [number, number, number], color: "#6f9272" },
    { position: [0.13, 0.77, 0.02] as [number, number, number], rotation: [0, 0, 0.4] as [number, number, number], scale: [0.13, 0.27, 0.11] as [number, number, number], color: "#789879" },
    { position: [-0.03, 0.91, 0.02] as [number, number, number], rotation: [0, 0, -0.08] as [number, number, number], scale: [0.12, 0.29, 0.1] as [number, number, number], color: "#5e8066" },
    { position: [0.2, 0.59, -0.03] as [number, number, number], rotation: [0, 0, 0.62] as [number, number, number], scale: [0.12, 0.23, 0.1] as [number, number, number], color: "#789879" },
    { position: [-0.2, 0.55, -0.03] as [number, number, number], rotation: [0, 0, -0.6] as [number, number, number], scale: [0.12, 0.22, 0.1] as [number, number, number], color: "#64866b" },
    { position: [0.03, 0.7, -0.12] as [number, number, number], rotation: [0.3, 0, 0.12] as [number, number, number], scale: [0.11, 0.24, 0.1] as [number, number, number], color: "#55765e" }
  ];

  return (
    <group position={position} scale={scale}><InteriorPart model="decor-plant" modelScale={[.85,.85,.85]}>
      <mesh position={[0, 0.035, 0]}>
        <cylinderGeometry args={[0.19, 0.16, 0.07, 20]} />
        <meshStandardMaterial color="#b9aa98" roughness={0.92} />
      </mesh>
      <mesh position={[0, 0.27, 0]}>
        <cylinderGeometry args={[0.205, 0.155, 0.43, 20, 1, true]} />
        <meshStandardMaterial color="#d8d0c4" roughness={0.83} side={2} />
      </mesh>
      <mesh position={[0, 0.48, 0]}>
        <cylinderGeometry args={[0.205, 0.205, 0.045, 20]} />
        <meshStandardMaterial color="#e1d9ce" roughness={0.85} />
      </mesh>
      <mesh position={[0, 0.51, 0]}>
        <cylinderGeometry args={[0.17, 0.17, 0.012, 16]} />
        <meshStandardMaterial color="#594d3e" roughness={1} />
      </mesh>
      {leaves.map((leaf, i) => (
        <mesh key={i} position={leaf.position} rotation={leaf.rotation} scale={leaf.scale}>
          <sphereGeometry args={[1, 12, 10]} />
          <meshStandardMaterial color={leaf.color} roughness={0.88} />
        </mesh>
      ))}
    </InteriorPart></group>
  );
}
