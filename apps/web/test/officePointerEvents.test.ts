import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, OrthographicCamera, Raycaster, Vector2, Vector3 } from 'three';
import { isSceneObjectVisible, visibleCharacterRaycast, visibleSceneHits } from '../src/office/scene/officePointerEvents';

function pickVolume(id: string) {
  const mesh = new Mesh(new BoxGeometry(1.1, 1.5, 1.1), new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
  mesh.userData.characterId = id;
  return mesh;
}

/** Different floors can project to the exact same screen point in the Office camera. */
function stackedFloors() {
  const scene = new Group(), visibleFloor = new Group(), hiddenFloor = new Group();
  visibleFloor.position.y = 6.4;
  const visible = pickVolume('actor-visible'); visible.position.y = .7;
  visibleFloor.add(visible);
  // Offset along the viewing ray: this hidden upper-floor volume is nearer.
  hiddenFloor.position.set(3.2, 12.8, 9.6);
  const hidden = pickVolume('actor-hidden'); hidden.position.y = .7;
  hiddenFloor.add(hidden); hiddenFloor.visible = false;
  scene.add(visibleFloor, hiddenFloor); scene.updateMatrixWorld(true);
  const target = new Vector3(0, 7.1, 0);
  const camera = new OrthographicCamera(-6, 6, 6, -6, .1, 100);
  camera.position.copy(target).add(new Vector3(10, 20, 30)); camera.lookAt(target);
  camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  const raycaster = new Raycaster(); raycaster.setFromCamera(new Vector2(0, 0), camera);
  return { scene, visibleFloor, hiddenFloor, visible, hidden, raycaster };
}

const selectedId = (hits: ReturnType<Raycaster['intersectObject']>) => visibleSceneHits(hits)[0]?.object.userData.characterId;

describe('Office pointer visibility', () => {
  it('rejects a closer hidden-floor avatar that Three still raycasts, selecting the visible seated avatar', () => {
    const h = stackedFloors();
    const raw = h.raycaster.intersectObject(h.scene, true);
    expect(raw[0]?.object).toBe(h.hidden);
    expect(raw.some(hit => hit.object === h.visible)).toBe(true);
    expect(isSceneObjectVisible(h.hidden)).toBe(false);
    expect(selectedId(raw)).toBe('actor-visible');
  });

  it('checks all ancestors, including a hidden actor under otherwise visible floor groups', () => {
    const scene = new Group(), floor = new Group(), actor = new Group(), volume = pickVolume('actor');
    scene.add(floor); floor.add(actor); actor.add(volume);
    expect(isSceneObjectVisible(volume)).toBe(true);
    actor.visible = false;
    expect(volume.visible).toBe(true);
    expect(isSceneObjectVisible(volume)).toBe(false);
    actor.visible = true; scene.visible = false;
    expect(isSceneObjectVisible(volume)).toBe(false);
  });

  it('rejects hidden wardrobe geometry before it can intercept another visible body', () => {
    const scene = new Group(), body = pickVolume('visible-body'), unusedGarment = pickVolume('unused-garment');
    unusedGarment.position.z = 2; unusedGarment.visible = false;
    scene.add(body, unusedGarment); scene.updateMatrixWorld(true);
    const raw = new Raycaster(new Vector3(0, 0, 10), new Vector3(0, 0, -1)).intersectObject(scene, true);
    expect(raw[0]?.object).toBe(unusedGarment);
    expect(selectedId(raw)).toBe('visible-body');
  });

  it('keeps intentionally transparent pick volumes when their object hierarchy is shown', () => {
    const volume = pickVolume('transparent-pick'); volume.updateMatrixWorld(true);
    const raw = new Raycaster(new Vector3(0, 0, 10), new Vector3(0, 0, -1)).intersectObject(volume);
    expect(volume.material.opacity).toBe(0);
    expect(visibleSceneHits(raw)).toEqual(raw);
    expect(selectedId(raw)).toBe('transparent-pick');
  });

  it('uses current floor visibility without caching the previous hit identity', () => {
    const h = stackedFloors();
    expect(selectedId(h.raycaster.intersectObject(h.scene, true))).toBe('actor-visible');
    h.visibleFloor.visible = false; h.hiddenFloor.visible = true;
    expect(selectedId(h.raycaster.intersectObject(h.scene, true))).toBe('actor-hidden');
    h.visibleFloor.visible = true; h.hiddenFloor.visible = false;
    expect(selectedId(h.raycaster.intersectObject(h.scene, true))).toBe('actor-visible');
  });

  it('preserves visible hit ordering and per-instance metadata', () => {
    const instances = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 3);
    for (let i = 0; i < 3; i++) instances.setMatrixAt(i, new Matrix4().makeTranslation(0, 0, 2 - i * 2));
    instances.updateMatrixWorld(true);
    const raw = new Raycaster(new Vector3(0, 0, 10), new Vector3(0, 0, -1)).intersectObject(instances);
    expect(new Set(raw.map(hit => hit.instanceId))).toEqual(new Set([0, 1, 2]));
    const filtered = visibleSceneHits(raw);
    expect(filtered).toEqual(raw);
    for (let i = 0; i < raw.length; i++) expect(filtered[i]).toBe(raw[i]);
  });

  it('returns no targets when every hit belongs to a hidden hierarchy', () => {
    const h = stackedFloors(); h.visibleFloor.visible = false;
    const raw = h.raycaster.intersectObject(h.scene, true);
    expect(raw.length).toBeGreaterThan(0);
    expect(visibleSceneHits(raw)).toEqual([]);
    expect(visibleSceneHits([])).toEqual([]);
  });

  it('skips hidden character geometry before raycasting and refreshes correctly on a floor switch', () => {
    const h = stackedFloors();
    h.visibleFloor.raycast = visibleCharacterRaycast;
    h.hiddenFloor.raycast = visibleCharacterRaycast;
    const visibleCast = vi.spyOn(h.visible, 'raycast'), hiddenCast = vi.spyOn(h.hidden, 'raycast');
    expect(selectedId(h.raycaster.intersectObject(h.scene, true))).toBe('actor-visible');
    expect(visibleCast).toHaveBeenCalledOnce();
    expect(hiddenCast).not.toHaveBeenCalled();
    visibleCast.mockClear(); hiddenCast.mockClear();
    h.visibleFloor.visible = false; h.hiddenFloor.visible = true;
    expect(selectedId(h.raycaster.intersectObject(h.scene, true))).toBe('actor-hidden');
    expect(visibleCast).not.toHaveBeenCalled();
    expect(hiddenCast).toHaveBeenCalledOnce();
  });

  it('retains the final visibility filter for a directly registered transparent pick volume', () => {
    const h = stackedFloors();
    h.visibleFloor.raycast = visibleCharacterRaycast;
    h.hiddenFloor.raycast = visibleCharacterRaycast;
    // R3F can register the hover pick volume independently of its clickable group.
    const raw = h.raycaster.intersectObjects([h.scene, h.hidden], true);
    expect(raw[0]?.object).toBe(h.hidden);
    expect(selectedId(raw)).toBe('actor-visible');
  });
});
