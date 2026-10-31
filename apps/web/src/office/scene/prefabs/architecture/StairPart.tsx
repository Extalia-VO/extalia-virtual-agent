import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { Material, Mesh, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { useStaticBatchRevision } from '../../StaticCampusBatch';

/** Semantic dimensions, never measured bounds (tread overhang and fittings are intentional). */
export const STAIR_PART_NOMINAL = {
  'stair-tread': [2.95, .09, 5.3 / 18],
  'stair-stringer': [.12, .24, 1],
  'stair-landing': [1, .13, 1],
  'stair-handrail': [.052, .036, 1],
  'stair-shoe': [.058, .055, 1],
  'stair-clamp': [.064, .066, .074],
} as const;
export type StairModel = keyof typeof STAIR_PART_NOMINAL;
export function stairPartScale(model: StairModel, dimensions: readonly [number, number, number]): [number, number, number] {
  return dimensions.map((dimension, axis) => dimension / STAIR_PART_NOMINAL[model][axis]!) as [number, number, number];
}

function disposeRejectedScene(scene: Object3D) {
  const geometries = new Set<Mesh['geometry']>(), materials = new Set<Material>();
  scene.traverse(node => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
}
/** One non-Suspense request. Failed/incomplete libraries retain the complete fallback. */
export function createStairLibraryStore(url?: string, loadScene = async (source: string) => (await new GLTFLoader().loadAsync(source)).scene) {
  let snapshot: ReadonlyMap<StairModel, Object3D> | null = null;
  let request: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load() {
      if (!url) return Promise.resolve();
      return request ??= (async () => {
        try {
          const scene = await loadScene(url);
          const parts = new Map<StairModel, Object3D>();
          for (const name of Object.keys(STAIR_PART_NOMINAL) as StairModel[]) {
            const node = scene.getObjectByName(name);
            if (!node) continue;
            let count = 0, valid = true;
            node.traverse(object => {
              const mesh = object as Mesh;
              if (!mesh.isMesh) return;
              count++;
              const positions = mesh.geometry?.getAttribute('position');
              if (!positions?.count || !mesh.material) { valid = false; return; }
              for (let i = 0; i < positions.count; i++) {
                if (!Number.isFinite(positions.getX(i)) || !Number.isFinite(positions.getY(i)) || !Number.isFinite(positions.getZ(i))) valid = false;
              }
            });
            if (valid && count > 0) parts.set(name, node);
          }
          if (parts.size === Object.keys(STAIR_PART_NOMINAL).length) snapshot = parts;
          else disposeRejectedScene(scene);
        } catch { /* Local assets are optional; preserve the procedural assembly. */ }
        listeners.forEach(listener => listener());
      })();
    },
  };
}
const urls = import.meta.glob<string>('/public-assets/architecture/stair-library.glb', { eager: true, query: '?url', import: 'default' });
const procedural = typeof location !== 'undefined' && new URLSearchParams(location.search).get('stairs') === 'procedural';
const library = createStairLibraryStore(procedural ? undefined : urls['/public-assets/architecture/stair-library.glb']);

/** Parent static batches observe readiness and rebake without remounting live scene state. */
export function useStairLibrary() {
  const assets = useSyncExternalStore(library.subscribe, library.getSnapshot, () => null);
  useEffect(() => { void library.load(); }, []);
  return assets;
}

/** Mesh transforms are independent; immutable opaque geometry/materials belong to the library. */
export function createStairInstance(source: Object3D): Object3D {
  const root = source.clone(true);
  root.traverse(node => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.officeInstanceable = true;
  });
  return root;
}

export function StairPart({ model, dimensions, children, rotation = [0, 0, 0], position = [0, 0, 0] }: {
  model: StairModel; dimensions?: readonly [number, number, number]; children: ReactNode;
  rotation?: [number, number, number]; position?: [number, number, number];
}) {
  const assets = useStairLibrary();
  const source = assets?.get(model);
  const instance = useMemo(() => source ? createStairInstance(source) : null, [source]);
  const [px, py, pz] = position, [rx, ry, rz] = rotation;
  const [dx, dy, dz] = dimensions ?? STAIR_PART_NOMINAL[model];
  const placement = useMemo(() => ({ instance, px, py, pz, rx, ry, rz, dx, dy, dz }), [instance, px, py, pz, rx, ry, rz, dx, dy, dz]);
  useStaticBatchRevision(placement);
  return <group name={`stair-part-${model}`} position={position} rotation={rotation}
    userData={{ interiorAuthored: !!instance, stairModel: model }}>
    {instance ? <group scale={dimensions ? stairPartScale(model, dimensions) : [1, 1, 1]}>
      <primitive object={instance} dispose={null} />
    </group> : children}
  </group>;
}
