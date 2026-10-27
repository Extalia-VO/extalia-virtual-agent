import { Float32BufferAttribute, type BufferGeometry, type Mesh, type SkinnedMesh } from 'three';
import type { FacialPose } from './facialExpression';
import { isCanonicalSourceHandAsset } from './sourceHandCurl';

const NAMES = ['ExtaliaBlink', 'ExtaliaMouth', 'ExtaliaBrow', 'ExtaliaGazeX', 'ExtaliaGazeY'] as const;
type FacePart = 'skin' | 'lashes' | 'eyes' | 'brows' | 'beard';
export interface SourceFaceGeometry { geometry: BufferGeometry; targets: readonly number[] }
export interface SourceFaceBinding extends SourceFaceGeometry { mesh: Mesh }
// Immutable shapes have the loader geometry's lifetime. Only influences belong to an avatar.
const cache = new WeakMap<BufferGeometry, Map<string, SourceFaceGeometry | null>>();
const clamp = (x: number, min = 0, max = 1) => Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : 0;
const smooth = (x: number) => { const t = clamp(x); return t * t * (3 - 2 * t); };
const band = (x: number, inner: number, outer: number) => 1 - smooth((Math.abs(x) - inner) / (outer - inner));

/** The canonical skin primitive includes separate eyeball islands; never move surrounding skin as gaze. */
function eyeVertices(source: BufferGeometry): Set<number> {
  const position = source.getAttribute('position'), index = source.index;
  const result = new Set<number>();
  if (!position || !index) return result;
  const adjacency = Array.from({ length: position.count }, () => [] as number[]);
  for (let i = 0; i + 2 < index.count; i += 3) {
    const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
    adjacency[a]?.push(b, c); adjacency[b]?.push(a, c); adjacency[c]?.push(a, b);
  }
  const seen = new Set<number>();
  for (let i = 0; i < position.count; i++) {
    if (seen.has(i)) continue;
    const component: number[] = [], pending = [i];
    while (pending.length) {
      const vertex = pending.pop()!;
      if (seen.has(vertex)) continue;
      seen.add(vertex); component.push(vertex);
      for (const neighbour of adjacency[vertex] ?? []) if (!seen.has(neighbour)) pending.push(neighbour);
    }
    if (component.length < 20 || component.length > 180) continue;
    if (component.every(v => Math.abs(position.getX(v)) > .012 && Math.abs(position.getX(v)) < .061
      && position.getY(v) > 1.70 && position.getY(v) < 1.75 && position.getZ(v) > .025)) {
      for (const vertex of component) result.add(vertex);
    }
  }
  return result;
}

