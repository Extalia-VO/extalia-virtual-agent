import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { readModelMetadata, verifyPublicModels } from '../public-models.mjs';
import {
  PARKING_ACCESS, PARKING_GLB_TRIANGLES, PARKING_LOTS, accessSurfaceY, parkingLot,
} from '../../apps/web/src/office/scene/campusParkingLots';
import { PARKING_GLB_ROOTS, bakeParkingGeometry } from '../../apps/web/src/office/scene/CampusParking';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { Box3, Raycaster, Vector3 } = await import(webRequire.resolve('three'));
const { GLTFLoader } = await import(webRequire.resolve('three/examples/jsm/loaders/GLTFLoader.js'));
type Scene = Awaited<ReturnType<InstanceType<typeof GLTFLoader>['parseAsync']>>['scene'];

const root = new URL('../../', import.meta.url);
const glbFile = new URL('apps/web/public-assets/landscape/campus-parking.glb', root);
const runtime = JSON.parse(readFileSync(new URL('apps/web/src/office/scene/campusParkingLots.json', root), 'utf8'));
/** The west lot is drawn by the runtime's instanced slabs (a few hundred triangles); the authored GLB stays comparable. */
const TRIANGLE_BUDGET = 2500;

describe('Blender-authored campus parking (east lot and both access connectors)', () => {
  let scene: Scene;
  const down = (x: number, z: number) => new Raycaster(new Vector3(x, 10, z), new Vector3(0, -1, 0)).intersectObject(scene, true)[0];
  beforeAll(async () => {
    scene = (await new GLTFLoader().parseAsync(new Uint8Array(readFileSync(glbFile)).buffer, '')).scene;
    scene.updateWorldMatrix(true, true);
  });

  it('is a registered MIT, project-generated public model', () => {
    const entry = verifyPublicModels().find(model => model.path === 'landscape/campus-parking.glb');
    expect(entry).toMatchObject({ license: 'MIT', provenance: { kind: 'project-generated', generator: 'tooling/blender/create-campus-parking.py' } });
    expect(readModelMetadata(glbFile).asset.copyright).toMatch(/MIT/);
  });

  it('stays within the triangle budget recorded with the layout and draws as one merged batch', () => {
    let triangles = 0;
    scene.traverse((node: Scene) => {
      if ('geometry' in node) triangles += (node.geometry.index?.count ?? node.geometry.getAttribute('position').count) / 3;
    });
    expect(triangles).toBe(PARKING_GLB_TRIANGLES);
    expect(triangles).toBeLessThanOrEqual(TRIANGLE_BUDGET);
    for (const name of PARKING_GLB_ROOTS) expect(scene.getObjectByName(name), name).toBeTruthy();
    const merged = bakeParkingGeometry(scene)!;
    expect(merged.getAttribute('position').count / 3).toBe(triangles);
    expect(merged.getAttribute('color').count).toBe(merged.getAttribute('position').count);
    merged.dispose();
    expect(Object.keys(runtime.glb.groups).sort()).toEqual([...PARKING_GLB_ROOTS].sort());
  });

  it('draws each access along the published profile, from the throat down to the road edge, with no gap or step', () => {
    const { throat, roadEdge, z } = PARKING_ACCESS;
    for (const lot of PARKING_LOTS) {
      const side = Math.sign(lot.entry.throat[0]);
      expect(lot.entry.throat[0]).toBe(side * throat);
      expect(lot.entry.throat[1]).toBe(z);
      // Off the centre dashes; zebra and give-way paint sit at most 6 mm proud of the surface.
      for (let u = throat - 1; u <= roadEdge - .05; u += .25) {
        const hit = down(side * u, z - 1.15);
        expect(hit, `${lot.id} ${u}`).toBeTruthy();
        expect(hit!.point.y - accessSurfaceY(u), `${lot.id} at |x|=${u}`).toBeGreaterThanOrEqual(-1e-3);
        expect(hit!.point.y - accessSurfaceY(u), `${lot.id} at |x|=${u}`).toBeLessThan(.0075);
      }
      // The connector reaches the carriageway edge flush with the road top.
      const box = new Box3().setFromObject(scene.getObjectByName(`parking-access-${lot.id}`)!);
      expect(side > 0 ? box.max.x : -box.min.x).toBeCloseTo(roadEdge, 5);
    }
  });

  it('keeps the east aisle and bays flat and clear, with the surface at the lot top', () => {
    const lot = parkingLot('east');
    for (const [x, z] of lot.aisle.slice(1)) {
      const hit = down(x + .6, z);
      expect(hit!.point.y).toBeGreaterThanOrEqual(lot.top - 1e-3);
      expect(hit!.point.y).toBeLessThan(lot.top + .0075);
    }
    for (const bay of lot.bays) {
      const hit = down(bay.x, bay.z + .4);
      expect(hit!.point.y, bay.id).toBeGreaterThanOrEqual(lot.top - 1e-3);
      expect(hit!.point.y, bay.id).toBeLessThan(lot.top + .0075);
    }
  });

  it('publishes the runtime layout from the same Blender markers', () => {
    expect(runtime.lots.map((lot: { id: string }) => lot.id)).toEqual(PARKING_LOTS.map(lot => lot.id));
    expect(runtime.access).toEqual(PARKING_ACCESS);
    runtime.lots.forEach((lot: { bays: { id: string; x: number; z: number }[] }, index: number) =>
      expect(lot.bays.map(({ id, x, z }) => ({ id, x, z }))).toEqual(PARKING_LOTS[index]!.bays.map(({ id, x, z }) => ({ id, x, z }))));
  });
});
