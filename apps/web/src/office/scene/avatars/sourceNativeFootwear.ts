import { Matrix4, Vector3, type BufferGeometry, type Group, type SkinnedMesh } from 'three';
import { originalSetFeatures } from './sourceOriginalSetFeatures';

const geometryCache = new WeakMap<BufferGeometry, Map<string, BufferGeometry | null>>();

/** Source sets opt into native shoes explicitly; truthy strings/numbers are not declarations. */
export function requestsNativeFootwear(scene: Group): boolean {
  return originalSetFeatures(scene).nativeFootwear;
}

/** Extract corrected native shoes and ankle backing, never native trouser cuffs. */
export function nativeFootwearGeometry(mesh: SkinnedMesh): BufferGeometry | undefined {
  const source = mesh.geometry;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const key = JSON.stringify(materials.map(material => material.name));
  const variants = geometryCache.get(source) ?? new Map<string, BufferGeometry | null>();
  geometryCache.set(source, variants);
  if (variants.has(key)) return variants.get(key) ?? undefined;
  const position = source.getAttribute('position');
  if (!position) return undefined;
  const index = source.index;
  const groups = source.groups.length ? source.groups : [{ start: 0, count: index?.count ?? position.count, materialIndex: 0 }];
  const kept: number[] = [], keptGroups: { start: number; count: number; materialIndex: number }[] = [];
  for (const group of groups) {
    const name = materials[group.materialIndex ?? 0]?.name ?? '';
    const shoes = name.startsWith('OfficeShoes'), skin = name.startsWith('Skin_');
    if (!shoes && !skin) continue;
    const start = kept.length;
    for (let triangle = group.start; triangle + 2 < Math.min(group.start + group.count, index?.count ?? position.count); triangle += 3) {
      const vertices = [0, 1, 2].map(offset => index ? index.getX(triangle + offset) : triangle + offset);
      if (shoes || vertices.every(vertex => position.getY(vertex) < .18)) kept.push(...vertices);
    }
    if (kept.length > start) keptGroups.push({ start, count: kept.length - start, materialIndex: group.materialIndex ?? 0 });
  }
  if (!kept.length) { variants.set(key, null); return undefined; }
  const geometry = source.clone();
  geometry.setIndex(kept);
  geometry.clearGroups();
  for (const group of keptGroups) geometry.addGroup(group.start, group.count, group.materialIndex);
  geometry.setDrawRange(0, kept.length);
  variants.set(key, geometry);
  return geometry;
}

/** A set reusing the native feet also uses their corrected sole height. */
export function wardrobeFootSoleProfile(
  profiles: ReadonlyMap<string, ReadonlyMap<string, number>> | undefined,
  selectedSlot: string | undefined,
  nativeFootwear: boolean,
): ReadonlyMap<string, number> | undefined {
  return (nativeFootwear ? profiles?.get('ScanOutfit') : undefined) ?? profiles?.get(selectedSlot ?? '');
}

/**
 * Sole coordinates are signed heights in the canonical rest pose. A positive
 * sole lowers the standing skeleton; seated hips stay on the seat while each
 * leg instead targets restAnkle - sole. Missing or implausible measurements
 * use the origin so bad source data cannot displace the character arbitrarily.
 */
export function footwearFloorContact(soles: ReadonlyMap<string, number> | undefined): {
  standingOffset: number; soleByFoot: ReadonlyMap<string, number>;
} {
  const soleByFoot = new Map(['leftFoot', 'rightFoot'].map(foot => {
    const value = soles?.get(foot);
    return [foot, typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= .2 ? value : 0] as const;
  }));
  return { standingOffset: -Math.min(...soleByFoot.values()), soleByFoot };
}

const ownedSoleCache = new WeakMap<BufferGeometry, Map<string, ReadonlyMap<string, number> | null>>();

export function isFootwearMaterialName(name: string): boolean {
  return /^(?:Original|Office)Shoes(?:_|$)/.test(name);
}

