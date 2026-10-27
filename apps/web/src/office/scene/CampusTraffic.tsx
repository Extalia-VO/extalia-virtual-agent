/* eslint-disable react-hooks/immutability -- Instanced Three.js matrices and materials are renderer-owned mutable resources. */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Color, DynamicDrawUsage, InstancedBufferAttribute, MeshStandardMaterial, Object3D, SpotLight, type BufferGeometry, type Group, type InstancedMesh } from 'three';
import { useSolarEnvironment, type LightOverride } from './Environment';
import { createMobilityFallbackModels, disposeMobilityLibrary, useCampusMobilityModels, type MobilityGeometry } from './CampusMobilityModels';
import { CYCLE_SHELTER, EV_CHARGERS, MOBILITY_MODELS, PARKED_VEHICLES, TRAFFIC_LANES, VEHICLE_SPECS, isMobilityVehicle, trafficPose, type MobilityModel, type ParkedVehicle, type TrafficLane } from './campusMobilityLayout';

/** Only active vehicles use their photocell; stationary site fixtures respect the light control. */
export function mobilityLampPower(model: MobilityModel, night: number, override: LightOverride, moving = false): number {
  const exterior = Math.max(0, Math.min(1, night));
  return model === 'mobility-charger' || model === 'mobility-cycle-shelter'
    ? override === 'off' ? 0 : override === 'on' ? 1 : exterior
    : moving ? exterior : 0;
}

/** Batch-owned attributes must never mutate the shared loaded or fallback geometry. */
export function createMobilityLampGeometry(source: BufferGeometry, model: MobilityModel, parked: number, moving: number): BufferGeometry {
  const geometry = source.clone();
  const emission = new Float32Array(parked + moving);
  for (let i = 0; i < emission.length; i++) emission[i] = !isMobilityVehicle(model) || i >= parked ? 1 : 0;
  geometry.setAttribute('mobilityEmission', new InstancedBufferAttribute(emission, 1));
  return geometry;
}

/** A combined headlamp pair follows the authored +Z front and reaches only the nearby road. */
export function trafficHeadlightBeam(lane: TrafficLane, pose: ReturnType<typeof trafficPose>, night: number, hidden = false) {
  const forwardX = Math.sin(pose.yaw), forwardZ = Math.cos(pose.yaw);
  const front = isMobilityVehicle(lane.model) ? VEHICLE_SPECS[lane.model].length / 2 : 0;
  return {
    position: [pose.x + forwardX * (front + .04), pose.y + .64, pose.z + forwardZ * (front + .04)] as [number, number, number],
    aim: [pose.x + forwardX * (front + 5), lane.top + .015, pose.z + forwardZ * (front + 5)] as [number, number, number],
    intensity: !hidden && pose.visible ? 18 * Math.max(0, Math.min(1, night)) : 0,
  };
}

interface MobilityInstances { parked: readonly ParkedVehicle[]; lanes: readonly TrafficLane[] }
const instances = new Map<MobilityModel, MobilityInstances>(MOBILITY_MODELS.map(model => [model, {
  parked: [...PARKED_VEHICLES, ...EV_CHARGERS, CYCLE_SHELTER].filter(vehicle => vehicle.model === model),
  lanes: TRAFFIC_LANES.filter(lane => lane.model === model),
}]));

function visibleInHierarchy(object: Object3D | null): boolean {
  for (let node = object; node; node = node.parent) if (!node.visible) return false;
  return object !== null;
}

