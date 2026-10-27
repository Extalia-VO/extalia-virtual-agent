import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { INTERIOR_MODELS } from '../../apps/web/src/office/scene/interior/InteriorPart';
import PROFILE from '../../apps/web/src/office/scene/interior/interiorAssetProfile.json';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { Box3, Raycaster, Vector3 } = await import(webRequire.resolve('three'));
const { GLTFLoader } = await import(webRequire.resolve('three/examples/jsm/loaders/GLTFLoader.js'));
type Scene = Awaited<ReturnType<InstanceType<typeof GLTFLoader>['parseAsync']>>['scene'];
const localFile = new URL('../../apps/web/local-assets/furniture/interior-library.glb', import.meta.url);
const manifestFile = new URL('../../apps/web/local-assets/furniture/interior-library.manifest.json', import.meta.url);

describe.skipIf(!existsSync(localFile))('actual local Blender interior library', () => {
  let scene: Scene;
  const asset = (name: string) => {
    const root = scene.getObjectByName(name);
    if (!root) throw new Error(`Missing interior asset ${name}`);
    return root;
  };
  const bounds = (name: string) => new Box3().setFromObject(asset(name));
  const ray = (name: string, origin: [number, number, number], direction: [number, number, number]) =>
    new Raycaster(new Vector3(...origin), new Vector3(...direction)).intersectObject(asset(name), true);

  beforeAll(async () => {
    scene = (await new GLTFLoader().parseAsync(new Uint8Array(readFileSync(localFile)).buffer, '')).scene;
    scene.updateWorldMatrix(true, true);
  });

  it('exports every runtime model at its contract origin and matches measured manifest bounds', () => {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    expect(Object.keys(manifest.groups).sort()).toEqual([...INTERIOR_MODELS].sort());
    let triangles = 0;
    for (const name of INTERIOR_MODELS) {
      const root = asset(name), box = bounds(name), expected = manifest.groups[name];
      expect(root.position.length(), name).toBeLessThan(1e-6);
      expect(root.scale.toArray(), name).toEqual([1, 1, 1]);
      let partTriangles = 0;
      root.traverse((node: Scene) => {
        if ('geometry' in node) partTriangles += (node.geometry.index?.count ?? node.geometry.getAttribute('position').count) / 3;
      });
      expect(partTriangles, name).toBe(expected.triangles);
      triangles += partTriangles;
      for (const [i, axis] of ['x', 'y', 'z'].entries()) {
        expect(box.min[axis], `${name} min ${axis}`).toBeCloseTo(expected.min[i], 5);
        expect(box.max[axis], `${name} max ${axis}`).toBeCloseTo(expected.max[i], 5);
      }
    }
    expect(triangles).toBe(manifest.triangles);
    expect(triangles).toBeLessThanOrEqual(180_000);
    expect(bounds('bookshelf').getSize(new Vector3()).x).toBeCloseTo(PROFILE.bookshelf.width, 5);
    expect(bounds('bookshelf').getSize(new Vector3()).y).toBeCloseTo(PROFILE.bookshelf.height, 5);
  });

  it('retains real cushion, deck and exercise contact heights with separate articulated pivots', () => {
    const stool = ray('bar-stool-seat', [0, 1, 0], [0, -1, 0])[0];
    expect(stool?.point.y).toBeCloseTo(PROFILE.barStool.seatHeight - PROFILE.barStool.seatPivot[1]!, 5);
    expect(bounds('bar-stool-base').max.y).toBeLessThan(PROFILE.barStool.seatPivot[1]!);
    // The lumbar pad stays behind an avatar facing local +Z throughout swivel motion.
    expect(ray('bar-stool-seat', [0, .125, 1], [0, 0, -1])[0]?.point.z).toBeLessThan(-.1);
    expect(ray('treadmill-belt', [0, 1, .35], [0, -1, 0])[0]?.point.y).toBeCloseTo(PROFILE.treadmill.deckHeight, 5);
    expect(ray('treadmill-frame', [0, 1, .35], [0, -1, 0])[0]?.point.y).toBeLessThan(PROFILE.treadmill.deckHeight);
    expect(ray('bike-frame', [.08, 2, PROFILE.bike.seatZ], [0, -1, 0])[0]?.point.y).toBeCloseTo(PROFILE.bike.seatHeight, 2);
    expect(bounds('bike-frame').max.y).toBeCloseTo(PROFILE.bike.handlebarPosition[1]! + .029, 5);
    expect(bounds('bike-crank').getCenter(new Vector3()).length()).toBeLessThan(1e-6);
    expect(bounds('bike-pedal').getCenter(new Vector3()).x).toBeCloseTo(0, 6);
    for (const name of ['strength-bench', 'cable-seat'])
      expect(ray(name, [.1, 2, .1], [0, -1, 0])[0]?.point.y).toBeCloseTo(PROFILE.strengthBench.seatHeight, 5);
    expect(bounds('cable-seat').max.y).toBeLessThan(.6);
    expect(bounds('cable-handle').getSize(new Vector3()).x).toBeCloseTo(.55, 5);
  });

  it('leaves the live TV and arcade picture fronts unobstructed', () => {
    for (const x of [-1.35, 0, 1.35]) for (const y of [-.70, 0, .70])
      expect(ray('tv-housing', [x, y, PROFILE.tvHousing.screenFrontZ], [0, 0, 1])).toHaveLength(0);
    for (const panel of [
      { position: PROFILE.arcadeShell.screenPosition, size: PROFILE.arcadeShell.screenSize },
      { position: PROFILE.arcadeShell.marqueePosition, size: PROFILE.arcadeShell.marqueeSize },
    ]) for (const x of [-.4, 0, .4]) for (const y of [-.4, 0, .4])
      expect(ray('arcade-shell', [x * panel.size[0]!, panel.position[1]! + y * panel.size[1]!, panel.position[2]!], [0, 0, 1])).toHaveLength(0);
    expect(bounds('tv-housing').getCenter(new Vector3()).y).toBeCloseTo(0, 6);
  });

  it('exports visible server LEDs and reusable hospitality props without a glass front', () => {
    const materials = new Set<string>();
    asset('server-rack').traverse((node: Scene) => {
      if (!('material' in node)) return;
      const list = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of list) {
        materials.add(material.name);
        expect(material.transparent).toBe(false);
      }
    });
    expect([...materials]).toEqual(expect.arrayContaining(['Server LED green', 'Server LED cyan', 'Server LED amber']));
    expect(ray('server-rack', [.295, 1.09 - .76 + .035, 2], [0, 0, -1])[0]?.point.z).toBeGreaterThan(.73);
    expect(bounds('server-rack').min.y).toBeCloseTo(0, 6);
    expect(bounds('food-plate').min.y).toBeCloseTo(0, 6);
    expect(Math.abs(bounds('food-plate').getSize(new Vector3()).x - PROFILE.foodPlate.diameter)).toBeLessThan(.001);
    expect(bounds('drink-cup').min.y).toBeCloseTo(0, 6);
  });

  it('keeps the pendant shade compact around its mounting origin without a baked cord', () => {
    // Mounting drop belongs to the runtime cord, never to shade geometry scale.
    const pendant = bounds('pendant-light');
    expect(pendant.max.y).toBeCloseTo(PROFILE.pendantLight.socketTop, 6);
    expect(pendant.min.y).toBeCloseTo(PROFILE.pendantLight.diffuserBottom, 6);
    expect(pendant.getSize(new Vector3()).y).toBeCloseTo(.283, 6);
    expect(pendant.getSize(new Vector3()).x).toBeLessThan(.82);
  });
});
