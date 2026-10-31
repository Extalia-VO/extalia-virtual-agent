import { Matrix4, Vector3, type BufferGeometry, type SkinnedMesh } from 'three';

/** Extend a nearby native hem beneath a loaded low-rise bottom, preserving the original garment. */
export function sourceWaistBacking(mesh: SkinnedMesh, bottom: SkinnedMesh): BufferGeometry {
  const source = mesh.geometry, position = source.getAttribute('position');
  if (!/^ScanOutfit(?:Casual)?$/.test(mesh.name.replace(/_\d+$/, '')) || !position || !mesh.skeleton) return source;
  const hips = mesh.skeleton.bones.findIndex(bone => bone.name === 'hips');
  const hipInverse = mesh.skeleton.boneInverses[hips];
  if (!hipInverse || Math.abs(mesh.bindMatrix.determinant()) < 1e-9) return source;
  const hip = new Vector3().setFromMatrixPosition(new Matrix4().copy(hipInverse).invert());
  const lower = bottom.geometry, lowerPosition = lower.getAttribute('position');
  if (!lowerPosition) return source;
  const lowerMaterials = Array.isArray(bottom.material) ? bottom.material : [bottom.material];
  const lowerCount = lower.index?.count ?? lowerPosition.count;
  const lowerGroups = lower.groups.length ? lower.groups : [{ start: 0, count: lowerCount, materialIndex: 0 }];
  const point = new Vector3();
  const bins = 48, tau = Math.PI * 2, waist = Array<number>(bins).fill(-Infinity);
  const angleBin = (x: number, z: number) => Math.floor(((Math.atan2(z - hip.z, x - hip.x) + tau) % tau) / tau * bins) % bins;
  for (const group of lowerGroups) {
    if (!/^OriginalBottom(?:_|$)/.test(lowerMaterials[group.materialIndex ?? 0]?.name ?? '')) continue;
    for (let offset = group.start; offset < Math.min(group.start + group.count, lowerCount); offset++) {
      point.fromBufferAttribute(lowerPosition, lower.index ? lower.index.getX(offset) : offset).applyMatrix4(bottom.bindMatrix);
      if (Math.abs(point.x - hip.x) < .28 && point.y > hip.y - .15 && point.y < hip.y + .18) {
        const bin = angleBin(point.x, point.z);
        waist[bin] = Math.max(waist[bin]!, point.y);
      }
    }
  }
  if (!waist.some(Number.isFinite)) return source;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const count = source.index?.count ?? position.count;
  const groups = source.groups.length ? source.groups : [{ start: 0, count, materialIndex: 0 }];
  const eligible = new Set<number>(), protectedVertices = new Set<number>();
  for (const group of groups) {
    const selected = /^Office(?:Top|Outer|Lining)(?:_|$)/.test(materials[group.materialIndex ?? 0]?.name ?? '') ? eligible : protectedVertices;
    for (let offset = group.start; offset < Math.min(group.start + group.count, count); offset++) selected.add(source.index ? source.index.getX(offset) : offset);
  }
  for (const vertex of protectedVertices) eligible.delete(vertex);
  // Only near-waist torso cloth is eligible. Hanging cuffs, skin and shoes remain untouched.
  const joints = source.getAttribute('skinIndex'), weights = source.getAttribute('skinWeight');
  if (!joints || !weights) return source;
  const candidates = [...eligible].filter(vertex => {
    let arm = 0;
    for (let influence = 0; influence < Math.min(joints.itemSize, weights.itemSize); influence++) {
      if (/(?:Arm|Hand)/.test(mesh.skeleton.bones[joints.getComponent(vertex, influence)]?.name ?? '')) arm += weights.getComponent(vertex, influence);
    }
    point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix);
    return arm < .2 && Math.abs(point.x - hip.x) < .23 && point.y > hip.y - .10 && point.y < hip.y + .15;
  });
  const hem = Math.min(...candidates.map(vertex => point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix).y));
  let geometry: BufferGeometry | undefined;
  const inverse = mesh.bindMatrix.clone().invert();
  for (const vertex of candidates) {
    point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix);
    const bin = angleBin(point.x, point.z);
    let height = -Infinity;
    for (let distance = 0; distance <= 4 && !Number.isFinite(height); distance++) {
      height = Math.max(waist[(bin + distance) % bins]!, waist[(bin - distance + bins) % bins]!);
    }
    const shift = point.y - (height - .015);
    if (!(shift > 0 && shift <= .08)) continue;
    const t = Math.max(0, Math.min(1, (hem + .12 - point.y) / .12));
    if (t <= 0) continue;
    point.y -= shift * t * t * (3 - 2 * t);
    point.applyMatrix4(inverse);
    geometry ??= source.clone();
    geometry.getAttribute('position').setXYZ(vertex, point.x, point.y, point.z);
  }
  if (!geometry) return source;
  geometry.getAttribute('position').needsUpdate = true;
  const oldNormals = source.getAttribute('normal');
  geometry.computeVertexNormals();
  if (oldNormals) {
    const computed = geometry.getAttribute('normal'), normals = oldNormals.clone();
    for (const vertex of candidates) normals.setXYZ(vertex, computed.getX(vertex), computed.getY(vertex), computed.getZ(vertex));
    geometry.setAttribute('normal', normals);
  }
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}
