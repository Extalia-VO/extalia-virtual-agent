import { describe, expect, it } from 'vitest';
import { Bone, BufferGeometry, Float32BufferAttribute, Group, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three';
import { sourceGarmentWeights } from '../src/office/scene/avatars/sourceGarmentWeights';

function fixture(joined = false) {
  const root = new Group(), hips = new Bone(), spine = new Bone();
  hips.name = 'hips'; spine.name = 'spine'; hips.add(spine); root.add(hips);
  const bones = [hips, spine];
  for (const side of ['left', 'right']) {
    const upper = new Bone(), lower = new Bone(), hand = new Bone();
    upper.name = `${side}UpperArm`; lower.name = `${side}LowerArm`; hand.name = `${side}Hand`;
    upper.position.set(side === 'left' ? -.2 : .2, 1.5, 0); lower.position.y = -.3; hand.position.y = -.25;
    root.add(upper); upper.add(lower); lower.add(hand); bones.push(upper, lower, hand);
  }
  root.updateMatrixWorld(true);
  const positions: number[] = [], joints: number[] = [], weights: number[] = [], indices: number[] = [];
  for (let side = 0; side < 2; side++) {
    const x = side ? .2 : -.2, base = positions.length / 3, upper = 2 + side * 3, lower = upper + 1, hand = upper + 2;
    for (const y of [1.5, 1.32, 1.12, .98]) for (const [dx, z] of [[-.035, -.035], [.035, -.035], [.035, .035], [-.035, .035]]) {
      positions.push(x + dx!, y, z!); joints.push(upper, lower, 0, 1);
      weights.push(...(y === 1.32 ? [.1, .9, 0, 0] : [1, 0, 0, 0]));
    }
    // A torso-painted vertex on the sleeve sits beside correctly arm-painted cloth.
    joints.splice((base + 8) * 4, 4, 0, 1, upper, lower); weights.splice((base + 8) * 4, 4, .9, .1, 0, 0);
    joints.splice((base + 12) * 4, 4, lower, hand, 0, 1); weights.splice((base + 12) * 4, 4, .8, .2, 0, 0);
    for (let row = 0; row < 3; row++) for (let corner = 0; corner < 4; corner++) {
      const a = base + row * 4 + corner, b = base + row * 4 + (corner + 1) % 4;
      const c = a + 4, d = b + 4; indices.push(a, c, b, b, c, d);
    }
  }
  // A duplicate UV-seam vertex must keep its sleeve component and get the same paint.
  const duplicate = positions.length / 3;
  positions.push(...positions.slice(8 * 3, 8 * 3 + 3)); joints.push(0, 1, 0, 0); weights.push(.9, .1, 0, 0);
  indices.push(duplicate, 9, 12);
  const collar = positions.length / 3;
  positions.push(-.03, 1.55, 0, .03, 1.55, 0, 0, 1.6, .03);
  for (let i = 0; i < 3; i++) { joints.push(0, 1, 0, 0); weights.push(.2, .8, 0, 0); }
  indices.push(collar, collar + 1, collar + 2);
  if (joined) indices.push(0, 16, collar);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(positions.map((_, i) => i % 3 === 2 ? 1 : 0), 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(Array(positions.length / 3 * 2).fill(.5), 2));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(joints, 4)); geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
  geometry.setIndex(indices); geometry.morphTargetsRelative = true;
  geometry.morphAttributes.position = [new Float32BufferAttribute(Array(positions.length).fill(.001), 3)];
  const material = new MeshStandardMaterial(); material.name = 'OfficeTop_Test';
  const mesh = new SkinnedMesh(geometry, material), skeleton = new Skeleton(bones); mesh.name = 'ScanOutfit_4'; root.add(mesh); mesh.bind(skeleton);
  const weightAt = (g: BufferGeometry, vertex: number, bone: number) => {
    let value = 0; for (let slot = 0; slot < 4; slot++) if (g.getAttribute('skinIndex').getComponent(vertex, slot) === bone) value += g.getAttribute('skinWeight').getComponent(vertex, slot); return value;
  };
  return { root, bones, geometry, mesh, skeleton, material, collar, duplicate, weightAt,
    dispose() { geometry.dispose(); material.dispose(); skeleton.dispose(); } };
}

