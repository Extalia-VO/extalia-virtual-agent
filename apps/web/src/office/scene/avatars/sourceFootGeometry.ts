import { Vector3, type BufferGeometry, type SkinnedMesh } from 'three';

type Role = 'shoe' | 'bottom' | 'skin';
interface Sample { x: number; y: number; z: number }
interface FootProfile { ankle: Vector3; shoeCount: number; sole: number; cuff?: { minX: number; maxX: number; minZ: number; maxZ: number } }
interface Entry { mesh: SkinnedMesh; outfit: string; roles: (Role | undefined)[]; sides: (string | undefined)[]; points: Sample[] }
const cache = new WeakMap<BufferGeometry, Map<string, BufferGeometry | null>>();
const smooth = (v: number) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };
const roleOf = (name: string): Role | undefined => name.startsWith('OfficeShoes_') ? 'shoe' : name.startsWith('OfficeBottom_') ? 'bottom' : name.startsWith('Skin_Outfit_') ? 'skin' : undefined;
const quantile = (values: number[], fraction: number) => values.sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)]!;

function entryFor(mesh: SkinnedMesh): Entry | undefined {
  const outfit = mesh.name.replace(/_\d+$/, '');
  if (!/^ScanOutfit(?:[A-Za-z]+)?$/.test(outfit) || !mesh.skeleton || Math.abs(mesh.matrixWorld.determinant()) < 1e-10) return undefined;
  const geometry = mesh.geometry, position = geometry.getAttribute('position');
  const joints = geometry.getAttribute('skinIndex'), weights = geometry.getAttribute('skinWeight');
  if (!position || !joints || !weights || joints.itemSize !== 4 || weights.itemSize !== 4 || position.count !== joints.count || position.count !== weights.count) return undefined;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const roles: (Role | undefined)[] = Array.from({ length: position.count });
  if (materials.length === 1) roles.fill(roleOf(materials[0]!.name));
  else {
    const seen = new Uint8Array(position.count), index = geometry.index;
    for (const group of geometry.groups) {
      const role = roleOf(materials[group.materialIndex ?? 0]?.name ?? '');
      for (let j = group.start; j < Math.min(group.start + group.count, index?.count ?? position.count); j++) {
        const vertex = index ? index.getX(j) : j;
        if (!seen[vertex]) { roles[vertex] = role; seen[vertex] = 1; }
        else if (roles[vertex] !== role) roles[vertex] = undefined;
      }
    }
  }
  const sides: (string | undefined)[] = [], points: Sample[] = [], point = new Vector3();
  for (let i = 0; i < position.count; i++) {
    const totals = { left: 0, right: 0 };
    for (let slot = 0; slot < 4; slot++) {
      const weight = weights.getComponent(i, slot), bone = mesh.skeleton.bones[joints.getComponent(i, slot)];
      if (!Number.isFinite(weight) || weight < 0) continue;
      if (/^left(?:UpperLeg|LowerLeg|Foot|Toes)$/.test(bone?.name ?? '')) totals.left += weight;
      if (/^right(?:UpperLeg|LowerLeg|Foot|Toes)$/.test(bone?.name ?? '')) totals.right += weight;
    }
    sides.push(totals.left >= .9 ? 'leftFoot' : totals.right >= .9 ? 'rightFoot' : undefined);
    point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    points.push({ x: point.x, y: point.y, z: point.z });
  }
  return { mesh, outfit, roles, sides, points };
}

