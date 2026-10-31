import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { Material, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { useSolarEnvironment } from '../Environment';

export const WORKSTATION_ASSETS = [
  'single-desk', 'monitor-stand', 'monitor-shell', 'laptop-deck', 'laptop-lid',
  'keyboard-compact', 'keyboard-full', 'mouse', 'mouse-pad', 'drawer-unit',
  'letter-tray', 'file-holder', 'books', 'plant', 'photo', 'notebook',
  'headphones', 'pen-cup', 'sticky-notes', 'desk-shelf', 'flower-vase', 'ornament-lamp',
] as const;
export type WorkstationAsset = typeof WORKSTATION_ASSETS[number];

const urls = import.meta.glob<string>('/public-assets/furniture/workstation-set.glb', { eager: true, query: '?url', import: 'default' });
const forceProcedural = typeof location !== 'undefined' && new URLSearchParams(location.search).get('workstations') === 'procedural';
let assets: ReadonlyMap<WorkstationAsset, Object3D> | null = null;
let requested = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

async function load(): Promise<void> {
  const url = forceProcedural ? undefined : urls['/public-assets/furniture/workstation-set.glb'];
  if (!url || requested) return;
  requested = true;
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    const found = new Map<WorkstationAsset, Object3D>();
    for (const name of WORKSTATION_ASSETS) {
      const part = gltf.scene.getObjectByName(name);
      if (part) found.set(name, part);
    }
    assets = found;
  } catch { /* Local-only library: a failed request keeps every procedural backup. */ }
  listeners.forEach(listener => listener());
}

export function updateWorkstationLampMaterials(materials: readonly MeshStandardMaterial[], factor: number): void {
  for (const material of materials) material.emissiveIntensity = factor > .05 ? .6 + 2.5 * factor : 0;
}

function LampEmission({ materials }: { materials: readonly MeshStandardMaterial[] }) {
  const { state } = useSolarEnvironment();
  const factor = state.factors.interiorLightFactor;
  useEffect(() => {
    updateWorkstationLampMaterials(materials, factor);
  }, [materials, factor]);
  return null;
}

/** Model geometry is shared; transforms and materials requiring live state are owned by each instance. */
export function createWorkstationInstance(source: Object3D, woodColor?: string): {
  root: Object3D; owned: Material[]; lamps: MeshStandardMaterial[];
} {
  const root = source.clone(true);
  const owned: Material[] = [], lamps: MeshStandardMaterial[] = [];
  const swaps = new Map<Material, Material>();
  root.traverse(node => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const replace = (material: Material): Material => {
      const cached = swaps.get(material);
      if (cached) return cached;
      const lamp = /desk lamp diffuser/i.test(material.name);
      const wood = woodColor !== undefined && /wood|oak/i.test(material.name);
      if (!lamp && !wood) return material;
      const copy = material.clone() as MeshStandardMaterial;
      if (wood) copy.color.set(woodColor!);
      if (lamp) lamps.push(copy);
      owned.push(copy); swaps.set(material, copy);
      return copy;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(replace) : replace(mesh.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
  return { root, owned, lamps };
}

/** A named part of the Blender library. Children provide its original geometry while absent/loading. */
export function WorkstationPart({ asset, children, position, modelScale, woodColor }: {
  asset: WorkstationAsset; children?: ReactNode;
  position?: readonly [number, number, number]; modelScale?: readonly [number, number, number]; woodColor?: string | undefined;
}) {
  const library = useSyncExternalStore(subscribe, () => assets, () => null);
  useEffect(() => { void load(); }, []);
  const source = library?.get(asset);
  const instance = useMemo(() => source ? createWorkstationInstance(source, woodColor) : null, [source, woodColor]);
  useEffect(() => () => { for (const material of instance?.owned ?? []) material.dispose(); }, [instance]);
  // The original must not be baked into a floor-wide batch before the replacement arrives.
  return <group name={`workstation-part-${asset}`} position={position ? [...position] : [0, 0, 0]} userData={{ officeDynamic: true, workstationAsset: asset, workstationAuthored: !!instance }}>
    {instance ? <>
      <group scale={modelScale ? [...modelScale] : [1, 1, 1]}><primitive object={instance.root} dispose={null} /></group>
      {instance.lamps.length > 0 && <LampEmission materials={instance.lamps} />}
    </> : children}
  </group>;
}
