import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, type InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Scene } from 'three';
import { installModelInstanceBatches, ModelBatchController } from '../src/office/scene/ModelInstanceBatches';

function fixture(count = 4) {
  const scene = new Scene(), geometry = new BoxGeometry(1, 1, 1), material = new MeshStandardMaterial();
  const parents: Group[] = [], sources: Mesh[] = [];
  for (let i = 0; i < count; i++) {
    const parent = new Group(); parent.userData.interiorAuthored = true;
    parent.position.set(i * 2, i * 3, i * -4); parent.rotation.y = i * .3;
    const mesh = new Mesh(geometry, material); mesh.position.set(.2, .4, .8);
    mesh.castShadow = true; parent.add(mesh); scene.add(parent);
    parents.push(parent); sources.push(mesh);
  }
  const controller = new ModelBatchController(scene);
  const update = (now = 0) => { scene.updateMatrixWorld(true); controller.update(now); };
  const batches = () => scene.children.filter(o => (o as InstancedMesh).isInstancedMesh) as InstancedMesh[];
  return { scene, geometry, material, parents, sources, controller, update, batches };
}
const matrixAt = (mesh: InstancedMesh, index: number) => { const matrix = new Matrix4(); mesh.getMatrixAt(index, matrix); return matrix; };
function expectMatrix(actual: Matrix4, expected: Matrix4) {
  actual.elements.forEach((value, i) => expect(value).toBeCloseTo(expected.elements[i]!, 5));
}

