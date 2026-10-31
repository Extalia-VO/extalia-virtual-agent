/* eslint-disable react-hooks/immutability -- Three.js resources and camera transforms are mutable renderer objects. */
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type {
  BufferGeometry,
  InstancedMesh,
  Material} from "three";
import {
  AdditiveBlending,
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  IcosahedronGeometry,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D
} from "three";
import { CAMPUS_ENTRY_LAYOUT } from "./layout";
import { FRONT_APPROACH } from "./campusSiteLayout";
import { insideParkingFootprint } from "./campusParkingLots";
import { useSolarEnvironment } from "./Environment";
import { ExteriorPart, useExteriorDisplayGeometries, useExteriorInstancedGeometries } from "./ExteriorPart";

/*
 * Instanced campus landscape: boulevard + grove trees, street/path lighting,
 * curbs, sidewalks and road markings. Everything is instanced (about 12 draw
 * calls total) and opted out of collision so the navigation grid only sees the
 * hand-placed forecourt props in CampusExterior.
 *
 * Placement guard: no instance may enter the arrival corridor
 * (the shared FRONT_APPROACH bounds, from the road to the lobby) or the building
 * envelope. Only flat, non-collidable ground decals
 * (night light pools) may touch the corridor band.
 */

const BASE_Y = -0.24;
const WALK_TOP = -0.225;
const POOL_Y = -0.185;
const FRONT_ROAD_Z = -28.5;
const REAR_ROAD_Z = 28.5;
const SIDE_ROAD_X = 38;
const ROAD_HALF = 4;

const CORRIDOR = {
  minX: FRONT_APPROACH.x - FRONT_APPROACH.width / 2 - 0.6,
  maxX: FRONT_APPROACH.x + FRONT_APPROACH.width / 2 + 0.6,
  minZ: FRONT_APPROACH.roadEdgeZ,
  maxZ: CAMPUS_ENTRY_LAYOUT.lobbyDoorZ
};

type Item = {
  x: number; y: number; z: number;
  sx: number; sy: number; sz: number;
  ry?: number;
  color?: string;
};

type TreeKind = "shade" | "columnar" | "ornamental" | "copper" | "blossom" | "blossomWhite";

type TreeSpec = {
  trunkRadius: number;
  trunkHeight: number;
  bark: string;
  /** [localX, localY, localZ, radius, verticalStretch] */
  crowns: [number, number, number, number, number][];
  leaves: string[];
};

const ORNAMENTAL_CROWNS: TreeSpec["crowns"] = [
  [0, 2.15, 0, 0.85, 0.9], [-0.48, 1.8, 0.22, 0.55, 0.9], [0.5, 1.9, -0.18, 0.52, 0.9]
] as const;
const BLOSSOM_CROWNS: TreeSpec["crowns"] = [
  [0, 2.25, 0, 1.0, 0.85], [0.65, 1.95, 0.3, 0.7, 0.85], [-0.6, 2.0, -0.24, 0.68, 0.85],
  [0.2, 2.85, -0.3, 0.56, 0.85], [-0.3, 2.7, 0.44, 0.52, 0.85]
] as const;

