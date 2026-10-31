import { Matrix4, Ray, Triangle, Vector3, type BufferGeometry, type SkinnedMesh } from 'three';

const LOW = .65, HIGH = 1.7, TROUSER_HIGH = 1.2, HEIGHT_CELLS = 96, ANGLE_CELLS = 96;
const TAU = Math.PI * 2, CLEARANCE = .005, MAX_SHIFT = .06;
interface SurfaceField {
  id: number;
  mesh: SkinnedMesh;
  points: Float32Array;
  triangles: number[];
  cells: number[][];
}
const fields = new WeakMap<BufferGeometry, Map<string, SurfaceField | null>>();
const fitted = new WeakMap<BufferGeometry, Map<string, BufferGeometry>>();
let nextField = 0;
const angleOf = (x: number, z: number) => (Math.atan2(z, x) + TAU) % TAU;
const heightCell = (y: number) => Math.max(0, Math.min(HEIGHT_CELLS - 1, Math.floor((y - LOW) / (HIGH - LOW) * HEIGHT_CELLS)));

/** Static lookup only: every queried surface intersection is still tested against an actual triangle. */
function surfaceField(mesh: SkinnedMesh, centre: Vector3, outerOnly: boolean, bodyOnly = false): SurfaceField | undefined {
  const geometry = mesh.geometry, position = geometry.getAttribute('position');
  if (!position || !mesh.bindMatrix.elements.every(Number.isFinite)) return undefined;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const index = geometry.index, count = index?.count ?? position.count;
  const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count, materialIndex: 0 }];
  const sourceGroups = groups.filter(group => {
    const name = materials[group.materialIndex ?? 0]?.name ?? '';
    return bodyOnly ? /^Skin(?:_|$)/.test(name) && !/(?:Hand|Foot|Nail)/i.test(name)
      : (outerOnly ? /^OriginalOuter(?:_|$)/ : /^Original(?:Top|Outer)(?:_|$)/).test(name);
  });
  if (!sourceGroups.length) return undefined;
  const bones = mesh.skeleton?.bones.map(bone => bone.name) ?? [];
  const key = JSON.stringify([sourceGroups, mesh.bindMatrix.elements, centre.x, centre.z, bones]);
  const variants = fields.get(geometry) ?? new Map<string, SurfaceField | null>();
  fields.set(geometry, variants);
  if (variants.has(key)) return variants.get(key) ?? undefined;
  const points = new Float32Array(position.count * 3), point = new Vector3();
  for (let vertex = 0; vertex < position.count; vertex++) {
    point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix);
    points.set([point.x, point.y, point.z], vertex * 3);
  }
  const field: SurfaceField = { id: nextField++, mesh, points, triangles: [], cells: Array.from({ length: HEIGHT_CELLS * ANGLE_CELLS }, () => []) };
  const joints = geometry.getAttribute('skinIndex'), weights = geometry.getAttribute('skinWeight');
  const armShare = (vertex: number) => {
    let share = 0;
    if (joints && weights) for (let influence = 0; influence < Math.min(joints.itemSize, weights.itemSize); influence++) {
      if (/(?:Arm|Hand)/.test(bones[joints.getComponent(vertex, influence)] ?? '')) share += weights.getComponent(vertex, influence);
    }
    return share;
  };
  for (const group of sourceGroups) for (let offset = group.start; offset + 2 < Math.min(group.start + group.count, count); offset += 3) {
    const vertices = [0, 1, 2].map(i => index ? index.getX(offset + i) : offset + i);
    // A hanging cuff beside the hip never covers the waist. Freezing it into
    // this rest-pose field would pinch trousers beneath the skin after reach.
    if (vertices.reduce((sum, vertex) => sum + armShare(vertex), 0) / 3 >= .25) continue;
    const heights = vertices.map(vertex => points[vertex * 3 + 1]!);
    const min = Math.min(...heights), max = Math.max(...heights);
    if (!Number.isFinite(min + max) || max < LOW || min > HIGH) continue;
    const angles = vertices.map(vertex => angleOf(points[vertex * 3]! - centre.x, points[vertex * 3 + 2]! - centre.z)).sort((a, b) => a - b);
    if (!angles.every(Number.isFinite)) continue;
    // Unwrap the shortest circular arc. Triangles surrounding the axis conservatively visit all angles.
    const gaps = angles.map((angle, i) => (angles[(i + 1) % 3]! + (i === 2 ? TAU : 0)) - angle);
    const gap = gaps.indexOf(Math.max(...gaps)), start = angles[(gap + 1) % 3]!, span = TAU - gaps[gap]!;
    const bins = new Set<number>();
    if (span >= Math.PI) for (let bin = 0; bin < ANGLE_CELLS; bin++) bins.add(bin);
    else for (let bin = Math.floor(start / TAU * ANGLE_CELLS) - 1; bin <= Math.floor((start + span) / TAU * ANGLE_CELLS) + 1; bin++) bins.add((bin + ANGLE_CELLS) % ANGLE_CELLS);
    const triangle = field.triangles.length;
    field.triangles.push(...vertices);
    for (let height = heightCell(min); height <= heightCell(max); height++) for (const bin of bins) field.cells[height * ANGLE_CELLS + bin]!.push(triangle);
  }
  const result = field.triangles.length ? field : undefined;
  variants.set(key, result ?? null);
  return result;
}

