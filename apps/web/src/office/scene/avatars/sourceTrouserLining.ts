import type { BufferGeometry, SkinnedMesh } from 'three';

const cache = new WeakMap<BufferGeometry, Map<string, BufferGeometry | null>>();

/** Additive backing for the explicitly selected alpha-cut trouser shell, never skin or trims. */
export function sourceTrouserLining(mesh: SkinnedMesh): BufferGeometry | undefined {
  const source = mesh.geometry, position = source.getAttribute('position'), normal = source.getAttribute('normal');
  if (!position || !normal || position.count !== normal.count) return undefined;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const index = source.index, count = index?.count ?? position.count;
  const groups = source.groups.length ? source.groups : [{ start: 0, count, materialIndex: 0 }];
  const selected = groups.filter(group => /^OriginalBottom(?:_|$)/.test(materials[group.materialIndex ?? 0]?.name ?? ''));
  if (!selected.length) return undefined;
  const key = JSON.stringify(selected), variants = cache.get(source) ?? new Map<string, BufferGeometry | null>();
  cache.set(source, variants);
  if (variants.has(key)) return variants.get(key) ?? undefined;
  const indices: number[] = [], moved = new Set<number>();
  for (const group of selected) for (let offset = group.start; offset < Math.min(group.start + group.count, count); offset++) {
    const vertex = index ? index.getX(offset) : offset;
    indices.push(vertex); moved.add(vertex);
  }
  if (!indices.length) { variants.set(key, null); return undefined; }
  const geometry = source.clone(), points = position.clone();
  for (const vertex of moved) {
    const x = normal.getX(vertex), y = normal.getY(vertex), z = normal.getZ(vertex);
    const length = Math.hypot(x, y, z);
    if (!Number.isFinite(length) || length < 1e-8) continue;
    points.setXYZ(vertex, position.getX(vertex) - .0015 * x / length,
      position.getY(vertex) - .0015 * y / length, position.getZ(vertex) - .0015 * z / length);
  }
  geometry.setAttribute('position', points); geometry.setIndex(indices); geometry.clearGroups();
  geometry.addGroup(0, indices.length, 0); geometry.setDrawRange(0, indices.length);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  variants.set(key, geometry); return geometry;
}
