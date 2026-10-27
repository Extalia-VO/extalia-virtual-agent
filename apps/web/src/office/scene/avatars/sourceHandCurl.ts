import { Float32BufferAttribute, Vector3, type Matrix4, type BufferGeometry, type SkinnedMesh } from 'three';

export const SOURCE_HAND_CURL_ANGLE = 0.75;
const NAMES = ['ExtaliaRelaxedLeftHand', 'ExtaliaRelaxedRightHand'] as const;
export interface SourceHandCurlBinding { side: 0 | 1; joint: number; handFromMesh: Matrix4; length?: number }
export interface SourceHandCurlGeometry { geometry: BufferGeometry; targets: readonly [number, number] }
// Like the original GLTF geometry, these immutable buffers live with the loader's asset cache.
// Instances own only their influence array/dictionary and must not dispose shared buffers.
const cache = new WeakMap<BufferGeometry, Map<string, SourceHandCurlGeometry | null>>();
const smooth = (value: number) => { const x = Math.max(0, Math.min(1, value)); return x * x * (3 - 2 * x); };

export function isCanonicalSourceHandAsset(url: string): boolean {
  return /(?:^|\/)(?:office-classic|business-man|female-casual|business-woman)(?:-[a-z0-9_-]+)?\.glb(?:[?#].*)?$/i.test(url);
}

/** One conservative relaxed shape per hand; no independent finger articulation. */
export function sourceHandCurlGeometry(source: BufferGeometry, bindings: readonly SourceHandCurlBinding[]): SourceHandCurlGeometry | undefined {
  const position = source.getAttribute('position'), normal = source.getAttribute('normal');
  const joints = source.getAttribute('skinIndex'), weights = source.getAttribute('skinWeight');
  if (!position || !normal || !joints || !weights || joints.itemSize !== 4 || weights.itemSize !== 4
    || position.count !== normal.count || position.count !== joints.count || position.count !== weights.count) return undefined;
  const key = bindings.map(binding => `${binding.side}:${binding.joint}:${binding.length ?? "auto"}:${binding.handFromMesh.elements.map(x => x.toFixed(8)).join(',')}`).join('|');
  const entries = cache.get(source) ?? new Map<string, SourceHandCurlGeometry | null>();
  cache.set(source, entries);
  if (entries.has(key)) return entries.get(key) ?? undefined;
  const count = position.count;
  const original = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) original.set([position.getX(i), position.getY(i), position.getZ(i)], i * 3);
  const targets = [original.slice(), original.slice()];
  const changed = [new Set<number>(), new Set<number>()];
  const point = new Vector3();
  const weightAt = (index: number, joint: number) => {
    let weight = 0;
    for (let component = 0; component < 4; component++) if (joints.getComponent(index, component) === joint) weight += weights.getComponent(index, component);
    return weight;
  };
  for (const binding of bindings) {
    if (binding.side !== 0 && binding.side !== 1) continue;
    let length = binding.length ?? 0;
    for (let i = 0; binding.length === undefined && i < count; i++) if (weightAt(i, binding.joint) >= 0.7) {
      point.fromBufferAttribute(position, i).applyMatrix4(binding.handFromMesh);
      length = Math.max(length, point.y);
    }
    // Calibrated canonical hand bounds; cuffs and unrelated rig geometry fail closed.
    if (length < 0.14 || length > 0.25 || Math.abs(binding.handFromMesh.determinant()) < 1e-10) continue;
    const meshFromHand = binding.handFromMesh.clone().invert();
    const pivot = length * 0.58, span = length - pivot;
    const thumbSign = binding.side === 0 ? -1 : 1;
    for (let i = 0; i < count; i++) {
      const skin = weightAt(i, binding.joint);
      if (skin <= 0.7) continue;
      point.fromBufferAttribute(position, i).applyMatrix4(binding.handFromMesh);
      if (point.y <= pivot) continue;
      // The canonical thumb extends laterally and toward -Z, unlike the four distal fingers.
      const lateral = 1 - smooth((thumbSign * point.x / length - 0.10) / 0.04);
      const thumbDepth = 1 - smooth((-point.z / length - 0.18) / 0.04);
      const angle = SOURCE_HAND_CURL_ANGLE * smooth((point.y - pivot) / span) * lateral * thumbDepth * smooth((skin - 0.7) / 0.25);
      if (angle <= 1e-7) continue;
      const y = point.y - pivot, z = point.z;
      point.y = pivot + y * Math.cos(angle) + z * Math.sin(angle);
      point.z = -y * Math.sin(angle) + z * Math.cos(angle);
      point.applyMatrix4(meshFromHand);
      targets[binding.side]!.set(point.toArray(), i * 3);
      changed[binding.side]!.add(i);
    }
  }
  if (!changed.some(set => set.size)) { entries.set(key, null); return undefined; }
  const geometry = source.clone();
  const existing = source.morphAttributes.position?.length ?? 0;
  const positions = [...geometry.morphAttributes.position ?? []];
  const normals = [...geometry.morphAttributes.normal ?? []];
  while (normals.length < existing) {
    const values = new Float32Array(count * 3);
    if (!source.morphTargetsRelative) for (let i = 0; i < count; i++) values.set([normal.getX(i), normal.getY(i), normal.getZ(i)], i * 3);
    normals.push(new Float32BufferAttribute(values, 3));
  }
  for (const side of [0, 1] as const) {
    const temporary = source.clone();
    temporary.setAttribute('position', new Float32BufferAttribute(targets[side]!, 3));
    temporary.computeVertexNormals();
    const computed = temporary.getAttribute('normal');
    const normalValues = new Float32Array(count * 3), positionValues = targets[side]!.slice();
    for (let i = 0; i < count; i++) {
      const base = new Vector3(normal.getX(i), normal.getY(i), normal.getZ(i));
      point.copy(base);
      if (changed[side]!.has(i)) {
        point.fromBufferAttribute(computed, i);
        if (point.lengthSq() < 1e-12) point.copy(base);
        point.normalize();
      }
      if (source.morphTargetsRelative) point.sub(base);
      normalValues.set(point.toArray(), i * 3);
      if (source.morphTargetsRelative) for (let axis = 0; axis < 3; axis++) positionValues[i * 3 + axis]! -= original[i * 3 + axis]!;
    }
    temporary.dispose();
    const attribute = new Float32BufferAttribute(positionValues, 3); attribute.name = NAMES[side];
    positions.push(attribute); normals.push(new Float32BufferAttribute(normalValues, 3));
  }
  geometry.morphAttributes.position = positions; geometry.morphAttributes.normal = normals;
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const result = { geometry, targets: [existing, existing + 1] as const };
  entries.set(key, result);
  return result;
}

/** Shared anatomical calibration across skin/nail material primitives keeps their surfaces attached. */
export function sourceHandCurlLengths(meshes: readonly SkinnedMesh[]): readonly [number, number] {
  const lengths: [number, number] = [0, 0];
  const point = new Vector3();
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position'), joints = mesh.geometry.getAttribute('skinIndex'), weights = mesh.geometry.getAttribute('skinWeight');
    if (!mesh.skeleton || !position || !joints || !weights) continue;
    for (const [side, name] of ['left', 'right'].entries()) {
      const joint = mesh.skeleton.bones.findIndex(bone => bone.name === `${name}Hand`);
      const hand = mesh.skeleton.bones[joint];
      if (!hand) continue;
      const transform = hand.matrixWorld.clone().invert().multiply(mesh.matrixWorld);
      for (let i = 0; i < position.count; i++) {
        let weight = 0;
        for (let component = 0; component < 4; component++) if (joints.getComponent(i, component) === joint) weight += weights.getComponent(i, component);
        if (weight < 0.7) continue;
        point.fromBufferAttribute(position, i).applyMatrix4(transform);
        lengths[side as 0 | 1] = Math.max(lengths[side as 0 | 1], point.y);
      }
    }
  }
  return lengths;
}

