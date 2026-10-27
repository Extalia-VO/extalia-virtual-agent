import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { bakeFloorPanelGeometry } from '../../apps/web/src/office/scene/interior/floorPanelModel';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Raycaster, Vector3 } = await import(webRequire.resolve('three'));
const { GLTFLoader } = await import(webRequire.resolve('three/examples/jsm/loaders/GLTFLoader.js'));
type Scene = Awaited<ReturnType<InstanceType<typeof GLTFLoader>['parseAsync']>>['scene'];
const file = new URL('../../apps/web/local-assets/floors/floor-panel.glb', import.meta.url);

describe('optional floor panel geometry contract', () => {
  it('bakes world transforms, centres geometry and leaves the imported scene untouched', () => {
    const scene = new Group(), mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    mesh.position.y = -.5;
    scene.add(mesh);
    const baked = bakeFloorPanelGeometry(scene)!;
    expect(baked).not.toBeNull();
    expect(baked.boundingBox!.min.toArray()).toEqual([-.5, -.5, -.5]);
    expect(baked.boundingBox!.max.toArray()).toEqual([.5, .5, .5]);
    expect(mesh.position.y).toBe(-.5);
    expect(mesh.geometry).not.toBe(baked);
    baked.dispose(); mesh.geometry.dispose(); mesh.material.dispose();
  });

  it('rejects malformed bounds or multiple meshes so the procedural fallback stays available', () => {
    const scene = new Group(), geometry = new BoxGeometry(1, 1, 1), material = new MeshStandardMaterial();
    const mesh = new Mesh(geometry, material);
    scene.add(mesh);
    expect(bakeFloorPanelGeometry(scene)).toBeNull();
    mesh.position.y = -.5;
    scene.add(new Mesh(geometry, material));
    expect(bakeFloorPanelGeometry(scene)).toBeNull();
    geometry.dispose(); material.dispose();
  });
});

describe.skipIf(!existsSync(file))('actual Blender floor panel export', () => {
  let scene: Scene;
  beforeAll(async () => {
    scene = (await new GLTFLoader().parseAsync(new Uint8Array(readFileSync(file)).buffer, '')).scene;
    scene.updateWorldMatrix(true, true);
  });

  it('has one closed 12-triangle panel with its authored top at zero and bottom at minus one', () => {
    const meshes: InstanceType<typeof Mesh>[] = [];
    scene.traverse(node => { if ((node as InstanceType<typeof Mesh>).isMesh) meshes.push(node as InstanceType<typeof Mesh>); });
    expect(meshes).toHaveLength(1);
    const bounds = new Box3().setFromObject(scene);
    expect(bounds.min.toArray()).toEqual([-.5, -1, -.5]);
    expect(bounds.max.toArray()).toEqual([.5, 0, .5]);
    const geometry = meshes[0]!.geometry;
    expect(geometry.index!.count).toBe(36);
    const manifest = JSON.parse(readFileSync(new URL('../../apps/web/local-assets/floors/floor-panel.manifest.json', import.meta.url), 'utf8'));
    expect(manifest.topContactY).toBe(0);
    expect(manifest.closed).toBe(true);
    expect(existsSync(new URL('../../apps/web/local-assets/floors/floor-panel.blend', import.meta.url))).toBe(true);
  });

  it('keeps the top outward facing and maps its UVs to the floor plane', () => {
    const hit = new Raycaster(new Vector3(.23, 1, -.17), new Vector3(0, -1, 0)).intersectObject(scene)[0];
    expect(hit).toBeDefined();
    expect(hit!.point.y).toBeCloseTo(0, 6);
    expect(hit!.face!.normal.y).toBeCloseTo(1, 6);
    expect(hit!.uv!.x).toBeCloseTo(.73, 6);
    expect(hit!.uv!.y).toBeCloseTo(.67, 6);
    const below = new Raycaster(new Vector3(0, -2, 0), new Vector3(0, 1, 0)).intersectObject(scene)[0];
    expect(below!.point.y).toBeCloseTo(-1, 6);
    expect(below!.face!.normal.y).toBeCloseTo(-1, 6);
  });

  it('loads the same centred unit box used by renderer scaling without importing its materials', () => {
    const geometry = bakeFloorPanelGeometry(scene)!;
    expect(geometry).not.toBeNull();
    expect(geometry.boundingBox!.min.toArray()).toEqual([-.5, -.5, -.5]);
    expect(geometry.boundingBox!.max.toArray()).toEqual([.5, .5, .5]);
    expect(geometry.groups).toHaveLength(0);
    geometry.dispose();
  });
});
