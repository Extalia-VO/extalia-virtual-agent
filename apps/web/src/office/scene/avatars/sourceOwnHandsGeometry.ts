import type { BufferGeometry, SkinnedMesh } from 'three';

const cache = new WeakMap<BufferGeometry, Map<string, BufferGeometry>>();

/** Authored original gloves occlude only hand-dominant native Body faces. */
export function nativeBodyWithoutHands(mesh: SkinnedMesh, ownHands: boolean): BufferGeometry {
  const source = mesh.geometry;
  if (ownHands !== true || mesh.name.replace(/_\d+$/, '') !== 'Body') return source;
  const position = source.getAttribute('position'), joints = source.getAttribute('skinIndex'), weights = source.getAttribute('skinWeight');
  if (!position || !joints || !weights || !mesh.skeleton) return source;
  const bones = mesh.skeleton.bones.map(bone => bone.name);
  const handIndices = new Set(bones.flatMap((name, index) => /^(?:left|right)Hand$/.test(name) ? [index] : []));
  if (!handIndices.size) return source;
  const key = JSON.stringify(bones), variants = cache.get(source) ?? new Map<string, BufferGeometry>();
  cache.set(source, variants);
  const cached = variants.get(key);
  if (cached) return cached;
  const index = source.index, count = index?.count ?? position.count;
  const groups = source.groups.length ? source.groups : [{ start: 0, count, materialIndex: 0 }];
  const kept: number[] = [], keptGroups: { start: number; count: number; materialIndex: number }[] = [];
  for (const group of groups) {
    const start = kept.length;
    for (let triangle = group.start; triangle + 2 < Math.min(group.start + group.count, count); triangle += 3) {
      const vertices = [0, 1, 2].map(offset => index ? index.getX(triangle + offset) : triangle + offset);
      let hand = 0;
      for (const vertex of vertices) for (let influence = 0; influence < Math.min(joints.itemSize, weights.itemSize); influence++) {
        const weight = weights.getComponent(vertex, influence);
        if (handIndices.has(joints.getComponent(vertex, influence)) && Number.isFinite(weight) && weight > 0) hand += weight / 3;
      }
      if (hand < .5) kept.push(...vertices);
    }
    if (kept.length > start) keptGroups.push({ start, count: kept.length - start, materialIndex: group.materialIndex ?? 0 });
  }
  if (kept.length === count) { variants.set(key, source); return source; }
  // Keep positions, skin weights, UVs and facial morph attributes byte-for-byte; only draw indices change.
  const geometry = source.clone();
  geometry.setIndex(kept);
  geometry.clearGroups();
  for (const group of keptGroups) geometry.addGroup(group.start, group.count, group.materialIndex);
  geometry.setDrawRange(0, kept.length);
  variants.set(key, geometry);
  return geometry;
}
