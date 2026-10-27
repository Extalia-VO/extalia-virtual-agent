import { useEffect, useSyncExternalStore } from 'react';
import { MeshStandardMaterial, type BufferGeometry, type Mesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { DeskChairVariant } from './deskChairs';
import { mergeChair } from './chairGeometry';

/** Blender files stay local, like campus/source-avatar models. Missing/broken files keep the backup. */
const urls = import.meta.glob<string>('/local-assets/furniture/office-chair-*.glb', { eager: true, query: '?url', import: 'default' });
const forceProcedural = typeof location !== 'undefined' && new URLSearchParams(location.search).get('chairs') === 'procedural';
const cache = new Map<DeskChairVariant, BufferGeometry | null>();
const pending = new Set<DeskChairVariant>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

// Shared by static and moving chairs; there is still only one instanced draw per variant/floor.
export const OFFICE_CHAIR_MODEL_MATERIAL = new MeshStandardMaterial({ vertexColors: true, roughness: .74, metalness: .14 });

async function load(variant: DeskChairVariant): Promise<void> {
  const url = forceProcedural ? undefined : urls[`/local-assets/furniture/office-chair-${variant}.glb`];
  if (!url || pending.has(variant) || cache.has(variant)) return;
  pending.add(variant);
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    try {
      const geometry = mergeChair(gltf.scene);
      if (!geometry) throw new Error('Empty chair model');
      cache.set(variant, geometry);
    } finally {
      // Only the baked geometry is retained. GLTF source buffers/materials are not mounted.
      gltf.scene.traverse(node => {
        const mesh = node as Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
      });
    }
  } catch {
    cache.set(variant, null);
  } finally {
    pending.delete(variant);
    listeners.forEach(listener => listener());
  }
}

/** Module-owned geometry is shared for the renderer lifetime; consumers must not dispose it. */
export function useOfficeChairModel(variant: DeskChairVariant): BufferGeometry | null {
  const geometry = useSyncExternalStore(subscribe, () => cache.get(variant) ?? null, () => null);
  useEffect(() => { void load(variant); }, [variant]);
  return geometry;
}
