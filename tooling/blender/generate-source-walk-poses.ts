#!/usr/bin/env node
/** Portable authoring poses from the same walk and limb math as SourceHumanoid.
 *
 * node --experimental-strip-types tooling/blender/generate-source-walk-poses.ts \
 *   --reference <canonical-rig.glb> --output <ignored-review.json> \
 *   --sole-left <metres> --sole-right <metres> [--phases 16] \
 *   [--heights 170] [--gaits feminine,masculine] [--strides 1,1.6]
 *
 * No textures are loaded. Common character translation is omitted from skinning
 * matrices, since it cannot affect cloth/body contact; its runtime bob is recorded.
 */
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gaitParameters } from '../../apps/web/src/office/scene/avatars/gait.ts';
import { createWalkPose, writeWalkPose } from '../../apps/web/src/office/scene/movement/walkCycle.ts';
import { createSourceArmRotations, sourceLimbBasis, writeSourceArmRotations } from '../../apps/web/src/office/scene/avatars/sourceArmBasis.ts';

// Three belongs to the web workspace. Resolve its installed dependency there,
// so this standalone CLI works without introducing a second renderer dependency.
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const threeModule = pathToFileURL(join(dirname(webRequire.resolve('three')), 'three.module.js')).href;
const { Bone, Group, Matrix4, Quaternion, Euler, Vector3 } = await import(threeModule);

type GltfNode = { name?: string; children?: number[]; matrix?: number[]; translation?: number[];
  rotation?: number[]; scale?: number[]; skin?: number; mesh?: number };
type GltfDocument = { nodes: GltfNode[]; skins: { joints: number[] }[];
  scenes: { nodes: number[] }[]; scene?: number };
