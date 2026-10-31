/* eslint-disable react-hooks/immutability -- layers, batch flags and the shadow pass are renderer-owned mutable state. */
import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { Camera, InstancedMesh, Mesh, Object3D, Scene, WebGLRenderer } from 'three';
import { getRenderBudgetLevel } from './renderBudget';
import { campusOverviewZoom, cullableMaterial, overviewCandidate, overviewFlags, OVERVIEW_CULL_RADIUS_PX, OVERVIEW_CULLED_LAYER, pixelsPerMetre, setCampusOverview } from './overviewLod';

/** Rescan for mounted/unmounted meshes this often (seconds); size tests rerun whenever the zoom or tier changes. */
const RESCAN_SECONDS = 2;
const CULLED_MASK = 1 << OVERVIEW_CULLED_LAYER;

type Candidate = { object: Mesh | InstancedMesh; radius: number; batch: boolean };

function worldRadius(mesh: Mesh): number {
  const geometry = mesh.geometry;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  return (geometry.boundingSphere?.radius ?? Infinity) * mesh.matrixWorld.getMaxScaleOnAxis();
}

/** Largest instance scale of a loaded-model batch (hidden instances are zero matrices). */
function batchRadius(batch: InstancedMesh): number {
  const geometry = batch.geometry;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const elements = batch.instanceMatrix.array;
  let scale = 0;
  for (let i = 0; i < batch.count; i++) {
    const o = i * 16;
    scale = Math.max(scale, Math.hypot(elements[o]!, elements[o + 1]!, elements[o + 2]!), Math.hypot(elements[o + 4]!, elements[o + 5]!, elements[o + 6]!),
      Math.hypot(elements[o + 8]!, elements[o + 9]!, elements[o + 10]!));
  }
  return (geometry.boundingSphere?.radius ?? Infinity) * (scale || Infinity);
}

/** Loaded furniture models (interior parts, workstations, team pods); architecture and stairs are not furniture. */
function furnitureRoot(object: Object3D): boolean {
  const data = object.userData;
  return data.interiorModel !== undefined || data.workstationAsset !== undefined || 'teamPodAuthored' in data;
}

function collect(scene: Scene, furniture: Object3D[]): Candidate[] {
  const found: Candidate[] = [];
  furniture.length = 0;
  for (const floor of scene.children) {
    if (!/^furnished-floor-\d$/.test(floor.name)) continue;
    const walk = (node: Object3D) => { if (furnitureRoot(node)) furniture.push(node); else node.children.forEach(walk); };
    walk(floor);
  }
  scene.traverse((object: Object3D) => {
    const mesh = object as Mesh & { isInstancedMesh?: boolean };
    if (!mesh.isMesh) return;
    if (mesh.isInstancedMesh) {
      if (mesh.userData.modelInstanceBatch === true && cullableMaterial(mesh.material)) found.push({ object: mesh as unknown as InstancedMesh, radius: batchRadius(mesh as unknown as InstancedMesh), batch: true });
      return;
    }
    if (overviewCandidate(mesh)) found.push({ object: mesh, radius: worldRadius(mesh), batch: false });
  });
  return found;
}

/**
 * Campus-overview cost cuts that leave the picture as it is at that distance (see `overviewLod.ts`):
 * sub-pixel, non-emissive detail is skipped in the campus view, and the key light's shadow pass skips the
 * loaded interior furniture there (instanced batches and furniture models; architecture, slabs, stairs and
 * people still cast). The interior sits under the roof and furniture shadows are a few pixels at most from
 * outside. Floor and stack views are unchanged.
 */
