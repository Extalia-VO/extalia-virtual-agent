/* eslint-disable react-hooks/immutability -- layers, batch flags and the shadow pass are renderer-owned mutable state. */
import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Frustum, Matrix4, Sphere, type Camera, type InstancedMesh, type Mesh, type Object3D, type Scene, type WebGLRenderer } from 'three';
import { INITIAL_RENDER_BUDGET_LEVEL } from './renderBudget';
import {
  campusOverviewZoom, cullableMaterial, deskCloseupZoom, isSmallDecorGroup, overviewCandidate,
  overviewFlags, OVERVIEW_CULL_RADIUS_PX, OVERVIEW_CULLED_LAYER, pixelsPerMetre, setCampusOverview,
  shouldCullSmallDecor,
} from './overviewLod';

/** Rescan for mounted/unmounted meshes this often (seconds); size tests rerun whenever the zoom or viewport changes. */
const RESCAN_SECONDS = 2;
const CULLED_MASK = 1 << OVERVIEW_CULLED_LAYER;
const DECOR_FRUSTUM_RADIUS = 1.35;

type Candidate = { object: Mesh | InstancedMesh; radius: number; batch: boolean };

function worldRadius(mesh: Mesh): number {
  const geometry = mesh.geometry;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  return (geometry.boundingSphere?.radius ?? Infinity) * mesh.matrixWorld.getMaxScaleOnAxis();
}

/** Largest visible instance scale of a loaded-model batch (only its active prefix is submitted). */
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

function collect(scene: Scene, furniture: Object3D[], decorGroups: Object3D[]): Candidate[] {
  const found: Candidate[] = [];
  furniture.length = 0;
  decorGroups.length = 0;
  for (const floor of scene.children) {
    if (!/^furnished-floor-\d$/.test(floor.name)) continue;
    const walk = (node: Object3D) => { if (furnitureRoot(node)) furniture.push(node); else node.children.forEach(walk); };
    const walkDecor = (node: Object3D) => { if (isSmallDecorGroup(node)) decorGroups.push(node); else node.children.forEach(walkDecor); };
    walk(floor);
    walkDecor(floor);
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
 * Overview and distance-based cost cuts that leave the picture as it is at that distance (see `overviewLod.ts`):
 * sub-pixel, non-emissive detail is skipped in the campus and stack views, small desk props and secondary
 * monitors hide when not zoomed in close (and are frustum-culled per desk during close-ups), and the key
 * light's shadow pass skips loaded interior furniture at overview distance while architecture, slabs, stairs
 * and people still cast.
 */
export function OverviewDetail({ campus, stacked = false }: { campus: boolean; stacked?: boolean }) {
  const gl = useThree(state => state.gl) as WebGLRenderer;
  const scene = useThree(state => state.scene);
  const live = useMemo(() => ({
    campus: false, stacked: false, overviewZoom: false, closeupZoom: false, wasCloseup: null as boolean | null,
    candidates: [] as Candidate[], culled: new Map<Mesh, number>(), culledBatches: new Set<InstancedMesh>(),
    decorGroups: [] as Object3D[], hiddenDecor: new Set<Object3D>(),
    frustum: new Frustum(), projScreenMatrix: new Matrix4(), sphere: new Sphere(), cameraSignature: '',
    nextScan: 0, threshold: -1, interiorShadowsHidden: [] as Object3D[], furniture: [] as Object3D[],
    stats: { candidates: 0, culled: 0, culledBatches: 0, hiddenDecor: 0 },
  }), []);

  const restoreMeshes = () => {
    for (const [mesh, mask] of live.culled) mesh.layers.mask = mask;
    live.culled.clear();
    for (const batch of live.culledBatches) delete batch.userData.officeDetailCulled;
    live.culledBatches.clear();
    live.threshold = -1;
  };

  const restore = () => {
    restoreMeshes();
    for (const group of live.hiddenDecor) group.visible = true;
    live.hiddenDecor.clear();
    live.wasCloseup = null;
  };

  useEffect(() => {
    // At overview zoom, interior furniture leaves the key-light shadow pass (main pass unchanged).
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
    return () => { shadowMap.render = original; restore(); live.candidates = []; live.furniture = []; live.decorGroups = []; setCampusOverview(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, live]);

  useFrame(({ camera, size, clock }) => {
    live.campus = campus;
    live.stacked = stacked;
    const metre = pixelsPerMetre(camera as Camera & { zoom: number }, size.height, camera.position.length());
    live.overviewZoom = (campus || stacked) && campusOverviewZoom(metre, live.overviewZoom);
    setCampusOverview(campus && live.overviewZoom);
    const closeup = !campus && !stacked && deskCloseupZoom(metre, live.closeupZoom);
    live.closeupZoom = closeup;
    if (!overviewFlags.detailCull) {
      if (live.culled.size || live.culledBatches.size || live.hiddenDecor.size) restore();
      return;
    }
    const rescan = clock.elapsedTime >= live.nextScan;
    if (rescan) {
      live.candidates = collect(scene, live.furniture, live.decorGroups);
      live.nextScan = clock.elapsedTime + RESCAN_SECONDS;
      const currentDecor = new Set(live.decorGroups);
      for (const group of live.hiddenDecor) if (!currentDecor.has(group)) { group.visible = true; live.hiddenDecor.delete(group); }
    }

    if (!closeup) {
      if (rescan || live.wasCloseup !== false) {
        for (const group of live.decorGroups) {
          if (group.visible) { group.visible = false; live.hiddenDecor.add(group); }
        }
        live.wasCloseup = false;
      }
    } else {
      const camSig = `${Math.round(camera.position.x * 20)},${Math.round(camera.position.y * 20)},${Math.round(camera.position.z * 20)},${Math.round(metre * 10)}`;
      if (rescan || live.wasCloseup !== true || camSig !== live.cameraSignature) {
        live.cameraSignature = camSig;
        live.wasCloseup = true;
        live.projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        live.frustum.setFromProjectionMatrix(live.projScreenMatrix);
        live.sphere.radius = DECOR_FRUSTUM_RADIUS;
        for (const group of live.decorGroups) {
          const e = group.matrixWorld.elements;
          live.sphere.center.set(e[12]!, e[13]!, e[14]!);
          if (shouldCullSmallDecor(true, live.frustum.intersectsSphere(live.sphere))) {
            if (group.visible) { group.visible = false; live.hiddenDecor.add(group); }
          } else if (live.hiddenDecor.delete(group)) {
            group.visible = true;
          }
        }
      }
    }

    const active = (campus || stacked) && overviewFlags.detailCull;
    if (!active) { if (live.culled.size || live.culledBatches.size) restoreMeshes(); return; }
    // Resolution probes change only the drawing buffer, never the scene's detail.
    const radiusPx = OVERVIEW_CULL_RADIUS_PX[INITIAL_RENDER_BUDGET_LEVEL]!;
    const threshold = radiusPx / metre;
    if (!rescan && Math.abs(threshold - live.threshold) < 1e-6) return;
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
    live.stats = { candidates: live.candidates.length, culled, culledBatches, hiddenDecor: live.hiddenDecor.size };
    scene.userData.overviewDetailStats = live.stats;
  });
  return null;
}
