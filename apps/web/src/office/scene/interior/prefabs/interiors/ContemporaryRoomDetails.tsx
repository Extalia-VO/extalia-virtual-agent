import { BoxGeometry, CylinderGeometry, IcosahedronGeometry, MeshStandardMaterial } from "three";

type Vec3 = readonly [number, number, number];
const unitBox = new BoxGeometry(1, 1, 1);
const planterShape = new CylinderGeometry(0.28, 0.22, 0.54, 10);
const foliageShape = new IcosahedronGeometry(1, 0);
const materials = {
  walnut: new MeshStandardMaterial({ color: "#665044", roughness: 0.8 }),
  dark: new MeshStandardMaterial({ color: "#343936", roughness: 0.82 }),
  stone: new MeshStandardMaterial({ color: "#ded8cb", roughness: 0.84 }),
  brass: new MeshStandardMaterial({ color: "#a98d5d", metalness: 0.55, roughness: 0.55 }),
  fabric: new MeshStandardMaterial({ color: "#c5bbaa", roughness: 1 }),
  olive: new MeshStandardMaterial({ color: "#69786d", roughness: 1 }),
  ink: new MeshStandardMaterial({ color: "#3d535b", roughness: 1 }),
  clay: new MeshStandardMaterial({ color: "#b78066", roughness: 1 }),
  leaf: new MeshStandardMaterial({ color: "#49634a", roughness: 0.95 })
};
type Finish = keyof typeof materials;

/** Shared flat geometry/materials are collected by the scene's static batching. */
export function InteriorBox({ position, size, finish = "walnut" }: {
  position: Vec3; size: Vec3; finish?: Finish;
}) {
  return <mesh geometry={unitBox} material={materials[finish]} position={[...position]}
    scale={[...size]} dispose={null} />;
}

/** Low-profile rugs do not become obstacles in the seat approach paths. */
export function ZonedRug({ position, size, cool = false }: {
  position: Vec3; size: readonly [number, number]; cool?: boolean;
}) {
  return <group position={[...position]} userData={{ officeCollision: false }}>
    <InteriorBox position={[0, 0, 0]} size={[size[0], 0.025, size[1]]} finish="dark" />
    <InteriorBox position={[0, 0.018, 0]} size={[size[0] - 0.12, 0.012, size[1] - 0.12]} finish={cool ? "olive" : "fabric"} />
    <InteriorBox position={[-size[0] * 0.32, 0.026, 0]} size={[0.035, 0.004, size[1] - 0.34]} finish="stone" />
    <InteriorBox position={[size[0] * 0.32, 0.026, 0]} size={[0.035, 0.004, size[1] - 0.34]} finish="stone" />
  </group>;
}

/** A functional low cabinet: recessed plinth, flush doors, stone service surface. */
export function ModernCredenza({ position, rotationY = 0, width, depth = 0.6 }: {
  position: Vec3; rotationY?: number; width: number; depth?: number;
}) {
  return <group position={[...position]} rotation={[0, rotationY, 0]}>
    <InteriorBox position={[0, 0.09, 0]} size={[width - 0.2, 0.18, depth - 0.13]} finish="dark" />
    <InteriorBox position={[0, 0.47, 0]} size={[width, 0.68, depth]} />
    <InteriorBox position={[0, 0.835, 0]} size={[width + 0.07, 0.06, depth + 0.04]} finish="stone" />
    {[-1, 0, 1].map(bay => <group key={bay} position={[bay * width / 3, 0.47, depth / 2 + 0.009]}>
      <InteriorBox position={[0, 0, 0]} size={[width / 3 - 0.025, 0.59, 0.025]} />
      <InteriorBox position={[0, 0.15, 0.025]} size={[0.27, 0.013, 0.018]} finish="brass" />
    </group>)}
    <InteriorBox position={[-width * 0.29, 0.88, 0]} size={[0.62, 0.045, 0.32]} finish="dark" />
    <InteriorBox position={[-width * 0.29, 0.915, 0]} size={[0.43, 0.025, 0.28]} finish="fabric" />
    <InteriorBox position={[width * 0.27, 0.98, 0]} size={[0.2, 0.22, 0.18]} finish="clay" />
  </group>;
}

