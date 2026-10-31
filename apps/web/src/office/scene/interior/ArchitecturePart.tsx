import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { FrontSide, type Material, type Mesh, type MeshStandardMaterial, type Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { useStaticBatchRevision } from '../StaticCampusBatch';

export const ARCHITECTURE_MODELS = [
  'architecture-glass-panel', 'architecture-glass-transom', 'architecture-solid-wall',
  'architecture-hinged-frame', 'architecture-hinged-glass-leaf', 'architecture-hinged-wood-leaf',
  'architecture-sliding-frame', 'architecture-sliding-leaf',
] as const;
export type ArchitectureModel = typeof ARCHITECTURE_MODELS[number];

/** Reject partial libraries so one doorway never mixes incompatible authored parts. */
export function collectArchitectureModels(scene: Object3D): ReadonlyMap<ArchitectureModel, Object3D> | null {
  const models = new Map<ArchitectureModel, Object3D>();
  for (const name of ARCHITECTURE_MODELS) {
    const root = scene.getObjectByName(name);
    if (!root) return null;
    let meshes = 0, valid = true;
    root.traverse(node => {
      const mesh = node as Mesh;
      if (!mesh.isMesh) return;
      meshes++;
      const positions = mesh.geometry?.getAttribute('position');
      if (!positions?.count || !mesh.material) { valid = false; return; }
      for (let i = 0; i < positions.count; i++) {
        if (!Number.isFinite(positions.getX(i)) || !Number.isFinite(positions.getY(i)) || !Number.isFinite(positions.getZ(i))) valid = false;
      }
    });
    if (!valid || !meshes) return null;
    models.set(name, root);
  }
  return models;
}

type Lease = { material: Material; retain: () => void; release: () => void };
/** Share normalized glass and equal paint variants instead of creating a material per wall. */
export class ArchitectureMaterialPool {
  private readonly entries = new WeakMap<Material, Map<string, { material: Material; refs: number }>>();
  acquire(source: Material, wallColor?: string): Lease {
    const glazing = /architecture glazing/i.test(source.name);
    const tint = wallColor !== undefined && /architecture wall paint/i.test(source.name);
    if (!glazing && !source.transparent && !tint) return { material: source, retain: () => {}, release: () => {} };
    const key = tint ? `paint:${wallColor!.toLowerCase()}` : glazing ? 'glazing' : 'transparent';
    let variants = this.entries.get(source);
    if (!variants) { variants = new Map(); this.entries.set(source, variants); }
    let entry = variants.get(key);
    if (!entry) {
      const material = source.clone() as MeshStandardMaterial;
      if (tint) material.color.set(wallColor!);
      if (glazing) {
        material.color.set('#c5e2e4'); material.transparent = true; material.opacity = 0.2;
        material.roughness = 0.12; material.metalness = 0.02;
      }
      if (material.transparent) {
        // Glazing is a closed thin box: front faces show from either side
        // without compositing the rear surface through the same pane.
        material.depthWrite = false; material.side = FrontSide; material.forceSinglePass = true;
      }
      entry = { material, refs: 0 }; variants.set(key, entry);
    }
    let retained = false;
    return { material: entry.material, retain: () => {
      if (!retained) { retained = true; entry.refs++; }
    }, release: () => {
      if (!retained) return;
      retained = false;
      if (--entry.refs === 0) queueMicrotask(() => {
        // Strict Mode replays effect setup/cleanup synchronously. Keep the
        // borrowed identity alive until a real unmount releases the last user.
        if (entry.refs === 0 && variants.get(key) === entry) { variants.delete(key); entry.material.dispose(); }
      });
    } };
  }
}
const materials = new ArchitectureMaterialPool();

/** Clone transforms only; immutable geometry and compatible materials retain shared identity. */
export function createArchitectureInstance(source: Object3D, wallColor?: string, pool = materials) {
  const root = source.clone(true), leases = new Map<Material, Lease>();
  root.traverse(node => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const replace = (original: Material) => {
      let lease = leases.get(original);
      if (!lease) { lease = pool.acquire(original, wallColor); leases.set(original, lease); }
      return lease.material;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(replace) : replace(mesh.material);
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mesh.castShadow = !list.every(material => material.transparent);
    mesh.receiveShadow = !list.every(material => material.transparent);
  });
  return { root, retain: () => { leases.forEach(lease => lease.retain()); }, dispose: () => { leases.forEach(lease => lease.release()); } };
}

const urls = import.meta.glob<string>('/public-assets/architecture/interior-architecture.glb', { eager: true, query: '?url', import: 'default' });
const procedural = typeof location !== 'undefined' && new URLSearchParams(location.search).get('architecture') === 'procedural';
let library: ReadonlyMap<ArchitectureModel, Object3D> | null = null, requested = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
async function load() {
  const url = procedural ? undefined : urls['/public-assets/architecture/interior-architecture.glb'];
  if (!url || requested) return;
  requested = true;
  try { library = collectArchitectureModels((await new GLTFLoader().loadAsync(url)).scene); }
  catch { /* Preserve the complete procedural wall and door visuals when loading fails. */ }
  listeners.forEach(listener => listener());
}

/** A containing static batch uses this snapshot as its revision when assets arrive. */
export function useArchitectureLibrary() {
  const assets = useSyncExternalStore(subscribe, () => library, () => null);
  useEffect(() => { void load(); }, []);
  return assets;
}

/** The app owns articulation and collision. Nominal scales affect only authored visuals. */
export function ArchitecturePart({ model, children, position, modelScale, wallColor }: {
  model: ArchitectureModel; children?: ReactNode; position?: readonly [number, number, number];
  modelScale?: readonly [number, number, number]; wallColor?: string;
}) {
  const assets = useArchitectureLibrary();
  const source = assets?.get(model);
  const instance = useMemo(() => source ? createArchitectureInstance(source, wallColor) : null, [source, wallColor]);
  const [px = 0, py = 0, pz = 0] = position ?? [], [sx = 1, sy = 1, sz = 1] = modelScale ?? [];
  const placement = useMemo(() => ({ instance, px, py, pz, sx, sy, sz }), [instance, px, py, pz, sx, sy, sz]);
  useStaticBatchRevision(placement);
  useLayoutEffect(() => { instance?.retain(); return () => instance?.dispose(); }, [instance]);
  return <group name={`architecture-part-${model}`} position={position ? [...position] : [0, 0, 0]}
    userData={{ interiorAuthored: !!instance, architectureModel: model }}>
    {instance ? <group scale={modelScale ? [...modelScale] : [1, 1, 1]}><primitive object={instance.root} dispose={null} /></group> : children}
  </group>;
}