/** Measure the chosen original shoes without reshaping them or borrowing hidden native heel heights. */
export function ownedFootwearSoles(mesh: SkinnedMesh): ReadonlyMap<string, number> | undefined {
  const geometry = mesh.geometry, position = geometry.getAttribute('position');
  if (!position || !mesh.skeleton) return undefined;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const feet = ['leftFoot', 'rightFoot'].map(name => {
    const index = mesh.skeleton.bones.findIndex(bone => bone.name === name), inverse = mesh.skeleton.boneInverses[index];
    return inverse ? { name, point: new Vector3().setFromMatrixPosition(new Matrix4().copy(inverse).invert()) } : undefined;
  }).filter((foot): foot is { name: string; point: Vector3 } => foot !== undefined);
  const key = JSON.stringify([materials.map(material => material.name), mesh.bindMatrix.elements,
    mesh.skeleton.bones.map(bone => bone.name), feet.map(foot => [foot.name, foot.point.toArray()])]);
  const variants = ownedSoleCache.get(geometry) ?? new Map<string, ReadonlyMap<string, number> | null>();
  ownedSoleCache.set(geometry, variants);
  if (variants.has(key)) return variants.get(key) ?? undefined;
  const index = geometry.index, joints = geometry.getAttribute('skinIndex'), weights = geometry.getAttribute('skinWeight');
  const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: index?.count ?? position.count, materialIndex: 0 }];
  const vertices = new Set<number>();
  for (const group of groups) {
    if (!isFootwearMaterialName(materials[group.materialIndex ?? 0]?.name ?? '')) continue;
    for (let offset = group.start; offset < Math.min(group.start + group.count, index?.count ?? position.count); offset++) vertices.add(index ? index.getX(offset) : offset);
  }
  const soles = new Map<string, number>(), point = new Vector3();
  for (const vertex of vertices) {
    point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix);
    if (!point.toArray().every(Number.isFinite)) continue;
    let left = 0, right = 0;
    if (joints && weights) for (let influence = 0; influence < Math.min(joints.itemSize, weights.itemSize); influence++) {
      const bone = mesh.skeleton.bones[joints.getComponent(vertex, influence)]?.name ?? '', weight = weights.getComponent(vertex, influence);
      if (/^left(?:UpperLeg|LowerLeg|Foot|Toes)$/.test(bone)) left += weight;
      if (/^right(?:UpperLeg|LowerLeg|Foot|Toes)$/.test(bone)) right += weight;
    }
    const foot = Math.max(left, right) > .1 ? (left >= right ? 'leftFoot' : 'rightFoot')
      : [...feet].sort((a, b) => a.point.distanceToSquared(point) - b.point.distanceToSquared(point))[0]?.name;
    if (foot) soles.set(foot, Math.min(soles.get(foot) ?? Infinity, point.y));
  }
  const result = soles.size ? soles : undefined;
  variants.set(key, result ?? null);
  return result;
}

/** Prefer a selected original's own shoe floor, while leaving legacy Office shoe profiles alone. */
export function sourceFootwearProfiles(
  nativeProfiles: ReadonlyMap<string, ReadonlyMap<string, number>> | undefined,
  meshes: readonly SkinnedMesh[],
  selected: { fullOutfit: boolean; bottom: boolean },
): { profiles: ReadonlyMap<string, ReadonlyMap<string, number>>; slot?: string } {
  const profiles = new Map<string, ReadonlyMap<string, number>>(nativeProfiles ?? []);
  let slot: string | undefined;
  const collect = (name: string, originalOnly: boolean) => {
    const soles = new Map<string, number>();
    for (const mesh of meshes) {
      if (mesh.name !== name) continue;
      if (originalOnly && !(Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some(material => /^OriginalShoes(?:_|$)/.test(material.name))) continue;
      for (const [foot, sole] of ownedFootwearSoles(mesh) ?? []) soles.set(foot, Math.min(soles.get(foot) ?? Infinity, sole));
    }
    if (soles.size) { profiles.set(name, soles); slot = name; }
  };
  if (selected.fullOutfit) collect('ScanOutfitModel', true);
  if (selected.bottom) collect('WardrobePieceBottom', false);
  return { profiles, ...(slot ? { slot } : {}) };
}
