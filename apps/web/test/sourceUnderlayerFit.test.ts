import { Bone, BufferGeometry, Float32BufferAttribute, Matrix4, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { sourceUnderlayerFit } from '../src/office/scene/avatars/sourceUnderlayerFit';

function native() {
  const centres = [[0, 1, .14], [0, .8, .14], [0, 1, -.14], [0, 1, .14], [0, 1, .14], [0, .6, .14]];
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(centres.flatMap(([x, y, z]) => [x! - .01, y!, z!, x! + .01, y!, z!, x!, y! + .02, z!]), 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(centres.flatMap(() => [0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(centres.flatMap(() => [0, 0, 1, 0, 0, 1]), 2));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(centres.flatMap(() => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(centres.flatMap(() => [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4));
  geometry.setIndex(Array.from({ length: centres.length * 3 }, (_, i) => i));
  const names = ['OfficeBottom_Trousers', 'OfficeBottom_Trousers', 'OfficeBottom_Trousers', 'OfficeShoes_Formal', 'Skin_Hand', 'OfficeBottom_Trousers'];
  names.forEach((_, i) => geometry.addGroup(i * 3, 3, i));
  const mesh = new SkinnedMesh(geometry, names.map(name => new MeshStandardMaterial({ name })));
  const hips = new Bone(); hips.name = 'hips'; mesh.bind(new Skeleton([hips])); mesh.name = 'ScanOutfit';
  return mesh;
}

function garment(name = 'OriginalTop_Shirt', opening = false) {
  const rectangles = opening ? [[-.2, -.03], [.03, .2]] : [[-.2, .2]];
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(rectangles.flatMap(([left, right]) => [left!, .9, .1, right!, .9, .1, right!, 1.1, .1, left!, .9, .1, right!, 1.1, .1, left!, 1.1, .1]), 3));
  const material = new MeshStandardMaterial({ name, transparent: true, opacity: .4 });
  const mesh = new SkinnedMesh(geometry, material); mesh.name = 'WardrobePieceTop';
  return mesh;
}

describe('native trousers behind original upper garments', () => {
  it('keeps the lower seat contour outside source skin when a thigh bends for sitting', () => {
    const mesh = native(), layer = garment(), body = garment('Skin_Body');
    const hips = new Bone(); hips.name = 'hips';
    const thigh = new Bone(); thigh.name = 'leftUpperLeg'; thigh.position.y = .8; hips.add(thigh);
    hips.updateMatrixWorld(true); mesh.bind(new Skeleton([hips, thigh]));
    for (let vertex = 0; vertex < 3; vertex++) {
      mesh.geometry.getAttribute('position').setY(vertex, .90 + vertex * .005);
      mesh.geometry.getAttribute('skinIndex').setX(vertex, 1);
    }
    const referenceHip = new Bone(); referenceHip.name = 'hips'; body.bind(new Skeleton([referenceHip]));
    const count = body.geometry.getAttribute('position').count;
    body.geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Array(count * 4).fill(0), 4));
    body.geometry.setAttribute('skinWeight', new Float32BufferAttribute(Array.from({ length: count }, () => [1, 0, 0, 0]).flat(), 4));
    body.geometry.translate(0, 0, .025);
    const fitted = new SkinnedMesh(sourceUnderlayerFit(mesh, [layer, body]), mesh.material);
    fitted.bind(mesh.skeleton, mesh.bindMatrix);
    thigh.rotation.x = Math.PI / 2; hips.updateMatrixWorld(true); mesh.skeleton.update();
    const actual = fitted.getVertexPosition(2, new Vector3());
    expect(actual.y).toBeCloseTo(.91, 6);
    expect(actual.z).toBeCloseTo(.133, 6);
    expect(mesh.getVertexPosition(2, new Vector3()).distanceTo(actual)).toBeGreaterThan(.1);
    expect(mesh.geometry.getAttribute('skinIndex').getX(2)).toBe(1);
    expect(fitted.geometry.getAttribute('skinIndex').getX(12)).toBe(mesh.geometry.getAttribute('skinIndex').getX(12));
  });
  it('matches exposed source-body hip binding so native trousers do not rotate through the seated waist', () => {
    const mesh = native(), layer = garment(), body = garment('Skin_Body');
    const hips = new Bone(); hips.name = 'hips';
    const thigh = new Bone(); thigh.name = 'leftUpperLeg'; hips.add(thigh);
    mesh.bind(new Skeleton([hips, thigh]));
    const joints = mesh.geometry.getAttribute('skinIndex');
    for (let vertex = 0; vertex < joints.count; vertex++) joints.setX(vertex, 1);
    const originalJoints = joints.array.slice();
    const referenceHip = new Bone(); referenceHip.name = 'hips'; body.bind(new Skeleton([referenceHip]));
    const count = body.geometry.getAttribute('position').count;
    body.geometry.setAttribute('skinIndex', new Uint16BufferAttribute(Array.from({ length: count }, () => [0, 0, 0, 0]).flat(), 4));
    body.geometry.setAttribute('skinWeight', new Float32BufferAttribute(Array.from({ length: count }, () => [1, 0, 0, 0]).flat(), 4));
    body.geometry.translate(0, 0, .025);
    const fit = sourceUnderlayerFit(mesh, [layer, body]);
    expect(fit.getAttribute('skinIndex').getX(2)).toBe(0);
    expect(fit.getAttribute('skinWeight').getX(2)).toBeCloseTo(1, 6);
    expect(fit.getAttribute('skinIndex').getX(3)).toBe(1);
    expect(fit.getAttribute('skinIndex').getX(12)).toBe(1);
    expect(joints.array).toEqual(originalJoints);
  });
  it('keeps native trousers outside actual body backing when an original hem lies inside it', () => {
    const mesh = native(), layer = garment();
    const body = garment('Skin_Body'); body.geometry.translate(0, 0, .025);
    const original = mesh.geometry.getAttribute('position').array.slice();
    const geometry = sourceUnderlayerFit(mesh, [layer, body]);
    expect(geometry.getAttribute('position').getZ(2)).toBeCloseTo(.133, 6);
    expect(mesh.geometry.getAttribute('position').array).toEqual(original);
    body.bindMatrix.makeTranslation(0, 0, .04);
    expect(sourceUnderlayerFit(mesh, [layer, body]).getAttribute('position').getZ(2)).toBeCloseTo(.173, 6);
  });
  it('does not mistake an arm-owned cuff beside the hip for waist coverage', () => {
    const mesh = native(), layer = garment();
    const arm = new Bone(); arm.name = 'leftLowerArm'; layer.bind(new Skeleton([arm]));
    const count = layer.geometry.getAttribute('position').count;
    layer.geometry.setAttribute('skinIndex', new Uint16BufferAttribute(Array.from({ length: count }, () => [0, 0, 0, 0]).flat(), 4));
    layer.geometry.setAttribute('skinWeight', new Float32BufferAttribute(Array.from({ length: count }, () => [1, 0, 0, 0]).flat(), 4));
    expect(sourceUnderlayerFit(mesh, [layer])).toBe(mesh.geometry);
    const torso = garment(), hips = new Bone(); hips.name = 'hips'; torso.bind(new Skeleton([hips]));
    torso.geometry.setAttribute('skinIndex', layer.geometry.getAttribute('skinIndex').clone());
    torso.geometry.setAttribute('skinWeight', layer.geometry.getAttribute('skinWeight').clone());
    expect(sourceUnderlayerFit(mesh, [torso]).getAttribute('position').getZ(2)).toBeCloseTo(.095, 6);
  });

  it('tucks only covered trousers; cropped/open areas, shoes and skin stay unchanged', () => {
    const mesh = native(), layer = garment(), source = mesh.geometry;
    const originalPositions = source.getAttribute('position').array.slice(), layerPositions = layer.geometry.getAttribute('position').array.slice();
    const geometry = sourceUnderlayerFit(mesh, [layer]), positions = geometry.getAttribute('position');
    expect(positions.getZ(2)).toBeCloseTo(.095, 6);
    for (let vertex = 3; vertex < 18; vertex++) {
      expect(positions.getX(vertex)).toBe(source.getAttribute('position').getX(vertex));
      expect(positions.getY(vertex)).toBe(source.getAttribute('position').getY(vertex));
      expect(positions.getZ(vertex)).toBe(source.getAttribute('position').getZ(vertex));
    }
    expect(source.getAttribute('position').array).toEqual(originalPositions);
    expect(layer.geometry.getAttribute('position').array).toEqual(layerPositions);
    expect((layer.material as MeshStandardMaterial).transparent).toBe(true);
    expect((layer.material as MeshStandardMaterial).opacity).toBe(.4);
    for (const attribute of ['uv', 'skinIndex', 'skinWeight']) expect(geometry.getAttribute(attribute).array).toEqual(source.getAttribute(attribute).array);
    expect(geometry.index?.array).toEqual(source.index?.array);
    expect(geometry.groups).toEqual(source.groups);
    for (let vertex = 9; vertex < 15; vertex++) expect(geometry.getAttribute('normal').getY(vertex)).toBe(1);
    expect(geometry.boundingBox).not.toBeNull(); expect(geometry.boundingSphere).not.toBeNull();
    expect(sourceUnderlayerFit(mesh, [layer])).toBe(geometry);
  });

  it('does not bridge an actual front opening or use failed/unloaded/ordinary fallback layers', () => {
    const mesh = native();
    expect(sourceUnderlayerFit(mesh, [])).toBe(mesh.geometry);
    expect(sourceUnderlayerFit(mesh, [garment('OfficeTop_Shirt')])).toBe(mesh.geometry);
    expect(sourceUnderlayerFit(mesh, [garment('OriginalBottom_Trousers')])).toBe(mesh.geometry);
    expect(sourceUnderlayerFit(mesh, [garment('OriginalOuter_OpenCoat', true)])).toBe(mesh.geometry);
    mesh.name = 'ScanOutfitModel';
    expect(sourceUnderlayerFit(mesh, [garment()])).toBe(mesh.geometry);
  });

  it('uses each mesh bind frame and bounds the radial shift to six centimetres', () => {
    const mesh = native(), layer = garment('OriginalOuter_Coat');
    mesh.bindMatrix.makeTranslation(0, 0, .04);
    layer.bindMatrix.makeTranslation(0, 0, .05);
    // Native bound radius .18, cloth radius .15: return to target local radius .105.
    const fitted = sourceUnderlayerFit(mesh, [layer]);
    expect(fitted.getAttribute('position').getZ(2)).toBeCloseTo(.105, 6);
    const larger = native();
    for (let vertex = 0; vertex < 3; vertex++) larger.geometry.getAttribute('position').setZ(vertex, .3);
    expect(sourceUnderlayerFit(larger, [garment()]).getAttribute('position').getZ(2)).toBeCloseTo(.24, 6);
  });

  it('covers the circular angle seam and keeps shared shoe/skin vertices protected', () => {
    const mesh = native(), layer = garment();
    mesh.geometry.applyMatrix4(new Matrix4().makeRotationY(Math.PI / 2));
    layer.bindMatrix.makeRotationY(Math.PI / 2);
    expect(sourceUnderlayerFit(mesh, [layer]).getAttribute('position').getX(2)).toBeCloseTo(.095, 6);
    const shared = native(); shared.geometry.addGroup(0, 3, 4);
    expect(sourceUnderlayerFit(shared, [garment()])).toBe(shared.geometry);
  });

  it('invalidates surface caches for different bind frames without editing either original', () => {
    const mesh = native(), layer = garment();
    const first = sourceUnderlayerFit(mesh, [layer]);
    layer.bindMatrix.makeTranslation(0, 0, .1);
    expect(sourceUnderlayerFit(mesh, [layer])).toBe(mesh.geometry);
    layer.bindMatrix.identity();
    expect(sourceUnderlayerFit(mesh, [layer])).toBe(first);
  });

  it('tucks native shirt, vest, accent and satin backing only behind actual original outer surfaces', () => {
    for (const name of ['OfficeTop_Shirt', 'OfficeOuter_Vest', 'OfficeAccent_Tie', 'OfficeLining_Satin']) {
      const mesh = native(), source = mesh.geometry, layer = garment('OriginalOuter_Jacket');
      (mesh.material as MeshStandardMaterial[])[0]!.name = name;
      for (let vertex = 0; vertex < 3; vertex++) source.getAttribute('position').setY(vertex, 1.4 + vertex * .01);
      layer.geometry.translate(0, .4, 0);
      expect(sourceUnderlayerFit(mesh, [garment('OriginalTop_Shirt')])).toBe(source);
      const fit = sourceUnderlayerFit(mesh, [layer]);
      expect(fit.getAttribute('position').getZ(2)).toBeCloseTo(.095, 6);
      expect(source.getAttribute('position').getZ(2)).toBeCloseTo(.14, 6);
      const open = garment('OriginalOuter_OpenJacket', true); open.geometry.translate(0, .4, 0);
      expect(sourceUnderlayerFit(mesh, [open])).toBe(source);
      expect(sourceUnderlayerFit(mesh, [])).toBe(source);
    }
  });
});