const TREE_SPECS: Record<TreeKind, TreeSpec> = {
  shade: {
    trunkRadius: 0.2, trunkHeight: 3.3, bark: "#6f5e4d",
    crowns: [
      [0, 4.3, 0, 1.45, 0.82], [-0.95, 3.7, 0.2, 1.1, 0.85], [0.9, 3.85, -0.35, 1.12, 0.85],
      [0.1, 3.75, 0.95, 1.02, 0.85], [-0.2, 5.0, -0.1, 0.95, 0.8]
    ] as const,
    leaves: ["#4f7a4a", "#5f8a50", "#6d9658", "#577f4c", "#80a560"]
  },
  columnar: {
    trunkRadius: 0.14, trunkHeight: 1.7, bark: "#66584a",
    crowns: [[0, 3.3, 0, 0.95, 2.3], [0.12, 4.9, 0.08, 0.62, 1.8]] as const,
    leaves: ["#3f6a45", "#4d7a4c"]
  },
  ornamental: {
    trunkRadius: 0.1, trunkHeight: 1.9, bark: "#7d6a58",
    crowns: ORNAMENTAL_CROWNS,
    leaves: ["#8fa87c", "#9db687", "#87a176"]
  },
  copper: {
    trunkRadius: 0.1, trunkHeight: 1.9, bark: "#6a5546",
    crowns: ORNAMENTAL_CROWNS,
    leaves: ["#7b4b4f", "#8a5a55", "#6e4248"]
  },
  blossom: {
    trunkRadius: 0.12, trunkHeight: 1.7, bark: "#6b5647",
    crowns: BLOSSOM_CROWNS,
    leaves: ["#f2b8c6", "#f7cdd6", "#fbe3e9", "#eaa3b6", "#f7cdd6"]
  },
  blossomWhite: {
    trunkRadius: 0.12, trunkHeight: 1.7, bark: "#6b5647",
    crowns: BLOSSOM_CROWNS,
    leaves: ["#f4f1ea", "#efe7ef", "#fbf7f2", "#e6dfe8", "#f8f2ec"]
  }
};

type Landscape = {
  trunks: Item[];
  canopies: Item[];
  pools: Item[];
  hardscape: Item[];
  markings: Item[];
};

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** True when a footprint of `radius` stays out of the arrival corridor and building envelope. */
export function landscapeClear(x: number, z: number, radius: number) {
  const inCorridor = x + radius > CORRIDOR.minX && x - radius < CORRIDOR.maxX
    && z + radius > CORRIDOR.minZ && z - radius < CORRIDOR.maxZ;
  const inEnvelope = Math.abs(x) < 24 && Math.abs(z) < 18;
  // Both lots, their aisle stub and access aprons/ramps (campusParkingLots footprints).
  return !inCorridor && !inEnvelope && !insideParkingFootprint(x, z, radius);
}

function onRoad(x: number, z: number, radius: number) {
  const reach = ROAD_HALF + radius;
  if (Math.abs(z - FRONT_ROAD_Z) < reach || Math.abs(z - REAR_ROAD_Z) < reach) return true;
  return Math.abs(Math.abs(x) - SIDE_ROAD_X) < reach && Math.abs(z) < 32.5 + radius;
}

function addTree(out: Landscape, kind: TreeKind, x: number, z: number, scale: number, rand: () => number) {
  if (x > 0 && x < 34 && Math.abs(z) < 25) x = 34;
  // Trunk footprint guard; canopies overhang at >= 1.6m and are not collidable.
  if (!landscapeClear(x, z, 1.2) || onRoad(x, z, 0.4)) return false;
  const spec = TREE_SPECS[kind]!;
  const yaw = rand() * Math.PI * 2;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out.trunks.push({
    x, y: BASE_Y, z,
    sx: spec.trunkRadius * scale, sy: spec.trunkHeight * scale, sz: spec.trunkRadius * scale,
    ry: yaw, color: spec.bark
  });
  spec.crowns.forEach(([lx, ly, lz, radius, stretch], index) => {
    const jitter = 0.9 + rand() * 0.2;
    out.canopies.push({
      x: x + (lx * c + lz * s) * scale,
      y: BASE_Y + ly * scale,
      z: z + (-lx * s + lz * c) * scale,
      sx: radius * scale * jitter,
      sy: radius * scale * stretch * jitter,
      sz: radius * scale * jitter,
      ry: rand() * Math.PI,
      color: spec.leaves[index % spec.leaves.length]!
    });
  });
  return true;
}

// The outer ring of cantilever street lamps and lawn path lights was removed: at night the
// plot is read through the lit facades of the main building and the surrounding towers,
// not through a necklace of poles circling the ground.

function pool(out: Landscape, x: number, z: number, radius: number, color = "#ffc27a") {
  out.pools.push({ x, y: POOL_Y, z, sx: radius, sy: 1, sz: radius, color });
}
const TREE_PIT = "#4e4237";

