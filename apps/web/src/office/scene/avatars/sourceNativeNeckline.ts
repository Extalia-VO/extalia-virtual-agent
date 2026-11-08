import { Triangle, Vector3, type BufferGeometry, type SkinnedMesh } from 'three';

interface Surface { id: number; triangles: Triangle[] }
const nativeCache = new WeakMap<BufferGeometry, Map<string, Surface>>();
const fittedCache = new WeakMap<BufferGeometry, Map<string, BufferGeometry>>();
let nextSurface = 0;
const validBind = (mesh: SkinnedMesh) => mesh.bindMatrix.elements.every(Number.isFinite) && Math.abs(mesh.bindMatrix.determinant()) > 1e-9;

/** Replace duplicate original neck skin only where the loaded native neckline supplies its surface. */
export function sourceNativeNeckline(mesh: SkinnedMesh, nativeNecklines: readonly SkinnedMesh[]): BufferGeometry {
  const source = mesh.geometry, position = source.getAttribute('position'), joints = source.getAttribute('skinIndex'), weights = source.getAttribute('skinWeight');
  if (!/^(?:WardrobePiece(?:Top|Outer)|ScanOutfitModel)$/.test(mesh.name.replace(/_\d+$/, ''))
    || !position || !joints || !weights || !mesh.skeleton || !validBind(mesh)) return source;
  const surfaces = nativeNecklines.flatMap(native => {
    if (native.name.replace(/_\d+$/, '') !== 'BodyNeckline' || !validBind(native)) return [];
    const geometry = native.geometry, pos = geometry.getAttribute('position');
    if (!pos) return [];
    const signature = JSON.stringify(native.bindMatrix.elements), cache = nativeCache.get(geometry) ?? new Map<string, Surface>(); nativeCache.set(geometry, cache);
    let surface = cache.get(signature);
    if (!surface) {
      const index = geometry.index, count = index?.count ?? pos.count, triangles: Triangle[] = [];
      if (count > 30_000 || geometry.drawRange.start !== 0 || geometry.drawRange.count < count) return [];
      for (let i = 0; i + 2 < count; i += 3) {
        const points = [0, 1, 2].map(corner => new Vector3().fromBufferAttribute(pos, index ? index.getX(i + corner) : i + corner).applyMatrix4(native.bindMatrix));
        if (!points.every(point => point.toArray().every(Number.isFinite))) return [];
        triangles.push(new Triangle(points[0]!, points[1]!, points[2]!));
      }
      surface = { id: nextSurface++, triangles }; cache.set(signature, surface);
    }
    return [surface];
  });
  if (!surfaces.length) return source;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material], bones = mesh.skeleton.bones.map(bone => bone.name);
  const key = JSON.stringify([surfaces.map(surface => surface.id).sort((a, b) => a - b), mesh.bindMatrix.elements, materials.map(material => material.name), bones]);
  const cache = fittedCache.get(source) ?? new Map<string, BufferGeometry>(); fittedCache.set(source, cache);
  if (cache.has(key)) return cache.get(key)!;
  const nearest = new Vector3(), point = new Vector3(), cornerPoint = new Vector3();
  const covered = (sample: Vector3) => Math.abs(sample.x) < .14 && sample.y >= 1.42 && sample.y <= 1.60 && sample.z >= -.132 && sample.z <= .106
    && surfaces.some(surface => surface.triangles.some(triangle => triangle.closestPointToPoint(sample, nearest).distanceToSquared(sample) <= .008 ** 2));
  const coverage = new Map<number, boolean>();
  const vertexCovered = (vertex: number): boolean => {
    if (!coverage.has(vertex)) {
      let allowed = 0, total = 0;
      for (let slot = 0; slot < Math.min(joints.itemSize, weights.itemSize); slot++) {
        const weight = weights.getComponent(vertex, slot);
        if (!Number.isFinite(weight) || weight < 0) { coverage.set(vertex, false); return false; }
        total += weight;
        if (/^(?:spine|chest|neck|head)$/.test(bones[joints.getComponent(vertex, slot)] ?? '')) allowed += weight;
      }
      coverage.set(vertex, total > .97 && total < 1.03 && allowed / total >= .98 && covered(point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix)));
    }
    return coverage.get(vertex)!;
  };
  const index = source.index, count = index?.count ?? position.count;
  if (source.drawRange.start !== 0 || source.drawRange.count < count) return source;
  const groups = source.groups.length ? source.groups : [{ start: 0, count, materialIndex: 0 }], kept: number[] = [], keptGroups: { start: number; count: number; materialIndex: number }[] = [];
  let removed = false;
  for (const group of groups) {
    const skin = /^Skin(?:_|$)/.test(materials[group.materialIndex ?? 0]?.name ?? ''), start = kept.length;
    for (let offset = group.start; offset + 2 < Math.min(group.start + group.count, count); offset += 3) {
      const vertices = [0, 1, 2].map(corner => index ? index.getX(offset + corner) : offset + corner);
      let hidden = false;
      if (skin && vertices.every(vertexCovered)) {
        point.set(0, 0, 0);
        for (const vertex of vertices) point.add(cornerPoint.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix));
        hidden = covered(point.multiplyScalar(1 / 3));
      }
      if (hidden) removed = true; else kept.push(...vertices);
    }
    if (kept.length > start) keptGroups.push({ start, count: kept.length - start, materialIndex: group.materialIndex ?? 0 });
  }
  if (!removed) { cache.set(key, source); return source; }
  const geometry = source.clone(); geometry.setIndex(kept); geometry.clearGroups();
  for (const group of keptGroups) geometry.addGroup(group.start, group.count, group.materialIndex);
  geometry.setDrawRange(0, kept.length); cache.set(key, geometry); return geometry;
}
