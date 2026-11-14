import type { Bone, DataTexture, Object3D, Skeleton, SkinnedMesh } from 'three';

/** Only immutable inverse binds and the exact same live bones may share GPU pose state. */
function compatible(a: Skeleton, b: Skeleton): boolean {
  return a.bones.length === b.bones.length && a.boneInverses.length === b.boneInverses.length
    && a.bones.every((bone, i) => bone === b.bones[i] && a.boneInverses[i]!.equals(b.boneInverses[i]!));
}

/**
 * Call only on one owned SkeletonUtils clone, after attaching its fitted pieces.
 * Bones outside that clone are refused. Geometry, morph controls, mesh bind frames
 * and materials remain untouched; inverse binds must remain immutable afterwards.
 */
export function shareAvatarSkeletons(root: Object3D): { before: number; after: number; meshes: number } {
  const bones = new Set<Bone>(), meshes: SkinnedMesh[] = [];
  root.traverse(object => {
    if ((object as Bone).isBone) bones.add(object as Bone);
    if ((object as SkinnedMesh).isSkinnedMesh && (object as SkinnedMesh).skeleton) meshes.push(object as SkinnedMesh);
  });
  const originals = new Set(meshes.map(mesh => mesh.skeleton));
  const resolved = new Map<Skeleton, Skeleton>(), groups = new Map<Bone, Skeleton[]>();
  for (const mesh of meshes) {
    const source = mesh.skeleton;
    const cached = resolved.get(source);
    if (cached) { mesh.skeleton = cached; continue; }
    const valid = source.bones.length > 0 && source.bones.length === source.boneInverses.length
      && source.bones.every(bone => bones.has(bone))
      && source.boneInverses.every(matrix => matrix.elements.length === 16 && matrix.elements.every(Number.isFinite));
    if (!valid) { resolved.set(source, source); continue; }
    const group = groups.get(source.bones[0]!) ?? [];
    const shared = group.find(candidate => compatible(candidate, source));
    if (shared) { mesh.skeleton = shared; resolved.set(source, shared); }
    else { group.push(source); groups.set(source.bones[0]!, group); resolved.set(source, source); }
  }
  const retained = new Set(meshes.map(mesh => mesh.skeleton));
  const retainedTextures = new Set([...retained].map(skeleton => skeleton.boneTexture).filter(Boolean));
  const releasedTextures = new Set<DataTexture>();
  for (const source of originals) {
    if (retained.has(source)) continue;
    // Normally these fresh clone skeletons have never rendered. A retained or
    // already released texture may also be aliased by multiple obsolete owners.
    const texture = source.boneTexture;
    if (texture && (retainedTextures.has(texture) || releasedTextures.has(texture))) {
      source.boneTexture = null;
      continue;
    }
    source.dispose();
    if (texture) releasedTextures.add(texture);
  }
  return { before: originals.size, after: retained.size, meshes: meshes.length };
}
