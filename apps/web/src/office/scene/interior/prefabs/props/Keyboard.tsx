import { useEffect, useMemo } from "react";
import { InstancedMesh, Object3D, BoxGeometry, MeshStandardMaterial } from "three";
import { FULL_ALPHA_OFFSET, KEY_PITCH, KEYBOARD_DIMENSIONS, type KeyboardKind } from "../../deskLayout";
import { WorkstationPart } from "../../WorkstationPart";

// Real keycaps: 19 mm pitch, 16.5 mm caps.
const CAP_GEOMETRY = new BoxGeometry(0.0165, 0.012, 0.0165);
const CAP_MATERIAL = new MeshStandardMaterial({ color: "#89979c", roughness: 0.62, metalness: 0.08 });
const ACCENT_MATERIAL = new MeshStandardMaterial({ color: "#5e9995", roughness: 0.54, metalness: 0.12 });

interface Key { x: number; z: number; width: number; accent: boolean }

/** Five rows of a 75% board (function row, numbers, three letter rows) plus the space row, centred on the letter block. */
function letterBlock(): Key[] {
  const rows = [14, 14, 13, 13, 12];
  const keys: Key[] = [];
  rows.forEach((count, row) => {
    const z = (row - 2.5) * KEY_PITCH;  // six rows (with the space row) centred on the board
    for (let column = 0; column < count; column++) {
      keys.push({ x: (column - (count - 1) / 2) * KEY_PITCH, z, width: 1,
        accent: (row === 0 && column === 0) || (row === 4 && column === count - 1) });
    }
  });
  // Space row: modifiers either side of a long bar.
  const spaceZ = 2.5 * KEY_PITCH;
  for (const x of [-6, -5, -4, 4, 5, 6]) keys.push({ x: x * KEY_PITCH, z: spaceZ, width: 1, accent: false });
  keys.push({ x: 0, z: spaceZ, width: 6.6, accent: false });
  return keys;
}

/** Navigation cluster and number pad to the right of the letter block. */
function numberPad(offsetX: number, navX: number): Key[] {
  const keys: Key[] = [];
  for (let row = 1; row < 3; row++) for (let column = 0; column < 3; column++) {
    keys.push({ x: navX + (column - 1) * KEY_PITCH, z: (row - 2.5) * KEY_PITCH, width: 1, accent: false });
  }
  for (const [column, row] of [[1, 4], [0, 5], [1, 5], [2, 5]] as const) {
    keys.push({ x: navX + (column - 1) * KEY_PITCH, z: (row - 2.5) * KEY_PITCH, width: 1, accent: false });
  }
  for (let row = 0; row < 6; row++) for (let column = 0; column < 4; column++) {
    keys.push({ x: offsetX + (column - 1.5) * KEY_PITCH, z: (row - 2.5) * KEY_PITCH, width: 1, accent: row === 5 && column === 3 });
  }
  return keys;
}

/** Key layout in the keyboard frame (x right, z toward the typist), shared by both sizes. */
export function keyboardKeys(kind: KeyboardKind): Key[] {
  const { width } = KEYBOARD_DIMENSIONS[kind];
  // The letter block is 14 keys wide; a full board puts it left and the pad right.
  const letterX = kind === "full" ? FULL_ALPHA_OFFSET : 0;
  const padX = width / 2 - 0.012 - 2 * KEY_PITCH;
  return [
    ...letterBlock().map(key => ({ ...key, x: key.x + letterX })),
    ...(kind === "full" ? numberPad(padX, (letterX + 7 * KEY_PITCH + padX - 2 * KEY_PITCH) / 2) : []),
  ];
}

function createKeycaps(kind: KeyboardKind, accent: boolean) {
  const keys = keyboardKeys(kind).filter(key => key.accent === accent);
  const mesh = new InstancedMesh(CAP_GEOMETRY, accent ? ACCENT_MATERIAL : CAP_MATERIAL, keys.length);
  const transform = new Object3D();
  keys.forEach(({ x, z, width }, index) => {
    transform.position.set(x, 0, z);
    transform.scale.set(width === 1 ? 1 : (width * KEY_PITCH - 0.0025) / 0.0165, 1, 1);
    transform.updateMatrix();
    mesh.setMatrixAt(index, transform.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function Keyboard({
  position = [0, 0, 0],
  rotationY = 0,
  kind = "compact"
}: {
  position?: [number, number, number] | readonly [number, number, number];
  rotationY?: number;
  kind?: KeyboardKind;
}) {
  const keycaps = useMemo(() => createKeycaps(kind, false), [kind]);
  const accentKeys = useMemo(() => createKeycaps(kind, true), [kind]);
  useEffect(() => () => { keycaps.dispose(); accentKeys.dispose(); }, [keycaps, accentKeys]);
  const { width, depth } = KEYBOARD_DIMENSIONS[kind];

  return (
    <group position={[...position]} rotation={[0, rotationY, 0]} userData={{ officeDeskInput: "keyboard", kind }}>
      <WorkstationPart asset={`keyboard-${kind}`}>
      {/* Low-profile graphite chassis. */}
      <mesh receiveShadow>
        <boxGeometry args={[width, 0.028, depth]} />
        <meshStandardMaterial color="#202a30" metalness={0.22} roughness={0.42} />
      </mesh>
      <primitive object={keycaps} position={[0, 0.021, 0]} dispose={null} />
      <primitive object={accentKeys} position={[0, 0.021, 0]} dispose={null} />
      {/* Status light on the top bezel. */}
      <mesh position={[width / 2 - 0.03, 0.0145, -depth / 2 + 0.006]}>
        <boxGeometry args={[0.012, 0.002, 0.003]} />
        <meshStandardMaterial color="#75c5b6" emissive="#357a71" emissiveIntensity={0.24} />
      </mesh>
      </WorkstationPart>
    </group>
  );
}