function buildLandscape(fullSpecimens = false): Landscape {
  const out: Landscape = {
    trunks: [], canopies: [], pools: [], hardscape: [], markings: []
  };
  const rand = mulberry(0x5eed7a11);

  const pit = (x: number, z: number) => out.markings.push({
    x, y: WALK_TOP + 0.003, z, sx: 1.5, sy: 0.006, sz: 1.5, color: TREE_PIT
  });
  // Boulevard trees carry no ground light pools: the outer plot stays dark at night.
  const boulevard = (x: number, z: number, kind: TreeKind, scale: number) => {
    if (addTree(out, kind, x, z, scale, rand)) pit(x, z);
  };

  // Front and rear boulevards: alternating shade / columnar trees between the lamps.
  for (const z of [-35.6, 35.6]) {
    for (let k = 0; k < 8; k += 1) {
      for (const side of [-1, 1]) {
        const x = side * (6 + k * 6);
        const kind: TreeKind = k % 2 === 0 ? "shade" : "columnar";
        // Two front cypresses use the full colour-preserving Blender specimen batch.
        if (!(fullSpecimens && z < 0 && k === 1)) boulevard(x, z, kind, 0.92 + rand() * 0.16);
      }
    }
  }
  // Outer side boulevards.
  for (const side of [-1, 1]) {
    for (let z = -30; z <= 30; z += 6) {
      const kind: TreeKind = Math.abs(z) % 12 === 0 ? "shade" : "columnar";
      boulevard(side * 44.8, z, kind, 0.9 + rand() * 0.18);
    }
  }

  // Side lawns: ornamental / blossom rhythm between the garden beds and the side roads.
  const sideZ = [-10, -3.5, 3, 9.5, 16, 21.5];
  for (const side of [-1, 1]) {
    sideZ.forEach((z, i) => {
      const flowering: TreeKind = side < 0 ? "blossom" : "blossomWhite";
      const kind: TreeKind = i % 2 === 0 ? flowering : i % 4 === 1 ? "copper" : "ornamental";
      // Front specimens retain their complete authored branching and blossom colours.
      if (!fullSpecimens || i !== 0) addTree(out, kind, side * 31.4, z, 0.95 + rand() * 0.15, rand);
    });
  }

  // East front lawn blossom grove (west front lawn hosts the café terrace).
  for (const [x, z, kind] of [[29.6, -22.2, "blossom"], [31.8, -18.4, "blossomWhite"], [29.4, -14.8, "blossom"]] as const) {
    addTree(out, kind, x, z, 1.0 + rand() * 0.12, rand);
  }

  // Corner groves anchor the four campus corners.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const kinds: TreeKind[] = sz < 0 ? ["shade", "blossom", "ornamental"] : ["shade", "copper", "blossomWhite"];
      const offsets: [number, number][] = [[46.4, 40.2], [43.4, 41.6], [46.8, 37.9]] as const;
      offsets.forEach(([ox, oz], i) => {
        addTree(out, kinds[i]!, sx * ox, sz * oz, 0.9 + rand() * 0.2, rand);
      });
    }
  }

  // Warm pools only under the main building's own forecourt fixtures and seating areas
  // (flat additive decals: safe inside the arrival corridor band).
  for (const side of [-1, 1]) {
    pool(out, side * 3.55, -23.4, 2.0, "#ffcf8f");
    pool(out, side * 3.55, -16.8, 2.2, "#ffcf8f");
    pool(out, side * 5.2, 20.5, 3.0);
    pool(out, side * 24.2, 8.5, 1.6);
  }
  pool(out, -28.6, -18.6, 3.8);
  pool(out, 4.4, -16.3, 1.6);
  pool(out, 0, 22.8, 1.6);



  return out;
}

