import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import type { Object3D} from 'three';
import { Color, DoubleSide, Matrix4, MeshBasicMaterial, Quaternion, Vector3,
  type BufferGeometry, type InstancedMesh, type Material, type Mesh, type MeshStandardMaterial } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import CATALOG from './campusGreenery.json';
import { COMMERCIAL_ASSETS_ONLY } from './campusMobilityLayout';
import { useStaticBatchRevision } from './StaticCampusBatch';

/*
 * Campus greenery: potted plants, garden plants and trees simplified from owner-provided downloads
 * (tooling/blender/prepare-greenery.py, one GLB of at most 1 MiB each). Every placement keeps its
 * procedural fallback until its model has loaded, and `?greenery=procedural` keeps the fallbacks.
 * Variants are picked deterministically from a placement's position, so a view is stable across
 * reloads, and each placement gets its own yaw, size and a slight foliage tint.
 */

export type GreeneryKind = 'plant' | 'garden' | 'tree';
export interface GreeneryEntry {
  id: string; kind: GreeneryKind; height: number; width: number; triangles: number;
  licenseUnverified?: boolean; nonCommercial?: boolean;
}
export interface GreeneryPart { geometry: BufferGeometry; material: Material; foliage: boolean }
export interface GreeneryModel { id: string; height: number; width: number; parts: readonly GreeneryPart[] }

const urls = import.meta.glob<string>('/public-assets/greenery/*.glb', { eager: true, query: '?url', import: 'default' });
const procedural = typeof location !== 'undefined' && new URLSearchParams(location.search).get('greenery') === 'procedural';

/** The licence switch leaves non-commercial and unverified greenery to the procedural fallbacks. */
export function licensedGreenery(entries: readonly GreeneryEntry[] = CATALOG.greenery as GreeneryEntry[],
  commercialOnly = COMMERCIAL_ASSETS_ONLY, available: (id: string) => boolean = id => Boolean(urls[`/public-assets/greenery/${id}.glb`])): GreeneryEntry[] {
  return entries.filter(entry => available(entry.id) && !(commercialOnly && (entry.licenseUnverified || entry.nonCommercial)));
}
export const GREENERY: readonly GreeneryEntry[] = procedural ? [] : licensedGreenery();
const BY_ID = new Map(GREENERY.map(entry => [entry.id, entry]));

/** Pools by role. Missing (unlicensed or unpublished) ids drop out; an empty pool keeps the fallback. */
const pool = (...ids: string[]) => ids.filter(id => BY_ID.has(id));
export const GREENERY_POOLS = {
  indoorPlant: pool('plant-marble-pot', 'plant-round-pot', 'plant-aloe-double'),
  gardenShrub: pool('garden-rhododendron', 'garden-hakonechloa'),
  gardenFlower: pool('garden-iris', 'garden-pasque', 'garden-hakonechloa'),
  shadeTree: pool('tree-oak-tall', 'tree-tulip', 'tree-oak-wide', 'tree-pepper', 'tree-rowan'),
  columnarTree: pool('tree-river-birch', 'tree-avocado', 'tree-butia-palm'),
  ornamentalTree: pool('tree-japanese-maple', 'tree-orange', 'tree-small-palm', 'tree-avocado'),
  palm: pool('tree-butia-palm', 'tree-small-palm'),
} as const;

/** Stable integer hash of a world position (centimetre grid) and a salt. */
export function placementHash(x: number, z: number, salt = 0): number {
  let h = Math.imul(Math.round(x * 100) ^ 0x9e3779b1, 0x85ebca6b) ^ Math.imul(Math.round(z * 100) ^ 0xc2b2ae35, 0x27d4eb2f) ^ salt;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}
const unit = (x: number, z: number, salt: number) => placementHash(x, z, salt) / 4294967296;

/** Deterministic variant for a placement; undefined when the pool is empty. */
export function pickGreenery(ids: readonly string[], x: number, z: number, salt = 0): string | undefined {
  return ids.length ? ids[placementHash(x, z, salt) % ids.length] : undefined;
}

const models = new Map<string, GreeneryModel>();
const requested = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, GreeneryModel> = new Map();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const publish = () => { snapshot = new Map(models); listeners.forEach(listener => listener()); };

function prepare(id: string, scene: Object3D): GreeneryModel {
  const parts: GreeneryPart[] = [];
  scene.updateMatrixWorld(true);
  scene.traverse(node => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    const material = mesh.material as MeshStandardMaterial;
    const foliage = material.alphaTest > 0 || material.side === DoubleSide;
    if (foliage) { material.side = DoubleSide; material.alphaTest = Math.max(material.alphaTest, .4); }
    material.name = `greenery-${id}-${material.name}`;
    parts.push({ geometry, material, foliage });
  });
  const entry = BY_ID.get(id)!;
  return { id, height: entry.height, width: entry.width, parts };
}

async function load(id: string) {
  const url = urls[`/public-assets/greenery/${id}.glb`];
  if (!url || requested.has(id)) return;
  requested.add(id);
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    models.set(id, prepare(id, gltf.scene));
    publish();
  } catch { /* A missing model keeps its procedural fallback. */ }
}

/** Loaded greenery models among `ids` (requests the rest). */
export function useGreenery(ids: readonly (string | undefined)[]): ReadonlyMap<string, GreeneryModel> {
  const loaded = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  const key = ids.filter(Boolean).join(',');
  useEffect(() => { for (const id of key.split(',')) if (id && BY_ID.has(id)) void load(id); }, [key]);
  return loaded;
}

export interface GreeneryPlacement {
  id: string;
  x: number; y: number; z: number;
  /** Target height in metres; the model keeps its proportions. */
  height: number;
  rotationY?: number;
}

