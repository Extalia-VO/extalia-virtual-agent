import { useEffect, useMemo, useRef, useLayoutEffect } from "react";
import type { BufferGeometry, InstancedMesh, Material} from "three";
import { BoxGeometry, CircleGeometry, Color, CylinderGeometry, IcosahedronGeometry, Matrix4, Vector3, MeshStandardMaterial } from "three";
import { useSolarEnvironment } from "./Environment";
import { useExteriorInstancedGeometries } from "./ExteriorPart";
import { FRONT_APPROACH } from "./campusSiteLayout";

// Dimensions & coordinates for the Civic Forecourt Park
const PARK_Y = -0.71;
const WALK_Y = -0.69;
const PLAZA_Y = -0.68;
const CURB_Y = -0.67;
const WATER_Y = -0.685;
/** The park begins one metre past the front road's far kerb so the road stays visible. */
const PARK_NORTH_Z = FRONT_APPROACH.roadCenterZ - FRONT_APPROACH.roadWidth / 2 - 1;
const PARK_SOUTH_Z = -87;
const PARK_DEPTH = PARK_NORTH_Z - PARK_SOUTH_Z;
const PARK_MID_Z = (PARK_NORTH_Z + PARK_SOUTH_Z) / 2;
/** Fountain and the transverse stroll paths share the middle of the first park block. */
const PARK_CROSS_Z = Math.round(PARK_MID_Z);

type ParkItem = {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  ry?: number;
  color?: string;
};

type TreeSpec = {
  trunkRadius: number;
  trunkHeight: number;
  bark: string;
  crownRadius: number;
  crownStretch: number;
  leaves: string[];
};

