import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { Group, Mesh: _Mesh, Texture } = await import(webRequire.resolve('three'));
const { GLTFLoader } = await import(webRequire.resolve('three/examples/jsm/loaders/GLTFLoader.js'));
type GroupType = InstanceType<typeof Group>;
type MeshType = InstanceType<typeof _Mesh>;
const lifecycle = { root: null as GroupType | null, effect: undefined as (() => void | (() => void)) | undefined };
vi.doMock(webRequire.resolve('react'), async () => ({
  ...await vi.importActual<Record<string, unknown>>(webRequire.resolve('react')),
  useRef: () => ({ current: lifecycle.root }),
  useState: () => [0, () => {}],
  useCallback: (callback: unknown) => callback,
  useLayoutEffect: (effect: () => void | (() => void)) => { lifecycle.effect = effect; },
}));
const { StaticCampusBatch } = await import('../../apps/web/src/office/scene/StaticCampusBatch');
const { createLiveModel, roleOf, updateLiveModelLighting } = await import('../../apps/web/src/office/scene/campusModels');


function meshes(root: GroupType, visibleOnly = false): MeshType[] {
  const found: MeshType[] = [];
  const collect = (node: MeshType) => { if (node.isMesh) found.push(node); };
  if (visibleOnly) root.traverseVisible(collect); else root.traverse(collect);
  return found;
}
function triangleCount(mesh: MeshType): number {
  return (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3;
}

describe('actual loaded Blender shell static batching', () => {
  for (const name of ['extalia-shell', 'terrace', 'roof-stair', 'elevators']) {
    const localFile = new URL(`../../apps/web/local-assets/building/${name}.glb`, import.meta.url);
    it.skipIf(!existsSync(localFile))(`${name}: reduces opaque draws without changing triangles, live materials or source ownership`, async () => {
    // Node has no image decoder. Keep each authored texture dependency and its
    // sharing identity while testing actual GLB geometry/material batching.
    const loader = new GLTFLoader().register(() => ({ name: 'test_texture_identity',
      loadTexture: () => Promise.resolve(new Texture()) }));
    const source = (await loader.parseAsync(new Uint8Array(readFileSync(localFile)).buffer, '')).scene;
    const model = createLiveModel(source);
    const wrapper = new Group(); wrapper.add(model.root); wrapper.updateWorldMatrix(true, true);
    const sourceVisibility = meshes(source).map(mesh => mesh.visible);
    const originals = meshes(model.root);
    const live = originals.filter(mesh => {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      return materials.some(material => roleOf(material) !== 'solid');
    });
    const liveRefs = live.map(mesh => mesh.material);
    const before = meshes(wrapper, true);
    const triangles = before.reduce((sum, mesh) => sum + triangleCount(mesh), 0);
    const solids = before.filter(mesh => !mesh.userData.officeDynamic);
    expect(solids.length).toBeGreaterThan(10);
    lifecycle.root = wrapper; StaticCampusBatch({ children: null });
    const cleanup = lifecycle.effect?.();
    try {
      const after = meshes(wrapper, true);
      const stats = wrapper.userData.staticBatchStats;
      expect(stats.mergedMeshes).toBeGreaterThan(10);
      expect(after.length).toBeLessThan(before.length - solids.length * .5);
      expect(after.reduce((sum, mesh) => sum + triangleCount(mesh), 0)).toBe(triangles);
      live.forEach((mesh, index) => {
        expect(mesh.visible).toBe(true);
        expect(mesh.userData.officeDynamic).toBe(true);
        expect(mesh.material).toBe(liveRefs[index]);
        expect(mesh.userData.officeBatchSource).toBeUndefined();
      });
      updateLiveModelLighting(model, 1, 1);
      if (name === 'extalia-shell') expect(model.facadeGlass.length).toBeGreaterThan(0);
      model.facadeGlass.forEach(material => expect(material.emissiveIntensity).toBe(.16));
      model.accents.forEach(material => expect(material.emissiveIntensity).toBe(.65));
      updateLiveModelLighting(model, 0, 0);
      model.facadeGlass.forEach(material => expect(material.emissiveIntensity).toBe(0));
      model.accents.forEach(material => expect(material.emissiveIntensity).toBe(0));
      expect(meshes(source).map(mesh => mesh.visible)).toEqual(sourceVisibility);
    } finally {
      if (typeof cleanup === 'function') cleanup();
      expect(meshes(wrapper, true).length).toBe(before.length);
      originals.forEach(mesh => expect(mesh.userData.officeBatchSource).toBeUndefined());
      model.owned.forEach(material => material.dispose());
      const geometries = new Set(meshes(source).map(mesh => mesh.geometry));
      geometries.forEach(geometry => geometry.dispose());
      const materials = new Set(meshes(source).flatMap(mesh => Array.isArray(mesh.material) ? mesh.material : [mesh.material]));
      materials.forEach(material => material.dispose());
    }
    });
  }
});