function Instances({
  name, geometry, material, items, castShadow = false, receiveShadow = false, dynamic = false, visible = true
}: {
  name: string;
  geometry: BufferGeometry;
  material: Material;
  items: Item[];
  castShadow?: boolean;
  receiveShadow?: boolean;
  dynamic?: boolean;
  visible?: boolean;
}) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const dummy = new Object3D();
    const color = new Color();
    const colored = items.some((item) => item.color);
    items.forEach((item, index) => {
      dummy.position.set(item.x, item.y, item.z);
      dummy.rotation.set(0, item.ry ?? 0, 0);
      dummy.scale.set(item.sx, item.sy, item.sz);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
      if (colored) mesh.setColorAt(index, color.set(item.color ?? "#ffffff"));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
  }, [items, geometry]);

  if (items.length === 0) return null;
  return (
    <instancedMesh
      key={geometry.uuid}
      ref={ref}
      name={name}
      args={[geometry, material, items.length]}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
      visible={visible}
      userData={dynamic ? { officeCollision: false, officeDynamic: true } : { officeCollision: false }}
    />
  );
}

/** Foreground plantings keep the entrance, mobility court and authored outdoor seats clear. */
export const FOREGROUND_BOTANICAL_PLACEMENTS = Object.freeze({
  flowers: [
    [-17, -31], [17, -31], [-22, -31], [22, -31],
    [-29, -14], [-29, -2], [-29, 18], [35, -14], [35, -2], [35, 18]
  ] as const,
  tropical: [[-27.8, 3], [35.2, 3], [-10, 31.8], [10, 31.8]] as const,
  blossom: [[-31.4, -10], [34, -10]] as const,
  columnar: [[-12, -35.6], [12, -35.6]] as const,
  pond: [-40, -0.24, 34] as const,
  pergola: [0, 0, 28.8] as const
});

function ForegroundBotanics() {
  const display = useExteriorDisplayGeometries();
  const fallback = useMemo(() => {
    const shape = new IcosahedronGeometry(1, 1);
    shape.scale(1.05, .32, .66);
    shape.translate(0, .28, 0);
    return shape;
  }, []);
  const material = useMemo(() => new MeshStandardMaterial({ vertexColors: true, roughness: .94 }), []);
  const fallbackMaterial = useMemo(() => new MeshStandardMaterial({ color: "#779768", roughness: .94 }), []);
  const items = useMemo(() => ({
    flowers: FOREGROUND_BOTANICAL_PLACEMENTS.flowers.map(([x, z], i) => ({ x, y: BASE_Y, z,
      sx: 1, sy: 1, sz: 1, ry: i % 2 ? Math.PI : 0 })),
    tropical: FOREGROUND_BOTANICAL_PLACEMENTS.tropical.map(([x, z], i) => ({ x, y: BASE_Y, z,
      sx: 1, sy: 1, sz: 1, ry: i * .7 })),
    blossom: FOREGROUND_BOTANICAL_PLACEMENTS.blossom.map(([x, z], i) => ({ x, y: BASE_Y, z, sx: 1, sy: 1, sz: 1, ry: i * 1.8 })),
    columnar: FOREGROUND_BOTANICAL_PLACEMENTS.columnar.map(([x, z], i) => ({ x, y: BASE_Y, z, sx: 1, sy: 1, sz: 1, ry: i * .9 }))
  }), []);
  useEffect(() => () => { fallback.dispose(); material.dispose(); fallbackMaterial.dispose(); }, [fallback, material, fallbackMaterial]);
  const flowers = display?.get("exterior-flower-bed"), tropical = display?.get("exterior-tropical-cluster");
  const blossom = display?.get("exterior-blossom-tree"), columnar = display?.get("exterior-columnar-tree");
  return <group name="campus-foreground-botanical-gardens">
    <Instances name="foreground-botanical-flower-parterres" geometry={flowers ?? fallback}
      material={flowers ? material : fallbackMaterial} items={items.flowers} receiveShadow />
    <Instances name="foreground-sculpted-ferns-and-agaves" geometry={tropical ?? fallback}
      material={tropical ? material : fallbackMaterial} items={items.tropical} receiveShadow />
    {blossom && <Instances name="foreground-branching-cherry-specimens" geometry={blossom}
      material={material} items={items.blossom} castShadow receiveShadow />}
    {columnar && <Instances name="foreground-sculpted-cypress-specimens" geometry={columnar}
      material={material} items={items.columnar} castShadow receiveShadow />}
    <ExteriorPart model="exterior-garden-pond" position={FOREGROUND_BOTANICAL_PLACEMENTS.pond}>
      <mesh position={[0, .06, 0]}><cylinderGeometry args={[2.3, 2.3, .08, 24]} /><meshStandardMaterial color="#357f94" roughness={.2} /></mesh>
    </ExteriorPart>
    <ExteriorPart model="exterior-garden-pergola" position={FOREGROUND_BOTANICAL_PLACEMENTS.pergola}>
      {[-1.85, 1.85].flatMap(x => [-1.25, 1.25].map(z => <mesh key={`${x}:${z}`} position={[x, 1.35, z]}>
        <boxGeometry args={[.13, 2.7, .13]} /><meshStandardMaterial color="#43525b" />
      </mesh>))}
      <mesh position={[0, 2.8, 0]}><boxGeometry args={[4.16, .14, 3.04]} /><meshStandardMaterial color="#b58b5d" /></mesh>
    </ExteriorPart>
  </group>;
}

