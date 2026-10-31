import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Raycaster, Vector3 } = await import(webRequire.resolve('three'));
const { GLTFLoader } = await import(webRequire.resolve('three/examples/jsm/loaders/GLTFLoader.js'));
import { describe, expect, it } from 'vitest';
import { bakeCampusMobilityModels, createMobilityFallbackModels, disposeMobilityLibrary, mobilitySources, USED_MOBILITY_MODELS } from '../../apps/web/src/office/scene/CampusMobilityModels';
import { mobilityLampPower } from '../../apps/web/src/office/scene/CampusTraffic';
import {
  DAILY_CATALOG, DERIVED_VEHICLE_MODELS, GENERATED_MOBILITY_MODELS, MOBILITY_MODELS, PARKED_VEHICLES, PARKING, PICKUPS, VEHICLE_CATALOG, VEHICLE_MODELS, VEHICLE_SPECS, isMobilityVehicle, type MobilityModel,
} from '../../apps/web/src/office/scene/campusMobilityLayout';

const localCampus = new URL('../../apps/web/local-assets/landscape/campus-mobility.glb', import.meta.url);
const publicAsset = (path: string) => new URL(`../../apps/web/public-assets/${path.replace(/^\/public-assets\//, '')}`, import.meta.url);
const parse = async (file: URL) => (await new GLTFLoader().parseAsync(new Uint8Array(readFileSync(file)).buffer, '')).scene;
const disposeScene = (scene: InstanceType<typeof Object3D>) => scene.traverse(node => {
  if (node instanceof Mesh) { node.geometry.dispose(); for (const material of [node.material].flat()) material.dispose(); }
});
const triangles = (geometry: { getAttribute(name: string): { count: number } }) => geometry.getAttribute('position').count / 3;

/** A minimal model: one body box, one lamp box and (for vehicles) a wheel template plus four hubs. */
function syntheticModel(name: MobilityModel, body: InstanceType<typeof MeshStandardMaterial>, lamp: InstanceType<typeof MeshStandardMaterial>, source: InstanceType<typeof BoxGeometry>, wheels = true) {
  const root = new Group(); root.name = name;
  const shape = new Mesh(source, body); shape.position.set(0, .5, 0); root.add(shape);
  const light = new Mesh(source, lamp); light.scale.set(.1, .1, .1); light.position.set(0, .7, 1); root.add(light);
  if (wheels && isMobilityVehicle(name)) {
    const template = new Group(); template.name = 'wheel-template'; template.position.set(.8, .3, 1.2); root.add(template);
    const tyre = new Mesh(source, body); tyre.scale.set(.2, .6, .6); template.add(tyre);
    for (const [label, x, z] of [['front-left', .8, 1.2], ['front-right', -.8, 1.2], ['rear-left', .8, -1.2], ['rear-right', -.8, -1.2]] as const) {
      const marker = new Object3D(); marker.name = `wheel-${label}`; marker.position.set(x, .3, z);
      marker.userData = { wheel_radius: .3, wheel_side: x > 0 ? 1 : -1 };
      root.add(marker);
    }
  }
  return root;
}

