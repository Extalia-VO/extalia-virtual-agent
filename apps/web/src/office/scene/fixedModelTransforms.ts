import { useLayoutEffect } from 'react';
import { Object3D, type Mesh } from 'three';

/** These clone constructors own immutable internal poses; articulation is outside
 * the clone. Source assets are never modified. Tiny clones use normal Three updates. */
export function installFixedModelTransforms(root: Object3D): () => void {
  const nodes: Object3D[] = [];
  let supported = true;
  root.traverse(node => {
    const mesh = node as Mesh & { isSkinnedMesh?: boolean; isBone?: boolean };
    const data = node.userData;
    if (!['Group', 'Object3D', 'Mesh'].includes(node.type) || mesh.isSkinnedMesh || mesh.isBone || mesh.morphTargetInfluences?.length || node.animations.length > 0 ||
      data.officeDynamic || data.officeSeat || data.officeSeatStation || data.officeStaticBatch ||
      !node.matrixWorldAutoUpdate || node.updateMatrix !== Object3D.prototype.updateMatrix ||
      node.updateMatrixWorld !== Object3D.prototype.updateMatrixWorld || node.updateWorldMatrix !== Object3D.prototype.updateWorldMatrix ||
      node.onBeforeRender !== Object3D.prototype.onBeforeRender || node.onAfterRender !== Object3D.prototype.onAfterRender ||
      node.onBeforeShadow !== Object3D.prototype.onBeforeShadow || node.onAfterShadow !== Object3D.prototype.onAfterShadow) supported = false;
    nodes.push(node);
  });
  if (!supported || nodes.length < 9) return () => {};
  root.updateWorldMatrix(true, true);
  const locals = nodes.slice(1).map(node => node.matrix.clone());
  const previous = root.userData.fixedModelTransformCache;
  const stats = { nodes: nodes.length, skippedFrames: 0, refreshes: 0 };
  root.userData.fixedModelTransformCache = stats;
  const descriptor = Object.getOwnPropertyDescriptor(root, 'updateMatrixWorld');
  const original = root.updateMatrixWorld;
  let parent = root.parent, ready = false, disposed = false;
  const local = new Float64Array(16), world = new Float64Array(16), parentWorld = new Float64Array(16), pose = new Float64Array(10);
  const differs = (matrix: readonly number[], saved: Float64Array) => {
    for (let i = 0; i < 16; i++) if (matrix[i] !== saved[i]) return true;
    return false;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const node of nodes) { node.removeEventListener('childadded', dispose); node.removeEventListener('childremoved', dispose); }
    if (root.updateMatrixWorld === update) {
      if (descriptor) Object.defineProperty(root, 'updateMatrixWorld', descriptor);
      else delete (root as Partial<Object3D>).updateMatrixWorld;
    }
    if (root.userData.fixedModelTransformCache === stats) {
      if (previous === undefined) delete root.userData.fixedModelTransformCache;
      else root.userData.fixedModelTransformCache = previous;
    }
  };
  const update: Object3D['updateMatrixWorld'] = function (force) {
    if (root.updateMatrix !== Object3D.prototype.updateMatrix || !root.matrixWorldAutoUpdate) {
      dispose(); original.call(root, force); return;
    }
    const p = root.position, q = root.quaternion, s = root.scale;
    const changed = !ready || root.matrixWorldNeedsUpdate || root.parent !== parent ||
      p.x !== pose[0] || p.y !== pose[1] || p.z !== pose[2] || q.x !== pose[3] || q.y !== pose[4] || q.z !== pose[5] || q.w !== pose[6] ||
      s.x !== pose[7] || s.y !== pose[8] || s.z !== pose[9] ||
      differs(root.matrix.elements, local) || differs(root.matrixWorld.elements, world) ||
      (root.parent !== null && differs(root.parent.matrixWorld.elements, parentWorld));
    if (!changed) { stats.skippedFrames++; return; }
    if (root.matrixAutoUpdate) root.updateMatrix();
    if (root.parent) root.matrixWorld.multiplyMatrices(root.parent.matrixWorld, root.matrix);
    else root.matrixWorld.copy(root.matrix);
    root.matrixWorldNeedsUpdate = false;
    // Preorder refresh follows animated placement parents without recomposing
    // the immutable clone's local poses. Queries retain Three's normal methods.
    for (let i = 1; i < nodes.length; i++) {
      const node = nodes[i]!;
      node.matrixWorld.multiplyMatrices(node.parent!.matrixWorld, locals[i - 1]!);
      node.matrixWorldNeedsUpdate = false;
    }
    parent = root.parent;
    pose[0] = p.x; pose[1] = p.y; pose[2] = p.z; pose[3] = q.x; pose[4] = q.y; pose[5] = q.z; pose[6] = q.w;
    pose[7] = s.x; pose[8] = s.y; pose[9] = s.z;
    local.set(root.matrix.elements); world.set(root.matrixWorld.elements);
    if (parent) parentWorld.set(parent.matrixWorld.elements);
    ready = true; stats.refreshes++;
  };
  root.updateMatrixWorld = update;
  for (const node of nodes) { node.addEventListener('childadded', dispose); node.addEventListener('childremoved', dispose); }
  return dispose;
}

/** Effect ownership re-installs correctly during Strict Mode setup/cleanup replay. */
export function useFixedModelTransforms(root: Object3D | null | undefined): void {
  useLayoutEffect(() => root ? installFixedModelTransforms(root) : undefined, [root]);
}