describe('loaded model shared-geometry instancing', () => {
  it('reduces repeated opaque loaded parts to one draw using exact current world matrices', () => {
    const h = fixture(); h.update();
    expect(h.batches()).toHaveLength(1);
    const batch = h.batches()[0]!;
    expect(batch.geometry).toBe(h.geometry); expect(batch.material).toBe(h.material);
    expect(batch.castShadow).toBe(true); expect(batch.frustumCulled).toBe(false);
    h.sources.forEach((source, i) => {
      expect(source.visible).toBe(false); expect(source.userData.officeBatchSource).toBe(true);
      expectMatrix(matrixAt(batch, i), source.matrixWorld);
    });
    h.parents[1]!.position.z = 17; h.update(16);
    expect(h.batches()[0]).toBe(batch);
    expectMatrix(matrixAt(batch, 1), h.sources[1]!.matrixWorld);
    expect(h.scene.userData.modelInstanceBatchStats).toEqual({ batches: 1, sources: 4, visibleInstances: 4 });
    h.controller.dispose();
  });

  it('tracks hidden floors and explicit source visibility without showing the hidden originals', () => {
    const h = fixture(); h.parents[2]!.visible = false; h.update();
    const batch = h.batches()[0]!;
    expect(matrixAt(batch, 2).determinant()).toBe(0);
    h.parents[2]!.visible = true; h.sources[1]!.visible = false; h.update(16);
    expectMatrix(matrixAt(batch, 2), h.sources[2]!.matrixWorld);
    expect(matrixAt(batch, 1).determinant()).toBe(0);
    h.sources[1]!.visible = true; expect(h.sources[1]!.visible).toBe(true); h.update(32);
    expect(matrixAt(batch, 1).determinant()).toBe(0);
    h.update(600); expect(h.sources[1]!.visible).toBe(false);
    h.sources[1]!.visible = false; h.controller.dispose();
    expect(h.sources[1]!.visible).toBe(false);
    expect(h.sources[0]!.visible).toBe(true);
    expect(Object.getOwnPropertyDescriptor(h.sources[0]!, 'visible')?.get).toBeUndefined();
  });

  it('zeros disconnected sources immediately and restores sources/resources when a bucket falls below its threshold', () => {
    const h = fixture(2); h.update();
    const batch = h.batches()[0]!, dispose = vi.spyOn(batch, 'dispose');
    const geometryDispose = vi.spyOn(h.geometry, 'dispose'), materialDispose = vi.spyOn(h.material, 'dispose');
    h.scene.remove(h.parents[1]!); h.update(16);
    expect(matrixAt(batch, 1).determinant()).toBe(0);
    h.update(600);
    expect(h.batches()).toHaveLength(0); expect(dispose).toHaveBeenCalledOnce();
    h.sources.forEach(mesh => { expect(mesh.visible).toBe(true); expect(mesh.userData.officeBatchSource).toBeUndefined(); });
    expect(geometryDispose).not.toHaveBeenCalled(); expect(materialDispose).not.toHaveBeenCalled();
    h.controller.dispose();
  });

  it('reconciles asynchronously replaced model instances without leaving stale geometry visible', () => {
    const h = fixture(3); h.update(); const previous = h.batches()[0]!;
    const replacement = h.sources[0]!.clone(); h.parents[0]!.remove(h.sources[0]!); h.parents[0]!.add(replacement);
    // clone reads the deliberately hidden source; a newly loaded clone normally
    // starts visible, so restore that intended state for this replacement.
    replacement.visible = true; delete replacement.userData.officeBatchSource;
    h.update(20); expect(matrixAt(previous, 0).determinant()).toBe(0);
    h.update(600); expect(h.batches()).toHaveLength(1); expect(h.batches()[0]).not.toBe(previous);
    expect(h.sources[0]!.visible).toBe(true); expect(replacement.visible).toBe(false);
    expect(h.scene.children).not.toContain(previous);
    h.controller.dispose(); expect(replacement.visible).toBe(true);
  });

  it('keeps unique emissions, transparency, custom callbacks, mirrored and procedural objects separate', () => {
    const h = fixture(12);
    h.sources[0]!.material = new MeshStandardMaterial();
    h.sources[1]!.material = new MeshStandardMaterial({ transparent: true, opacity: .5 });
    h.sources[2]!.onBeforeRender = () => {};
    h.parents[3]!.scale.x = -1;
    h.parents[4]!.userData.interiorAuthored = false;
    h.sources[5]!.material = [h.material];
    h.sources[6]!.layers.set(1);
    h.sources[7]!.receiveShadow = true;
    h.sources[8]!.renderOrder = 3;
    h.update();
    expect(h.batches()).toHaveLength(1); expect(h.batches()[0]!.count).toBe(3);
    for (let i = 0; i < 9; i++) expect(h.sources[i]!.visible).toBe(true);
    h.controller.dispose();
  });

  it('returns a material-swapped source to normal rendering immediately while zeroing its stale instance', () => {
    const h = fixture(); h.update(); const batch = h.batches()[0]!;
    h.sources[0]!.material = new MeshStandardMaterial({ color: '#338877' });
    h.update(16);
    expect(h.sources[0]!.visible).toBe(true);
    expect(h.sources[0]!.userData.officeBatchSource).toBeUndefined();
    expect(matrixAt(batch, 0).determinant()).toBe(0);
    // If the shared material returns before the scan, retain normal rendering
    // until the grouping pass can safely take ownership again.
    h.sources[0]!.material = h.material; h.update(32);
    expect(h.sources[0]!.visible).toBe(true); expect(matrixAt(batch, 0).determinant()).toBe(0);
    h.update(600); expect(h.sources[0]!.visible).toBe(false);
    expect(h.batches()).toHaveLength(1);
    h.controller.dispose(); expect(h.sources[0]!.visible).toBe(true);
  });

  it('keeps hidden templates and mesh parents out of batches so children and collision remain unchanged', () => {
    const h = fixture(5);
    h.sources[0]!.visible = false;
    const child = new Mesh(h.geometry, h.material); child.castShadow = true; h.sources[1]!.add(child);
    h.update();
    expect(h.sources[0]!.userData.officeBatchSource).toBeUndefined();
    expect(h.sources[0]!.visible).toBe(false);
    expect(h.sources[1]!.visible).toBe(true);
    expect(h.sources[1]!.userData.officeBatchSource).toBeUndefined();
    expect(child.visible).toBe(false);
    expect(h.batches()).toHaveLength(1);
    h.controller.dispose(); expect(child.visible).toBe(true);
  });

  it('keeps unchanged buckets between scans and preserves prior collision flags on cleanup', () => {
    const h = fixture(); h.sources[0]!.userData.officeBatchSource = false; h.update();
    const batch = h.batches()[0]!; h.update(600); expect(h.batches()[0]).toBe(batch);
    h.controller.dispose(); h.controller.dispose();
    expect(h.sources[0]!.userData.officeBatchSource).toBe(false);
    expect(h.batches()).toHaveLength(0);
    h.update(1200); expect(h.batches()).toHaveLength(0);
  });

  it('keeps static instance buffers clean and rechecks transform handedness only after movement', () => {
    const h = fixture(); h.update(); const batch = h.batches()[0]!;
    const version = batch.instanceMatrix.version;
    const determinant = vi.spyOn(h.sources[0]!.matrixWorld, 'determinant');
    h.update(16); h.update(32);
    expect(batch.instanceMatrix.version).toBe(version);
    expect(determinant).not.toHaveBeenCalled();
    h.parents[0]!.position.x += .25; h.update(48);
    expect(determinant).toHaveBeenCalledOnce();
    expect(batch.instanceMatrix.version).toBe(version + 1);
    expectMatrix(matrixAt(batch, 0), h.sources[0]!.matrixWorld);
    h.parents[0]!.scale.x = -1; h.update(64);
    expect(h.sources[0]!.visible).toBe(true);
    expect(h.sources[0]!.userData.officeBatchSource).toBeUndefined();
    expect(matrixAt(batch, 0).determinant()).toBe(0);
    h.controller.dispose();
  });

  it('skips drawing wholly hidden batches and restores a floor without rebuilding or uploading unchanged matrices', () => {
    const h = fixture(); const floor = new Group(); h.scene.add(floor);
    h.parents.forEach(parent => floor.add(parent)); floor.visible = false; h.update();
    const batch = h.batches()[0]!;
    expect(batch.visible).toBe(false); const version = batch.instanceMatrix.version;
    h.update(16); expect(batch.instanceMatrix.version).toBe(version);
    floor.visible = true; h.update(32);
    expect(h.batches()[0]).toBe(batch); expect(batch.visible).toBe(true);
    expect(batch.instanceMatrix.version).toBe(version + 1);
    h.update(48); expect(batch.instanceMatrix.version).toBe(version + 1);
    h.sources.forEach((source, index) => expectMatrix(matrixAt(batch, index), source.matrixWorld));
    h.controller.dispose();
  });

  it('batches explicitly loaded pod and static-chair pairs while leaving unmarked procedural backups alone', () => {
    for (const mode of ['pod', 'chair'] as const) {
      const h = fixture(2);
      h.parents.forEach((parent, index) => {
        parent.userData.interiorAuthored = false;
        parent.userData.officeSeat = true;
        if (mode === 'pod') parent.userData.teamPodAuthored = true;
        else h.sources[index]!.userData.officeInstanceable = true;
      });
      const backupParent = new Group(), backup = new Mesh(h.geometry, h.material);
      backup.castShadow = true; backupParent.userData.teamPodAuthored = false;
      backupParent.userData.officeSeat = true; backupParent.add(backup); h.scene.add(backupParent);
      h.update();
      expect(h.batches()).toHaveLength(1); expect(h.batches()[0]!.count).toBe(2);
      expect(backup.visible).toBe(true); expect(backup.userData.officeBatchSource).toBeUndefined();
      h.parents.forEach(parent => expect(parent.userData.officeSeat).toBe(true));
      // A replacement with different geometry renders normally immediately,
      // then the lone remaining shared source is released by the next scan.
      const previous = h.batches()[0]!;
      h.sources[0]!.geometry = new BoxGeometry(2, 1, 1); h.update(16);
      expect(h.sources[0]!.visible).toBe(true);
      expect(matrixAt(previous, 0).determinant()).toBe(0);
      h.update(600); expect(h.batches()).toHaveLength(0);
      h.controller.dispose();
      h.sources[0]!.geometry.dispose();
    }
  });

  it('chains the existing scene callback and restores only its own installed hook', () => {
    const h = fixture(); const before = vi.fn(); h.scene.onBeforeRender = before;
    const stop = installModelInstanceBatches(h.scene, () => 0);
    h.scene.updateMatrixWorld(true);
    h.scene.onBeforeRender(null!, h.scene, null!, null!, null!, null!);
    expect(before).toHaveBeenCalledOnce(); expect(h.batches()).toHaveLength(1);
    stop(); expect(h.scene.onBeforeRender).toBe(before); expect(h.batches()).toHaveLength(0);
    const stopAgain = installModelInstanceBatches(h.scene); const later = vi.fn(); h.scene.onBeforeRender = later;
    stopAgain(); expect(h.scene.onBeforeRender).toBe(later);
    h.controller.dispose();
  });
});
