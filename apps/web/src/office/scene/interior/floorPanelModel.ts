import { useEffect, useSyncExternalStore } from 'react';
import type { BufferGeometry, Material, Mesh, Object3D, Texture } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Local Blender geometry is optional; floor finishes retain their application materials. */
const urls = import.meta.glob<string>('/public-assets/floors/floor-panel.glb', { eager: true, query: '?url', import: 'default' });
const forceProcedural = typeof location !== 'undefined' && new URLSearchParams(location.search).get('floors') === 'procedural';
let cached: BufferGeometry | null = null;
let requested = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Bake the one normalized panel and centre its volume for FootprintBox's scaling contract. */
export function bakeFloorPanelGeometry(scene: Object3D): BufferGeometry | null {
  scene.updateWorldMatrix(true, true);
  const meshes: Mesh[] = [];
  scene.traverse(node => { if ((node as Mesh).isMesh) meshes.push(node as Mesh); });
  if (meshes.length !== 1) return null;
  const mesh = meshes[0]!;
  const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const coordinates = box ? [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z] : [];
  const expected = [-.5, -1, -.5, .5, 0, .5];
  if (!box || coordinates.some((value, index) => !Number.isFinite(value) || Math.abs(value - expected[index]!) > 1e-5) ||
      !geometry.getAttribute('position') || !geometry.getAttribute('normal') || !geometry.getAttribute('uv')) {
    geometry.dispose();
    return null;
  }
  geometry.translate(0, .5, 0);
  geometry.clearGroups();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.name = 'blender-floor-panel-unit';
  return geometry;
}

function disposeImportedScene(scene: Object3D): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  scene.traverse(node => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value && typeof value === 'object' && (value as Texture).isTexture) textures.add(value as Texture);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

async function load(): Promise<void> {
  if (requested) return;
  requested = true;
  const url = forceProcedural ? undefined : urls['/public-assets/floors/floor-panel.glb'];
  if (!url) return;
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    try { cached = bakeFloorPanelGeometry(gltf.scene); }
    finally { disposeImportedScene(gltf.scene); }
  } catch {
    cached = null;
  } finally {
    listeners.forEach(listener => listener());
  }
}

/** Shared renderer-lifetime geometry. Consumers must not dispose it; null uses the procedural box. */
export function useFloorPanelModel(): BufferGeometry | null {
  const geometry = useSyncExternalStore(subscribe, () => cached, () => null);
  useEffect(() => { void load(); }, []);
  return geometry;
}
