import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, type InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Object3D, Scene, SkinnedMesh, Vector3 } from 'three';
import { installFixedModelTransforms } from '../src/office/scene/fixedModelTransforms';
import { ModelBatchController } from '../src/office/scene/ModelInstanceBatches';

function source(count = 16) {
  const root = new Group(), geometry = new BoxGeometry(), material = new MeshStandardMaterial();
  for (let i = 0; i < count; i++) {
    const mesh = new Mesh(geometry, material); mesh.position.set(i, i % 3, i % 2); root.add(mesh);
  }
  return root;
}
function matricesEqual(a: Object3D, b: Object3D) {
  a.matrixWorld.elements.forEach((value, index) => expect(value).toBeCloseTo(b.matrixWorld.elements[index]!, 9));
  a.children.forEach((child, i) => matricesEqual(child, b.children[i]!));
}

describe('fixed authored clone transforms', () => {
  it('skips an unchanged clone without touching source assets or changing material emission', () => {
    const template = source(64), clone = template.clone(true), parent = new Group(); parent.add(clone);
    const originalMethod = template.updateMatrixWorld;
    const dispose = installFixedModelTransforms(clone);
    parent.updateMatrixWorld(true);
    const calls = clone.children.map(node => vi.spyOn(node, 'updateMatrixWorld'));
    const material = (clone.children[0] as Mesh).material as MeshStandardMaterial;
    material.emissiveIntensity = 4;
    for (let i = 0; i < 120; i++) parent.updateMatrixWorld(true);
    expect(calls.reduce((sum, call) => sum + call.mock.calls.length, 0)).toBe(0);
    expect(clone.userData.fixedModelTransformCache).toEqual({ nodes: 65, skippedFrames: 120, refreshes: 1 });
    expect(material.emissiveIntensity).toBe(4);
    expect(template.updateMatrixWorld).toBe(originalMethod); expect(template.userData.fixedModelTransformCache).toBeUndefined();
    expect(clone.children.every(node => node.matrixAutoUpdate && node.matrixWorldAutoUpdate)).toBe(true);
    dispose(); parent.updateMatrixWorld(true);
    expect(calls.reduce((sum, call) => sum + call.mock.calls.length, 0)).toBe(64);
    calls.forEach(call => call.mockRestore());
  });

  it('matches normal updates across parent/root motion, reparenting, manual root matrix and pre-draw queries', () => {
    const template = source(), clone = template.clone(true), reference = template.clone(true);
    const parent = new Group(), referenceParent = new Group(); parent.add(clone); referenceParent.add(reference);
    const dispose = installFixedModelTransforms(clone);
    const frame = () => { parent.updateMatrixWorld(true); referenceParent.updateMatrixWorld(true); matricesEqual(clone, reference); };
    frame();
    for (let i = 0; i < 12; i++) {
      parent.position.x = referenceParent.position.x = i;
      parent.rotation.y = referenceParent.rotation.y = i / 5;
      parent.scale.y = referenceParent.scale.y = 1 + i / 10;
      clone.position.z = reference.position.z = i / 3;
      clone.rotation.z = reference.rotation.z = i / 7;
      clone.scale.x = reference.scale.x = i % 2 ? -1 : 1;
      const query = clone.children[3]!.getWorldPosition(new Vector3());
      const expected = reference.children[3]!.getWorldPosition(new Vector3());
      query.toArray().forEach((value, j) => expect(value).toBeCloseTo(expected.toArray()[j]!, 9));
      frame();
    }
    const moved = new Group(), movedReference = new Group(); moved.position.z = movedReference.position.z = 9;
    parent.add(moved); referenceParent.add(movedReference); moved.add(clone); movedReference.add(reference); frame();
    clone.matrixAutoUpdate = reference.matrixAutoUpdate = false;
    clone.matrix.makeTranslation(5, 6, 7); reference.matrix.copy(clone.matrix); frame();
    clone.matrixWorldNeedsUpdate = reference.matrixWorldNeedsUpdate = true; frame();
    dispose();
  });

  it('restores ordinary updates immediately on child mutation and supports setup/cleanup replay', () => {
    const root = source(), previous = { preserved: true }; root.userData.fixedModelTransformCache = previous;
    const first = installFixedModelTransforms(root); root.updateMatrixWorld(true); first(); first();
    expect(root.userData.fixedModelTransformCache).toBe(previous);
    const second = installFixedModelTransforms(root); root.updateMatrixWorld(true);
    const child = new Mesh(); child.position.x = 12; root.children[0]!.add(child);
    expect(root.updateMatrixWorld).toBe(Object3D.prototype.updateMatrixWorld);
    expect(root.userData.fixedModelTransformCache).toBe(previous);
    root.updateMatrixWorld(true); expect(child.matrixWorld.elements[12]).toBe(12); second();
    const third = installFixedModelTransforms(root); root.remove(root.children.at(-1)!);
    expect(root.updateMatrixWorld).toBe(Object3D.prototype.updateMatrixWorld); third();
  });

  it('keeps source matrices current for instancing after an animated outer parent moves', () => {
    const scene = new Scene(), parent = new Group(); parent.userData.interiorAuthored = true; scene.add(parent);
    const clone = source(); parent.add(clone);
    const restore = installFixedModelTransforms(clone), batches = new ModelBatchController(scene);
    scene.updateMatrixWorld(true); batches.update(0);
    parent.position.set(9, 2, 7); parent.rotation.y = 0.3;
    scene.updateMatrixWorld(true); batches.update(16);
    const batch = scene.children.find(node => node.name === 'loaded-model-instance-batch') as InstancedMesh;
    const actual = batch.getMatrixAt(5, new Matrix4());
    actual.elements.forEach((value, i) => expect(value).toBeCloseTo(clone.children[5]!.matrixWorld.elements[i]!, 5));
    restore(); batches.dispose(); expect(clone.children.every(node => node.visible)).toBe(true);
  });

  it('does not intercept tiny, animated, manually managed or custom-update clones', () => {
    const cases = [source(7), source(), source(), source(), source()];
    cases[1]!.add(new SkinnedMesh());
    cases[2]!.children[0]!.updateMatrixWorld = () => {};
    cases[3]!.children[0]!.userData.officeDynamic = true;
    cases[4]!.children[0]!.matrixWorldAutoUpdate = false;
    for (const root of cases) {
      const original = root.updateMatrixWorld, restore = installFixedModelTransforms(root);
      expect(root.updateMatrixWorld).toBe(original); expect(root.userData.fixedModelTransformCache).toBeUndefined(); restore();
    }
  });
});