/** Attach shared shape buffers while keeping all existing morph controls instance-local. */
export function attachSourceHandCurl(mesh: SkinnedMesh, assetUrl: string, lengths?: readonly [number, number]): SourceHandCurlGeometry | undefined {
  if (!isCanonicalSourceHandAsset(assetUrl) || !mesh.skeleton) return undefined;
  const bindings: SourceHandCurlBinding[] = [];
  for (const [side, name] of ['left', 'right'].entries()) {
    const joint = mesh.skeleton.bones.findIndex(bone => bone.name === `${name}Hand`);
    const hand = mesh.skeleton.bones[joint];
    if (!hand || hand.children.length || hand.parent?.name !== `${name}LowerArm`) return undefined;
    bindings.push({ side: side as 0 | 1, joint, handFromMesh: hand.matrixWorld.clone().invert().multiply(mesh.matrixWorld), ...(lengths ? { length: lengths[side as 0 | 1] } : {}) });
  }
  const result = sourceHandCurlGeometry(mesh.geometry, bindings);
  if (!result) return undefined;
  const dictionary = { ...mesh.morphTargetDictionary };
  const influences = [...mesh.morphTargetInfluences ?? []];
  mesh.geometry = result.geometry;
  mesh.updateMorphTargets();
  mesh.morphTargetDictionary = { ...dictionary, [NAMES[0]]: result.targets[0], [NAMES[1]]: result.targets[1] };
  mesh.morphTargetInfluences = Array.from({ length: result.targets[1] + 1 }, (_, index) => influences[index] ?? 0);
  return result;
}

export function sourceHandCurlInfluence(curl: readonly number[], weight: number): number {
  const mean = curl.reduce((sum, value) => sum + (Number.isFinite(value) ? Math.max(0, value) : 0), 0) / Math.max(1, curl.length);
  return Math.max(0, Math.min(1, mean / SOURCE_HAND_CURL_ANGLE)) * Math.max(0, Math.min(1, Number.isFinite(weight) ? weight : 0));
}