/** Fit known formal outfit cuffs and exposed insteps to their unchanged shoes, once in the source rest pose. */
export function fitSourceFootGeometry(meshes: readonly SkinnedMesh[]): {
  corrections: readonly { mesh: SkinnedMesh; geometry: BufferGeometry }[];
  soleByOutfit: ReadonlyMap<string, ReadonlyMap<string, number>>;
} {
  const entries = meshes.map(entryFor).filter((entry): entry is Entry => !!entry);
  const outfits = new Map<string, Map<string, FootProfile>>();
  for (const entry of entries) {
    let feet = outfits.get(entry.outfit);
    if (!feet) { feet = new Map(); outfits.set(entry.outfit, feet); }
    for (const name of ['leftFoot', 'rightFoot']) {
      if (feet.has(name)) continue;
      const bone = entry.mesh.skeleton.bones.find(candidate => candidate.name === name);
      if (bone) feet.set(name, { ankle: new Vector3().setFromMatrixPosition(bone.matrixWorld), shoeCount: 0, sole: Infinity });
    }
    for (let i = 0; i < entry.points.length; i++) {
      const profile = feet.get(entry.sides[i] ?? ''), role = entry.roles[i], point = entry.points[i]!;
      if (!profile || !Number.isFinite(point.x + point.y + point.z)) continue;
      if (role === 'shoe') { profile.shoeCount++; profile.sole = Math.min(profile.sole, point.y); }
    }
  }
  const soleByOutfit = new Map<string, ReadonlyMap<string, number>>();
  for (const [outfit, feet] of outfits) {
    const soles = new Map<string, number>();
    for (const [name, profile] of feet) {
      if (Number.isFinite(profile.sole)) soles.set(name, profile.sole);
      const ring = entries.filter(entry => entry.outfit === outfit).flatMap(entry => entry.points.filter((point, i) => entry.roles[i] === 'bottom' && entry.sides[i] === name && point.y >= profile.ankle.y + .12 && point.y <= profile.ankle.y + .18));
      if (ring.length >= 6) profile.cuff = { minX: quantile(ring.map(p => p.x), .025) - .01, maxX: quantile(ring.map(p => p.x), .975) + .01, minZ: quantile(ring.map(p => p.z), .025) - .01, maxZ: quantile(ring.map(p => p.z), .975) + .01 };
    }
    soleByOutfit.set(outfit, soles);
  }
  const corrections: { mesh: SkinnedMesh; geometry: BufferGeometry }[] = [];
  for (const entry of entries) {
    // Other wardrobe variants have different tailoring and are intentionally left intact.
    if (entry.outfit !== 'ScanOutfit') continue;
    const feet = outfits.get(entry.outfit)!;
    const signature = JSON.stringify([entry.mesh.matrixWorld.elements, entry.roles, [...feet].map(([name, p]) => [name, p.ankle.toArray(), p.shoeCount, p.sole, p.cuff])]);
    const source = entry.mesh.geometry, memo = cache.get(source) ?? new Map<string, BufferGeometry | null>(); cache.set(source, memo);
    if (memo.has(signature)) { const geometry = memo.get(signature); if (geometry) corrections.push({ mesh: entry.mesh, geometry }); continue; }
    const position = source.getAttribute('position').clone(), changed = new Set<number>(), inverse = entry.mesh.matrixWorld.clone().invert(), local = new Vector3();
    for (let i = 0; i < entry.points.length; i++) {
      const profile = feet.get(entry.sides[i] ?? ''), role = entry.roles[i], point = entry.points[i]!;
      if (!profile || profile.shoeCount < 3 || !Number.isFinite(point.x + point.y + point.z)) continue;
      let { x, z } = point;
      const { y } = point;
      const dy = y - profile.ankle.y;
      if (role === 'bottom' && profile.cuff && y >= profile.sole && dy < .13) {
        const strength = 1 - smooth((dy - .035) / .095), b = profile.cuff;
        x += (Math.max(b.minX, Math.min(b.maxX, x)) - x) * strength;
        z += (Math.max(b.minZ, Math.min(b.maxZ, z)) - z) * strength;
      } else if (role === 'skin' && y > profile.sole && dy < .08) {
        // Closed pumps already contain the toes. Keep the exposed ankle's
        // height and tuck the excess scanned bare forefoot into the heel cup.
        // A height-only falloff keeps this map monotone along the foot instead
        // of folding its surface around individual shoe sample columns.
        const strength = 1 - smooth((dy - .03) / .05);
        const excess = Math.max(0, z - profile.ankle.z - .025);
        const tucked = .12 * excess + .88 * .005 * -Math.expm1(-excess / .005);
        z += (tucked - excess) * strength;
        const lateral = x - profile.ankle.x, excessX = Math.max(0, Math.abs(lateral) - .026);
        const tuckedX = .12 * excessX + .88 * .003 * -Math.expm1(-excessX / .003);
        x += Math.sign(lateral) * (tuckedX - excessX) * strength;
      }
      if (Math.abs(x - point.x) + Math.abs(y - point.y) + Math.abs(z - point.z) <= 1e-7) continue;
      local.set(x, y, z).applyMatrix4(inverse); position.setXYZ(i, local.x, local.y, local.z); changed.add(i);
    }
    if (!changed.size) { memo.set(signature, null); continue; }
    const geometry = source.clone(); geometry.setAttribute('position', position);
    // Preserve authored normals everywhere outside the edited vertices.
    const originalNormals = source.getAttribute('normal'); geometry.computeVertexNormals();
    if (originalNormals) {
      const normals = geometry.getAttribute('normal');
      for (let i = 0; i < normals.count; i++) if (!changed.has(i)) normals.setXYZ(i, originalNormals.getX(i), originalNormals.getY(i), originalNormals.getZ(i));
    }
    geometry.computeBoundingBox(); geometry.computeBoundingSphere(); memo.set(signature, geometry); corrections.push({ mesh: entry.mesh, geometry });
  }
  return { corrections, soleByOutfit };
}