/** Conservative metre-space shapes for the inspected canonical face topology, never arbitrary imports. */
export function sourceFaceExpressionGeometry(source: BufferGeometry, part: FacePart, female = false): SourceFaceGeometry | undefined {
  const position = source.getAttribute('position'), normal = source.getAttribute('normal');
  if (!position || !normal || position.count !== normal.count || position.count > 10000) return undefined;
  const key = `${part}:${female}`;
  const entries = cache.get(source) ?? new Map<string, SourceFaceGeometry | null>();
  cache.set(source, entries);
  if (entries.has(key)) return entries.get(key) ?? undefined;
  // Bounds and topology gates prevent a similarly named replacement from being deformed.
  if ((part === 'skin' && position.count !== 4182) || (part === 'lashes' && position.count !== 748)
    || (part === 'eyes' && position.count !== 164)) { entries.set(key, null); return undefined; }
  for (let i = 0; i < position.count; i++) {
    if (![position.getX(i), position.getY(i), position.getZ(i)].every(Number.isFinite)
      || Math.abs(position.getX(i)) > .16 || position.getY(i) < 1.55 || position.getY(i) > 1.88
      || Math.abs(position.getZ(i)) > .16) { entries.set(key, null); return undefined; }
  }
  const eyeY = female ? 1.723 : 1.728, mouthY = female ? 1.655 : 1.657;
  const eyeIslands = part === 'skin' ? eyeVertices(source) : new Set<number>();
  const base = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) base.set([position.getX(i), position.getY(i), position.getZ(i)], i * 3);
  const values = NAMES.map(() => base.slice());
  let changed = false;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i), side = x < 0 ? -1 : 1;
    const eye = part === 'eyes' || eyeIslands.has(i);
    const eyeLine = eyeY + (Math.abs(x) - .034) * .035;
    if (part === 'skin' || part === 'lashes' || part === 'eyes') {
      const influence = eye || part === 'lashes' ? 1
        : band(Math.abs(x) - .035, .016, .029) * band(y - eyeLine, .010, .026) * smooth((z - .042) / .02);
      // Collapse eyeball islands with the lids, so whites cannot protrude through a closed lid.
      values[0]![i * 3 + 1] = y + (eyeLine - y) * influence * .995;
      if (eye) {
        const centerZ = female ? .052 : .057;
        values[3]![i * 3] = x + (z - centerZ) * .16;
        values[3]![i * 3 + 2] = z - (x - side * .034) * .16;
        values[4]![i * 3 + 1] = y + (z - centerZ) * .12;
        values[4]![i * 3 + 2] = z - (y - eyeY) * .12;
      }
    }
    if ((part === 'skin' && !eye) || part === 'beard') {
      const mouth = band(x, .014, .047) * band(y - mouthY, .012, .052) * smooth((z - .035) / .04);
      // A small jaw/lower-lip drop and upper-lip lift; keep the original mouth interior and texture.
      const lower = 1 - smooth((y - mouthY + .002) / .005);
      values[1]![i * 3 + 1] = y + mouth * (.002 * (1 - lower) - .014 * lower);
      values[1]![i * 3 + 2] = z - mouth * lower * .002;
    }
    if ((part === 'skin' && !eye) || part === 'brows') {
      const brow = part === 'brows' ? 1 : band(Math.abs(x) - .035, .014, .03)
        * band(y - (eyeY + .019), .004, .016) * smooth((z - .045) / .025);
      values[2]![i * 3 + 1] = y - .003 * brow * (1 - smooth((Math.abs(x) - .018) / .045));
    }
    for (const value of values) if (value[i * 3] !== base[i * 3] || value[i * 3 + 1] !== base[i * 3 + 1] || value[i * 3 + 2] !== base[i * 3 + 2]) changed = true;
  }
  if (!changed) { entries.set(key, null); return undefined; }
  const geometry = source.clone(), existing = source.morphAttributes.position?.length ?? 0;
  const positions = [...geometry.morphAttributes.position ?? []], normals = [...geometry.morphAttributes.normal ?? []];
  while (normals.length < existing) {
    const neutral = new Float32Array(base.length);
    if (!source.morphTargetsRelative) for (let i = 0; i < position.count; i++) neutral.set([normal.getX(i), normal.getY(i), normal.getZ(i)], i * 3);
    normals.push(new Float32BufferAttribute(neutral, 3));
  }
  for (let shape = 0; shape < NAMES.length; shape++) {
    const target = values[shape]!;
    const temporary = source.clone(); temporary.setAttribute('position', new Float32BufferAttribute(target.slice(), 3)); temporary.computeVertexNormals();
    const computed = temporary.getAttribute('normal'), normalValues = new Float32Array(base.length);
    for (let i = 0; i < position.count; i++) {
      const moved = target[i * 3] !== base[i * 3] || target[i * 3 + 1] !== base[i * 3 + 1] || target[i * 3 + 2] !== base[i * 3 + 2];
      for (let axis = 0; axis < 3; axis++) {
        const offset = i * 3 + axis;
        const n = moved && computed.getX(i) ** 2 + computed.getY(i) ** 2 + computed.getZ(i) ** 2 > 1e-10
          ? computed.getComponent(i, axis) : normal.getComponent(i, axis);
        normalValues[offset] = n - (source.morphTargetsRelative ? normal.getComponent(i, axis) : 0);
        if (source.morphTargetsRelative) target[offset]! -= base[offset]!;
      }
    }
    temporary.dispose();
    const attribute = new Float32BufferAttribute(target, 3); attribute.name = NAMES[shape]!;
    positions.push(attribute); normals.push(new Float32BufferAttribute(normalValues, 3));
  }
  geometry.morphAttributes.position = positions; geometry.morphAttributes.normal = normals;
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const result = { geometry, targets: NAMES.map((_, i) => existing + i) }; entries.set(key, result); return result;
}

export function attachSourceFaceExpressions(mesh: Mesh, assetUrl: string): SourceFaceBinding | undefined {
  if (!isCanonicalSourceHandAsset(assetUrl) || Array.isArray(mesh.material)) return undefined;
  const skeleton = (mesh as SkinnedMesh).skeleton;
  if (!skeleton?.bones.some(bone => bone.name === 'head') || skeleton.bones.some(bone => /eye|jaw/i.test(bone.name))) return undefined;
  const material = mesh.material.name;
  const part: FacePart | undefined = /^Skin_Head/.test(material) ? 'skin' : /^Eyelash/.test(material) ? 'lashes'
    : /^Ga_Eye/.test(material) ? 'eyes' : /^Eyebrow/.test(material) ? 'brows' : /^(Beard|Mustache)/.test(material) ? 'beard' : undefined;
  if (!part) return undefined;
  const result = sourceFaceExpressionGeometry(mesh.geometry, part, /female-casual|business-woman/i.test(assetUrl));
  if (!result) return undefined;
  const dictionary = { ...mesh.morphTargetDictionary }, influences = [...mesh.morphTargetInfluences ?? []];
  mesh.geometry = result.geometry; mesh.updateMorphTargets();
  mesh.morphTargetDictionary = { ...dictionary, ...Object.fromEntries(NAMES.map((name, i) => [name, result.targets[i]!])) };
  mesh.morphTargetInfluences = Array.from({ length: (result.targets.at(-1) ?? -1) + 1 }, (_, i) => influences[i] ?? 0);
  return { ...result, mesh };
}

/** No geometry writes or allocation in the frame loop; zero inputs exactly restore the source face. */
export function writeSourceFaceExpressions(bindings: readonly SourceFaceBinding[], pose: FacialPose): void {
  const blink = clamp(pose.blink);
  for (const binding of bindings) {
    const weights = binding.mesh.morphTargetInfluences;
    if (!weights) continue;
    weights[binding.targets[0]!] = blink;
    weights[binding.targets[1]!] = clamp(Math.max(clamp(pose.yawn), clamp(pose.mouthOpen)));
    weights[binding.targets[2]!] = clamp(pose.brow, -1, 1);
    weights[binding.targets[3]!] = clamp(pose.gazeX, -1, 1) * (1 - blink);
    weights[binding.targets[4]!] = clamp(pose.gazeY, -1, 1) * (1 - blink);
  }
}
