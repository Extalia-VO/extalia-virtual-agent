import { type BufferGeometry, type SkinnedMesh } from 'three';

export type WardrobePartSlot = 'top' | 'bottom' | 'outer';
export type LoadedWardrobeParts = Readonly<Partial<Record<WardrobePartSlot, boolean>> & { footwear?: boolean }>;
const cache = new WeakMap<BufferGeometry, Map<string, BufferGeometry>>();

/** Keep native chest coverage if the fitted top fails, even when the user selected no outer. */
export function wardrobeReplacementParts(loaded: LoadedWardrobeParts, mixing: boolean, outer?: string): LoadedWardrobeParts {
  if (!mixing) return {};
  return { ...loaded, outer: loaded.top === true && (loaded.outer === true || !outer || outer === 'none') };
}

/** Remove only the scanned layers actually replaced by loaded fitted pieces. */
export function sourceWardrobeGeometry(mesh: SkinnedMesh, parts: LoadedWardrobeParts): BufferGeometry {
  const source = mesh.geometry;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const names = materials.map(material => material.name);
  const bones = mesh.skeleton?.bones.map(bone => bone.name) ?? [];
  const key = JSON.stringify([parts.top === true, parts.bottom === true, parts.outer === true, parts.footwear, names, bones]);
  const variants = cache.get(source) ?? new Map<string, BufferGeometry>();
  cache.set(source, variants);
  const cached = variants.get(key);
  if (cached) return cached;
  const position = source.getAttribute('position');
  if (!position) return source;
  const index = source.index, joints = source.getAttribute('skinIndex'), weights = source.getAttribute('skinWeight');
  const upperSkin = (vertices: readonly number[]): boolean => {
    // Match Blender's slot cut exactly: forearms can hang below the waist.
    let height = 0, arm = 0;
    for (const vertex of vertices) {
      height += position.getY(vertex);
      if (joints && weights) for (let influence = 0; influence < Math.min(joints.itemSize, weights.itemSize); influence++) {
        if (/(?:Arm|Hand)/.test(bones[joints.getComponent(vertex, influence)] ?? '')) arm += weights.getComponent(vertex, influence);
      }
    }
    return height / vertices.length >= 1 || arm / vertices.length >= .35;
  };
  const groups = source.groups.length ? source.groups : [{ start: 0, count: index?.count ?? position.count, materialIndex: 0 }];
  const kept: number[] = [], keptGroups: { start: number; count: number; materialIndex: number }[] = [];
  for (const group of groups) {
    const name = names[group.materialIndex ?? 0] ?? '';
    const start = kept.length;
    for (let triangle = group.start; triangle + 2 < Math.min(group.start + group.count, index?.count ?? position.count); triangle += 3) {
      const vertices = [0, 1, 2].map(offset => index ? index.getX(triangle + offset) : triangle + offset);
      const upper = upperSkin(vertices);
      let replaced = false;
      if (/^Office(?:Outer|Lining)/.test(name)) replaced = parts.outer === true;
      else if (/^Office(?:Top|Accent)/.test(name)) replaced = parts.top === true;
      else if (/^OfficeShoes/.test(name)) replaced = parts.bottom === true && parts.footwear !== false;
      else if (/^Office(?:Bottom|Belt)/.test(name)) replaced = parts.bottom === true;
      else if (/^(?:Skin|Nails)/.test(name)) {
        const nativeFoot = !upper && parts.footwear === false && vertices.every(vertex => position.getY(vertex) < .18);
        replaced = upper ? parts.top === true : parts.bottom === true && !nativeFoot;
      } else if (/^OfficeTrim/.test(name)) replaced = upper ? parts.top === true : parts.bottom === true;
      if (!replaced) kept.push(...vertices);
    }
    if (kept.length > start) keptGroups.push({ start, count: kept.length - start, materialIndex: group.materialIndex ?? 0 });
  }
  if (kept.length === (index?.count ?? position.count)) { variants.set(key, source); return source; }
  const geometry = source.clone();
  geometry.setIndex(kept);
  geometry.clearGroups();
  for (const group of keptGroups) geometry.addGroup(group.start, group.count, group.materialIndex);
  geometry.setDrawRange(0, kept.length);
  variants.set(key, geometry);
  return geometry;
}