const TREE_STYLES: Record<string, TreeSpec> = {
  shade: {
    trunkRadius: 0.22,
    trunkHeight: 2.8,
    bark: "#5c4a3b",
    crownRadius: 1.5,
    crownStretch: 0.9,
    leaves: ["#446e3f", "#4f7c46", "#5d8a52"]
  },
  flowering: {
    trunkRadius: 0.16,
    trunkHeight: 2.3,
    bark: "#6b5847",
    crownRadius: 1.3,
    crownStretch: 0.85,
    leaves: ["#f5b8c7", "#f9cbd6", "#fce4ea"]
  },
  cypress: {
    trunkRadius: 0.18,
    trunkHeight: 1.8,
    bark: "#54463a",
    crownRadius: 0.9,
    crownStretch: 2.2,
    leaves: ["#385a3c", "#416942"]
  }
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

function buildCivicPark() {
  const rand = mulberry(0x42f04ec7);

  const lawns: ParkItem[] = [];
  const hardscape: ParkItem[] = [];
  const trunks: ParkItem[] = [];
  const canopies: ParkItem[] = [];
  const benches: ParkItem[] = [];
  const lamps: ParkItem[] = [];
  const pools: ParkItem[] = [];

  // 1. Main Central Green Expanses (Flanking the grand axial approach)
  // Green sectors at x 8..56 either side, from the road's far kerb to the southern walk.
  lawns.push({ x: -32, y: PARK_Y, z: PARK_MID_Z, sx: 46, sy: 0.05, sz: PARK_DEPTH, color: "#4f754a" });
  lawns.push({ x: 32, y: PARK_Y, z: PARK_MID_Z, sx: 46, sy: 0.05, sz: PARK_DEPTH, color: "#4f754a" });

  // Outer Decorative Grass Borders
  lawns.push({ x: -32, y: PARK_Y + 0.01, z: PARK_MID_Z, sx: 44, sy: 0.04, sz: PARK_DEPTH - 2, color: "#598353" });
  lawns.push({ x: 32, y: PARK_Y + 0.01, z: PARK_MID_Z, sx: 44, sy: 0.04, sz: PARK_DEPTH - 2, color: "#598353" });
  // Park-side footway along the front road.
  hardscape.push({ x: 0, y: WALK_Y, z: PARK_NORTH_Z + 0.4, sx: 112, sy: 0.03, sz: 1.8, color: "#cfcac0" });

  // 2. Central Civic Promenade & Oval Reflection Plaza
  // Grand central promenade linking to FRONT_APPROACH
  hardscape.push({ x: 0, y: PLAZA_Y, z: PARK_MID_Z - 0.5, sx: 11.2, sy: 0.04, sz: PARK_DEPTH + 1, color: "#ded9cd" });
  // Decorative paving edge borders
  hardscape.push({ x: -5.8, y: CURB_Y, z: PARK_MID_Z - 0.5, sx: 0.4, sy: 0.06, sz: PARK_DEPTH + 1, color: "#b5b0a4" });
  hardscape.push({ x: 5.8, y: CURB_Y, z: PARK_MID_Z - 0.5, sx: 0.4, sy: 0.06, sz: PARK_DEPTH + 1, color: "#b5b0a4" });

  // Transverse pedestrian park walks (East-West stroll paths)
  hardscape.push({ x: -32, y: WALK_Y, z: PARK_CROSS_Z, sx: 46, sy: 0.03, sz: 3.6, color: "#e3ded2" });
  hardscape.push({ x: 32, y: WALK_Y, z: PARK_CROSS_Z, sx: 46, sy: 0.03, sz: 3.6, color: "#e3ded2" });

  // Perimeter promenade along southern avenue (z = -88)
  hardscape.push({ x: 0, y: WALK_Y, z: -87.5, sx: 110, sy: 0.03, sz: 3.2, color: "#cfcac0" });

  // 3. Central Fountain & Water Basin on the promenade axis
  hardscape.push({ x: 0, y: PLAZA_Y + 0.008, z: PARK_CROSS_Z, sx: 14.8, sy: 0.03, sz: 14.8, color: "#d6d1c6" });
  hardscape.push({ x: 0, y: PLAZA_Y + 0.03, z: PARK_CROSS_Z, sx: 7.4, sy: 0.14, sz: 7.4, color: "#c4bfb4" });
  hardscape.push({ x: 0, y: PLAZA_Y + 0.12, z: PARK_CROSS_Z, sx: 6.2, sy: 0.08, sz: 6.2, color: "#b6b0a4" });
  hardscape.push({ x: 0, y: PLAZA_Y + 0.28, z: PARK_CROSS_Z, sx: 1.4, sy: 0.36, sz: 1.4, color: "#9fa5a2" });
  pools.push({ x: 0, y: WATER_Y + 0.08, z: PARK_CROSS_Z, sx: 2.8, sy: 1, sz: 2.8, color: "#5c92ad" });

  // Formal parterre garden borders & flower beds flanking the central promenade
  for (const side of [-1, 1]) {
    for (const zBand of [PARK_NORTH_Z - 5.5, PARK_SOUTH_Z + 5.5]) {
      hardscape.push({ x: side * 14.5, y: PARK_Y + 0.05, z: zBand, sx: 9.6, sy: 0.14, sz: 3.4, color: "#bcb7ac" });
      lawns.push({ x: side * 14.5, y: PARK_Y + 0.11, z: zBand, sx: 9.0, sy: 0.06, sz: 2.8, color: "#486b43" });
      for (const dx of [-3.2, 0, 3.2]) {
        canopies.push({ x: side * 14.5 + dx, y: PARK_Y + 0.32, z: zBand, sx: 0.65, sy: 0.42, sz: 0.65, color: dx === 0 ? "#b896d8" : "#628658" });
      }
    }
    // Pocket plaza nodes at the transverse walk intersections (x = ±32, z = PARK_CROSS_Z)
    hardscape.push({ x: side * 32, y: WALK_Y + 0.008, z: PARK_CROSS_Z, sx: 8.4, sy: 0.035, sz: 8.4, color: "#d8d3c8" });
    hardscape.push({ x: side * 32, y: WALK_Y + 0.08, z: PARK_CROSS_Z, sx: 3.2, sy: 0.16, sz: 3.2, color: "#b8b3a8" });
    lawns.push({ x: side * 32, y: WALK_Y + 0.15, z: PARK_CROSS_Z, sx: 2.6, sy: 0.06, sz: 2.6, color: "#4e7348" });
    canopies.push({ x: side * 32, y: WALK_Y + 0.48, z: PARK_CROSS_Z, sx: 0.95, sy: 0.58, sz: 0.95, color: "#f3c4d0" });
  }

  // 4. Formal Tree Allées & Shaded Groves
  // Central Promenade Allée: Majestic cypress & columnar trees lining the axial path
  for (let z = PARK_SOUTH_Z + 1; z <= PARK_NORTH_Z - 1.5; z += 5) {
    [-7.2, 7.2].forEach((x) => {
      const spec = TREE_STYLES.cypress!;
      trunks.push({ x, y: PARK_Y + 0.05, z, sx: spec.trunkRadius, sy: spec.trunkHeight, sz: spec.trunkRadius, color: spec.bark });
      canopies.push({ x, y: PARK_Y + 0.05 + spec.trunkHeight * 0.9, z, sx: spec.crownRadius, sy: spec.crownRadius * spec.crownStretch, sz: spec.crownRadius, color: spec.leaves[0]! });

      // Stone tree surround
      hardscape.push({ x, y: PLAZA_Y + 0.01, z, sx: 1.6, sy: 0.02, sz: 1.6, color: "#7a6e63" });
    });
  }

  // Shaded Canopy Groves in the Green Sectors (alternating shade and cherry/magnolia blossoms)
  [-44, -32, -20, 20, 32, 44].forEach((x, colIdx) => {
    [PARK_SOUTH_Z + 4, PARK_CROSS_Z, PARK_NORTH_Z - 4].forEach((z, rowIdx) => {
      // Keep clear of the transverse stroll path center
      if (z === PARK_CROSS_Z && (Math.abs(x) === 32)) return;

      const styleKey = (colIdx + rowIdx) % 3 === 0 ? "flowering" : "shade";
      const spec = TREE_STYLES[styleKey]!;
      const scale = 0.9 + rand() * 0.2;
      const leafColor = spec.leaves[Math.floor(rand() * spec.leaves.length)]!;

      trunks.push({
        x: x + (rand() - 0.5) * 1.5,
        y: PARK_Y + 0.05,
        z: z + (rand() - 0.5) * 1.5,
        sx: spec.trunkRadius * scale,
        sy: spec.trunkHeight * scale,
        sz: spec.trunkRadius * scale,
        color: spec.bark
      });

      canopies.push({
        x: x + (rand() - 0.5) * 1.5,
        y: PARK_Y + 0.05 + spec.trunkHeight * scale + spec.crownRadius * scale * 0.6,
        z: z + (rand() - 0.5) * 1.5,
        sx: spec.crownRadius * scale,
        sy: spec.crownRadius * spec.crownStretch * scale,
        sz: spec.crownRadius * scale,
        color: leafColor
      });
    });
  });

  // 5. Park Benches & Street Lamps along paths
  [-4, 4].forEach((x) => {
    [PARK_SOUTH_Z + 6, PARK_NORTH_Z - 3].forEach((z) => {
      benches.push({ x, y: PLAZA_Y + 0.16, z, sx: 1.4, sy: 0.35, sz: 0.5, ry: x > 0 ? -Math.PI / 2 : Math.PI / 2, color: "#8a5836" });
    });
  });

  [-38, -26, 26, 38].forEach((x) => {
    benches.push({ x, y: WALK_Y + 0.16, z: PARK_CROSS_Z + 1.5, sx: 1.4, sy: 0.35, sz: 0.5, ry: 0, color: "#8a5836" });
    benches.push({ x, y: WALK_Y + 0.16, z: PARK_CROSS_Z - 1.5, sx: 1.4, sy: 0.35, sz: 0.5, ry: Math.PI, color: "#8a5836" });
  });

  // Pedestrian Lamps with warm pools
  for (let z = PARK_SOUTH_Z + 3; z <= PARK_NORTH_Z - 1; z += 6) {
    [-8.8, 8.8].forEach((x) => {
      lamps.push({ x, y: PLAZA_Y + 1.6, z, sx: 0.12, sy: 3.2, sz: 0.12, color: "#424b52" });
      pools.push({ x, y: PLAZA_Y + 0.02, z, sx: 3.2, sy: 1, sz: 3.2, color: "#ffe6bf" });
    });
  }

  // ── 6. Southern Forecourt Extension ──────────────────────────────────
  // Green corridor south of the main civic park (z = -90 to -130), filling the
  // gap between the CivicForecourtPark and the new skyline parks so the entire
  // front of the campus reads as one integrated parkscape rather than bare
  // asphalt patches with orphaned grid-street fragments.

  // Wide lawn strips flanking the extended promenade
  lawns.push({ x: -40, y: PARK_Y, z: -110, sx: 60, sy: 0.05, sz: 38, color: "#4f754a" });
  lawns.push({ x: 40, y: PARK_Y, z: -110, sx: 60, sy: 0.05, sz: 38, color: "#4f754a" });
  // Decorative inner layer
  lawns.push({ x: -40, y: PARK_Y + 0.01, z: -110, sx: 56, sy: 0.04, sz: 34, color: "#598353" });
  lawns.push({ x: 40, y: PARK_Y + 0.01, z: -110, sx: 56, sy: 0.04, sz: 34, color: "#598353" });

  // Continuation of the central promenade axis southward
  hardscape.push({ x: 0, y: PLAZA_Y, z: -110, sx: 8.4, sy: 0.04, sz: 40, color: "#ded9cd" });
  // Side curbs along the extended promenade
  hardscape.push({ x: -4.4, y: CURB_Y, z: -110, sx: 0.35, sy: 0.06, sz: 40, color: "#b5b0a4" });
  hardscape.push({ x: 4.4, y: CURB_Y, z: -110, sx: 0.35, sy: 0.06, sz: 40, color: "#b5b0a4" });

  // Transverse stroll paths crossing the southern lawn
  for (const z of [-100, -120]) {
    hardscape.push({ x: -40, y: WALK_Y, z, sx: 60, sy: 0.03, sz: 2.8, color: "#e3ded2" });
    hardscape.push({ x: 40, y: WALK_Y, z, sx: 60, sy: 0.03, sz: 2.8, color: "#e3ded2" });
  }

  // Perimeter promenade at the southern edge (z = -130)
  hardscape.push({ x: 0, y: WALK_Y, z: -129, sx: 110, sy: 0.03, sz: 2.8, color: "#cfcac0" });

  // Secondary fountain / water feature at the southern roundabout
  hardscape.push({ x: 0, y: PLAZA_Y + 0.02, z: -110, sx: 5.6, sy: 0.1, sz: 5.6, color: "#c4bfb4" });
  pools.push({ x: 0, y: WATER_Y + 0.08, z: -110, sx: 2.2, sy: 1, sz: 2.2, color: "#5c92ad" });

  // Extended avenue of cypress trees along the central promenade
  for (let z = -95; z >= -125; z -= 5.5) {
    [-6.2, 6.2].forEach((x) => {
      const spec = TREE_STYLES.cypress!;
      trunks.push({ x, y: PARK_Y + 0.05, z, sx: spec.trunkRadius, sy: spec.trunkHeight, sz: spec.trunkRadius, color: spec.bark });
      canopies.push({ x, y: PARK_Y + 0.05 + spec.trunkHeight * 0.9, z, sx: spec.crownRadius, sy: spec.crownRadius * spec.crownStretch, sz: spec.crownRadius, color: spec.leaves[0]! });
      hardscape.push({ x, y: PLAZA_Y + 0.01, z, sx: 1.4, sy: 0.02, sz: 1.4, color: "#7a6e63" });
    });
  }

  // Shade & flowering tree groves in the southern lawn sectors
  [-56, -40, -24, 24, 40, 56].forEach((x, colIdx) => {
    [-100, -110, -120].forEach((z, rowIdx) => {
      const styleKey = (colIdx + rowIdx) % 3 === 0 ? "flowering" : "shade";
      const spec = TREE_STYLES[styleKey]!;
      const scale = 0.85 + rand() * 0.25;
      const leafColor = spec.leaves[Math.floor(rand() * spec.leaves.length)]!;

      trunks.push({
        x: x + (rand() - 0.5) * 2,
        y: PARK_Y + 0.05,
        z: z + (rand() - 0.5) * 2,
        sx: spec.trunkRadius * scale,
        sy: spec.trunkHeight * scale,
        sz: spec.trunkRadius * scale,
        color: spec.bark
      });

      canopies.push({
        x: x + (rand() - 0.5) * 2,
        y: PARK_Y + 0.05 + spec.trunkHeight * scale + spec.crownRadius * scale * 0.6,
        z: z + (rand() - 0.5) * 2,
        sx: spec.crownRadius * scale,
        sy: spec.crownRadius * spec.crownStretch * scale,
        sz: spec.crownRadius * scale,
        color: leafColor
      });
    });
  });

  // Benches along transverse paths in the southern extension
  [-30, -50, 30, 50].forEach((x) => {
    [-100, -120].forEach((z) => {
      benches.push({ x, y: WALK_Y + 0.16, z: z - 1.5, sx: 1.4, sy: 0.35, sz: 0.5, ry: 0, color: "#8a5836" });
      benches.push({ x, y: WALK_Y + 0.16, z: z + 1.5, sx: 1.4, sy: 0.35, sz: 0.5, ry: Math.PI, color: "#8a5836" });
    });
  });

  // Lamp posts along the extended promenade
  for (let z = -94; z >= -126; z -= 8) {
    [-7.8, 7.8].forEach((x) => {
      lamps.push({ x, y: PLAZA_Y + 1.6, z, sx: 0.12, sy: 3.2, sz: 0.12, color: "#424b52" });
      pools.push({ x, y: PLAZA_Y + 0.02, z, sx: 3.2, sy: 1, sz: 3.2, color: "#ffe6bf" });
    });
  }

  return { lawns, hardscape, trunks, canopies, benches, lamps, pools };
}

function InstancedBatch({
  geometry,
  material,
  items,
  castShadow = false,
  receiveShadow = false
}: {
  geometry: BufferGeometry;
  material: Material;
  items: ParkItem[];
  castShadow?: boolean;
  receiveShadow?: boolean;
}) {
  const meshRef = useRef<InstancedMesh>(null);

  useLayoutEffect(() => {
    if (!meshRef.current) return;
    const mat4 = new Matrix4();
    const col = new Color();

    items.forEach((item, index) => {
      mat4.makeRotationY(item.ry ?? 0);
      mat4.scale(new Vector3(item.sx, item.sy, item.sz));
      mat4.setPosition(item.x, item.y, item.z);
      meshRef.current!.setMatrixAt(index, mat4);
      if (item.color) {
        meshRef.current!.setColorAt(index, col.set(item.color));
      }
    });

    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) meshRef.current.instanceColor.needsUpdate = true;
    meshRef.current.computeBoundingSphere();
  }, [items, geometry]);

  return (
    <instancedMesh
      key={geometry.uuid}
      ref={meshRef}
      args={[geometry, material, items.length]}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
    />
  );
}

