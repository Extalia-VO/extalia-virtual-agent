import type { BufferGeometry, Group, SkinnedMesh } from 'three';

export interface ClosedJacketCoverage {
  kind: 'closed-jacket';
  frontHalfWidth: number;
  frontMinDepth: number;
  collarMinHeight: number;
}

const geometryCache = new WeakMap<BufferGeometry, Map<string, BufferGeometry>>();
const sceneCache = new WeakMap<Group, ClosedJacketCoverage | null>();
const FIELDS = new Set(['kind', 'frontHalfWidth', 'frontMinDepth', 'collarMinHeight']);

/** Only an authored, bounded coverage declaration may occlude another garment. */
export function readWardrobeCoverage(value: unknown): ClosedJacketCoverage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some(key => !FIELDS.has(key)) || entry.kind !== 'closed-jacket') return undefined;
  const number = (key: string, min: number, max: number): number | undefined => {
    const candidate = entry[key];
    return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= min && candidate <= max ? candidate : undefined;
  };
  const frontHalfWidth = number('frontHalfWidth', .01, .25), frontMinDepth = number('frontMinDepth', 0, .25), collarMinHeight = number('collarMinHeight', 1, 1.9);
  return frontHalfWidth !== undefined && frontMinDepth !== undefined && collarMinHeight !== undefined
    ? { kind: 'closed-jacket', frontHalfWidth, frontMinDepth, collarMinHeight } : undefined;
}

/** glTF multi-material nodes can carry extras on the group above their skinned primitives. */
export function declaredWardrobeCoverage(scene: Group): ClosedJacketCoverage | undefined {
  if (sceneCache.has(scene)) return sceneCache.get(scene) ?? undefined;
  let coverage: ClosedJacketCoverage | undefined, conflict = false;
  scene.traverse(node => {
    const candidate = readWardrobeCoverage(node.userData.extaliaWardrobeCoverage);
    if (!candidate) return;
    if (coverage && JSON.stringify(coverage) !== JSON.stringify(candidate)) conflict = true;
    else coverage = candidate;
  });
  const result = conflict ? undefined : coverage;
  sceneCache.set(scene, result ?? null);
  return result;
}

/**
 * A source-declared closed coat covers upper side/back/arm layers. Its open centre and collar
 * retain underlying chest coverage. No inference is made for open jackets, vests or unknown data.
 */
export function underlayerCoverageGeometry(mesh: SkinnedMesh, coverage: ClosedJacketCoverage | undefined): BufferGeometry {
  const source = mesh.geometry;
  if (!coverage) return source;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const names = materials.map(material => material.name), bones = mesh.skeleton?.bones.map(bone => bone.name) ?? [];
  const neckline = mesh.name.replace(/_\d+$/, '') === 'BodyNeckline';
  const key = JSON.stringify([coverage, names, bones, neckline]);
  const variants = geometryCache.get(source) ?? new Map<string, BufferGeometry>();
  geometryCache.set(source, variants);
  const cached = variants.get(key);
  if (cached) return cached;
  const position = source.getAttribute('position');
  if (!position) return source;
  const index = source.index, joints = source.getAttribute('skinIndex'), weights = source.getAttribute('skinWeight');
  const groups = source.groups.length ? source.groups : [{ start: 0, count: index?.count ?? position.count, materialIndex: 0 }];
  const kept: number[] = [], keptGroups: { start: number; count: number; materialIndex: number }[] = [];
  for (const group of groups) {
    const name = names[group.materialIndex ?? 0] ?? '';
    const skin = /^(?:Skin|Nails)/.test(name), garment = /^(?:Original|Office)(?:Top|Accent|Lining|Outer)/.test(name);
    const start = kept.length;
    for (let triangle = group.start; triangle + 2 < Math.min(group.start + group.count, index?.count ?? position.count); triangle += 3) {
      const vertices = [0, 1, 2].map(offset => index ? index.getX(triangle + offset) : triangle + offset);
      let x = 0, y = 0, z = 0, arm = 0, hand = 0, head = 0;
      for (const vertex of vertices) {
        x += position.getX(vertex) / 3; y += position.getY(vertex) / 3; z += position.getZ(vertex) / 3;
        if (joints && weights) for (let influence = 0; influence < Math.min(joints.itemSize, weights.itemSize); influence++) {
          const bone = bones[joints.getComponent(vertex, influence)] ?? '', weight = weights.getComponent(vertex, influence) / 3;
          if (/(?:Arm|Hand)/.test(bone)) arm += weight;
          if (/Hand/.test(bone)) hand += weight;
          if (/head/i.test(bone)) head += weight;
        }
      }
      const upperSkin = skin && (y >= 1 || arm >= .35) && hand < .5 && head < .5;
      const underCoat = garment || upperSkin || neckline;
      const opening = Math.abs(x) <= coverage.frontHalfWidth && z >= coverage.frontMinDepth
        || y >= coverage.collarMinHeight && z >= 0;
      if (!underCoat || arm < .35 && opening) kept.push(...vertices);
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
