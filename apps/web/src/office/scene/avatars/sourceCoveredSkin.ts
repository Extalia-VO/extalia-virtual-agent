import { Box3, Matrix4, Ray, Vector3, type BufferGeometry, type SkinnedMesh } from 'three';

interface Node { bounds: Box3; triangles?: number[]; left?: Node; right?: Node }
interface Surface { id: number; points: Float32Array; indices: number[]; root: Node }
const surfaces = new WeakMap<BufferGeometry, Map<string, Surface | null>>();
const variants = new WeakMap<BufferGeometry, Map<string, BufferGeometry>>();
let nextSurface = 0;
const MARGIN = .006, INWARD = .035, OUTWARD = .05;

function bottomSurface(mesh: SkinnedMesh): Surface | undefined {
  const geometry = mesh.geometry, position = geometry.getAttribute('position'), index = geometry.index;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (!position || !mesh.bindMatrix.elements.every(Number.isFinite) || Math.abs(mesh.bindMatrix.determinant()) < 1e-9) return undefined;
  const count = index?.count ?? position.count;
  if (geometry.drawRange.start !== 0 || geometry.drawRange.count < count) return undefined;
  const groups = (geometry.groups.length ? geometry.groups : [{ start: 0, count, materialIndex: 0 }]).filter(group => {
    const material = materials[group.materialIndex ?? 0];
    return material && /^(?:Original|Office)Bottom(?:_|$)/.test(material.name) && !/skirt|dress/i.test(material.name)
      && material.visible && !material.transparent && material.opacity === 1 && material.alphaTest === 0
      && !('alphaMap' in material && material.alphaMap);
  });
  if (!groups.length) return undefined;
  const key = JSON.stringify([groups, mesh.bindMatrix.elements]);
  const cache = surfaces.get(geometry) ?? new Map<string, Surface | null>(); surfaces.set(geometry, cache);
  if (cache.has(key)) return cache.get(key) ?? undefined;
  const points = new Float32Array(position.count * 3), point = new Vector3();
  for (let vertex = 0; vertex < position.count; vertex++) {
    point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix);
    if (!point.toArray().every(Number.isFinite)) { cache.set(key, null); return undefined; }
    points.set([point.x, point.y, point.z], vertex * 3);
  }
  const indices: number[] = [];
  for (const group of groups) for (let offset = group.start; offset + 2 < Math.min(group.start + group.count, count); offset += 3) {
    for (let corner = 0; corner < 3; corner++) indices.push(index ? index.getX(offset + corner) : offset + corner);
  }
  if (!indices.length || indices.length > 600_000 || indices.some(vertex => !Number.isInteger(vertex) || vertex < 0 || vertex >= position.count)) {
    cache.set(key, null); return undefined;
  }
  const boxes: Box3[] = [], centres: Vector3[] = [];
  for (let offset = 0; offset < indices.length; offset += 3) {
    const bounds = new Box3();
    for (let corner = 0; corner < 3; corner++) bounds.expandByPoint(point.fromArray(points, indices[offset + corner]! * 3));
    boxes.push(bounds); centres.push(bounds.getCenter(new Vector3()));
  }
  const build = (triangles: number[]): Node => {
    const bounds = new Box3(); for (const triangle of triangles) bounds.union(boxes[triangle]!);
    if (triangles.length <= 12) return { bounds, triangles };
    const size = bounds.getSize(new Vector3()), axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
    triangles.sort((a, b) => centres[a]![axis] - centres[b]![axis]);
    const mid = Math.floor(triangles.length / 2);
    return { bounds, left: build(triangles.slice(0, mid)), right: build(triangles.slice(mid)) };
  };
  const surface = { id: nextSurface++, points, indices, root: build(boxes.map((_, triangle) => triangle)) };
  cache.set(key, surface); return surface;
}

/**
 * Suppress only pelvis/upper-thigh skin covered by caller-vetted trousers or shorts.
 * The caller must exclude skirts/dresses: generic OriginalBottom material roles do not
 * distinguish them. No cloth, rest positions, bindings or morph targets are changed.
 */
