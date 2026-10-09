import { useMemo } from "react";
import { InstancedMesh, Object3D, BoxGeometry, MeshStandardMaterial } from "three";

const CAP_GEOMETRY = new BoxGeometry(0.027, 0.012, 0.022);
const CAP_MATERIAL = new MeshStandardMaterial({ color: "#89979c", roughness: 0.62, metalness: 0.08 });
const ACCENT_MATERIAL = new MeshStandardMaterial({ color: "#5e9995", roughness: 0.54, metalness: 0.12 });

const KEY_ROWS = [
  { count: 14, z: -0.056 },
  { count: 13, z: -0.029 },
  { count: 13, z: -0.002 },
  { count: 12, z: 0.025 }
];
const keyPositions = KEY_ROWS.flatMap(({ count, z }, row) =>
  Array.from({ length: count }, (_, column) => ({
    x: (column - (count - 1) / 2) * 0.035,
    z,
    accent: row === 0 && (column === 0 || column === count - 1) || row === 3 && column === count - 1
  })));

function createKeycaps(accent: boolean) {
  const positions = keyPositions.filter((key) => key.accent === accent);
  const mesh = new InstancedMesh(CAP_GEOMETRY, accent ? ACCENT_MATERIAL : CAP_MATERIAL, positions.length);
  const transform = new Object3D();
  positions.forEach(({ x, z }, index) => {
    transform.position.set(x, 0, z);
    transform.updateMatrix();
    mesh.setMatrixAt(index, transform.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function Keyboard({
  position = [0, 0, 0],
  rotationY = 0
}: {
  position?: [number, number, number];
  rotationY?: number;
}) {
  const keycaps = useMemo(() => createKeycaps(false), []);
  const accentKeys = useMemo(() => createKeycaps(true), []);

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* Low-profile graphite chassis with a soft front wrist rest. */}
      <mesh receiveShadow>
        <boxGeometry args={[0.56, 0.028, 0.19]} />
        <meshStandardMaterial color="#202a30" metalness={0.22} roughness={0.42} />
      </mesh>
      <mesh position={[0, 0.016, 0.069]}>
        <boxGeometry args={[0.53, 0.008, 0.035]} />
        <meshStandardMaterial color="#303b41" roughness={0.7} />
      </mesh>
      <primitive object={keycaps} position={[0, 0.021, 0]} dispose={null} />
      <primitive object={accentKeys} position={[0, 0.021, 0]} dispose={null} />
      <mesh position={[0, 0.022, 0.055]}>
        <boxGeometry args={[0.15, 0.012, 0.021]} />
        <meshStandardMaterial color="#89979c" roughness={0.62} metalness={0.08} />
      </mesh>
      <mesh position={[0, 0.020, -0.082]}>
        <boxGeometry args={[0.035, 0.003, 0.004]} />
        <meshStandardMaterial color="#75c5b6" emissive="#357a71" emissiveIntensity={0.24} />
      </mesh>
    </group>
  );
}
