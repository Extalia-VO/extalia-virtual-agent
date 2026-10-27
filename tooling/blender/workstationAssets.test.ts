import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { Box3, Raycaster, Vector3 } = await import(webRequire.resolve('three'));
const { GLTFLoader } = await import(webRequire.resolve('three/examples/jsm/loaders/GLTFLoader.js'));
type Group = Awaited<ReturnType<InstanceType<typeof GLTFLoader>['parseAsync']>>['scene'];
type Object3D = Group;
import { WORKSTATION_ASSETS } from '../../apps/web/src/office/scene/interior/WorkstationPart';
import { MOUSE_DIMENSIONS } from '../../apps/web/src/office/scene/interior/deskLayout';
import { MONITOR, monitorPanelY } from '../../apps/web/src/office/scene/interior/prefabs/props/deviceGeometry';
import { keyboardKeys } from '../../apps/web/src/office/scene/interior/prefabs/props/Keyboard';
import PROFILE from '../../apps/web/src/office/scene/interior/workstationAssetProfile.json';

const localFile = new URL('../../apps/web/local-assets/furniture/workstation-set.glb', import.meta.url);
describe.skipIf(!existsSync(localFile))('actual local Blender workstation library', () => {
  let scene: Group;
  const asset = (name: string): Object3D => {
    const object = scene.getObjectByName(name);
    if (!object) throw new Error(`Missing asset ${name}`);
    return object;
  };
  beforeAll(async () => {
    const binary = new Uint8Array(readFileSync(localFile)).buffer;
    scene = (await new GLTFLoader().parseAsync(binary, '')).scene;
    scene.updateWorldMatrix(true,true);
  });

  it('exports all library roots at the origin and keeps display frames behind the live picture', () => {
    for (const name of WORKSTATION_ASSETS) {
      const root = asset(name);
      expect(root.position.length(), name).toBeLessThan(1e-6);
      expect(root.scale.toArray(), name).toEqual([1,1,1]);
    }
    const desk = new Box3().setFromObject(asset('single-desk'));
    expect(desk.max.y).toBeCloseTo(PROFILE.desk.top, 6);
    expect(desk.min.y).toBeCloseTo(0, 6);
    const shell = new Box3().setFromObject(asset('monitor-shell'));
    expect(shell.max.x-shell.min.x).toBeCloseTo(MONITOR.width+MONITOR.bezel, 6);
    expect(monitorPanelY(PROFILE.monitor.height)+shell.min.y).toBeCloseTo(MONITOR.clearance, 6);
    expect(shell.max.z).toBeLessThan(MONITOR.depth/2+.001);
    expect(new Box3().setFromObject(asset('laptop-lid')).max.z).toBeLessThan(.014+.01/2+.001);
  });

  it('places actual cap tops at the hand contact height, including the right-hand number pad', () => {
    for (const kind of ['compact','full'] as const) for (const key of keyboardKeys(kind)) {
      const hit = new Raycaster(new Vector3(key.x,.2,key.z),new Vector3(0,-1,0)).intersectObject(asset(`keyboard-${kind}`))[0];
      expect(hit, `${kind} key at ${key.x}:${key.z}`).toBeDefined();
      expect(hit!.point.y).toBeCloseTo(.027, 6);
    }
    const mouse = new Box3().setFromObject(asset('mouse'));
    expect(mouse.max.y-mouse.min.y).toBeCloseTo(MOUSE_DIMENSIONS.height, 6);
    expect(mouse.max.x-mouse.min.x).toBeCloseTo(MOUSE_DIMENSIONS.width, 6);
    expect(mouse.max.z-mouse.min.z).toBeCloseTo(MOUSE_DIMENSIONS.length, 6);
  });
});
