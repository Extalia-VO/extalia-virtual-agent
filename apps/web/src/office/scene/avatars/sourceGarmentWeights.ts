import { Matrix4, Vector3, type BufferGeometry, type SkinnedMesh } from 'three';

const cache = new WeakMap<BufferGeometry, Map<string, BufferGeometry | null>>();
const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
interface Arm { upper: number; lower: number; hand: number; shoulder: Vector3; elbow: Vector3; wrist: Vector3 }

/** Repair isolated formal sleeves and sleeveless bodices; ambiguous joined garments stay unchanged. */
export function sourceGarmentWeights(mesh: SkinnedMesh): BufferGeometry | undefined {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const mode = materials.length && materials.every(material => material.name.startsWith('OfficeTop_')) ? 'sleeve'
    : materials.length && materials.every(material => /^Office(?:Outer|Lining)_/.test(material.name)) ? 'bodice' : undefined;
  if (mesh.name.replace(/_\d+$/, '') !== 'ScanOutfit' || !mode) return undefined;
  const source = mesh.geometry, position = source.getAttribute('position');
  const weights = source.getAttribute('skinWeight'), joints = source.getAttribute('skinIndex'), index = source.index;
  if (!position || !weights || !joints || !mesh.skeleton || weights.itemSize !== 4 || joints.itemSize !== 4
    || weights.count !== position.count || joints.count !== position.count) return undefined;
  const arms: Arm[] = [];
  for (const side of ['left', 'right']) {
    const bone = (part: string) => mesh.skeleton.bones.findIndex(b => b.name === `${side}${part}`);
    const upper = bone('UpperArm'), lower = bone('LowerArm'), hand = bone('Hand');
    if ([upper, lower, hand].some(i => i < 0 || !mesh.skeleton.boneInverses[i])) return undefined;
    const point = (i: number) => new Vector3().setFromMatrixPosition(new Matrix4().copy(mesh.skeleton.boneInverses[i]!).invert());
    const shoulder = point(upper), elbow = point(lower), wrist = point(hand);
    if (shoulder.distanceTo(elbow) < .1 || elbow.distanceTo(wrist) < .1) return undefined;
    arms.push({ upper, lower, hand, shoulder, elbow, wrist });
  }
  const signature = JSON.stringify([mode, mesh.bindMatrix.elements, mesh.skeleton.bones.map(b => b.name), arms.map(a => [a.upper, a.lower, a.hand, a.shoulder.toArray(), a.elbow.toArray(), a.wrist.toArray()])]);
  const entries = cache.get(source) ?? new Map<string, BufferGeometry | null>(); cache.set(source, entries);
  if (entries.has(signature)) return entries.get(signature) ?? undefined;
  const parent = new Int32Array(position.count).fill(-1), points: (Vector3 | undefined)[] = [];
  const find = (vertex: number): number => {
    let root = vertex;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[vertex] !== vertex) { const next = parent[vertex]!; parent[vertex] = root; vertex = next; }
    return root;
  };
  const join = (a: number, b: number) => { parent[find(a)] = find(b); };
  const welded = new Map<string, number>();
  const count = index?.count ?? position.count;
  if (count % 3 !== 0) return undefined;
  for (let i = 0; i < count; i++) {
    const vertex = index ? index.getX(i) : i;
    if (vertex < 0 || vertex >= position.count) return undefined;
    if (parent[vertex] !== -1) continue;
    const point = new Vector3().fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix);
    if (!point.toArray().every(Number.isFinite)) return undefined;
    points[vertex] = point; parent[vertex] = vertex;
    const key = point.toArray().map(v => Math.round(v * 1e5)).join(',');
    const previous = welded.get(key);
    if (previous === undefined) welded.set(key, vertex); else join(vertex, previous);
  }
  for (let i = 0; i < count; i += 3) {
    const a = index ? index.getX(i) : i, b = index ? index.getX(i + 1) : i + 1, c = index ? index.getX(i + 2) : i + 2;
    join(a, b); join(b, c);
  }
  const components = new Map<number, number[]>();
  for (let i = 0; i < parent.length; i++) if (parent[i] !== -1) {
    const root = find(i), component = components.get(root) ?? []; component.push(i); components.set(root, component);
  }
  const newWeights = weights.clone(), newJoints = joints.clone();
  const midX = (arms[0]!.shoulder.x + arms[1]!.shoulder.x) / 2;
  const forearm = new Vector3(), offset = new Vector3();
  let changed = false;
  for (const component of components.values()) {
    if (component.length < 12) continue;
    if (mode === 'bodice') {
      // A vest spans the torso but never reaches a cuff. A jacket containing
      // sleeves fails this check, so its arm binding remains authored.
      const minX = Math.min(...component.map(i => points[i]!.x)), maxX = Math.max(...component.map(i => points[i]!.x));
      if (minX >= midX - .03 || maxX <= midX + .03
        || arms.some(arm => component.some(i => points[i]!.distanceTo(arm.wrist) < .14))) continue;
      const armBones = new Set(arms.flatMap(arm => [arm.upper, arm.lower, arm.hand]));
      const fallback = mesh.skeleton.bones.findIndex(bone => bone.name === 'chest');
      for (const i of component) {
        const kept = new Map<number, number>(); let leaked = 0, valid = true;
        for (let slot = 0; slot < 4; slot++) {
          const joint = joints.getComponent(i, slot), weight = weights.getComponent(i, slot);
          if (!Number.isFinite(weight) || weight < 0 || joint >= mesh.skeleton.bones.length) { valid = false; break; }
          if (armBones.has(joint)) leaked += weight;
          else if (weight > 0) kept.set(joint, (kept.get(joint) ?? 0) + weight);
        }
        if (!valid || leaked < 1e-6) continue;
        if (!kept.size && fallback >= 0) kept.set(fallback, 1);
        const sum = [...kept.values()].reduce((a, b) => a + b, 0);
        if (sum < 1e-6) continue;
        const ranked = [...kept].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
        for (let slot = 0; slot < 4; slot++) {
          newJoints.setComponent(i, slot, ranked[slot]?.[0] ?? 0);
          newWeights.setComponent(i, slot, (ranked[slot]?.[1] ?? 0) / sum);
        }
        changed = true;
      }
      continue;
    }
    for (const arm of arms) {
      const sign = Math.sign(arm.shoulder.x - midX);
      let minY = Infinity, maxY = -Infinity, cuffDistance = Infinity, shoulderDistance = Infinity, unilateral = true;
      for (const i of component) {
        const p = points[i]!;
        if ((p.x - midX) * sign <= .025) unilateral = false;
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        cuffDistance = Math.min(cuffDistance, p.distanceTo(arm.wrist));
        shoulderDistance = Math.min(shoulderDistance, p.distanceTo(arm.shoulder));
      }
      const length = arm.shoulder.distanceTo(arm.elbow) + arm.elbow.distanceTo(arm.wrist);
      if (!unilateral || maxY - minY < length * .65 || minY > arm.elbow.y - .05
        || maxY < arm.shoulder.y - .12 || cuffDistance > .13 || shoulderDistance > .18) continue;
      forearm.subVectors(arm.wrist, arm.elbow);
      const lengthSq = forearm.lengthSq();
      for (const i of component) {
        const p = points[i]!, strength = smooth((arm.shoulder.y - p.y - .06) / .08);
        if (strength <= 0) continue;
        const old = new Map<number, number>(); let total = 0, valid = true;
        for (let slot = 0; slot < 4; slot++) {
          const weight = weights.getComponent(i, slot), joint = joints.getComponent(i, slot);
          if (!Number.isFinite(weight) || weight < 0 || joint >= mesh.skeleton.bones.length) { valid = false; break; }
          if (weight > 0) old.set(joint, (old.get(joint) ?? 0) + weight);
          total += weight;
        }
        if (!valid || total < .97 || total > 1.03) continue;
        const handWeight = p.distanceTo(arm.wrist) <= .07 ? (old.get(arm.hand) ?? 0) / total : 0;
        const t = offset.subVectors(p, arm.elbow).dot(forearm) / lengthSq;
        const lowerWeight = smooth((t + .12) / .24);
        const target = new Map([[arm.upper, (1 - lowerWeight) * (1 - handWeight)], [arm.lower, lowerWeight * (1 - handWeight)], [arm.hand, handWeight]]);
        const result = new Map<number, number>();
        for (const [joint, weight] of old) result.set(joint, weight / total * (1 - strength));
        for (const [joint, weight] of target) result.set(joint, (result.get(joint) ?? 0) + weight * strength);
        const ranked = [...result].filter(([, weight]) => weight > 1e-7).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 4);
        const sum = ranked.reduce((value, [, weight]) => value + weight, 0);
        for (let slot = 0; slot < 4; slot++) {
          newJoints.setComponent(i, slot, ranked[slot]?.[0] ?? 0);
          newWeights.setComponent(i, slot, (ranked[slot]?.[1] ?? 0) / sum);
        }
        changed = true;
      }
      break;
    }
  }
  if (!changed) { entries.set(signature, null); return undefined; }
  const geometry = source.clone(); geometry.setAttribute('skinIndex', newJoints); geometry.setAttribute('skinWeight', newWeights);
  entries.set(signature, geometry); return geometry;
}