export function CivicForecourtPark() {
  const { state } = useSolarEnvironment();
  const nightFactor = state.factors.exteriorLightFactor;
  const data = useMemo(() => buildCivicPark(), []);
  const blenderGeometries = useExteriorInstancedGeometries();

  const geometries = useMemo(() => {
    const box = new BoxGeometry(1, 1, 1);
    const trunkCyl = new CylinderGeometry(0.7, 1, 1, 8);
    trunkCyl.translate(0, 0.5, 0);
    const canopyIco = new IcosahedronGeometry(1, 1);
    const disc = new CircleGeometry(1, 24);
    disc.rotateX(-Math.PI / 2);

    return { box, trunkCyl, canopyIco, disc };
  }, []);

  const materials = useMemo(() => {
    const lawnMat = new MeshStandardMaterial({ roughness: 0.95, metalness: 0.05 });
    const stoneMat = new MeshStandardMaterial({ roughness: 0.88, metalness: 0.1 });
    const woodMat = new MeshStandardMaterial({ roughness: 0.85, metalness: 0.15 });
    const barkMat = new MeshStandardMaterial({ roughness: 0.95 });
    const leavesMat = new MeshStandardMaterial({ roughness: 0.82, flatShading: true });
    const metalMat = new MeshStandardMaterial({ roughness: 0.45, metalness: 0.7 });
    const lampOpticsMat = new MeshStandardMaterial({ color: "#fff2da", emissive: "#ffd3a0", emissiveIntensity: 0, roughness: .4 });
    const waterMat = new MeshStandardMaterial({ roughness: 0.2, metalness: 0.8, color: "#4f849c" });
    const poolMat = new MeshStandardMaterial({
      roughness: 1,
      transparent: true,
      opacity: 0.5,
      depthWrite: false
    });

    return { lawnMat, stoneMat, woodMat, barkMat, leavesMat, metalMat, lampOpticsMat, waterMat, poolMat };
  }, []);

  // eslint-disable-next-line react-hooks/immutability -- Three.js material emission follows the shared night state.
  useEffect(() => { materials.lampOpticsMat.emissiveIntensity = nightFactor * 3.6; }, [materials, nightFactor]);
  useEffect(() => () => {
    Object.values(geometries).forEach(geometry => geometry.dispose());
    Object.values(materials).forEach(material => material.dispose());
  }, [geometries, materials]);

  return (
    <group name="civic-forecourt-park" userData={{ officePassable: true, officeCollision: false }}>
      {/* 1. Green Lawn Parterres */}
      <InstancedBatch geometry={geometries.box} material={materials.lawnMat} items={data.lawns} receiveShadow />

      {/* 2. Plaza Pavement, Curbs & Footways */}
      <InstancedBatch geometry={geometries.box} material={materials.stoneMat} items={data.hardscape} receiveShadow />

      {/* 3. Water Feature Basin */}
      <InstancedBatch geometry={geometries.disc} material={materials.waterMat} items={data.pools.filter(p => p.color === "#5c92ad")} />

      {/* 4. Trees: Trunks & Polyhedral Canopies */}
      <InstancedBatch geometry={blenderGeometries?.trunk ?? geometries.trunkCyl} material={materials.barkMat} items={data.trunks} castShadow />
      <InstancedBatch geometry={blenderGeometries?.canopy ?? geometries.canopyIco} material={materials.leavesMat} items={data.canopies} castShadow />

      {/* 5. Park Benches & Street Lamps */}
      <InstancedBatch geometry={blenderGeometries?.bench ?? geometries.box} material={materials.woodMat} items={data.benches} castShadow />
      <InstancedBatch geometry={blenderGeometries?.lamp ?? geometries.box} material={materials.metalMat} items={data.lamps} castShadow />

      {blenderGeometries?.lampOptics && <InstancedBatch geometry={blenderGeometries.lampOptics}
        material={materials.lampOpticsMat} items={data.lamps} />}

      {/* 6. Night Ambient Light Decals */}
      {nightFactor > 0.05 && (
        <InstancedBatch
          geometry={geometries.disc}
          material={materials.poolMat}
          items={data.pools.filter(p => p.color !== "#5c92ad")}
        />
      )}
    </group>
  );
}