export function OverviewDetail({ campus }: { campus: boolean }) {
  const gl = useThree(state => state.gl) as WebGLRenderer;
  const scene = useThree(state => state.scene);
  const live = useMemo(() => ({ campus: false, overviewZoom: false, candidates: [] as Candidate[], culled: new Map<Mesh, number>(), culledBatches: new Set<InstancedMesh>(),
    nextScan: 0, threshold: -1, interiorShadowsHidden: [] as Object3D[], furniture: [] as Object3D[], stats: { candidates: 0, culled: 0, culledBatches: 0 } }), []);

  const restore = () => {
    for (const [mesh, mask] of live.culled) mesh.layers.mask = mask;
    live.culled.clear();
    for (const batch of live.culledBatches) delete batch.userData.officeDetailCulled;
    live.culledBatches.clear();
    live.threshold = -1;
  };

  useEffect(() => {
    // At campus overview zoom, interior furniture leaves the key-light shadow pass (main pass unchanged).
    const shadowMap = gl.shadowMap as WebGLRenderer['shadowMap'] & { render(lights: unknown, scene: Scene, camera: Camera): void };
    const original = shadowMap.render;
    shadowMap.render = function render(lights, target, camera) {
      if (!live.overviewZoom || overviewFlags.interiorShadows) return original.call(this, lights, target, camera);
      const hidden = live.interiorShadowsHidden;
      for (const child of target.children) {
        if (child.visible && child.userData.modelInstanceBatch === true && child.userData.officeInterior === true) { child.visible = false; hidden.push(child); }
      }
      for (const root of live.furniture) if (root.visible) { root.visible = false; hidden.push(root); }
      try { original.call(this, lights, target, camera); } finally {
        for (const child of hidden) child.visible = true;
        hidden.length = 0;
      }
    };
    return () => { shadowMap.render = original; restore(); live.candidates = []; live.furniture = []; setCampusOverview(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, live]);

  useFrame(({ camera, size, clock }) => {
    live.campus = campus;
    const metre = pixelsPerMetre(camera as Camera & { zoom: number }, size.height, camera.position.length());
    live.overviewZoom = campus && campusOverviewZoom(metre, live.overviewZoom);
    setCampusOverview(live.overviewZoom);
    const active = campus && overviewFlags.detailCull;
    if (!active) { if (live.culled.size || live.culledBatches.size) restore(); return; }
    const level = getRenderBudgetLevel();
    const radiusPx = OVERVIEW_CULL_RADIUS_PX[Math.min(level, OVERVIEW_CULL_RADIUS_PX.length - 1)]!;
    const threshold = radiusPx / metre;
    const rescan = clock.elapsedTime >= live.nextScan;
    if (rescan) { live.candidates = collect(scene, live.furniture); live.nextScan = clock.elapsedTime + RESCAN_SECONDS; }
    else if (Math.abs(threshold - live.threshold) < 1e-6) return;
    live.threshold = threshold;
    let culled = 0, culledBatches = 0;
    for (const { object, radius, batch } of live.candidates) {
      const small = radius < threshold;
      if (batch) {
        const instanced = object as InstancedMesh;
        if (small) { instanced.userData.officeDetailCulled = true; live.culledBatches.add(instanced); culledBatches++; }
        else if (live.culledBatches.delete(instanced)) delete instanced.userData.officeDetailCulled;
        continue;
      }
      const mesh = object as Mesh;
      if (small) {
        if (!live.culled.has(mesh)) { live.culled.set(mesh, mesh.layers.mask); mesh.layers.mask = CULLED_MASK; }
        culled++;
      } else if (live.culled.has(mesh)) { mesh.layers.mask = live.culled.get(mesh)!; live.culled.delete(mesh); }
    }
    // Meshes that unmounted or became batch sources since the last scan get their layers back.
    if (rescan) {
      const current = new Set(live.candidates.map(candidate => candidate.object));
      for (const [mesh, mask] of live.culled) if (!current.has(mesh)) { mesh.layers.mask = mask; live.culled.delete(mesh); }
      for (const batch of live.culledBatches) if (!current.has(batch)) { delete batch.userData.officeDetailCulled; live.culledBatches.delete(batch); }
    }
    live.stats = { candidates: live.candidates.length, culled, culledBatches };
    scene.userData.overviewDetailStats = live.stats;
  });
  return null;
}
