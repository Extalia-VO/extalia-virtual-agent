import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import profile from '../../apps/web/src/office/scene/interior/architectureAssetProfile.json';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { Box3, Mesh, Raycaster, Vector3 } = await import(webRequire.resolve('three'));
const { GLTFLoader } = await import(webRequire.resolve('three/examples/jsm/loaders/GLTFLoader.js'));
const localFile = new URL('../../apps/web/local-assets/architecture/interior-architecture.glb', import.meta.url);
const manifestFile = new URL('../../apps/web/local-assets/architecture/interior-architecture.manifest.json', import.meta.url);
type Scene = Awaited<ReturnType<InstanceType<typeof GLTFLoader>['parseAsync']>>['scene'];

async function loadLibrary(): Promise<Scene> {
  return (await new GLTFLoader().parseAsync(new Uint8Array(readFileSync(localFile)).buffer, '')).scene;
}

function dispose(scene: Scene) {
  scene.traverse(node => {
    if (!(node instanceof Mesh)) return;
    node.geometry.dispose();
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose();
  });
}

describe('authored architecture library contracts', () => {
  it('defines all independently animated architecture parts with nominal dimensions and source pivots', () => {
    expect(Object.keys(profile.models)).toEqual([
      'architecture-glass-panel', 'architecture-glass-transom', 'architecture-solid-wall',
      'architecture-hinged-frame', 'architecture-hinged-glass-leaf', 'architecture-hinged-wood-leaf',
      'architecture-sliding-frame', 'architecture-sliding-leaf',
    ]);
    expect(profile.models['architecture-hinged-glass-leaf'].origin).toBe('hinge-floor');
    expect(profile.models['architecture-sliding-frame'].width).toBe(2.4);
  });

  it.skipIf(!existsSync(localFile))('exports identity roots, bounded silhouettes and at most six material draws per part', async () => {
    const scene = await loadLibrary();
    try {
      let triangles = 0, draws = 0;
      for (const [name, spec] of Object.entries(profile.models)) {
        const root = scene.getObjectByName(name)!;
        expect(root, name).toBeDefined();
        expect(root.position.toArray(), name).toEqual([0, 0, 0]);
        expect(root.quaternion.toArray(), name).toEqual([0, 0, 0, 1]);
        expect(root.scale.toArray(), name).toEqual([1, 1, 1]);
        expect(root.userData.nominal_dimensions, name).toEqual([spec.width, spec.height, spec.depth]);
        expect(root.userData.origin_contract, name).toBe(spec.origin);
        const bounds = new Box3().setFromObject(root);
        expect(bounds.min.y, name).toBeCloseTo(spec.origin === 'center' ? -spec.height / 2 : 0, 5);
        const frame = name.endsWith('-frame');
        if (frame) {
          expect(bounds.max.y, name).toBeGreaterThan(spec.height);
          expect(bounds.max.y, name).toBeLessThan(spec.height + .16);
        } else {
          expect(bounds.max.y, name).toBeCloseTo(spec.origin === 'center' ? spec.height / 2 : spec.height, 5);
          const hinge = spec.origin === 'hinge-floor';
          expect(bounds.min.x, name).toBeCloseTo(hinge ? 0 : -spec.width / 2, 5);
          expect(bounds.max.x, name).toBeCloseTo(hinge ? spec.width : spec.width / 2, 5);
        }
        const meshes: InstanceType<typeof Mesh>[] = [];
        root.traverse(node => { if (node instanceof Mesh) meshes.push(node); });
        expect(meshes.length, name).toBeLessThanOrEqual(6);
        expect(meshes.length, name).toBeGreaterThanOrEqual(3);
        for (const mesh of meshes) {
          expect(Array.isArray(mesh.material), name).toBe(false);
          const geometry = mesh.geometry;
          expect(geometry.getAttribute('normal').count, name).toBe(geometry.getAttribute('position').count);
          triangles += (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
          draws++;
        }
      }
      expect(triangles).toBeGreaterThan(2_000); // Rounded sections and useful hardware, beyond proxy boxes.
      expect(triangles).toBeLessThan(12_000);
      expect(draws).toBeLessThanOrEqual(40);
      if (existsSync(manifestFile)) {
        const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
        expect(manifest.triangles).toBe(triangles);
        expect(manifest.meshes).toBe(draws);
      }
    } finally { dispose(scene); }
  });

  it.skipIf(!existsSync(localFile))('keeps frames outside the nominal clear doorway and wall skirting physically recessed', async () => {
    const scene = await loadLibrary();
    try {
      scene.updateMatrixWorld(true);
      for (const name of ['architecture-hinged-frame', 'architecture-sliding-frame'] as const) {
        const root = scene.getObjectByName(name)!;
        const spec = profile.models[name];
        const point = new Vector3();
        root.traverse(node => {
          if (!(node instanceof Mesh)) return;
          const positions = node.geometry.getAttribute('position');
          for (let i = 0; i < positions.count; i++) {
            point.fromBufferAttribute(positions, i).applyMatrix4(node.matrixWorld);
            if (point.y > .00001 && point.y < spec.height - .00001) {
              expect(Math.abs(point.x), `${name} clear width at height ${point.y}`).toBeGreaterThanOrEqual(spec.width / 2 - .00001);
            }
          }
        });
        for (const x of [-.45, 0, .45]) {
          const ray = new Raycaster(new Vector3(x * spec.width, spec.height * .5, 1), new Vector3(0, 0, -1));
          expect(ray.intersectObject(root, true), name).toHaveLength(0);
        }
      }
      const wall = scene.getObjectByName('architecture-solid-wall')!;
      const depthAt = (y: number) => new Raycaster(new Vector3(0, y, 1), new Vector3(0, 0, -1)).intersectObject(wall, true)[0]!.point.z;
      expect(depthAt(-1.24)).toBeCloseTo(.0425, 5);
      expect(depthAt(-1.19)).toBeCloseTo(.0445, 5);
      expect(depthAt(0)).toBeCloseTo(.055, 5);
      const timber = scene.getObjectByName('architecture-hinged-wood-leaf')!;
      const panelHit = new Raycaster(new Vector3(.5, .6, 1), new Vector3(0, 0, -1)).intersectObject(timber, true)[0]!;
      const railHit = new Raycaster(new Vector3(.05, .6, 1), new Vector3(0, 0, -1)).intersectObject(timber, true)[0]!;
      expect(panelHit.point.z).toBeCloseTo(.0235, 5);
      expect(railHit.point.z).toBeCloseTo(.0275, 5);
      const aluminium = scene.getObjectByName('architecture-glass-panel')!.children.find(node =>
        node instanceof Mesh && node.material.name === 'Architecture powdercoat aluminium') as InstanceType<typeof Mesh>;
      const positions = aluminium.geometry.getAttribute('position'), indices = aluminium.geometry.index!;
      const a = new Vector3(), b = new Vector3(), c = new Vector3();
      let bevelFaces = 0;
      for (let i = 0; i < indices.count; i += 3) {
        a.fromBufferAttribute(positions, indices.getX(i));
        b.fromBufferAttribute(positions, indices.getX(i + 1)).sub(a);
        c.fromBufferAttribute(positions, indices.getX(i + 2)).sub(a);
        const normal = b.cross(c).normalize();
        if (normal.toArray().filter(value => Math.abs(value) > .1).length > 1) bevelFaces++;
      }
      expect(bevelFaces).toBeGreaterThan(24);
    } finally { dispose(scene); }
  });

  it.skipIf(!existsSync(localFile))('preserves both-face lever contact, sliding pulls and separate tint/glazing/sensor materials', async () => {
    const scene = await loadLibrary();
    try {
      scene.updateMatrixWorld(true);
      for (const name of ['architecture-hinged-glass-leaf', 'architecture-hinged-wood-leaf']) {
        const root = scene.getObjectByName(name)!;
        for (const sign of [-1, 1]) {
          const ray = new Raycaster(new Vector3(.82, 1.275, sign * .6), new Vector3(0, 0, -sign));
          const hit = ray.intersectObject(root, true)[0]!;
          expect(hit, name).toBeDefined();
          expect(Math.abs(hit.point.z), name).toBeCloseTo(.112, 3);
          expect((hit.object as InstanceType<typeof Mesh>).material.name).toBe('Architecture satin stainless hardware');
        }
      }
      const sliding = scene.getObjectByName('architecture-sliding-leaf')!;
      for (const sign of [-1, 1]) {
        const hit = new Raycaster(new Vector3(.41, 1.15, sign * .6), new Vector3(0, 0, -sign)).intersectObject(sliding, true)[0]!;
        expect(Math.abs(hit.point.z)).toBeCloseTo(.097, 3);
      }
      const names = new Set<string>();
      scene.traverse(node => {
        if (!(node instanceof Mesh)) return;
        names.add(node.material.name);
        if (node.material.name === 'Architecture glazing') {
          expect(node.material.transparent).toBe(true);
          expect(node.material.opacity).toBeCloseTo(.2, 5);
        }
        if (node.material.name === 'Architecture sensor LED') {
          expect(node.material.emissiveIntensity).toBeGreaterThan(0);
        }
      });
      expect(names.has('Architecture wall paint')).toBe(true);
      expect(names.has('Architecture sensor LED')).toBe(true);
      expect(names.has('Architecture etched safety bands')).toBe(true);
    } finally { dispose(scene); }
  });

  it.skipIf(!existsSync(localFile))('supports both fully open sliding leaves across the complete travel envelope', async () => {
    const scene = await loadLibrary();
    try {
      scene.updateMatrixWorld(true);
      const root = scene.getObjectByName('architecture-sliding-frame')!;
      const { width, height } = profile.models['architecture-sliding-frame'];
      // SlidingDoor uses halfWidth * .98 leaves and a .88 leaf-width slide.
      const leafWidth = width / 2 * .98;
      const fullyOpenOuterEdge = leafWidth * (1 + .88);
      const cover = root.children.find(node => node instanceof Mesh && node.material.name === 'Architecture powdercoat aluminium')!;
      const rail = root.children.find(node => node instanceof Mesh && node.material.name === 'Architecture EPDM gasket and shadow reveal')!;
      for (const component of [cover, rail]) {
        const bounds = new Box3().setFromObject(component);
        expect(bounds.min.x).toBeLessThan(-fullyOpenOuterEdge - .02);
        expect(bounds.max.x).toBeGreaterThan(fullyOpenOuterEdge + .02);
      }
      for (const sign of [-1, 1]) {
        const x = sign * fullyOpenOuterEdge;
        const coverHit = new Raycaster(new Vector3(x, height + .112, 1), new Vector3(0, 0, -1)).intersectObject(cover)[0]!;
        const railHit = new Raycaster(new Vector3(x, height + .015, 1), new Vector3(0, 0, -1)).intersectObject(rail)[0]!;
        expect(coverHit).toBeDefined();
        expect(coverHit.point.z).toBeCloseTo(.12, 5);
        expect(railHit).toBeDefined();
        expect(railHit.point.z).toBeCloseTo(.1075, 5);
      }
      // Longer travel support remains entirely above the clear opening.
      for (const x of [-width / 2 + .001, 0, width / 2 - .001]) {
        for (const y of [.01, height / 2, height - .001]) {
          expect(new Raycaster(new Vector3(x, y, 1), new Vector3(0, 0, -1)).intersectObject(root, true)).toHaveLength(0);
        }
      }
    } finally { dispose(scene); }
  });
});
