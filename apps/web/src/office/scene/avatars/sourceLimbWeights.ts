import { Vector3, type Matrix4, type BufferGeometry, type SkinnedMesh } from 'three';

const cache = new WeakMap<BufferGeometry, Map<string, BufferGeometry | null>>();
const smooth = (value: number) => { const x = Math.max(0, Math.min(1, value)); return x * x * (3 - 2 * x); };
const EPSILON = 1e-6;

/** Correct only cloth influenced exclusively by one upper/lower joint pair below its hinge. */
export function sourceLimbWeights(mesh: SkinnedMesh): BufferGeometry | undefined {
  const name = mesh.name.replace(/_\d+$/, '');
  if (!/^(?:ScanOutfit[A-Za-z]*|Source(?:Top|Bottom)|Office(?:Top|Outer|Bottom))$/.test(name) || !mesh.skeleton) return undefined;
  const source = mesh.geometry, position = source.getAttribute('position');
  const joints = source.getAttribute('skinIndex'), weights = source.getAttribute('skinWeight');
  if (!position || !joints || !weights || joints.itemSize !== 4 || weights.itemSize !== 4
    || position.count !== joints.count || position.count !== weights.count) return undefined;
  const chains: { upper: number; lower: number; transform: Matrix4; axis: Vector3; lengthSq: number }[] = [];
  for (const side of ['left', 'right']) for (const [upperName, lowerName, endName] of [
    ['UpperLeg', 'LowerLeg', 'Foot'], ['UpperArm', 'LowerArm', 'Hand'],
  ]) {
    const index = (suffix: string) => mesh.skeleton.bones.findIndex(bone => bone.name === `${side}${suffix}`);
    const upper = index(upperName!), lower = index(lowerName!), end = index(endName!);
    const inverse = mesh.skeleton.boneInverses[lower], endInverse = mesh.skeleton.boneInverses[end];
    if (upper < 0 || lower < 0 || end < 0 || !inverse || !endInverse || Math.abs(endInverse.determinant()) < 1e-10) continue;
    const axis = new Vector3().setFromMatrixPosition(endInverse.clone().invert()).applyMatrix4(inverse);
    const lengthSq = axis.lengthSq();
    if (!Number.isFinite(lengthSq) || lengthSq < 0.01 || lengthSq > 1) continue;
    chains.push({ upper, lower, transform: inverse.clone().multiply(mesh.bindMatrix), axis, lengthSq });
  }
  if (!chains.length) return undefined;
  const signature = chains.map(chain => `${chain.upper}:${chain.lower}:${chain.transform.elements.map(x => x.toFixed(8)).join(',')}:${chain.axis.toArray().map(x => x.toFixed(8)).join(',')}`).join('|');
  const entries = cache.get(source) ?? new Map<string, BufferGeometry | null>(); cache.set(source, entries);
  if (entries.has(signature)) return entries.get(signature) ?? undefined;
  const newJoints = joints.clone(), newWeights = weights.clone();
  const point = new Vector3(), offset = new Vector3();
  let changed = false;
  for (let i = 0; i < position.count; i++) for (const chain of chains) {
    let upperWeight = 0, lowerWeight = 0, upperSlot = -1, lowerSlot = -1, emptySlot = -1, other = false;
    for (let slot = 0; slot < 4; slot++) {
      const weight = weights.getComponent(i, slot), joint = joints.getComponent(i, slot);
      if (!Number.isFinite(weight) || weight < 0) { other = true; continue; }
      if (weight === 0) { if (emptySlot < 0) emptySlot = slot; continue; }
      if (joint === chain.upper) { upperWeight += weight; upperSlot = slot; }
      else if (joint === chain.lower) { lowerWeight += weight; lowerSlot = slot; }
      else other = true;
    }
    const total = upperWeight + lowerWeight;
    if (other || total < 0.97 || upperSlot < 0 || upperWeight <= EPSILON) continue;
    point.fromBufferAttribute(position, i).applyMatrix4(chain.transform);
    const t = point.dot(chain.axis) / chain.lengthSq;
    if (t <= 0 || t > 1) continue;
    offset.copy(point).addScaledVector(chain.axis, -t);
    if (offset.lengthSq() > 0.13 * 0.13) continue;
    const allowed = total * (1 - smooth(t / 0.24));
    if (upperWeight <= allowed + EPSILON) continue;
    if (lowerSlot < 0) lowerSlot = emptySlot;
    if (lowerSlot < 0) continue;
    // Consolidate duplicate pair slots without changing any unrelated influence.
    for (let slot = 0; slot < 4; slot++) {
      const joint = joints.getComponent(i, slot);
      if (joint === chain.upper || joint === chain.lower) newWeights.setComponent(i, slot, 0);
    }
    newJoints.setComponent(i, lowerSlot, chain.lower);
    newWeights.setComponent(i, upperSlot, allowed);
    newWeights.setComponent(i, lowerSlot, total - allowed);
    changed = true;
    break;
  }
  if (!changed) { entries.set(signature, null); return undefined; }
  const geometry = source.clone();
  geometry.setAttribute('skinIndex', newJoints); geometry.setAttribute('skinWeight', newWeights);
  entries.set(signature, geometry);
  return geometry;
}