export function CampusLandscape() {
  const { state } = useSolarEnvironment();
  const night = state.factors.exteriorLightFactor;
  const display = useExteriorDisplayGeometries();
  const data = useMemo(() => buildLandscape(Boolean(display?.has("exterior-blossom-tree") && display?.has("exterior-columnar-tree"))), [display]);
  const blenderGeometries = useExteriorInstancedGeometries();

  const geometries = useMemo(() => {
    const trunk = new CylinderGeometry(0.62, 1, 1, 7);
    trunk.translate(0, 0.5, 0);
    const poolDisc = new CircleGeometry(1, 28);
    poolDisc.rotateX(-Math.PI / 2);
    return { trunk, canopy: new IcosahedronGeometry(1, 1), box: new BoxGeometry(1, 1, 1), pool: poolDisc };
  }, []);

  const materials = useMemo(() => ({
    bark: new MeshStandardMaterial({ color: "#ffffff", roughness: 0.95 }),
    canopy: new MeshStandardMaterial({ color: "#ffffff", roughness: 0.95, flatShading: true, emissiveIntensity: 0 }),
    pool: new MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, toneMapped: false }),
    hardscape: new MeshStandardMaterial({ color: "#ffffff", roughness: 0.92 }),
    marking: new MeshStandardMaterial({ color: "#ffffff", roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  }), []);

  // exteriorLightFactor drives every night-only response from one place.
  useEffect(() => {
    materials.canopy.emissiveIntensity = 0;
    materials.pool.opacity = 0.36 * night;
  }, [materials, night]);

  useEffect(() => () => {
    Object.values(geometries).forEach((geometry) => geometry.dispose());
    Object.values(materials).forEach((material) => material.dispose());
  }, [geometries, materials]);

  return (
    <group name="campus-landscape" userData={{ officeCollision: false }}>
      <ForegroundBotanics />
      <Instances name="landscape-hardscape" geometry={geometries.box} material={materials.hardscape} items={data.hardscape} receiveShadow />
      <Instances name="landscape-markings" geometry={geometries.box} material={materials.marking} items={data.markings} receiveShadow />
      <Instances name="landscape-tree-trunks" geometry={blenderGeometries?.trunk ?? geometries.trunk} material={materials.bark} items={data.trunks} castShadow />
      <Instances name="landscape-tree-canopies" geometry={blenderGeometries?.canopy ?? geometries.canopy} material={materials.canopy} items={data.canopies} castShadow receiveShadow dynamic />
      {/* Instanced night light pools removed per user directive */}
    </group>
  );
}
