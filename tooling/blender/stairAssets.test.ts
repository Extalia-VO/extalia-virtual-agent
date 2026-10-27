import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { STAIR_PART_NOMINAL, stairPartScale } from '../../apps/web/src/office/scene/prefabs/architecture/StairPart';
import { OFFICE_STAIRCASE } from '../../apps/web/src/office/scene/layout';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { Box3, Raycaster, Vector3 } = await import(webRequire.resolve('three'));
const { GLTFLoader } = await import(webRequire.resolve('three/examples/jsm/loaders/GLTFLoader.js'));
type Scene = Awaited<ReturnType<InstanceType<typeof GLTFLoader>['parseAsync']>>['scene'];
const localFile = new URL('../../apps/web/local-assets/architecture/stair-library.glb', import.meta.url);
const manifestFile = new URL('../../apps/web/local-assets/architecture/stair-library.manifest.json', import.meta.url);

describe.skipIf(!existsSync(localFile))('actual Blender stair modules', () => {
  let scene: Scene;
  const part = (name: string) => {
    const root = scene.getObjectByName(name);
    if (!root) throw new Error(`Missing stair module ${name}`);
    return root;
  };
  const top = (root: Scene | ReturnType<typeof part>, x: number, z: number) =>
    new Raycaster(new Vector3(x, 10, z), new Vector3(0, -1, 0)).intersectObject(root, true)[0]?.point.y;
  beforeAll(async () => {
    scene = (await new GLTFLoader().parseAsync(new Uint8Array(readFileSync(localFile)).buffer, '')).scene;
    scene.updateWorldMatrix(true, true);
  });

  it('exports the named roots at zero with measured bounds, nominal dimensions and material batches', () => {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    expect(Object.keys(manifest.groups).sort()).toEqual(Object.keys(STAIR_PART_NOMINAL).sort());
    let triangles = 0, meshes = 0;
    for (const name of Object.keys(STAIR_PART_NOMINAL) as Array<keyof typeof STAIR_PART_NOMINAL>) {
      const root = part(name), contract = manifest.groups[name], bounds = new Box3().setFromObject(root);
      expect(root.position.length(), name).toBeLessThan(1e-6);
      expect(root.scale.toArray(), name).toEqual([1, 1, 1]);
      expect(contract.nominalDimensions).toEqual(STAIR_PART_NOMINAL[name]);
      let count = 0, draws = 0;
      const roles = new Set<string>();
      root.traverse((node: Scene) => {
        if (!('geometry' in node)) return;
        count += (node.geometry.index?.count ?? node.geometry.getAttribute('position').count) / 3;
        expect(Array.isArray(node.material)).toBe(false);
        roles.add(node.material.name); draws++;
        expect(node.material.transparent).toBe(false);
        expect(node.material.emissiveIntensity === 0 || node.material.emissive.getHex() === 0).toBe(true);
      });
      expect(count).toBe(contract.triangles); expect(draws).toBe(contract.meshes);
      expect(draws).toBe(roles.size); // Exactly one opaque mesh per material.
      for (const [i, axis] of ['x', 'y', 'z'].entries()) {
        expect(bounds.min[axis], `${name} min ${axis}`).toBeCloseTo(contract.min[i], 5);
        expect(bounds.max[axis], `${name} max ${axis}`).toBeCloseTo(contract.max[i], 5);
      }
      triangles += count; meshes += draws;
    }
    expect(triangles).toBe(manifest.triangles); expect(triangles).toBeLessThan(10_000);
    expect(meshes).toBe(manifest.meshes); expect(meshes).toBeLessThanOrEqual(18);
    const lights: Scene[] = [];
    scene.traverse((node: Scene) => { if ('isLight' in node) lights.push(node); });
    expect(lights).toHaveLength(0);
  });

  it('retains actual foot contact tops and tread centers on both switchback flights', () => {
    const { width, rise, runPerFlight: run, stepsPerFlight: steps, gap } = OFFICE_STAIRCASE;
    const tread = run / steps, stepRise = rise / 2 / steps;
    for (const direction of [1, -1]) for (let i = 0; i < steps; i++) {
      const root = part('stair-tread').clone(true);
      const y = (direction === 1 ? 0 : rise / 2) + stepRise * (i+1);
      root.scale.set(...stairPartScale('stair-tread', [width, .09, tread]));
      root.rotation.y = direction === 1 ? 0 : Math.PI;
      root.position.set(-direction * (width+gap)/2, y, direction*(-run/2+tread*(i+.5)));
      root.updateWorldMatrix(true, true);
      for (const lane of [-.68, .68]) {
        expect(top(root, root.position.x+lane, root.position.z)).toBeCloseTo(y, 5);
        // Grip strips share exactly the same contact top, with real wood recesses.
        expect(top(root, root.position.x+lane, root.position.z-direction*(tread/2-.04))).toBeCloseTo(y, 5);
      }
    }
    const landing = part('stair-landing').clone(true);
    landing.scale.set(6.4, 1, 2.6); landing.updateWorldMatrix(true, true);
    for (const x of [-2, -.68, .68, 2]) for (const z of [-.65, .65]) expect(top(landing, x, z)).toBeCloseTo(0, 6);
  });

  it('retains oak, metal, grip and limestone roles and visibly shaped manufactured details', () => {
    const roles = new Set<string>();
    scene.traverse((node: Scene) => { if ('material' in node) roles.add(node.material.name); });
    expect([...roles]).toEqual(expect.arrayContaining(['Stair oak', 'Stair oak endgrain', 'Stair brushed steel',
      'Stair graphite structure', 'Stair inset grip', 'Stair limestone']));
    // The I-profile spine has a genuine recessed web, not a renamed cuboid.
    const spine = part('stair-stringer');
    const ray = new Raycaster(new Vector3(1, 0, 0), new Vector3(-1, 0, 0));
    expect(ray.intersectObject(spine, true)[0]?.point.x).toBeCloseTo(.026, 5);
    const cap = new Raycaster(new Vector3(1, .108, 0), new Vector3(-1, 0, 0));
    expect(cap.intersectObject(spine, true)[0]?.point.x).toBeCloseTo(.06, 5);
  });
});