describe('topology-scoped source sleeve binding', () => {
  it('binds disconnected sleeves to their own arm and keeps cap, cuffs and collar contacts', () => {
    const f = fixture();
    try {
      const corrected = sourceGarmentWeights(f.mesh)!;
      expect(corrected).toBeDefined(); expect(sourceGarmentWeights(f.mesh)).toBe(corrected);
      for (let side = 0; side < 2; side++) {
        const base = side * 16, upper = 2 + side * 3, lower = upper + 1, hand = upper + 2;
        expect(f.weightAt(corrected, base + 8, lower)).toBeCloseTo(1, 6);
        expect(f.weightAt(corrected, base + 4, upper)).toBeCloseTo(1, 6);
        expect(f.weightAt(corrected, base + 12, hand)).toBeCloseTo(.2, 6);
        for (let slot = 0; slot < 4; slot++) expect(corrected.getAttribute('skinWeight').getComponent(base, slot)).toBe(f.geometry.getAttribute('skinWeight').getComponent(base, slot));
      }
      expect(f.weightAt(corrected, f.duplicate, 3)).toBeCloseTo(1, 6);
      for (let slot = 0; slot < 4; slot++) expect(corrected.getAttribute('skinWeight').getComponent(f.collar, slot)).toBe(f.geometry.getAttribute('skinWeight').getComponent(f.collar, slot));
      for (let i = 0; i < corrected.getAttribute('skinWeight').count; i++) {
        const values = [0, 1, 2, 3].map(s => corrected.getAttribute('skinWeight').getComponent(i, s));
        expect(values.every(Number.isFinite)).toBe(true); expect(values.reduce((a, b) => a + b)).toBeCloseTo(1, 6);
      }
    } finally { f.dispose(); }
  });

  it('removes the stretched seam between a torso-painted sleeve point and its arm-painted neighbour', () => {
    const f = fixture();
    try {
      const corrected = sourceGarmentWeights(f.mesh)!;
      f.bones[2]!.rotation.x = -.7; f.bones[3]!.rotation.x = -1.2;
      f.root.updateMatrixWorld(true); f.skeleton.update();
      const edge = () => f.mesh.getVertexPosition(8, new Vector3()).distanceTo(f.mesh.getVertexPosition(9, new Vector3()));
      const before = edge(); f.mesh.geometry = corrected;
      expect(before).toBeGreaterThan(.2); expect(edge()).toBeLessThan(.08);
    } finally { f.dispose(); }
  });

  it('preserves source geometry and all attributes outside binding', () => {
    const f = fixture(), originalWeights = Array.from(f.geometry.getAttribute('skinWeight').array);
    try {
      const corrected = sourceGarmentWeights(f.mesh)!;
      expect(Array.from(f.geometry.getAttribute('skinWeight').array)).toEqual(originalWeights);
      for (const key of ['position', 'normal', 'uv']) expect(Array.from(corrected.getAttribute(key).array)).toEqual(Array.from(f.geometry.getAttribute(key).array));
      expect(Array.from(corrected.index!.array)).toEqual(Array.from(f.geometry.index!.array));
      expect(Array.from(corrected.morphAttributes.position![0]!.array)).toEqual(Array.from(f.geometry.morphAttributes.position![0]!.array));
    } finally { f.dispose(); }
  });

  it('leaves a joined sleeve/bodice topology and unrelated assets untouched', () => {
    const joined = fixture(true), f = fixture();
    try {
      expect(sourceGarmentWeights(joined.mesh)).toBeUndefined();
      joined.material.name = 'OfficeOuter_Test'; expect(sourceGarmentWeights(joined.mesh)).toBeUndefined();
      f.material.name = 'OfficeShoes_Test'; expect(sourceGarmentWeights(f.mesh)).toBeUndefined();
      f.material.name = 'OfficeTop_Test'; f.mesh.name = 'ScanOutfitCasual'; expect(sourceGarmentWeights(f.mesh)).toBeUndefined();
      f.mesh.name = 'Body'; expect(sourceGarmentWeights(f.mesh)).toBeUndefined();
    } finally { joined.dispose(); f.dispose(); }
  });

  it('keeps a sleeveless vest on the torso when the arms move', () => {
    const f = fixture(), geometry = new BufferGeometry(), material = new MeshStandardMaterial();
    try {
      const points = [1.15, 1.3, 1.45].flatMap(y => [[-.16, y, -.08], [.16, y, -.08], [.16, y, .08], [-.16, y, .08]]);
      geometry.setAttribute('position', new Float32BufferAttribute(points.flat(), 3));
      geometry.setAttribute('skinIndex', new Uint16BufferAttribute(points.flatMap(p => [p[0]! < 0 ? 2 : 5, 1, 0, 0]), 4));
      geometry.setAttribute('skinWeight', new Float32BufferAttribute(points.flatMap(() => [.8, .2, 0, 0]), 4));
      const indices = [];
      for (let row = 0; row < 2; row++) for (let corner = 0; corner < 4; corner++) {
        const a = row * 4 + corner, b = row * 4 + (corner + 1) % 4; indices.push(a, a + 4, b, b, a + 4, b + 4);
      }
      geometry.setIndex(indices); material.name = 'OfficeOuter_Test';
      const vest = new SkinnedMesh(geometry, material); vest.name = 'ScanOutfit_2'; f.root.add(vest); vest.bind(f.skeleton);
      const corrected = sourceGarmentWeights(vest)!; expect(corrected).toBeDefined(); vest.geometry = corrected;
      f.bones[2]!.rotation.x = -.8; f.bones[5]!.rotation.x = -.6; f.root.updateMatrixWorld(true); f.skeleton.update();
      for (let i = 0; i < points.length; i++) {
        expect(f.weightAt(corrected, i, 1)).toBeCloseTo(1, 6);
        expect(vest.getVertexPosition(i, new Vector3()).distanceTo(new Vector3(...points[i] as [number, number, number]))).toBeLessThan(1e-6);
      }
    } finally { geometry.dispose(); material.dispose(); f.dispose(); }
  });
});