/**
 * Tuck native trousers behind original tops/coats and native upper clothing behind original
 * coats. Open hems/fronts have no triangle hit and retain their backing. Originals stay intact.
 */
export function sourceUnderlayerFit(mesh: SkinnedMesh, layers: readonly SkinnedMesh[]): BufferGeometry {
  const source = mesh.geometry, position = source.getAttribute('position');
  if (!layers.length || !/^ScanOutfit(?:Casual)?$/.test(mesh.name.replace(/_\d+$/, '')) || !position || !mesh.skeleton) return source;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const lowerRole = (name: string) => /^OfficeBottom(?:_|$)/.test(name);
  const upperRole = (name: string) => /^Office(?:Top|Outer|Accent|Lining)(?:_|$)/.test(name);
  const hasLower = materials.some(material => lowerRole(material.name)), hasUpper = materials.some(material => upperRole(material.name));
  if (!hasLower && !hasUpper) return source;
  const hips = mesh.skeleton.bones.findIndex(bone => bone.name === 'hips'), hipInverse = mesh.skeleton.boneInverses[hips];
  if (!hipInverse || !mesh.bindMatrix.elements.every(Number.isFinite) || Math.abs(mesh.bindMatrix.determinant()) < 1e-9) return source;
  const centre = new Vector3().setFromMatrixPosition(new Matrix4().copy(hipInverse).invert());
  const collect = (outerOnly: boolean) => layers.map(layer => surfaceField(layer, centre, outerOnly)).filter((field): field is SurfaceField => field !== undefined);
  const lowerSurfaces = hasLower ? collect(false) : [], upperSurfaces = hasUpper ? collect(true) : [];
  const bodySurfaces = [mesh, ...layers].map(layer => surfaceField(layer, centre, false, true)).filter((field): field is SurfaceField => field !== undefined);
  if (!lowerSurfaces.length && !upperSurfaces.length) return source;
  const key = JSON.stringify([lowerSurfaces.map(field => field.id).sort((a, b) => a - b), upperSurfaces.map(field => field.id).sort((a, b) => a - b), bodySurfaces.map(field => field.id).sort((a, b) => a - b), materials.map(material => material.name), mesh.bindMatrix.elements]);
  const variants = fitted.get(source) ?? new Map<string, BufferGeometry>();
  fitted.set(source, variants);
  const cached = variants.get(key);
  if (cached) return cached;
  const index = source.index, count = index?.count ?? position.count;
  const groups = source.groups.length ? source.groups : [{ start: 0, count, materialIndex: 0 }];
  const trousers = new Set<number>(), upper = new Set<number>(), protectedVertices = new Set<number>();
  for (const group of groups) {
    const name = materials[group.materialIndex ?? 0]?.name ?? '';
    const vertices = lowerRole(name) ? trousers : upperRole(name) ? upper : protectedVertices;
    for (let offset = group.start; offset < Math.min(group.start + group.count, count); offset++) vertices.add(index ? index.getX(offset) : offset);
  }
  for (const vertex of protectedVertices) { trousers.delete(vertex); upper.delete(vertex); }
  const eligible = new Set([...trousers, ...upper]);
  const inverse = mesh.bindMatrix.clone().invert(), point = new Vector3(), hit = new Vector3();
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), direction = new Vector3(), ray = new Ray();
  let geometry: BufferGeometry | undefined;
  const moved = new Set<number>();
  const sourceJoints = source.getAttribute('skinIndex'), sourceWeights = source.getAttribute('skinWeight');
  const boneMap = new Map(mesh.skeleton.bones.map((bone, index) => [bone.name, index]));
  const bodyTriangle = new Triangle(), nearest = new Vector3(), barycentric = new Vector3();
  const bindingBodies = bodySurfaces.filter(field => layers.includes(field.mesh) && field.mesh.geometry.getAttribute('skinIndex') && field.mesh.geometry.getAttribute('skinWeight'));
  for (const vertex of eligible) {
    point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix);
    const surfaces = upper.has(vertex) ? upperSurfaces : lowerSurfaces;
    if (!surfaces.length || point.y < LOW || point.y > (upper.has(vertex) ? HIGH : TROUSER_HIGH)) continue;
    const radius = Math.hypot(point.x - centre.x, point.z - centre.z);
    if (!Number.isFinite(radius) || radius < .04) continue;
    direction.set((point.x - centre.x) / radius, 0, (point.z - centre.z) / radius);
    ray.set(new Vector3(centre.x, point.y, centre.z), direction);
    const angle = Math.min(ANGLE_CELLS - 1, Math.floor(angleOf(direction.x, direction.z) / TAU * ANGLE_CELLS));
    const cell = heightCell(point.y) * ANGLE_CELLS + angle;
    if (trousers.has(vertex) && sourceJoints && sourceWeights && point.y > .82 && point.y < 1.18) {
      let closestDistance = .08, closest: { field: SurfaceField; triangle: number; bary: Vector3 } | undefined;
      for (const field of bindingBodies) for (let offset = 0; offset < field.triangles.length; offset += 3) {
        bodyTriangle.a.fromArray(field.points, field.triangles[offset]! * 3);
        bodyTriangle.b.fromArray(field.points, field.triangles[offset + 1]! * 3);
        bodyTriangle.c.fromArray(field.points, field.triangles[offset + 2]! * 3);
        bodyTriangle.closestPointToPoint(point, nearest);
        const distance = point.distanceTo(nearest);
        if (distance >= closestDistance) continue;
        bodyTriangle.getBarycoord(nearest, barycentric);
        closestDistance = distance; closest = { field, triangle: offset, bary: barycentric.clone() };
      }
      if (closest) {
        const field = closest.field, joints = field.mesh.geometry.getAttribute('skinIndex'), weights = field.mesh.geometry.getAttribute('skinWeight');
        const smooth = (value: number) => { const x = Math.max(0, Math.min(1, value)); return x * x * (3 - 2 * x); };
        const blend = smooth((point.y - .82) / .06) * smooth((1.18 - point.y) / .04) * smooth((.08 - closestDistance) / .03);
        const row = new Map<number, number>();
        for (let slot = 0; slot < 4; slot++) row.set(sourceJoints.getComponent(vertex, slot), (row.get(sourceJoints.getComponent(vertex, slot)) ?? 0) + sourceWeights.getComponent(vertex, slot) * (1 - blend));
        for (let corner = 0; corner < 3; corner++) {
          const index = field.triangles[closest.triangle + corner]!;
          for (let slot = 0; slot < Math.min(joints.itemSize, weights.itemSize); slot++) {
            const joint = boneMap.get(field.mesh.skeleton.bones[joints.getComponent(index, slot)]?.name ?? '');
            if (joint !== undefined) row.set(joint, (row.get(joint) ?? 0) + weights.getComponent(index, slot) * closest.bary.getComponent(corner) * blend);
          }
        }
        const influences = [...row].filter(([, weight]) => weight > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
        const total = influences.reduce((sum, [, weight]) => sum + weight, 0);
        if (total > .99) {
          geometry ??= source.clone();
          for (let slot = 0; slot < 4; slot++) {
            geometry.getAttribute('skinIndex').setComponent(vertex, slot, influences[slot]?.[0] ?? 0);
            geometry.getAttribute('skinWeight').setComponent(vertex, slot, (influences[slot]?.[1] ?? 0) / total);
          }
        }
      }
    }
    let coveringRadius = Infinity;
    for (const field of surfaces) for (const triangle of field.cells[cell]!) {
      a.fromArray(field.points, field.triangles[triangle]! * 3);
      b.fromArray(field.points, field.triangles[triangle + 1]! * 3);
      c.fromArray(field.points, field.triangles[triangle + 2]! * 3);
      if (!ray.intersectTriangle(a, b, c, false, hit)) continue;
      const distance = Math.hypot(hit.x - centre.x, hit.z - centre.z);
      if (distance >= .04) coveringRadius = Math.min(coveringRadius, distance);
    }
    let bodyRadius = 0;
    for (const field of bodySurfaces) for (const triangle of field.cells[cell]!) {
      a.fromArray(field.points, field.triangles[triangle]! * 3);
      b.fromArray(field.points, field.triangles[triangle + 1]! * 3);
      c.fromArray(field.points, field.triangles[triangle + 2]! * 3);
      if (ray.intersectTriangle(a, b, c, false, hit)) bodyRadius = Math.max(bodyRadius, Math.hypot(hit.x - centre.x, hit.z - centre.z));
    }
    // An original hem may sit inside the body. It cannot pull the native
    // backing through that body while the torso and thighs bend independently.
    if (!Number.isFinite(coveringRadius) && !bodyRadius) continue;
    const desired = Math.max(.035, bodyRadius ? bodyRadius + .008 : 0,
      Number.isFinite(coveringRadius) ? coveringRadius - CLEARANCE : radius);
    if (Math.abs(radius - desired) <= 1e-6 || radius < desired && !bodyRadius) continue;
    const fittedRadius = Math.max(radius - MAX_SHIFT, Math.min(radius + MAX_SHIFT, desired));
    point.set(centre.x + direction.x * fittedRadius, point.y, centre.z + direction.z * fittedRadius).applyMatrix4(inverse);
    geometry ??= source.clone();
    geometry.getAttribute('position').setXYZ(vertex, point.x, point.y, point.z);
    moved.add(vertex);
  }
  if (!geometry) { variants.set(key, source); return source; }
  if (bindingBodies.length) {
    geometry.getAttribute('skinIndex').needsUpdate = true; geometry.getAttribute('skinWeight').needsUpdate = true;
  }
  geometry.getAttribute('position').needsUpdate = true;
  const oldNormals = source.getAttribute('normal');
  geometry.computeVertexNormals();
  if (oldNormals) {
    const computed = geometry.getAttribute('normal'), normals = oldNormals.clone();
    // Recompute only native garment faces affected by movement; preserve skin/shoe normals.
    for (const group of groups) for (let offset = group.start; offset + 2 < Math.min(group.start + group.count, count); offset += 3) {
      const vertices = [0, 1, 2].map(i => index ? index.getX(offset + i) : offset + i);
      if (!vertices.some(vertex => moved.has(vertex))) continue;
      for (const vertex of vertices) if (eligible.has(vertex)) normals.setXYZ(vertex, computed.getX(vertex), computed.getY(vertex), computed.getZ(vertex));
    }
    geometry.setAttribute('normal', normals);
  }
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  variants.set(key, geometry);
  return geometry;
}