/** Shallow display wall with closed archive storage below and open bays above. */
export function ModernStorageWall({ position, rotationY = 0, width, depth = 0.55 }: {
  position: Vec3; rotationY?: number; width: number; depth?: number;
}) {
  return <group position={[...position]} rotation={[0, rotationY, 0]}>
    <ModernCredenza position={[0, 0, 0]} width={width} depth={depth} />
    <InteriorBox position={[0, 1.85, -depth / 2 + 0.04]} size={[width, 1.88, 0.08]} finish="dark" />
    {[1.02, 1.82, 2.72].map(y => <InteriorBox key={y} position={[0, y, 0]} size={[width, 0.07, depth]} />)}
    {[-0.5, -1 / 6, 1 / 6, 0.5].map(x => <InteriorBox key={x} position={[x * width, 1.88, 0]} size={[0.055, 1.77, depth]} />)}
    {[-1, 0, 1].map(bay => <group key={bay} position={[bay * width / 3, 1.12, 0.025]}>
      <InteriorBox position={[-0.12, 0.17, 0]} size={[0.26, 0.34, 0.23]} finish={bay === 0 ? "ink" : "fabric"} />
      <InteriorBox position={[0.12, 0.11, 0]} size={[0.12, 0.22, 0.21]} finish="clay" />
      <InteriorBox position={[0, 0.89, 0]} size={[0.38, 0.12, 0.25]} finish="stone" />
    </group>)}
  </group>;
}

/** Wall-local +Z faces inward. Decorative only, with a small fixed rib count. */
export function AcousticPanel({ position, rotationY = 0, width, height = 2.65 }: {
  position: Vec3; rotationY?: number; width: number; height?: number;
}) {
  return <group position={[...position]} rotation={[0, rotationY, 0]} userData={{ officeCollision: false }}>
    <InteriorBox position={[0, 0, 0]} size={[width, height, 0.04]} finish="dark" />
    {Array.from({ length: 12 }, (_, i) => <InteriorBox key={i}
      position={[(i / 11 - 0.5) * (width - 0.13), 0, 0.04]}
      size={[width / 21, height, 0.045]} />)}
  </group>;
}

export function AbstractArtwork({ position, rotationY = 0, width = 2.15, cool = false }: {
  position: Vec3; rotationY?: number; width?: number; cool?: boolean;
}) {
  const height = width * 0.57;
  return <group position={[...position]} rotation={[0, rotationY, 0]} userData={{ officeCollision: false }}>
    <InteriorBox position={[0, 0, 0]} size={[width, height, 0.055]} finish="brass" />
    <InteriorBox position={[0, 0, 0.033]} size={[width - 0.075, height - 0.075, 0.02]} finish="stone" />
    <InteriorBox position={[-width * 0.19, 0.08, 0.048]} size={[width * 0.34, height * 0.65, 0.007]} finish={cool ? "ink" : "olive"} />
    <InteriorBox position={[width * 0.17, -height * 0.16, 0.051]} size={[width * 0.34, height * 0.31, 0.007]} finish="clay" />
    <InteriorBox position={[width * 0.12, height * 0.2, 0.052]} size={[width * 0.45, 0.04, 0.007]} finish="dark" />
  </group>;
}

export function SculpturalPlanter({ position }: { position: Vec3 }) {
  return <group position={[...position]} dispose={null}>
    <mesh geometry={planterShape} material={materials.stone} position={[0, 0.27, 0]} />
    <InteriorBox position={[0, 0.73, 0]} size={[0.035, 0.55, 0.035]} finish="walnut" />
    {[[-0.18, 1.02, 0.03], [0.18, 1.22, -0.02], [0, 1.43, 0.04]].map((p, i) =>
      <mesh key={i} position={p as [number, number, number]} scale={[0.29, 0.42, 0.25]}
        geometry={foliageShape} material={materials.leaf} />)}
  </group>;
}
