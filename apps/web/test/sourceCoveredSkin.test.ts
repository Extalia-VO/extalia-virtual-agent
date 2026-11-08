import { Bone, BoxGeometry, BufferGeometry, Float32BufferAttribute, Matrix4, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import { describe, expect, it } from 'vitest';
import { sourceCoveredSkin } from '../src/office/scene/avatars/sourceCoveredSkin';

function skin(centres = [[.1, .78, .16], [-.1, .78, -.16]], indexed = true) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(centres.flatMap(([x, y, z]) => [x! - .008, y!, z!, x! + .008, y!, z!, x!, y! + .012, z!]), 3));
  const count = centres.length * 3;
  geometry.setAttribute('uv', new Float32BufferAttribute(Array.from({ length: count }, (_, i) => [i % 2, i % 3]).flat(), 2));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Array(count * 4).fill(0), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(Array.from({ length: count }, () => [1, 0, 0, 0]).flat(), 4));
  geometry.morphTargetsRelative = true;
  geometry.morphAttributes.position = [new Float32BufferAttribute(Array.from({ length: count }, () => [0, .01, 0]).flat(), 3)];
  if (indexed) geometry.setIndex(Array.from({ length: count }, (_, i) => i));
  const mesh: SkinnedMesh = new SkinnedMesh(geometry, new MeshStandardMaterial({ name: 'Skin_Context' }));
  const hips = new Bone(); hips.name = 'hips'; hips.position.y = 1;
  const left = new Bone(); left.name = 'leftUpperLeg'; left.position.set(.1, -.05, 0);
  const right = new Bone(); right.name = 'rightUpperLeg'; right.position.set(-.1, -.05, 0);
  hips.add(left, right); hips.updateMatrixWorld(true);
  mesh.bind(new Skeleton([hips, left, right]), new Matrix4());
  return mesh;
}

function leg(x: number, low = .4, high = 1.12) {
  const geometry = new BoxGeometry(.18, high - low, .28); geometry.translate(x, (low + high) / 2, 0);
  geometry.clearGroups();
  return new SkinnedMesh(geometry, new MeshStandardMaterial({ name: 'OriginalBottom_Trousers' }));
}

function patches(rectangles: number[][], name = 'OriginalBottom_Trousers') {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(rectangles.flatMap(([left, right, low, high]) => [
    left!, low!, .14, right!, low!, .14, right!, high!, .14,
    left!, low!, .14, right!, high!, .14, left!, high!, .14,
  ]), 3));
  return new SkinnedMesh(geometry, new MeshStandardMaterial({ name }));
}