const FOLIAGE_TINT = new Color();
/** Slight per-placement foliage variation: lightness and a small hue shift toward yellow or blue-green. */
function tint(target: Color, x: number, z: number): Color {
  const light = .86 + unit(x, z, 11) * .22, warm = (unit(x, z, 12) - .5) * .12;
  return target.setRGB(light * (1 + warm), light, light * (1 - warm));
}

/** Stable yaw for a placement (radians). */
export const placementYaw = (x: number, z: number) => unit(x, z, 7) * Math.PI * 2;
/** Stable size factor in [1 - spread, 1 + spread]. */
export const placementSize = (x: number, z: number, spread = .1) => 1 + (unit(x, z, 9) * 2 - 1) * spread;

/**
 * Instanced placements of many greenery variants: one InstancedMesh per (variant, part), so a grove of
 * a dozen variants costs a few dozen draw calls. Unloaded variants are skipped (callers keep fallbacks).
 */
export function GreeneryInstances({ name, placements, castShadow = true, receiveShadow = true }: {
  name: string; placements: readonly GreeneryPlacement[]; castShadow?: boolean; receiveShadow?: boolean;
}) {
  const loaded = useGreenery(useMemo(() => [...new Set(placements.map(p => p.id))], [placements]));
  const groups = useMemo(() => {
    const byId = new Map<string, GreeneryPlacement[]>();
    for (const placement of placements) if (loaded.has(placement.id)) byId.set(placement.id, [...(byId.get(placement.id) ?? []), placement]);
    return [...byId].map(([id, items]) => ({ model: loaded.get(id)!, items }));
  }, [placements, loaded]);
  return <group name={name} userData={{ officeCollision: false, officePassable: true }}>
    {groups.flatMap(({ model, items }) => model.parts.map((part, index) =>
      <GreeneryPartInstances key={`${model.id}:${index}`} model={model} part={part} items={items} castShadow={castShadow} receiveShadow={receiveShadow} />))}
  </group>;
}

function GreeneryPartInstances({ model, part, items, castShadow, receiveShadow }: {
  model: GreeneryModel; part: GreeneryPart; items: readonly GreeneryPlacement[]; castShadow: boolean; receiveShadow: boolean;
}) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const matrix = new Matrix4(), position = new Vector3(), rotation = new Quaternion(), scale = new Vector3(), up = new Vector3(0, 1, 0);
    items.forEach((item, index) => {
      const size = item.height / model.height;
      position.set(item.x, item.y, item.z);
      rotation.setFromAxisAngle(up, item.rotationY ?? placementYaw(item.x, item.z));
      matrix.compose(position, rotation, scale.setScalar(size));
      mesh.setMatrixAt(index, matrix);
      if (part.foliage) mesh.setColorAt(index, tint(FOLIAGE_TINT, item.x, item.z));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
  }, [items, model, part]);
  return <instancedMesh ref={ref} name={`greenery-${model.id}`} args={[part.geometry, part.material, items.length]}
    castShadow={castShadow} receiveShadow={receiveShadow} userData={{ officeCollision: false, officePassable: true }} />;
}

const TRUNK_PROXY = new MeshBasicMaterial({ visible: false });
/**
 * One greenery model with its procedural fallback (`children`) until it loads. Trees opt out of
 * render-derived collision (a crown can reach the ground) and get a hidden trunk-sized proxy instead.
 */
export function GreeneryModel({ id, height, rotationY, position = [0, 0, 0], trunkRadius, children }: {
  id: string | undefined; height: number; rotationY?: number; position?: readonly [number, number, number];
  /** Trees: radius of the hidden collision proxy (metres, world size). */
  trunkRadius?: number;
  children?: ReactNode;
}) {
  const loaded = useGreenery(useMemo(() => [id], [id]));
  const model = id ? loaded.get(id) : undefined;
  useStaticBatchRevision(model);
  if (!model) return <>{children}</>;
  const size = height / model.height;
  const yaw = rotationY ?? placementYaw(position[0], position[2]);
  return <group position={[...position]} userData={{ officeDynamic: true, greenery: model.id }}>
    <group rotation={[0, yaw, 0]} scale={size} userData={trunkRadius ? { officeCollision: false, officePassable: true } : {}}>
      {model.parts.map((part, index) => <mesh key={index} geometry={part.geometry} material={part.material} castShadow receiveShadow />)}
    </group>
    {trunkRadius !== undefined && <mesh position={[0, .9, 0]} material={TRUNK_PROXY} userData={{ greeneryTrunk: true }}>
      <cylinderGeometry args={[trunkRadius, trunkRadius, 1.8, 6]} />
    </mesh>}
  </group>;
}

export const greeneryHeight = (id: string) => BY_ID.get(id)?.height ?? 1;

/**
 * World position (x, z, floor-aware) of a placement group, measured once after mount. Room prefabs reuse
 * local coordinates, so variants picked from world positions differ between rooms and floors.
 */
export function useWorldSeed<T extends Object3D>(level: 'self' | 'room' = 'self'): [RefObject<T | null>, readonly [number, number] | null] {
  const ref = useRef<T>(null);
  const [seed, setSeed] = useState<readonly [number, number] | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    // `room`: the enclosing room group, so every pot of one room shares its variant and size.
    const anchor = level === 'room' ? node?.parent ?? node : node;
    if (!anchor) return;
    anchor.updateWorldMatrix(true, false);
    const at = anchor.getWorldPosition(new Vector3());
    setSeed([Math.round(at.x * 100) / 100, Math.round((at.z + at.y * 3.7) * 100) / 100]);
  }, [level]);
  return [ref, seed];
}

/** Yaw aligned with the building grid (a quarter turn), stable per placement: planters stand square to the walls. */
export const gridYaw = (x: number, z: number) => (placementHash(x, z, 13) % 4) * Math.PI / 2;