export function sourceCoveredSkin(mesh: SkinnedMesh, trouserLayers: readonly SkinnedMesh[]): BufferGeometry {
  const source = mesh.geometry, position = source.getAttribute('position'), joints = source.getAttribute('skinIndex'), weights = source.getAttribute('skinWeight');
  if (!position || !joints || !weights || !mesh.skeleton || !trouserLayers.length
    || joints.count !== position.count || weights.count !== position.count
    || !mesh.bindMatrix.elements.every(Number.isFinite) || Math.abs(mesh.bindMatrix.determinant()) < 1e-9) return source;
  const bones = mesh.skeleton.bones.map(bone => bone.name), hipIndex = bones.indexOf('hips');
  const inverse = mesh.skeleton.boneInverses[hipIndex];
  if (!inverse || !inverse.elements.every(Number.isFinite) || Math.abs(inverse.determinant()) < 1e-9) return source;
  const hip = new Vector3().setFromMatrixPosition(new Matrix4().copy(inverse).invert());
  const legs = ['leftUpperLeg', 'rightUpperLeg'].map(name => {
    const bind = mesh.skeleton.boneInverses[bones.indexOf(name)];
    return bind && bind.elements.every(Number.isFinite) && Math.abs(bind.determinant()) >= 1e-9
      ? new Vector3().setFromMatrixPosition(bind.clone().invert()) : undefined;
  });
  if (legs.some(leg => !leg)) return source;
  const fields = trouserLayers.map(bottomSurface).filter((field): field is Surface => field !== undefined);
  if (!fields.length) return source;
  const index = source.index, count = index?.count ?? position.count;
  if (source.drawRange.start !== 0 || source.drawRange.count < count) return source;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const groups = source.groups.length ? source.groups : [{ start: 0, count, materialIndex: 0 }];
  const key = JSON.stringify([fields.map(field => field.id).sort((a, b) => a - b), mesh.bindMatrix.elements,
    hip.toArray(), legs.map(leg => leg!.toArray()), bones, materials.map(material => material.name)]);
  const cache = variants.get(source) ?? new Map<string, BufferGeometry>(); variants.set(source, cache);
  if (cache.has(key)) return cache.get(key)!;
  const ray = new Ray(), direction = new Vector3(), origin = new Vector3(), a = new Vector3(), b = new Vector3(), c = new Vector3(), hit = new Vector3(), boxHit = new Vector3();
  const normal = new Vector3(), edgeA = new Vector3(), edgeB = new Vector3();
  const point = new Vector3(), shifted = new Vector3(), tangent = new Vector3();
  const coveredRay = (sample: Vector3, centre: Vector3, side: number): boolean => {
    direction.set(sample.x - centre.x, 0, sample.z - centre.z);
    const radius = direction.length();
    if (radius < .025 || radius > .32) return false;
    direction.divideScalar(radius); origin.copy(sample).addScaledVector(direction, -INWARD); ray.set(origin, direction);
    const intersects = (field: Surface, node: Node): boolean => {
      if (!ray.intersectBox(node.bounds, boxHit) || !node.bounds.containsPoint(origin) && boxHit.distanceTo(origin) > INWARD + OUTWARD) return false;
      if (node.triangles) for (const triangle of node.triangles) {
        const offset = triangle * 3;
        a.fromArray(field.points, field.indices[offset]! * 3); b.fromArray(field.points, field.indices[offset + 1]! * 3); c.fromArray(field.points, field.indices[offset + 2]! * 3);
        // A neighbouring leg or a garment displaced to the far side can expose its
        // inward-facing wall to this ray. Only the authored outward wall covers skin.
        normal.crossVectors(edgeA.subVectors(b, a), edgeB.subVectors(c, a));
        if (normal.dot(direction) > 1e-10 && ray.intersectTriangle(a, b, c, false, hit) && hit.distanceTo(origin) <= INWARD + OUTWARD
          && (side === 0 || (hit.x - hip.x) * side >= .003)) return true;
      }
      return !!(node.left && intersects(field, node.left) || node.right && intersects(field, node.right));
    };
    return fields.some(field => intersects(field, field.root));
  };
  const coveredPoint = (sample: Vector3): boolean => {
    if (sample.y < hip.y - .43 || sample.y > hip.y + .14 || Math.abs(sample.x - hip.x) > .29) return false;
    let centre = hip, side = 0;
    if (sample.y < hip.y - .11) {
      centre = Math.abs(sample.x - legs[0]!.x) < Math.abs(sample.x - legs[1]!.x) ? legs[0]! : legs[1]!;
      side = Math.sign(centre.x - hip.x);
      if (!side || (sample.x - hip.x) * side < .003) return false;
    }
    tangent.set(-(sample.z - centre.z), 0, sample.x - centre.x).normalize();
    if (!coveredRay(sample, centre, side)) return false;
    for (const sign of [-1, 1]) {
      shifted.copy(sample).addScaledVector(tangent, sign * MARGIN);
      if (!coveredRay(shifted, centre, side)) return false;
      shifted.copy(sample); shifted.y += sign * MARGIN;
      if (!coveredRay(shifted, centre, side)) return false;
    }
    return true;
  };
  const vertexCoverage = new Map<number, boolean>();
  const eligible = (vertex: number): boolean => {
    let allowed = 0, total = 0;
    for (let slot = 0; slot < Math.min(joints.itemSize, weights.itemSize); slot++) {
      const weight = weights.getComponent(vertex, slot), name = bones[joints.getComponent(vertex, slot)];
      if (!Number.isFinite(weight) || weight < 0) return false;
      total += weight;
      if (/^(?:hips|spine|chest|(?:left|right)UpperLeg)$/.test(name ?? '')) allowed += weight;
    }
    return total > .97 && total < 1.03 && allowed / total >= .95;
  };
  const vertexCovered = (vertex: number): boolean => {
    if (!vertexCoverage.has(vertex)) vertexCoverage.set(vertex, eligible(vertex)
      && coveredPoint(point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix)));
    return vertexCoverage.get(vertex)!;
  };
  const kept: number[] = [], keptGroups: { start: number; count: number; materialIndex: number }[] = [];
  let removed = false;
  for (const group of groups) {
    const skin = /^Skin(?:_|$)/.test(materials[group.materialIndex ?? 0]?.name ?? ''), start = kept.length;
    for (let offset = group.start; offset + 2 < Math.min(group.start + group.count, count); offset += 3) {
      const vertices = [0, 1, 2].map(corner => index ? index.getX(offset + corner) : offset + corner);
      let hidden = false;
      if (skin && vertices.every(vertexCovered)) {
        point.set(0, 0, 0);
        for (const vertex of vertices) point.add(a.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix));
        hidden = coveredPoint(point.multiplyScalar(1 / 3));
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