describe('selected trouser coverage of source skin', () => {
  it.each([true, false])('removes only covered upper-thigh/seat skin, preserving every source attribute (indexed %s)', indexed => {
    const mesh = skin([[.1, .78, .16], [-.1, .78, -.16], [.1, .32, .16], [0, 1.5, .16]], indexed);
    const source = mesh.geometry, before = source.clone();
    const fitted = sourceCoveredSkin(mesh, [leg(.1), leg(-.1)]);
    expect(fitted).not.toBe(source);
    expect(Array.from(fitted.index!.array)).toEqual([6, 7, 8, 9, 10, 11]);
    expect(fitted.groups).toEqual([{ start: 0, count: 6, materialIndex: 0 }]);
    expect(fitted.drawRange).toEqual({ start: 0, count: 6 });
    for (const attribute of ['position', 'uv', 'skinIndex', 'skinWeight']) {
      expect(fitted.getAttribute(attribute).array).toEqual(before.getAttribute(attribute).array);
      expect(source.getAttribute(attribute).array).toEqual(before.getAttribute(attribute).array);
    }
    expect(fitted.morphAttributes.position![0]!.array).toEqual(before.morphAttributes.position![0]!.array);
    expect(source.index?.array).toEqual(before.index?.array);
    expect(source.groups).toEqual(before.groups);
  });

  it('keeps exposed thighs below shorts and skin beyond the bounded overlap envelope', () => {
    const mesh = skin([[.1, .78, .16], [.1, .95, .16], [.1, .95, .20]]);
    const fitted = sourceCoveredSkin(mesh, [leg(.1, .88)]);
    expect(Array.from(fitted.index!.array)).toEqual([0, 1, 2, 6, 7, 8]);
  });

  it('keeps cloth, neckline and arm/hand skin even when they share a covered location', () => {
    const mesh = skin([[.1, .78, .16], [.1, .78, .16], [.1, .78, .16], [0, 1.5, .16]]);
    const source = mesh.geometry;
    const hand = new Bone(); hand.name = 'leftHand'; mesh.skeleton.bones.push(hand);
    for (let vertex = 6; vertex < 9; vertex++) source.getAttribute('skinIndex').setX(vertex, 3);
    mesh.material = [new MeshStandardMaterial({ name: 'Skin_Context' }), new MeshStandardMaterial({ name: 'OriginalBottom_Fabric' })];
    source.addGroup(0, 3, 0); source.addGroup(3, 3, 1); source.addGroup(6, 6, 0);
    const fitted = sourceCoveredSkin(mesh, [leg(.1)]);
    expect(Array.from(fitted.index!.array)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(fitted.groups).toEqual([{ start: 0, count: 3, materialIndex: 1 }, { start: 3, count: 6, materialIndex: 0 }]);
  });

  it('requires every corner, centroid and a seam margin; it never bridges an opening or a shorts hem', () => {
    const mesh = skin([[0, .94, .16]]), position = mesh.geometry.getAttribute('position');
    position.setXYZ(0, -.06, .92, .16); position.setXYZ(1, .06, .92, .16); position.setXYZ(2, 0, 1, .16);
    const disconnected = patches([[-.08, -.03, .89, .95], [.03, .08, .89, .95], [-.02, .02, .975, 1.025]]);
    expect(sourceCoveredSkin(mesh, [disconnected])).toBe(mesh.geometry);
    const nearHem = skin([[.1, .88, .16]]);
    expect(sourceCoveredSkin(nearHem, [leg(.1, .878)])).toBe(nearHem.geometry);
    const cornerOutside = skin([[.1, .88, .16]]);
    cornerOutside.geometry.getAttribute('position').setY(2, .85);
    expect(sourceCoveredSkin(cornerOutside, [leg(.1, .87)])).toBe(cornerOutside.geometry);
  });

  it('ignores skirts, transparent/cutout/invisible materials, failed layers and unknown bindings', () => {
    const mesh = skin();
    expect(sourceCoveredSkin(mesh, [])).toBe(mesh.geometry);
    for (const change of [
      (m: MeshStandardMaterial) => { m.name = 'OriginalBottom_Skirt'; },
      (m: MeshStandardMaterial) => { m.name = 'OriginalTop_Shirt'; },
      (m: MeshStandardMaterial) => { m.transparent = true; },
      (m: MeshStandardMaterial) => { m.opacity = .5; },
      (m: MeshStandardMaterial) => { m.alphaTest = .5; },
      (m: MeshStandardMaterial) => { m.visible = false; },
    ]) {
      const layer = leg(.1); change(layer.material as MeshStandardMaterial);
      expect(sourceCoveredSkin(mesh, [layer])).toBe(mesh.geometry);
    }
    mesh.skeleton.bones[0]!.name = 'unknown';
    expect(sourceCoveredSkin(mesh, [leg(.1)])).toBe(mesh.geometry);
  });

  it('does not mistake the opposite leg for clothing on exposed inner-thigh skin', () => {
    const mesh = skin([[.025, .78, 0]]);
    expect(sourceCoveredSkin(mesh, [leg(-.1)])).toBe(mesh.geometry);
  });

  it('uses bind frames and caches selected surface identities, not another look or instance', () => {
    const mesh = skin([[.1, .78, .16]]), layer = leg(.1), untouched = skin([[.1, .78, .16]]);
    const first = sourceCoveredSkin(mesh, [layer]);
    expect(first.index!.count).toBe(0);
    expect(sourceCoveredSkin(mesh, [layer])).toBe(first);
    layer.bindMatrix.makeTranslation(0, 0, .3);
    expect(sourceCoveredSkin(mesh, [layer])).toBe(mesh.geometry);
    // A different source bind frame also invalidates the previous cached result.
    mesh.bindMatrix.makeTranslation(0, 0, -.1);
    expect(sourceCoveredSkin(mesh, [layer])).toBe(mesh.geometry);
    mesh.bindMatrix.identity(); layer.bindMatrix.identity();
    expect(sourceCoveredSkin(mesh, [layer])).toBe(first);
    expect(sourceCoveredSkin(untouched, [])).toBe(untouched.geometry);
    expect(untouched.geometry.index!.count).toBe(3);
    const framedSkin = skin([[.1, .78, .16]]), framedLayer = leg(.1);
    framedSkin.geometry.translate(0, 0, -.04); framedSkin.bindMatrix.makeTranslation(0, 0, .04);
    framedLayer.geometry.translate(0, 0, -.08); framedLayer.bindMatrix.makeTranslation(0, 0, .08);
    expect(sourceCoveredSkin(framedSkin, [framedLayer]).index!.count).toBe(0);
  });
});