function MobilityBatch({ model, geometry }: { model: MobilityModel; geometry: MobilityGeometry }) {
  const { state, lightOverride, reducedMotion } = useSolarEnvironment();
  const body = useRef<InstancedMesh>(null), lamp = useRef<InstancedMesh>(null);
  const group = useRef<Group>(null);
  const time = useRef(0);
  const config = instances.get(model)!;
  const count = config.parked.length + config.lanes.length;
  const scratch = useMemo(() => new Object3D(), []);
  const lampGeometry = useMemo(() => createMobilityLampGeometry(geometry.lamp, model, config.parked.length, config.lanes.length), [geometry.lamp, model, config]);
  useEffect(() => () => lampGeometry.dispose(), [lampGeometry]);
  const headlights = useMemo(() => config.lanes.map(lane => {
    const light = new SpotLight('#fff0d7', 0, 9, .4, .7, 2);
    light.name = `${lane.id}-short-headlight-beam`;
    light.castShadow = false;
    return light;
  }), [config]);
  useEffect(() => () => headlights.forEach(light => light.dispose()), [headlights]);
  const materials = useMemo(() => {
    const body = new MeshStandardMaterial({ name: `campus-${model}-body`, color: '#ffffff', vertexColors: true, metalness: .25, roughness: .42 });
    const lamp = new MeshStandardMaterial({ name: `campus-${model}-lamp`, color: '#ffffff', vertexColors: true, emissive: '#ffffff', emissiveIntensity: 0, roughness: .3, toneMapped: false });
    // Standard emissive radiance otherwise ignores vertex colours, turning red
    // tail lamps and green charging indicators white when their power rises.
    lamp.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float mobilityEmission;\nvarying float vMobilityEmission;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMobilityEmission = mobilityEmission;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vMobilityEmission;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vMobilityEmission;\n#ifdef USE_COLOR\n totalEmissiveRadiance *= vColor.rgb;\n#endif');
    };
    lamp.customProgramCacheKey = () => 'campus-mobility-coloured-lamps-v2';
    return { body, lamp };
  }, [model]);
  useEffect(() => () => { materials.body.dispose(); materials.lamp.dispose(); }, [materials]);
  useEffect(() => {
    materials.lamp.emissiveIntensity = mobilityLampPower(model, state.factors.exteriorLightFactor, lightOverride, true) * 1.25;
  }, [materials, model, state.factors.exteriorLightFactor, lightOverride]);

  const update = (seconds: number, motionOff: boolean) => {
    if (!body.current || !lamp.current) return;
    config.lanes.forEach((lane, index) => {
      const pose = trafficPose(lane, seconds, motionOff);
      const light = headlights[index]!;
      const beam = trafficHeadlightBeam(lane, pose, state.factors.exteriorLightFactor, document.hidden || !visibleInHierarchy(group.current));
      light.position.set(...beam.position);
      light.target.position.set(...beam.aim);
      light.intensity = beam.intensity;
      scratch.position.set(pose.x, pose.y, pose.z);
      scratch.rotation.set(0, pose.yaw, 0);
      scratch.scale.setScalar(pose.visible ? 1 : 0);
      scratch.updateMatrix();
      body.current!.setMatrixAt(config.parked.length + index, scratch.matrix);
      lamp.current!.setMatrixAt(config.parked.length + index, scratch.matrix);
    });
    if (config.lanes.length) { body.current.instanceMatrix.needsUpdate = true; lamp.current.instanceMatrix.needsUpdate = true; }
  };

  useLayoutEffect(() => {
    if (!body.current || !lamp.current) return;
    for (const mesh of [body.current, lamp.current]) mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    config.parked.forEach((vehicle, index) => {
      scratch.position.set(vehicle.x, vehicle.y, vehicle.z);
      scratch.rotation.set(0, vehicle.yaw, 0); scratch.scale.setScalar(1); scratch.updateMatrix();
      body.current!.setMatrixAt(index, scratch.matrix); lamp.current!.setMatrixAt(index, scratch.matrix);
      body.current!.setColorAt(index, new Color(vehicle.tone));
    });
    config.lanes.forEach((lane, index) => body.current!.setColorAt(config.parked.length + index, new Color(lane.tone)));
    if (body.current.instanceColor) body.current.instanceColor.needsUpdate = true;
    update(time.current, reducedMotion);
    body.current.instanceMatrix.needsUpdate = true; lamp.current.instanceMatrix.needsUpdate = true;
    // Geometry replacement after async load retains the same active traffic clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, config, scratch, reducedMotion]);

  useFrame((_, delta) => {
    if (!config.lanes.length) return;
    if (document.hidden || !visibleInHierarchy(group.current)) {
      headlights.forEach(light => { light.intensity = 0; });
      return;
    }
    if (!reducedMotion) time.current += Math.min(.1, Math.max(0, delta));
    update(time.current, reducedMotion);
  });
  if (!count) return null;
  return <group ref={group} name={`campus-mobility-${model}`}>
    <instancedMesh ref={body} name={`${model}-bodies`} args={[geometry.body, materials.body, count]} frustumCulled={false} />
    <instancedMesh ref={lamp} name={`${model}-lamps`} args={[lampGeometry, materials.lamp, count]} frustumCulled={false} />
    {headlights.map(light => <group key={light.name} userData={{ officeDynamic: true }}>
      <primitive object={light} /><primitive object={light.target} />
    </group>)}
  </group>;
}

/** Twenty geometry role batches and four short, shadow-free headlight beams; no parked-car lights. */
export function CampusTraffic() {
  const loaded = useCampusMobilityModels();
  const fallback = useMemo(() => createMobilityFallbackModels(), []);
  useEffect(() => () => disposeMobilityLibrary(fallback), [fallback]);
  const library = loaded ?? fallback;
  return <group name="campus-mobility" userData={{ officeCollision: false }}>
    {MOBILITY_MODELS.map(model => <MobilityBatch key={model} model={model} geometry={library.get(model)!} />)}
  </group>;
}
