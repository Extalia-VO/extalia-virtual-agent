import { useLayoutEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { DynamicDrawUsage, InstancedMesh, Matrix4, Object3D, type Mesh, type Material, type Scene } from 'three';

const MIN_INSTANCES = 2;
const RESCAN_MS = 500;
const zero = new Matrix4().makeScale(0, 0, 0);

type Source = {
  mesh: Mesh;
  descriptor: PropertyDescriptor;
  visible: boolean;
  batchSource: unknown;
  world: number[];
  shown: boolean | null;
};
type Batch = { key: string; mesh: InstancedMesh; sources: Source[] };
type ParentVisibility = { frame: number; connected: boolean; shown: boolean };
const detached: ParentVisibility = { frame: -1, connected: false, shown: false };

function authored(mesh: Object3D, scene: Scene): boolean {
  let found = mesh.userData.officeInstanceable === true;
  for (let node: Object3D | null = mesh; node; node = node.parent) {
    if (node === scene) return found;
    if (node.userData.interiorAuthored === true || node.userData.workstationAuthored === true ||
      node.userData.exteriorAuthored === true || node.userData.teamPodAuthored === true) found = true;
  }
  return false;
}

function eligibleKey(mesh: Mesh, scene: Scene, owned: ReadonlyMap<Mesh, Source>): string | null {
  if (!mesh.isMesh || mesh.children.length > 0 || !(owned.get(mesh)?.visible ?? mesh.visible) || (mesh as InstancedMesh).isInstancedMesh || (mesh as Mesh & { isSkinnedMesh?: boolean }).isSkinnedMesh ||
    Array.isArray(mesh.material) || mesh.morphTargetInfluences?.length || mesh.customDepthMaterial || mesh.customDistanceMaterial ||
    !authored(mesh, scene) || (mesh.userData.officeBatchSource && !owned.has(mesh))) return null;
  if (mesh.onBeforeRender !== Object3D.prototype.onBeforeRender || mesh.onAfterRender !== Object3D.prototype.onAfterRender ||
    mesh.onBeforeShadow !== Object3D.prototype.onBeforeShadow || mesh.onAfterShadow !== Object3D.prototype.onAfterShadow) return null;
  const material = mesh.material as Material;
  // Translucent surfaces require object sorting. Array materials and custom draw
  // callbacks also stay in the original scene rather than approximating them.
  if (material.transparent || mesh.matrixWorld.determinant() <= 0) return null;
  const descriptor = owned.get(mesh)?.descriptor ?? Object.getOwnPropertyDescriptor(mesh, 'visible');
  if (!descriptor || !('value' in descriptor) || !descriptor.configurable || !descriptor.writable) return null;
  return [mesh.geometry.uuid, material.uuid, mesh.castShadow, mesh.receiveShadow, mesh.layers.mask, mesh.renderOrder].join('/');
}

/** Reuse immutable Blender geometry/materials across repeated loaded parts.
 * Sources remain available for collision/picking; only their render visibility
 * is intercepted. This class never advances animation or owns shared assets.
 */
export class ModelBatchController {
  private readonly batches = new Map<string, Batch>();
  private readonly owned = new Map<Mesh, Source>();
  private nextScan = 0;
  private updating = false;
  private stopped = false;
  private frame = 0;
  private readonly visibility = new WeakMap<Object3D, ParentVisibility>();
  private readonly rootVisibility: ParentVisibility = { frame: 0, connected: true, shown: true };
  private readonly stats = { batches: 0, sources: 0, visibleInstances: 0 };
  constructor(private readonly scene: Scene) {}

  private releaseSource(source: Source): void {
    if (this.owned.get(source.mesh) !== source) return;
    Object.defineProperty(source.mesh, 'visible', { ...source.descriptor, value: source.visible });
    if (source.batchSource === undefined) delete source.mesh.userData.officeBatchSource;
    else source.mesh.userData.officeBatchSource = source.batchSource;
    this.owned.delete(source.mesh);
  }

  private release(batch: Batch): void {
    for (const source of batch.sources) this.releaseSource(source);
    this.scene.remove(batch.mesh);
    // InstancedMesh.dispose releases instance buffers through the renderer's
    // dispose event; geometry and material still belong to the model library.
    batch.mesh.dispose();
  }

  private scan(): void {
    const groups = new Map<string, Mesh[]>();
    this.scene.traverse(object => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      const key = eligibleKey(mesh, this.scene, this.owned);
      if (!key) return;
      const list = groups.get(key) ?? [];
      list.push(mesh);
      groups.set(key, list);
    });
    const changed = new Set<string>();
    for (const [key, batch] of this.batches) {
      const next = groups.get(key);
      if (!next || next.length < MIN_INSTANCES || next.length !== batch.sources.length ||
        next.some((mesh, index) => mesh !== batch.sources[index]!.mesh || this.owned.get(mesh) !== batch.sources[index])) {
        changed.add(key);
      }
    }
    // Release every changed group before assigning any new one: a source may
    // have moved between material groups since the previous scan.
    for (const key of changed) {
      this.release(this.batches.get(key)!);
      this.batches.delete(key);
    }
    for (const [key, meshes] of groups) {
      if (meshes.length < MIN_INSTANCES || this.batches.has(key)) continue;
      const first = meshes[0]!;
      const instance = new InstancedMesh(first.geometry, first.material, meshes.length);
      instance.name = 'loaded-model-instance-batch';
      instance.userData = { officeCollision: false, officePassable: true, officeDynamic: true, modelInstanceBatch: true };
      instance.castShadow = first.castShadow;
      instance.receiveShadow = first.receiveShadow;
      instance.layers.mask = first.layers.mask;
      instance.renderOrder = first.renderOrder;
      instance.frustumCulled = false;
      instance.matrixAutoUpdate = false;
      instance.matrixWorldAutoUpdate = false;
      instance.matrix.identity();
      instance.matrixWorld.identity();
      instance.instanceMatrix.setUsage(DynamicDrawUsage);
      instance.raycast = () => {};
      const sources = meshes.map(mesh => {
        const source: Source = { mesh, descriptor: Object.getOwnPropertyDescriptor(mesh, 'visible')!,
          visible: mesh.visible, batchSource: mesh.userData.officeBatchSource, world: mesh.matrixWorld.elements.slice(), shown: null };
        Object.defineProperty(mesh, 'visible', { configurable: true, enumerable: source.descriptor.enumerable,
          get: () => false, set: (visible: boolean) => { source.visible = visible; } });
        mesh.userData.officeBatchSource = true;
        this.owned.set(mesh, source);
        return source;
      });
      this.scene.add(instance);
      this.batches.set(key, { key, mesh: instance, sources });
    }
  }

  private parentVisibility(node: Object3D | null): ParentVisibility {
    if (!node) return detached;
    if (node === this.scene) return this.rootVisibility;
    const cached = this.visibility.get(node);
    if (cached?.frame === this.frame) return cached;
    const parent = this.parentVisibility(node.parent);
    const state = cached ?? { frame: this.frame, connected: false, shown: false };
    state.frame = this.frame;
    state.connected = parent.connected;
    state.shown = node.visible && parent.shown;
    if (!cached) this.visibility.set(node, state);
    return state;
  }

  private sameRenderState(source: Source, instance: InstancedMesh): boolean {
    const mesh = source.mesh;
    // Raw identity/scalar comparisons only on the hot path. Authored ancestry,
    // descriptors and UUID grouping keys are checked by the bounded scan.
    return this.owned.get(mesh) === source && source.visible && mesh.children.length === 0 &&
      mesh.geometry === instance.geometry && mesh.material === instance.material &&
      !(mesh.material as Material).transparent && mesh.castShadow === instance.castShadow &&
      mesh.receiveShadow === instance.receiveShadow && mesh.layers.mask === instance.layers.mask &&
      mesh.renderOrder === instance.renderOrder && !mesh.morphTargetInfluences?.length &&
      !mesh.customDepthMaterial && !mesh.customDistanceMaterial &&
      mesh.onBeforeRender === Object3D.prototype.onBeforeRender && mesh.onAfterRender === Object3D.prototype.onAfterRender &&
      mesh.onBeforeShadow === Object3D.prototype.onBeforeShadow && mesh.onAfterShadow === Object3D.prototype.onAfterShadow;
  }

  update(now: number): void {
    if (this.stopped || this.updating) return;
    this.updating = true;
    try {
      if (now >= this.nextScan) { this.scan(); this.nextScan = now + RESCAN_MS; }
      this.frame++;
      this.rootVisibility.frame = this.frame;
      this.rootVisibility.shown = this.scene.visible;
      let visible = 0;
      for (const batch of this.batches.values()) {
        let dirty = false, active = 0;
        for (let index = 0; index < batch.sources.length; index++) {
          const source = batch.sources[index]!;
          const mesh = source.mesh;
          const parent = this.parentVisibility(mesh.parent);
          const world = mesh.matrixWorld.elements;
          let moved = source.shown === null;
          for (let i = 0; !moved && i < 16; i++) moved = world[i] !== source.world[i];
          const valid = parent.connected && this.sameRenderState(source, batch.mesh) &&
            (!moved || mesh.matrixWorld.determinant() > 0);
          // Invalidated sources render normally immediately; a later grouping
          // scan can safely acquire them again without a disappearance window.
          if (!valid) this.releaseSource(source);
          const shown = valid && parent.shown;
          if (shown !== source.shown || (shown && moved)) {
            batch.mesh.setMatrixAt(index, shown ? mesh.matrixWorld : zero);
            dirty = true;
          }
          if (moved) for (let i = 0; i < 16; i++) source.world[i] = world[i]!;
          source.shown = shown;
          if (shown) active++;
        }
        batch.mesh.visible = active > 0;
        if (dirty) batch.mesh.instanceMatrix.needsUpdate = true;
        visible += active;
      }
      this.stats.batches = this.batches.size;
      this.stats.sources = this.owned.size;
      this.stats.visibleInstances = visible;
      this.scene.userData.modelInstanceBatchStats = this.stats;
    } finally { this.updating = false; }
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const batch of this.batches.values()) this.release(batch);
    this.batches.clear();
    delete this.scene.userData.modelInstanceBatchStats;
  }
}

/** Three invokes Scene.onBeforeRender after updating world matrices and before
 * building its render list, including synchronous continuity redraws.
 */
export function installModelInstanceBatches(scene: Scene, now = () => performance.now()): () => void {
  const controller = new ModelBatchController(scene);
  const previous = scene.onBeforeRender;
  const callback: Scene['onBeforeRender'] = function (...args) {
    previous.apply(scene, args);
    controller.update(now());
  };
  scene.onBeforeRender = callback;
  return () => {
    if (scene.onBeforeRender === callback) scene.onBeforeRender = previous;
    controller.dispose();
  };
}

export function ModelInstanceBatches() {
  const scene = useThree(state => state.scene);
  useLayoutEffect(() => installModelInstanceBatches(scene), [scene]);
  return null;
}
