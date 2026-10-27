import { describe, expect, it } from 'vitest';
import { Bone, BufferGeometry, Float32BufferAttribute, MeshStandardMaterial, Skeleton, SkinnedMesh } from 'three';
import { createFacialPose, writeFacialPose } from '../src/office/scene/avatars/facialExpression';
import { attachSourceFaceExpressions, sourceFaceExpressionGeometry, writeSourceFaceExpressions } from '../src/office/scene/avatars/sourceFaceExpressions';

function geometry(relative = true) {
  const result = new BufferGeometry();
  const points = new Float32Array(4182 * 3), normals = new Float32Array(points.length);
  for (let i = 0; i < 4182; i++) { points.set([0, 1.8, .08], i * 3); normals.set([0, 0, 1], i * 3); }
  // Upper/lower eyelid, lower lip, brow and untouched forehead.
  points.set([.034, 1.737, .08, .034, 1.718, .08, 0, 1.651, .095, .025, 1.747, .085]);
  result.setAttribute('position', new Float32BufferAttribute(points, 3));
  result.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  result.setIndex([0, 1, 2, 0, 2, 3]);
  result.morphTargetsRelative = relative;
  return result;
}

describe('canonical source face expressions', () => {
  it.each([true, false])('closes eyelids, lowers lip and tenses brow without changing rest attributes (relative=%s)', relative => {
    const source = geometry(relative), original = Array.from(source.getAttribute('position').array);
    const result = sourceFaceExpressionGeometry(source, 'skin')!;
    expect(result).toBeDefined();
    expect(source.morphAttributes.position).toBeUndefined();
    expect(Array.from(source.getAttribute('position').array)).toEqual(original);
    const point = (target: number, vertex: number, axis: number) => result.geometry.morphAttributes.position![result.targets[target]!]!.getComponent(vertex, axis)
      + (relative ? source.getAttribute('position').getComponent(vertex, axis) : 0);
    expect(Math.abs(point(0, 0, 1) - point(0, 1, 1))).toBeLessThan(.0002);
    expect(point(1, 2, 1)).toBeLessThan(1.64);
    expect(point(2, 3, 1)).toBeLessThan(1.746);
    for (let target = 0; target < 5; target++) for (let axis = 0; axis < 3; axis++) expect(point(target, 4, axis)).toBeCloseTo(original[12 + axis]!, 7);
    for (const attribute of [...result.geometry.morphAttributes.position!, ...result.geometry.morphAttributes.normal!]) expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true);
    expect(sourceFaceExpressionGeometry(source, 'skin')!.geometry).toBe(result.geometry);
    source.dispose(); result.geometry.dispose();
  });

  it('shares buffers, preserves existing controls, isolates instances and restores zero pose', () => {
    const source = geometry();
    const originalMorph = new Float32BufferAttribute(new Float32Array(4182 * 3), 3); originalMorph.name = 'Female';
    source.morphAttributes.position = [originalMorph];
    const material = new MeshStandardMaterial(); material.name = 'Skin_Head.001';
    const head = new Bone(); head.name = 'head';
    const skeleton = new Skeleton([head]);
    const first = new SkinnedMesh(source, material), second = new SkinnedMesh(source, material);
    first.bind(skeleton); second.bind(skeleton); first.morphTargetInfluences![0] = .37;
    const a = attachSourceFaceExpressions(first, '/assets/office-classic.glb')!, b = attachSourceFaceExpressions(second, '/assets/office-classic.glb')!;
    expect(a.geometry).toBe(b.geometry);
    expect(a.targets).toEqual([1, 2, 3, 4, 5]);
    expect(first.morphTargetInfluences![0]).toBe(.37);
    expect(first.morphTargetDictionary!.Female).toBe(0);
    const pose = createFacialPose(); pose.blink = 1; pose.yawn = .8; pose.brow = .6; pose.gazeX = 1;
    writeSourceFaceExpressions([a], pose);
    expect(first.morphTargetInfluences!.slice(1)).toEqual([1, .8, .6, 0, 0]);
    expect(second.morphTargetInfluences!.slice(1)).toEqual([0, 0, 0, 0, 0]);
    writeSourceFaceExpressions([a], createFacialPose());
    expect(first.morphTargetInfluences!.slice(1)).toEqual([0, 0, 0, 0, 0]);
    Object.assign(pose, { blink: NaN, yawn: Infinity, mouthOpen: NaN, brow: NaN, gazeX: Infinity, gazeY: NaN });
    writeSourceFaceExpressions([a], pose);
    expect(first.morphTargetInfluences!.every(Number.isFinite)).toBe(true);
    // Reduced motion is sampled by the shared driver and also resets an already active face.
    writeFacialPose(pose, 17, 200, 'idle', true);
    writeSourceFaceExpressions([a], pose);
    expect(first.morphTargetInfluences![a.targets[0]!]).toBe(0);
    expect(first.morphTargetInfluences![a.targets[1]!]).toBe(0);
    expect(first.morphTargetInfluences![a.targets[3]!]).toBe(0);
    source.dispose(); a.geometry.dispose(); material.dispose(); skeleton.dispose();
  });

  it('fails closed for unknown assets, other anatomy, malformed coordinates and unsupported topology', () => {
    const source = geometry(), material = new MeshStandardMaterial(); material.name = 'Skin_Head.001';
    const head = new Bone(); head.name = 'head'; const skeleton = new Skeleton([head]);
    const mesh = new SkinnedMesh(source, material); mesh.bind(skeleton);
    expect(attachSourceFaceExpressions(mesh, '/assets/custom.glb')).toBeUndefined();
    expect(mesh.geometry).toBe(source);
    material.name = 'OfficeHair';
    expect(attachSourceFaceExpressions(mesh, '/assets/office-classic.glb')).toBeUndefined();
    const malformed = geometry(); malformed.getAttribute('position').setX(0, NaN);
    expect(sourceFaceExpressionGeometry(malformed, 'skin')).toBeUndefined();
    const unknown = new BufferGeometry(); unknown.setAttribute('position', new Float32BufferAttribute([0, 1.7, .08], 3)); unknown.computeVertexNormals();
    expect(sourceFaceExpressionGeometry(unknown, 'skin')).toBeUndefined();
    source.dispose(); malformed.dispose(); unknown.dispose(); material.dispose(); skeleton.dispose();
  });
});