describe('campus mobility geometry and light contracts', () => {
  it('keeps every fallback vehicle, charger and shelter complete, grounded and within three batches each', () => {
    const models = createMobilityFallbackModels();
    try {
      expect([...models.keys()]).toEqual(MOBILITY_MODELS);
      let total = 0;
      for (const [name, { body, lamp, wheels }] of models) {
        expect(body.boundingBox!.max.y, name).toBeGreaterThan(1.1);
        for (const geometry of [body, lamp, ...(wheels ? [wheels.geometry] : [])]) {
          expect(geometry.getAttribute('normal').count, name).toBe(geometry.getAttribute('position').count);
          expect(geometry.getAttribute('color').count, name).toBe(geometry.getAttribute('position').count);
          total += triangles(geometry) * (geometry === wheels?.geometry ? wheels.hubs.length : 1);
        }
        expect(lamp.getAttribute('mobilityTail').count, name).toBe(lamp.getAttribute('position').count);
        if (!isMobilityVehicle(name)) { expect(body.boundingBox!.min.y, name).toBeCloseTo(0, 5); expect(wheels, name).toBeUndefined(); continue; }
        // Wheels rest on the road: every hub stands one radius above y=0 and faces outwards.
        expect(wheels!.hubs, name).toHaveLength(4);
        expect(wheels!.radius, name).toBeCloseTo(VEHICLE_SPECS[name]!.wheel);
        for (const hub of wheels!.hubs) { expect(hub.y - wheels!.radius, name).toBeCloseTo(0, 5); expect(Math.sign(hub.x), name).toBe(hub.side); }
        expect(body.boundingBox!.min.y, name).toBeGreaterThanOrEqual(0);
      }
      // Bounded per model; only the day's rotation is ever built at runtime.
      expect(total / models.size).toBeLessThan(3_000);
      const today = new Set<string>(DAILY_CATALOG.map(vehicle => vehicle.model));
      for (const vehicle of PARKED_VEHICLES) expect(today.has(vehicle.model), vehicle.model).toBe(true);
      const trafficOnly = new Set(VEHICLE_CATALOG.filter(vehicle => vehicle.trafficOnly).map(vehicle => vehicle.model));
      const silhouettes = new Set<string>();
      for (const name of VEHICLE_MODELS) {
        const size = models.get(name)!.body.boundingBox!.getSize(new Vector3());
        // Mirrors excluded: even the widest full-size pickups' fallback bodies stay within half a 3.2 m bay's margin.
        expect(size.x, name).toBeLessThanOrEqual(2.5);
        // Full-size pickups (up to 5.95 m) nose up to half a metre into the wide drive aisle, as real ones do.
        if (!trafficOnly.has(name)) expect(size.z, name).toBeLessThanOrEqual(PARKING.bayDepth + .5);
        silhouettes.add(size.toArray().map(value => value.toFixed(2)).join(','));
      }
      expect(silhouettes.size).toBe(VEHICLE_MODELS.length);
      const down = new Raycaster(new Vector3(0, 5, -.4), new Vector3(0, -1, 0));
      const material = new MeshStandardMaterial();
      try {
        // Every derived pickup's fallback keeps a cab over an open bed (the retired single-cab truck's silhouette).
        expect(PICKUPS.length).toBeGreaterThanOrEqual(4);
        for (const model of PICKUPS) {
          if (!isMobilityVehicle(model)) throw new Error('Pickup must be a vehicle');
          const spec = VEHICLE_SPECS[model]!, body = new Mesh(models.get(model)!.body, material);
          const bed = new Raycaster(new Vector3(0, 5, -spec.length * .38), new Vector3(0, -1, 0)).intersectObject(body)[0]!.point.y;
          const cab = new Raycaster(new Vector3(0, 5, spec.cabinZ), new Vector3(0, -1, 0)).intersectObject(body)[0]!.point.y;
          expect(bed, model).toBeCloseTo(.72);
          expect(cab, model).toBeGreaterThan(bed + .8);
        }
        expect(down.intersectObject(new Mesh(models.get('mobility-pickup')!.body, material))[0]!.point.y).toBeGreaterThan(1.6);
      } finally { material.dispose(); }
      const colors = models.get('mobility-sedan')!.body.getAttribute('color');
      let darkTrimOrGlass = 0;
      for (let i = 0; i < colors.count; i++) if (colors.getX(i) + colors.getY(i) + colors.getZ(i) < .2) darkTrimOrGlass++;
      expect(darkTrimOrGlass).toBeGreaterThan(30);
      const leds = models.get('mobility-sedan')!.lamp;
      const color = leds.getAttribute('color'), tail = leds.getAttribute('mobilityTail');
      const red = Array.from({ length: color.count }, (_, i) => color.getX(i) > color.getY(i) * 3);
      expect(red).toContain(true);
      for (let i = 0; i < color.count; i++) expect(tail.getX(i)).toBe(red[i] ? 1 : 0);
    } finally { disposeMobilityLibrary(models); }
  });

  it('splits imported body, lamp and wheel roles and keeps source transforms, normals and colours', () => {
    const scene = new Group();
    const source = new BoxGeometry(1, 1, 1);
    const body = new MeshStandardMaterial({ name: 'Mobility opaque blue grey glazing', color: '#254854' });
    const lamp = new MeshStandardMaterial({ name: 'Mobility lamp tail', color: '#f33b19' });
    for (const name of MOBILITY_MODELS) scene.add(syntheticModel(name, body, lamp, source));
    const models = bakeCampusMobilityModels(scene)!;
    try {
      expect(models.size).toBe(MOBILITY_MODELS.length);
      const result = models.get('mobility-sedan')!;
      expect(result.body.boundingBox!.min.y).toBeCloseTo(0);
      expect(result.lamp.boundingBox!.max.z).toBeCloseTo(1.05);
      expect(result.body.getAttribute('color').getX(0)).toBeCloseTo(body.color.r);
      expect(result.lamp.getAttribute('color').getY(0)).toBeCloseTo(lamp.color.g);
      expect(result.lamp.getAttribute('mobilityTail').getX(0)).toBe(1);
      // Exported normals survive the split (a box keeps its axis-aligned face normals).
      const normal = result.body.getAttribute('normal');
      for (let i = 0; i < normal.count; i++) expect(Math.abs(normal.getX(i)) + Math.abs(normal.getY(i)) + Math.abs(normal.getZ(i))).toBeCloseTo(1);
      // The wheel lives in template space around its hub, not in the body.
      expect(result.body.boundingBox!.max.x).toBeCloseTo(.5);
      const wheelBox = new Box3().setFromBufferAttribute(result.wheels!.geometry.getAttribute('position') as never);
      expect(wheelBox.getCenter(new Vector3()).length()).toBeCloseTo(0);
      expect(result.wheels!.geometry.getAttribute('normal').count).toBe(result.wheels!.geometry.getAttribute('position').count);
      expect(result.wheels!.hubs.map(hub => hub.side)).toEqual([1, -1, 1, -1]);
      expect(result.wheels!.radius).toBe(.3);
      expect(models.get('mobility-charger')!.wheels).toBeUndefined();
      expect(source.getAttribute('color')).toBeUndefined();
      expect(source.boundingBox).toBeNull();
    } finally { disposeMobilityLibrary(models); source.dispose(); body.dispose(); lamp.dispose(); }
  });

  it('bakes only the requested models and rejects partial files so their fallback stays mounted', () => {
    const source = new BoxGeometry();
    const body = new MeshStandardMaterial({ name: 'Mobility pearl enamel' });
    const lamp = new MeshStandardMaterial({ name: 'Mobility lamp head' });
    try {
      const single = new Group(); single.add(syntheticModel('mobility-sports', body, lamp, source));
      const sports = bakeCampusMobilityModels(single, ['mobility-sports'])!;
      expect([...sports.keys()]).toEqual(['mobility-sports']);
      disposeMobilityLibrary(sports);
      expect(bakeCampusMobilityModels(single)).toBeNull();
      const wheelless = new Group(); wheelless.add(syntheticModel('mobility-van', body, lamp, source, false));
      expect(bakeCampusMobilityModels(wheelless, ['mobility-van'])).toBeNull();
      const partial = new Group(), root = new Group(); root.name = MOBILITY_MODELS[0]!; partial.add(root);
      expect(bakeCampusMobilityModels(partial, [MOBILITY_MODELS[0]!])).toBeNull();
      root.add(new Mesh(source, body));
      expect(bakeCampusMobilityModels(partial, [MOBILITY_MODELS[0]!])).toBeNull();
      expect(source.getAttribute('position').count).toBe(24);
    } finally { source.dispose(); body.dispose(); lamp.dispose(); }
  });

  it('fetches lazily: one campus file for generated models and one licensed file per used car', () => {
    const sources = mobilitySources();
    const names = sources.flatMap(source => source.names);
    expect(new Set(names)).toEqual(new Set(USED_MOBILITY_MODELS));
    expect(sources[0]).toEqual({ path: '/public-assets/landscape/campus-mobility.glb', names: GENERATED_MOBILITY_MODELS.filter(model => USED_MOBILITY_MODELS.includes(model)) });
    for (const { path, names } of sources.slice(1)) {
      expect(names).toHaveLength(1);
      expect(DERIVED_VEHICLE_MODELS).toContain(names[0]);
      expect(path).toBe(`/public-assets/vehicles/${names[0]!.replace('mobility-', '')}.glb`);
      expect(existsSync(publicAsset(path)), path).toBe(true);
    }
    expect(mobilitySources(['mobility-sports'])).toEqual([{ path: '/public-assets/vehicles/sports.glb', names: ['mobility-sports'] }]);
  });

  it('lights moving cars by the photocell or the manual control, never parked cars', () => {
    for (const model of VEHICLE_MODELS) {
      for (const override of ['auto', 'on', 'off'] as const) expect(mobilityLampPower(model, 1, override)).toBe(0);
      expect(mobilityLampPower(model, .6, 'auto', true)).toBe(.6);
      expect(mobilityLampPower(model, 0, 'auto', true)).toBe(0);
      expect(mobilityLampPower(model, 0, 'on', true)).toBe(1);
      expect(mobilityLampPower(model, 1, 'off', true)).toBe(0);
    }
    for (const model of ['mobility-charger', 'mobility-cycle-shelter'] as const) {
      expect(mobilityLampPower(model, .7, 'auto')).toBe(.7);
      expect(mobilityLampPower(model, 1, 'off')).toBe(0);
      expect(mobilityLampPower(model, 0, 'on')).toBe(1);
    }
  });

  it('ships each licensed car as a small, textureless, debadged GLB that bakes into body, lamps and one wheel', async () => {
    for (const model of DERIVED_VEHICLE_MODELS) {
      const file = publicAsset(`vehicles/${model.replace('mobility-', '')}.glb`);
      // A traffic-only vehicle (the 11 m rigid truck) may use up to 12k triangles and 600 KB.
      const trafficOnly = VEHICLE_CATALOG.find(vehicle => vehicle.model === model)!.trafficOnly === true;
      expect(statSync(file).size, model).toBeLessThanOrEqual(trafficOnly ? 600_000 : 350_000);
      const bytes = readFileSync(file);
      const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
      expect(json.images ?? [], model).toHaveLength(0);
      expect(json.textures ?? [], model).toHaveLength(0);
      for (const mesh of json.meshes) for (const primitive of mesh.primitives) expect(Object.keys(primitive.attributes).sort(), model).toEqual(['NORMAL', 'POSITION']);
      for (const material of json.materials) expect(material.name, model).toMatch(/^Mobility (paint|glass|trim|rubber|alloy|plate|lamp head|lamp tail)$/);
      const names = json.nodes.map((node: { name: string }) => node.name).join(' ');
      expect(names, model).not.toMatch(/logo|badge|emblem|seat|steer|dash|interior/i);
      const scene = await parse(file);
      const models = bakeCampusMobilityModels(scene, [model])!;
      try {
        expect(models, model).not.toBeNull();
        const { body, lamp, wheels } = models.get(model)!;
        const spec = VEHICLE_SPECS[model]!;
        const fileTriangles = triangles(body) + triangles(lamp) + triangles(wheels!.geometry);
        expect(fileTriangles, model).toBeLessThanOrEqual(trafficOnly ? 12_000 : 6_600);
        expect(scene.getObjectByName(model)!.userData.vehicle_spec, model).toEqual({
          length: spec.length, width: spec.width, height: spec.height, wheel: spec.wheel, wheelbase: spec.wheelbase, track: spec.track,
        });
        const bounds = new Box3().union(body.boundingBox!).union(lamp.boundingBox!);
        const size = bounds.getSize(new Vector3());
        expect(size.z, model).toBeCloseTo(spec.length, 1);
        expect(size.y, model).toBeLessThanOrEqual(spec.height + .01);
        // Faces +Z: headlamps sit in front, tail lamps behind.
        const tail = lamp.getAttribute('mobilityTail'), position = lamp.getAttribute('position');
        let head = 0, rear = 0;
        for (let i = 0; i < tail.count; i++) if (tail.getX(i)) rear += position.getZ(i); else head += position.getZ(i);
        expect(head, model).toBeGreaterThan(0);
        expect(rear, model).toBeLessThan(0);
        expect(wheels!.hubs, model).toHaveLength(4);
        for (const hub of wheels!.hubs) expect(hub.y - wheels!.radius, model).toBeCloseTo(0, 2);
        expect(Math.abs(wheels!.hubs[0]!.z - wheels!.hubs[2]!.z), model).toBeCloseTo(spec.wheelbase, 2);
        const wheelBox = new Box3().setFromBufferAttribute(wheels!.geometry.getAttribute('position') as never);
        expect(wheelBox.max.y, model).toBeCloseTo(wheels!.radius, 2);
        expect(wheelBox.max.x, model).toBeGreaterThan(-wheelBox.min.x);
      } finally { disposeMobilityLibrary(models); disposeScene(scene); }
    }
  });

  it.skipIf(!existsSync(localCampus))('bakes the generated charger and shelter (the single-cab truck is retired)', async () => {
    const scene = await parse(localCampus);
    const models = bakeCampusMobilityModels(scene, GENERATED_MOBILITY_MODELS)!;
    try {
      expect(models.size).toBe(GENERATED_MOBILITY_MODELS.length);
      let total = 0;
      for (const [name, model] of models) {
        const bounds = new Box3().union(model.body.boundingBox!).union(model.lamp.boundingBox!);
        expect(bounds.getSize(new Vector3()).length(), name).toBeLessThan(7);
        total += triangles(model.body) + triangles(model.lamp) + (model.wheels ? triangles(model.wheels.geometry) * 4 : 0);
        if (!isMobilityVehicle(name)) continue;
        const spec = VEHICLE_SPECS[name]!;
        expect(scene.getObjectByName(name)!.userData.vehicle_spec).toEqual(spec);
        expect(model.wheels!.hubs.map(hub => [hub.x, hub.y, hub.z].map(value => +value.toFixed(3)))).toEqual([
          [spec.track / 2, spec.wheel, spec.wheelbase / 2], [-spec.track / 2, spec.wheel, spec.wheelbase / 2],
          [spec.track / 2, spec.wheel, -spec.wheelbase / 2], [-spec.track / 2, spec.wheel, -spec.wheelbase / 2],
        ].map(hub => hub.map(value => +value.toFixed(3))));
      }
      expect(total).toBeLessThan(8_000);
      expect(GENERATED_MOBILITY_MODELS.some(model => isMobilityVehicle(model))).toBe(false);
      // Vehicles are all derived cars now; the campus file carries no truck or double cab.
      expect(scene.getObjectByName('mobility-truck')).toBeUndefined();
      expect(scene.getObjectByName('mobility-double-cabin')).toBeUndefined();
    } finally { disposeMobilityLibrary(models); disposeScene(scene); }
  });
});
