import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { bakeCampusMobilityModels, disposeMobilityLibrary, mobilitySources } from '../../apps/web/src/office/scene/CampusMobilityModels';
import { DAILY_CATALOG, TRAFFIC_LANES, VEHICLE_CATALOG, VEHICLE_MODELS, VEHICLE_SPECS, isMobilityVehicle, trafficPool, type MobilityModel } from '../../apps/web/src/office/scene/campusMobilityLayout';
import { carPoint, headlightSpotAim, vehicleIndicatorAnchors, vehicleLampAnchors, type VehicleLampAnchors } from '../../apps/web/src/office/scene/campusVehicleLamps';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { GLTFLoader } = await import(webRequire.resolve('three/examples/jsm/loaders/GLTFLoader.js'));
const { Triangle, Vector3 } = await import(webRequire.resolve('three'));
const publicAsset = (path: string) => new URL(`../../apps/web/public-assets/${path.replace(/^\/public-assets\//, '')}`, import.meta.url);

/** Lamp anchors derived from the published GLB lamp-head/lamp-tail lens geometry of every car. */
async function publishedLampAnchors(): Promise<Map<MobilityModel, VehicleLampAnchors>> {
  const anchors = new Map<MobilityModel, VehicleLampAnchors>();
  for (const { path, names } of mobilitySources(VEHICLE_MODELS)) {
    const gltf = await new GLTFLoader().parseAsync(new Uint8Array(readFileSync(publicAsset(path))).buffer, '');
    const library = bakeCampusMobilityModels(gltf.scene, names);
    if (!library) throw new Error(`Unbakeable ${path}`);
    try {
      for (const model of names) if (isMobilityVehicle(model)) anchors.set(model, vehicleLampAnchors(library.get(model)!.lamp, VEHICLE_SPECS[model]!));
    } finally { disposeMobilityLibrary(library); }
  }
  return anchors;
}

describe('published campus car lamp anchors', () => {
  it('mounts amber indicators on the actual front/rear lens triangles of every published car', async () => {
    const point = new Vector3(), nearest = new Vector3(), triangle = new Triangle();
    for (const { path, names } of mobilitySources(VEHICLE_MODELS)) {
      const gltf = await new GLTFLoader().parseAsync(new Uint8Array(readFileSync(publicAsset(path))).buffer, '');
      const library = bakeCampusMobilityModels(gltf.scene, names);
      if (!library) throw new Error(`Unbakeable ${path}`);
      try {
        for (const model of names) if (isMobilityVehicle(model)) {
          const lamp = library.get(model)!.lamp, position = lamp.getAttribute('position'), tail = lamp.getAttribute('mobilityTail');
          const index = lamp.index, count = index?.count ?? position.count;
          const anchors = vehicleIndicatorAnchors(lamp, VEHICLE_SPECS[model]!);
          for (const [rear, pair] of [[false, anchors.head], [true, anchors.tail]] as const) for (const [side, anchor] of pair.entries()) {
            expect(anchor.x * (side === 0 ? 1 : -1), model).toBeGreaterThan(0);
            expect(anchor.normal[2] * (rear ? -1 : 1), model).toBeGreaterThanOrEqual(.35);
            expect(Math.abs(anchor.x), model).toBeLessThan(VEHICLE_SPECS[model]!.width / 2 + .05);
            point.set(anchor.x, anchor.y, anchor.z);
            let distance = Infinity;
            for (let offset = 0; offset + 2 < count; offset += 3) {
              const a = index ? index.getX(offset) : offset;
              if ((tail.getX(a) > .5) !== rear) continue;
              triangle.a.fromBufferAttribute(position, a);
              triangle.b.fromBufferAttribute(position, index ? index.getX(offset + 1) : offset + 1);
              triangle.c.fromBufferAttribute(position, index ? index.getX(offset + 2) : offset + 2);
              triangle.closestPointToPoint(point, nearest);
              distance = Math.min(distance, point.distanceTo(nearest));
            }
            expect(distance, `${model} ${rear ? 'rear' : 'front'} ${side}`).toBeLessThan(1e-6);
          }
        }
      } finally { disposeMobilityLibrary(library); }
    }
  });

  it('finds a mirrored head and tail lamp pair at the nose and tail of every published car', async () => {
    const published = await publishedLampAnchors();
    expect([...published.keys()].sort()).toEqual([...VEHICLE_MODELS].sort());
    for (const [model, { head, tail }] of published) {
      const { length, height, track } = VEHICLE_SPECS[model]!;
      for (const [pair, front] of [[head, true], [tail, false]] as const) {
        expect(pair[0].x, model).toBeGreaterThan(0);
        expect(pair[1].x, model).toBeLessThan(0);
        expect(Math.abs(pair[0].x + pair[1].x), model).toBeLessThan(.12);
        // Thin full-width bars (the angular electric pickup) may sit a few centimetres off level.
        expect(Math.abs(pair[0].y - pair[1].y), model).toBeLessThan(.1);
        for (const lamp of pair) {
          expect(Math.abs(lamp.x), model).toBeGreaterThanOrEqual(.3 * track - 1e-9);
          expect(Math.abs(lamp.x), model).toBeLessThanOrEqual(.5 * track + 1e-9);
          // Mid-engined supercars carry their rear lamp ends down at the diffuser (about 0.33 m).
          expect(lamp.y, model).toBeGreaterThan(.3);
          // High full-width tail bars (the mid-size SUV) reach about 71 % of the roof height.
          expect(lamp.y, model).toBeLessThan(height * .72);
          // The lens edge sits within 35 cm of the measured bumper (the sports car has a long nose).
          if (front) expect(Math.abs(lamp.z - length / 2), model).toBeLessThan(.35);
          // The rigid truck's tail lamps sit on the chassis, 0.8 m ahead of the box doors.
          else expect(Math.abs(lamp.z + length / 2), model).toBeLessThan(VEHICLE_CATALOG.find(vehicle => vehicle.model === model)?.trafficOnly ? .9 : .35);
        }
      }
    }
  });

  it('aims the real headlight spot from the traffic cars’ measured lamp height down their own lane', async () => {
    const published = await publishedLampAnchors();
    // Every network lane with every vehicle that drives today (the connected network replaced per-lane schedules).
    const pool = trafficPool(DAILY_CATALOG), driving = new Set([...pool.cars, ...pool.long].map(vehicle => vehicle.model));
    for (const lane of TRAFFIC_LANES) for (const model of driving) {
      const lamps = published.get(model)!;
      const yaw = Math.atan2(lane.to[0] - lane.from[0], lane.to[1] - lane.from[1]);
      const pose = { x: (lane.from[0] + lane.to[0]) / 2, y: lane.top + .015, z: (lane.from[1] + lane.to[1]) / 2, yaw };
      const { position, aim } = headlightSpotAim(pose, lamps, lane.top);
      expect(position.y - pose.y).toBeCloseTo((lamps.head[0].y + lamps.head[1].y) / 2);
      // Both points stay on the lane's centreline (the car's axis), the aim 12 m ahead on the asphalt.
      const across = (p: { x: number; z: number }) => (p.x - pose.x) * Math.cos(yaw) - (p.z - pose.z) * Math.sin(yaw);
      expect(across(position)).toBeCloseTo(0);
      expect(across(aim)).toBeCloseTo(0);
      expect(aim.y).toBe(lane.top);
      const nose = carPoint(pose, { x: 0, y: 0, z: Math.max(lamps.head[0].z, lamps.head[1].z) });
      expect(Math.hypot(aim.x - nose.x, aim.z - nose.z)).toBeCloseTo(12);
    }
  });
});
