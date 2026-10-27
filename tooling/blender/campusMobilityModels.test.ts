import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Raycaster, Vector3 } = await import(webRequire.resolve('three'));
const { GLTFLoader } = await import(webRequire.resolve('three/examples/jsm/loaders/GLTFLoader.js'));
import { describe, expect, it } from 'vitest';
import { bakeCampusMobilityModels, createMobilityFallbackModels, disposeMobilityLibrary } from '../../apps/web/src/office/scene/CampusMobilityModels';
import { mobilityLampPower } from '../../apps/web/src/office/scene/CampusTraffic';
import { MOBILITY_MODELS, PARKED_VEHICLES, VEHICLE_MODELS, VEHICLE_SPECS } from '../../apps/web/src/office/scene/campusMobilityLayout';

const localFile = new URL('../../apps/web/local-assets/landscape/campus-mobility.glb', import.meta.url);

describe('campus mobility geometry and light contracts', () => {
  it('keeps all fallback vehicles, chargers and cycle shelter complete and grounded in twenty role batches', () => {
    const models = createMobilityFallbackModels();
    try {
      expect([...models.keys()]).toEqual(MOBILITY_MODELS);
      let triangles = 0;
      for (const [name, { body, lamp }] of models) {
        expect(body.boundingBox!.min.y, name).toBeCloseTo(0, 5);
        expect(body.boundingBox!.max.y, name).toBeGreaterThan(1.3);
        for (const geometry of [body, lamp]) {
          expect(geometry.getAttribute('normal').count, name).toBe(geometry.getAttribute('position').count);
          expect(geometry.getAttribute('color').count, name).toBe(geometry.getAttribute('position').count);
          triangles += geometry.getAttribute('position').count / 3;
        }
      }
      expect(triangles).toBeLessThan(24_000);
      expect(models.size * 2).toBeLessThanOrEqual(20);
      expect(new Set(PARKED_VEHICLES.map(vehicle => vehicle.model))).toEqual(new Set(VEHICLE_MODELS));
      const silhouettes = new Set<string>();
      for (const name of VEHICLE_MODELS) {
        const bounds = models.get(name)!.body.boundingBox!;
        const size = bounds.getSize(new Vector3());
        expect(size.x, name).toBeLessThanOrEqual(2.15);
        expect(size.z, name).toBeLessThanOrEqual(5.15);
        silhouettes.add(size.toArray().map(value => value.toFixed(2)).join(','));
      }
      expect(silhouettes.size).toBe(VEHICLE_MODELS.length);
      const down = new Raycaster(new Vector3(0, 5, -.4), new Vector3(0, -1, 0));
      const material = new MeshStandardMaterial();
      try {
        const single = down.intersectObject(new Mesh(models.get('mobility-truck')!.body, material))[0]!.point.y;
        const double = down.intersectObject(new Mesh(models.get('mobility-double-cabin')!.body, material))[0]!.point.y;
        expect(single).toBeCloseTo(.72);
        expect(double).toBeGreaterThan(single + 1);
      } finally { material.dispose(); }
      const colors = models.get('mobility-sedan')!.body.getAttribute('color');
      let darkTiresOrGlass = 0;
      for (let i = 0; i < colors.count; i++) if (colors.getX(i) + colors.getY(i) + colors.getZ(i) < .2) darkTiresOrGlass++;
      expect(darkTiresOrGlass).toBeGreaterThan(30);
      const leds = models.get('mobility-sedan')!.lamp.getAttribute('color');
      expect(Array.from({ length: leds.count }, (_, i) => leds.getX(i) > leds.getY(i) * 3)).toContain(true);
    } finally { disposeMobilityLibrary(models); }
  });

  it('preserves source transforms and material colours while splitting imported body and lamp roles', () => {
    const scene = new Group();
    const source = new BoxGeometry(1, 1, 1);
    const body = new MeshStandardMaterial({ name: 'Mobility opaque blue grey glazing', color: '#254854' });
    const lamp = new MeshStandardMaterial({ name: 'Mobility lamp red taillight', color: '#f33b19' });
    for (const name of MOBILITY_MODELS) {
      const root = new Group(); root.name = name;
      const shape = new Mesh(source, body); shape.position.set(0, .5, 0); root.add(shape);
      const light = new Mesh(source, lamp); light.scale.set(.1, .1, .1); light.position.set(0, .7, 1); root.add(light);
      scene.add(root);
    }
    const models = bakeCampusMobilityModels(scene)!;
    try {
      expect(models.size).toBe(MOBILITY_MODELS.length);
      const result = models.get('mobility-sedan')!;
      expect(result.body.boundingBox!.min.y).toBeCloseTo(0);
      expect(result.lamp.boundingBox!.max.z).toBeCloseTo(1.05);
      expect(result.body.getAttribute('color').getX(0)).toBeCloseTo(body.color.r);
      expect(result.lamp.getAttribute('color').getY(0)).toBeCloseTo(lamp.color.g);
      expect(source.getAttribute('color')).toBeUndefined();
      expect(source.boundingBox).toBeNull();
    } finally { disposeMobilityLibrary(models); source.dispose(); body.dispose(); lamp.dispose(); }
  });

  it('rejects partial or malformed libraries so the complete fallback can remain mounted', () => {
    const partial = new Group();
    const root = new Group(); root.name = MOBILITY_MODELS[0]!;
    partial.add(root);
    expect(bakeCampusMobilityModels(partial)).toBeNull();
    const geometry = new BoxGeometry();
    const material = new MeshStandardMaterial({ name: 'Mobility pearl enamel' });
    root.add(new Mesh(geometry, material));
    expect(bakeCampusMobilityModels(partial)).toBeNull();
    expect(geometry.getAttribute('position').count).toBe(24);
    geometry.dispose(); material.dispose();
  });

  it('follows photocell darkness for cars and manual controls for charger and shelter lamps', () => {
    for (const model of VEHICLE_MODELS) {
      expect(mobilityLampPower(model, 0, 'on')).toBe(0);
      expect(mobilityLampPower(model, 1, 'off')).toBe(0);
      expect(mobilityLampPower(model, 1, 'off', true)).toBe(1);
    }
    for (const model of ['mobility-charger', 'mobility-cycle-shelter'] as const) {
      expect(mobilityLampPower(model, .7, 'auto')).toBe(.7);
      expect(mobilityLampPower(model, 1, 'off')).toBe(0);
      expect(mobilityLampPower(model, 0, 'on')).toBe(1);
    }
  });

  it.skipIf(!existsSync(localFile))('bakes the actual Blender library into ten bounded, colour-preserving model pairs', async () => {
    const scene = (await new GLTFLoader().parseAsync(new Uint8Array(readFileSync(localFile)).buffer, '')).scene;
    const models = bakeCampusMobilityModels(scene)!;
    try {
      expect(models.size).toBe(MOBILITY_MODELS.length);
      let triangles = 0;
      for (const model of models.values()) {
        const bounds = new Box3().union(model.body.boundingBox!).union(model.lamp.boundingBox!);
        expect(bounds.min.y).toBeCloseTo(0, 4);
        expect(bounds.getSize(new Vector3()).length()).toBeLessThan(7);
        triangles += (model.body.getAttribute('position').count + model.lamp.getAttribute('position').count) / 3;
      }
      expect(triangles).toBeLessThan(24_000);
      const silhouettes = new Set<string>();
      for (const name of VEHICLE_MODELS) {
        const root = scene.getObjectByName(name)!;
        const spec = VEHICLE_SPECS[name];
        expect(root.userData.vehicle_spec).toEqual(spec);
        const bounds = models.get(name)!.body.boundingBox!;
        const size = bounds.getSize(new Vector3());
        expect(size.x, name).toBeLessThanOrEqual(2.15);
        expect(size.z, name).toBeLessThanOrEqual(5.15);
        silhouettes.add(size.toArray().map(value => value.toFixed(2)).join(','));
        const tires: InstanceType<typeof Mesh>[] = [];
        root.traverse(node => { if (node instanceof Mesh && node.name.startsWith('Sculpted_road_tire')) tires.push(node); });
        // glTF normalises spaces in Blender object names to underscores.
        if (!tires.length) root.traverse(node => { if (node instanceof Mesh && node.name.startsWith('Sculpted road tire')) tires.push(node); });
        expect(tires, name).toHaveLength(4);
        for (const tire of tires) expect(new Box3().setFromObject(tire).min.y, name).toBeCloseTo(0, 4);
        const window = root.children.find(node => node.name.startsWith('Front_windscreen') || node.name.startsWith('Front windscreen'))!;
        const cabin = root.children.find(node => node.name.startsWith('Raised_passenger_cabin') || node.name.startsWith('Raised passenger cabin'))!;
        const windowBox = new Box3().setFromObject(window), cabinBox = new Box3().setFromObject(cabin);
        expect(windowBox.min.y, name).toBeGreaterThan(cabinBox.min.y);
        expect(windowBox.max.y, name).toBeLessThan(cabinBox.max.y);
      }
      expect(silhouettes.size).toBe(VEHICLE_MODELS.length);
      const material = new MeshStandardMaterial();
      const down = new Raycaster(new Vector3(0, 5, -.4), new Vector3(0, -1, 0));
      try {
        const bed = down.intersectObject(new Mesh(models.get('mobility-truck')!.body, material))[0]!.point.y;
        const cab = down.intersectObject(new Mesh(models.get('mobility-double-cabin')!.body, material))[0]!.point.y;
        expect(bed).toBeCloseTo(.72, 4);
        expect(cab).toBeCloseTo(VEHICLE_SPECS['mobility-double-cabin'].height, 4);
      } finally { material.dispose(); }
    } finally {
      disposeMobilityLibrary(models);
      scene.traverse(node => { if (node instanceof Mesh) { node.geometry.dispose(); for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose(); } });
    }
  });
});