const CANONICAL = ['root', 'hips', 'spine', 'chest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];

function argumentsOf(values: string[]) {
  const parsed = new Map<string, string>();
  const allowed = new Set(['reference', 'output', 'sole-left', 'sole-right', 'phases', 'heights', 'gaits', 'strides']);
  for (let i = 0; i < values.length; i += 2) {
    const name = values[i]?.replace(/^--/, '');
    if (!name || !allowed.has(name) || !values[i]!.startsWith('--') || parsed.has(name)
      || values[i + 1] === undefined || values[i + 1]!.startsWith('--')) throw new Error('Invalid or duplicate walk-pose argument');
    parsed.set(name, values[i + 1]!);
  }
  for (const name of ['reference', 'output', 'sole-left', 'sole-right']) if (!parsed.has(name)) throw new Error(`Missing --${name}`);
  const number = (name: string, value: string, low: number, high: number) => {
    const n = Number(value);
    if (!value.trim() || !Number.isFinite(n) || n < low || n > high) throw new Error(`Invalid --${name}`);
    return n;
  };
  const phases = number('phases', parsed.get('phases') ?? '16', 8, 16);
  if (!Number.isInteger(phases) || phases % 2 !== 0) throw new Error('Phases must be an even integer in 8..16');
  const heights = (parsed.get('heights') ?? '170').split(',').map(v => number('heights', v, 145, 195));
  const strides = (parsed.get('strides') ?? '1,1.6').split(',').map(v => number('strides', v, .5, 1.6));
  const gaits = (parsed.get('gaits') ?? 'feminine,masculine').split(',');
  if (!gaits.length || gaits.some(g => g !== 'feminine' && g !== 'masculine')
    || heights.length > 3 || strides.length > 4 || new Set(gaits).size !== gaits.length
    || new Set(heights).size !== heights.length || new Set(strides).size !== strides.length) throw new Error('Walk profiles must be a bounded unique list');
  return { reference: parsed.get('reference')!, output: parsed.get('output')!, phases, heights, strides,
    gaits: gaits as ('feminine' | 'masculine')[],
    soles: { leftFoot: number('sole-left', parsed.get('sole-left')!, -.15, .15),
      rightFoot: number('sole-right', parsed.get('sole-right')!, -.15, .15) } };
}

function readDocument(raw: Buffer): GltfDocument {
  if (raw.length < 20 || raw.readUInt32LE(0) !== 0x46546c67 || raw.readUInt32LE(4) !== 2
    || raw.readUInt32LE(8) !== raw.length || raw.readUInt32LE(16) !== 0x4e4f534a
    || raw.readUInt32LE(12) > raw.length - 20) throw new Error('Expected complete canonical GLB');
  const document = JSON.parse(raw.subarray(20, 20 + raw.readUInt32LE(12)).toString('utf8')) as GltfDocument;
  if (!Array.isArray(document.nodes) || !Array.isArray(document.skins) || !Array.isArray(document.scenes)) throw new Error('Reference GLB needs nodes, skin and active scene');
  return document;
}

async function main() {
  const options = argumentsOf(process.argv.slice(2));
  const raw = await readFile(options.reference);
  const doc = readDocument(raw);
  const skins = doc.skins.filter(s => s.joints.length === 20
    && new Set(s.joints.map(i => doc.nodes[i]?.name)).size === 20
    && s.joints.every(i => CANONICAL.includes(doc.nodes[i]?.name ?? '')));
  if (skins.length !== 1) throw new Error('Reference must contain one canonical 20-joint skin');
  const jointIds = new Set(skins[0]!.joints);
  const scene = new Group();
  const nodes = doc.nodes.map((node, index) => {
    const object = jointIds.has(index) ? new Bone() : new Group();
    object.name = node.name ?? `node-${index}`;
    if (node.matrix) new Matrix4().fromArray(node.matrix).decompose(object.position, object.quaternion, object.scale);
    else {
      if (node.translation) object.position.fromArray(node.translation);
      if (node.rotation) object.quaternion.fromArray(node.rotation);
      if (node.scale) object.scale.fromArray(node.scale);
    }
    return object;
  });
  const parents = new Set<number>();
  for (let i = 0; i < doc.nodes.length; i++) for (const child of doc.nodes[i]!.children ?? []) {
    if (!Number.isInteger(child) || child < 0 || child >= nodes.length || child === i || parents.has(child)) throw new Error('Invalid reference hierarchy');
    parents.add(child); nodes[i]!.add(nodes[child]!);
  }
  const roots = doc.scenes[doc.scene ?? 0]?.nodes;
  if (!roots?.length) throw new Error('Reference needs active scene roots');
  for (const root of roots) {
    if (!nodes[root] || parents.has(root)) throw new Error('Invalid active scene root');
    scene.add(nodes[root]);
  }
  scene.updateMatrixWorld(true);
  const entries = new Map(CANONICAL.map(name => {
    const index = skins[0]!.joints.find(i => doc.nodes[i]?.name === name)!;
    const bone = nodes[index]!;
    if (bone.scale.distanceTo(new Vector3(1, 1, 1)) > 1e-6 || !bone.matrixWorld.elements.every(Number.isFinite)) throw new Error('Reference joints require finite unit scale');
    return [name, { bone, rest: bone.quaternion.clone(), world: bone.getWorldQuaternion(new Quaternion()),
      inverse: bone.matrixWorld.clone().invert(), point: bone.getWorldPosition(new Vector3()) }] as const;
  }));
  const at = (name: string) => {
    const value = entries.get(name);
    if (!value) throw new Error(`Missing canonical bone ${name}`);
    return value;
  };
  const limb = (side: string, arm: boolean) => {
    const names = arm ? [`${side}UpperArm`, `${side}LowerArm`, `${side}Hand`]
      : [`${side}UpperLeg`, `${side}LowerLeg`, `${side}Foot`];
    const [upper, lower, end] = names.map(name => at(name).point);
    return { names, x: upper.x, upper: upper.distanceTo(lower), lower: lower.distanceTo(end), ankle: end.y,
      upperBasis: sourceLimbBasis(lower.clone().sub(upper)), lowerBasis: sourceLimbBasis(end.clone().sub(lower)) };
  };
  const legs = ['left', 'right'].map(s => limb(s, false));
  const arms = ['left', 'right'].map(s => limb(s, true)).sort((a, b) => a.x - b.x);
  const rotations = createSourceArmRotations();
  const rotate = (name: string, delta: ReturnType<typeof createSourceArmRotations>['upper']) => {
    const entry = at(name);
    entry.bone.quaternion.copy(entry.rest).multiply(entry.world.clone().invert().multiply(delta).multiply(entry.world));
  };
  const conversion = new Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
  const inverseConversion = conversion.clone().invert();
  const output = [];
  for (const heightCm of options.heights) for (const gait of options.gaits) for (const stride of options.strides) {
    const scale = heightCm / 185;
    const leg = legs[0]!;
    const legLength = (leg.upper + leg.lower + leg.ankle - options.soles.leftFoot) * scale;
    for (let index = 0; index < options.phases; index++) {
      const phase = index * Math.PI * 2 / options.phases;
      const pose = writeWalkPose(createWalkPose(), gaitParameters({ gait, heightCm }), phase, 1, legLength, stride);
      for (const entry of entries.values()) entry.bone.quaternion.copy(entry.rest);
      for (let side = 0; side < 2; side++) {
        const geo = legs[side]!;
        // Matches SourceHumanoid's sit=0, walk=1: cancellation weight=0,
        // floorSeatedKnee passes through, footLevel=0 and no activity delta.
        writeSourceArmRotations(rotations, geo.upperBasis, geo.lowerBasis, pose.hip[side]!, 0, pose.knee[side]!, 0, 0);
        rotate(geo.names[0]!, rotations.upper); rotate(geo.names[1]!, rotations.lower);
        rotate(geo.names[2]!, rotations.hand.clone().multiply(rotations.lowerBasis));
        const arm = arms[side]!;
        writeSourceArmRotations(rotations, arm.upperBasis, arm.lowerBasis, pose.arm[side]!, 0, -.08 + pose.elbow, 0, 0);
        rotate(arm.names[0]!, rotations.upper); rotate(arm.names[1]!, rotations.lower); rotate(arm.names[2]!, rotations.hand);
      }
      rotate('spine', new Quaternion().setFromEuler(new Euler(.02, 0, pose.pelvisRoll, 'YXZ')));
      rotate('chest', new Quaternion().setFromEuler(new Euler(0, pose.torsoTwist, 0, 'YXZ')));
      scene.updateMatrixWorld(true);
      const matrices = CANONICAL.map(name => {
        const entry = at(name);
        const matrix = conversion.clone().multiply(entry.bone.matrixWorld).multiply(entry.inverse).multiply(inverseConversion);
        return Array.from({ length: 4 }, (_, row) => Array.from({ length: 4 }, (_, column) => matrix.elements[column * 4 + row]));
      });
      output.push({ heightCm, gait, stride, phase, legLength, commonVerticalBobMetres: pose.bob, matrices });
    }
  }
  const restJoints = Object.fromEntries(CANONICAL.map(name => {
    const p = at(name).point; return [name, [p.x, -p.z, p.y]];
  }));
  const result = { schemaVersion: 1, exporter: 'generate-source-walk-poses.ts', coordinateFrame: 'blender-z-up',
    commonRootMotionOmitted: true, activity: 'none', walk: 1, sit: 0,
    referenceSHA256: createHash('sha256').update(raw).digest('hex'), boneNames: CANONICAL,
    soles: options.soles, restJoints, poses: output };
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, JSON.stringify(result) + '\n');
  console.log(JSON.stringify({ poses: output.length, referenceSHA256: result.referenceSHA256, schemaVersion: 1 }));
}
await main();
