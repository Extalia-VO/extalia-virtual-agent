import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { Color, Mesh, MeshStandardMaterial} from "three";
import { Data3DTexture, DataUtils, Group, HalfFloatType, LinearFilter, Object3D, RGBAFormat, SpotLight, Vector3 } from "three";
import { useSolarEnvironment } from "../../Environment";
import { OFFICE_BUILDING } from "../../layout";
import { bakeFixtureIrradiance, IRRADIANCE_GRID_DIMENSIONS, IRRADIANCE_GRID_MIN, IRRADIANCE_GRID_MAX, type BakedFixture } from "./fixtureIrradiance";
import { composeIrradiance, type IrradianceField } from "./composeIrradiance";
import { getScreenEmitters, screenEmitterRevision, screenEmitterUrgentRevision } from "../prefabs/screens/screenEmitterRegistry";
import { ceilingYForFloor, type CeilingFloor } from "../prefabs/architecture/ceilingMounting";
import { getRenderBudget } from "../../environment/renderBudget";
import { isCampusOverview } from "../../environment/overviewLod";
import { deviceIrradiancePower, screenCastStrength, WALL_SCREEN_SIZE } from "../prefabs/screens/screenLightBudget";

export interface RegisteredFixture {
  anchor: Group;
  target: Object3D;
  intensity: number;
  color: Color;
  distance: number;
  angle: number;
  penumbra: number;
  name: string;
  floorY?: number;
  /** Small strip samples contribute cached light without occupying a live spotlight. */
  bakedOnly?: boolean;
}
const fixtures = new Set<RegisteredFixture>();
let revision = 0;
export function registerFixture(fixture: RegisteredFixture) {
  fixtures.add(fixture); revision++;
  return () => { fixtures.delete(fixture); revision++; };
}
export function updateFixture() { revision++; }
const locationKey = (name: string, position: Vector3, target: Vector3) =>
  `${name}:${[position.x, position.y, position.z, target.x, target.y, target.z].map(n => Math.round(n * 1000)).join(",")}`;

const LIVE_BEAM_BUDGET = 6;
/**
 * Baked share of a screen's emission. Panels are dim next to room lamps: a desk monitor adds roughly
 * a tenth of a lit workspace at arm's length, so a seated person is softly lit, not glaring white.
 */
const DEVICE_IRRADIANCE_SCALE = 0.6;
/** Device bake shape for desk panels and wall displays (see `BakedFixture.frontClip`/`minDistance`). */
const DESK_DEVICE_BAKE = { angle: 1.2, penumbra: 0.9, frontClip: 0.3, minDistance: 0.75 } as const;
const WALL_DEVICE_BAKE = { angle: 1.15, penumbra: 0.9, frontClip: 0.95, minDistance: 0.6 } as const;
const EMPTY_SIZE = IRRADIANCE_GRID_DIMENSIONS[0] * IRRADIANCE_GRID_DIMENSIONS[1] * IRRADIANCE_GRID_DIMENSIONS[2] * 4;
const shaderDeclarations = `
uniform highp sampler3D fixtureRadiance;
uniform highp sampler3D fixtureDirection;
uniform float fixturePower;
uniform float fixtureSampleYOffset;
uniform vec3 fixtureMin;
uniform vec3 fixtureSize;
varying vec3 vFixtureWorldPosition;
`;

/** Static fixture illumination is cached in a shared HDR volume, not evaluated per light per pixel.
 * A small live pool adds local specular detail; moving cabins keep their own real shadowed beam. */
export function FixtureLighting() {
  const { scene, gl } = useThree();
  const { state, lightsOn } = useSolarEnvironment();
  const interiorFactor = state.factors.interiorLightFactor;
  const exteriorFactor = state.factors.exteriorLightFactor;
  const power = Math.max(interiorFactor, exteriorFactor);
  // Screens light the room only at night with the lamps off; otherwise they are emissive only.
  const devicePower = deviceIrradiancePower(screenCastStrength(state.factors.nightFactor, lightsOn));
  const cache = useMemo(() => {
    const [nx, ny, nz] = IRRADIANCE_GRID_DIMENSIONS;
    const radiance = new Data3DTexture(new Uint16Array(EMPTY_SIZE), nx, ny, nz);
    radiance.type = HalfFloatType;
    const direction = new Data3DTexture(new Uint8Array(EMPTY_SIZE).fill(128), nx, ny, nz);
    for (const texture of [radiance, direction]) {
      texture.format = RGBAFormat; texture.minFilter = LinearFilter; texture.magFilter = LinearFilter;
      texture.unpackAlignment = 1; texture.needsUpdate = true;
    }
    const group = new Group(); group.name = "architectural-live-beams";
    const lights = Array.from({ length: LIVE_BEAM_BUDGET }, () => {
      const light = new SpotLight("#fff1df", 0); light.target = new Object3D();
      group.add(light, light.target); return light;
    });
    return { radiance, direction, group, lights, uniforms: {
      fixtureRadiance: { value: radiance }, fixtureDirection: { value: direction }, fixturePower: { value: 0 },
      fixtureMin: { value: new Vector3(...IRRADIANCE_GRID_MIN) },
      fixtureSize: { value: new Vector3(...IRRADIANCE_GRID_MAX).sub(new Vector3(...IRRADIANCE_GRID_MIN)) }
    }, patched: new Map<MeshStandardMaterial, { compile: MeshStandardMaterial["onBeforeCompile"]; key: MeshStandardMaterial["customProgramCacheKey"]; cleanup: () => void }>(),
      seenRevision: -1, seenScreens: -1, seenUrgentScreens: -1, nextScreens: 0, nextScan: 0, nextBake: 0, nextPool: 0, nextShadow: 0,
      lastInterior: -1, lastExterior: -1, composedDevicePower: -1,
      architecture: undefined as IrradianceField | undefined, devices: undefined as IrradianceField | undefined,
      composedPower: -1, compositionDirty: false, deviceCount: 0, devicesByFloor: [0, 0, 0],
      shadowPositions: new Map<string, number>(), selected: new Set<RegisteredFixture>(),
      position: new Vector3(), target: new Vector3(), projected: new Vector3(), zonePosition: new Vector3(), bakeMs: 0, bakedCount: 0 };
  }, []);
  // Lamp power is applied when composing; device irradiance stays active with lamps off.
  cache.uniforms.fixturePower.value = 1;
  useEffect(() => {
    const previous = gl.shadowMap.autoUpdate;
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    return () => {
      gl.shadowMap.autoUpdate = previous;
      for (const [material, original] of cache.patched) {
        original.cleanup(); material.needsUpdate = true;
      }
      cache.radiance.dispose(); cache.direction.dispose(); cache.lights.forEach(light => light.dispose());
      if (import.meta.env.DEV) {
        delete (window as Window & { __EXTALIA_FIXTURE_LIGHTING__?: unknown; __EXTALIA_LIGHTING_AUDIT__?: unknown }).__EXTALIA_FIXTURE_LIGHTING__;
        delete (window as Window & { __EXTALIA_FIXTURE_LIGHTING__?: unknown; __EXTALIA_LIGHTING_AUDIT__?: unknown }).__EXTALIA_LIGHTING_AUDIT__;
      }
    };
  }, [cache, gl]);

  useFrame(({ camera, clock }) => {
    const elapsed = clock.elapsedTime;
    if (elapsed >= cache.nextScan) {
      cache.nextScan = elapsed + 0.5;
      scene.traverse(object => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const candidate of materials) {
          const material = candidate as MeshStandardMaterial;
          if (!material.isMeshStandardMaterial || cache.patched.has(material)) continue;
          const compile = material.onBeforeCompile, key = material.customProgramCacheKey;
          const cleanup = () => {
            material.onBeforeCompile = compile; material.customProgramCacheKey = key;
            material.removeEventListener("dispose", cleanup); cache.patched.delete(material);
          };
          cache.patched.set(material, { compile, key, cleanup });
          material.addEventListener("dispose", cleanup);
          material.onBeforeCompile = (shader, renderer) => {
            compile.call(material, shader, renderer);
            Object.assign(shader.uniforms, cache.uniforms);
            // Soffits receive soft room bounce, rather than sampling the coarse
            // cache immediately beside recessed emitters (which creates bright grid artifacts).
            shader.uniforms.fixtureSampleYOffset = { value: material.userData.officeCeilingSoffit
              ? material.userData.officeCeilingSampleYOffset ?? 0 : 0 };
            shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vFixtureWorldPosition;")
              .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>
                vec4 fixtureVertex = vec4(transformed, 1.0);
                #ifdef USE_INSTANCING
                  fixtureVertex = instanceMatrix * fixtureVertex;
                #endif
                vFixtureWorldPosition = (modelMatrix * fixtureVertex).xyz;`);
            shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\n" + shaderDeclarations)
              .replace("#include <lights_fragment_end>", `
                vec3 fixtureSamplePosition = vFixtureWorldPosition + vec3(0.0, fixtureSampleYOffset, 0.0);
                vec3 fixtureUv = (fixtureSamplePosition - fixtureMin) / fixtureSize;
                // The road ramp descends below the volume; it shares the ground-level slice.
                fixtureUv.y = max(fixtureUv.y, 0.0);
                if (fixturePower > 0.001 && all(greaterThanEqual(fixtureUv, vec3(0.0))) && all(lessThanEqual(fixtureUv, vec3(1.0)))) {
                  vec3 fixtureEnergy = texture(fixtureRadiance, fixtureUv).rgb;
                  vec3 fixtureIncoming = normalize(texture(fixtureDirection, fixtureUv).rgb * 2.0 - 1.0 + vec3(0.00001));
                  vec3 fixtureNormal = inverseTransformDirection(geometryNormal, viewMatrix);
                  float fixtureCosine = max(dot(fixtureNormal, fixtureIncoming), 0.0);
                  // Small local bounce belongs to the same finite fixture footprint.
                  irradiance += fixtureEnergy * fixturePower * (fixtureCosine * 0.82 + 0.12);
                }
                #include <lights_fragment_end>`);
          };
          material.customProgramCacheKey = () => key.call(material) + ":fixture-volume-v3";
          material.needsUpdate = true;
        }
      });
    }
    // Shadow maps are reused while lights are stationary; refresh faster for a travelling cab.
    if (elapsed >= cache.nextShadow) {
      let moving = false;
      scene.traverseVisible(object => {
        const light = object as SpotLight;
        if (!light.isLight || !light.castShadow || light.intensity <= 0) return;
        light.getWorldPosition(cache.position);
        const previous = cache.shadowPositions.get(light.uuid);
        if (previous !== undefined && Math.abs(previous - cache.position.y) > 0.005) moving = true;
        cache.shadowPositions.set(light.uuid, cache.position.y);
      });
      gl.shadowMap.needsUpdate = true;
      cache.nextShadow = elapsed + (moving ? 1 / 12 : getRenderBudget().shadowRefreshSeconds);
    }
    const factorChanged = cache.lastInterior !== interiorFactor || cache.lastExterior !== exteriorFactor;
    if (power > 0.001 && (factorChanged || (cache.seenRevision !== revision && elapsed >= cache.nextBake))) {
      const started = performance.now();
      const sources: BakedFixture[] = [];
      const bakedLocations = new Set<string>();
      for (const fixture of fixtures) {
        if (fixture.intensity <= 0.001) continue;
        fixture.anchor.getWorldPosition(cache.position); fixture.target.getWorldPosition(cache.target);
        const key = locationKey(fixture.name, cache.position, cache.target);
        // Campus/stack and focused-floor views can mount the same physical stair twice.
        if (bakedLocations.has(key)) continue;
        bakedLocations.add(key);
        let bounds: BakedFixture["bounds"];
        for (let ancestor: Object3D | null = fixture.anchor; ancestor; ancestor = ancestor.parent) {
          const zone = ancestor.userData.officeLightZone as [number, number] | undefined;
          if (zone) {
            ancestor.getWorldPosition(cache.zonePosition);
            bounds = { west: cache.zonePosition.x - zone[0] / 2, east: cache.zonePosition.x + zone[0] / 2,
              north: cache.zonePosition.z - zone[1] / 2, south: cache.zonePosition.z + zone[1] / 2 };
            break;
          }
        }
        sources.push({ position: cache.position.toArray() as [number, number, number], aim: cache.target.toArray() as [number, number, number],
          intensity: fixture.intensity / power, color: [fixture.color.r, fixture.color.g, fixture.color.b],
          distance: fixture.distance, angle: fixture.angle, penumbra: fixture.penumbra, bounds,
          floorY: fixture.floorY ?? Math.max(0, Math.floor(cache.position.y / 6.4) * 6.4),
          excludeBounds: cache.position.x < OFFICE_BUILDING.west || cache.position.x > OFFICE_BUILDING.east ||
            cache.position.z < OFFICE_BUILDING.north || cache.position.z > OFFICE_BUILDING.south
            ? { west: OFFICE_BUILDING.west, east: OFFICE_BUILDING.east, north: OFFICE_BUILDING.north, south: OFFICE_BUILDING.south }
            : undefined });
      }
      cache.architecture = bakeFixtureIrradiance(sources);
      cache.bakedCount = sources.length;
      cache.compositionDirty = true;
      cache.bakeMs = performance.now() - started;
      cache.seenRevision = revision; cache.nextBake = elapsed + 0.6;
      cache.lastInterior = interiorFactor; cache.lastExterior = exteriorFactor;
    }
    // Device light is only baked while it can show; by day or with lamps on the panels cast nothing.
    if (devicePower > 0 && (cache.devices === undefined || (cache.seenScreens !== screenEmitterRevision() &&
        (elapsed >= cache.nextScreens || cache.seenUrgentScreens !== screenEmitterUrgentRevision())))) {
      const sources: BakedFixture[] = [];
      const floors = [0, 0, 0];
      for (const screen of getScreenEmitters()) {
        if (screen.intensity <= 0.001) continue;
        screen.group.localToWorld(cache.position.set(0, 0, screen.depth / 2 + 0.035));
        screen.group.localToWorld(cache.target.set(0, 0, screen.depth / 2 + 1));
        let bounds: BakedFixture["bounds"];
        for (let ancestor: Object3D | null = screen.group; ancestor; ancestor = ancestor.parent) {
          const zone = ancestor.userData.officeLightZone as [number, number] | undefined;
          if (zone) {
            ancestor.getWorldPosition(cache.zonePosition);
            bounds = { west: cache.zonePosition.x - zone[0] / 2, east: cache.zonePosition.x + zone[0] / 2,
              north: cache.zonePosition.z - zone[1] / 2, south: cache.zonePosition.z + zone[1] / 2 };
            break;
          }
        }
        const floor = Math.max(0, Math.min(2, Math.floor(cache.position.y / 6.4)));
        floors[floor]!++;
        // Forward-only: a cone under 90° plus a front clip, so nothing lands behind a panel or its wall.
        const shape = Math.sqrt(screen.width * screen.height) >= WALL_SCREEN_SIZE ? WALL_DEVICE_BAKE : DESK_DEVICE_BAKE;
        sources.push({ position: cache.position.toArray() as [number, number, number],
          aim: cache.target.toArray() as [number, number, number], intensity: screen.intensity * DEVICE_IRRADIANCE_SCALE,
          color: [...screen.color], distance: Math.min(7.5, Math.max(3.2, Math.sqrt(screen.width * screen.height) * 3.4)),
          angle: shape.angle, penumbra: shape.penumbra, frontClip: shape.frontClip, minDistance: shape.minDistance, floorY: floor * 6.4,
          ceilingY: floor * 6.4 + ceilingYForFloor((floor + 1) as CeilingFloor), bounds });
      }
      cache.devices = bakeFixtureIrradiance(sources);
      cache.deviceCount = sources.length; cache.devicesByFloor = floors;
      cache.compositionDirty = true; cache.seenScreens = screenEmitterRevision(); cache.nextScreens = elapsed + 1;
      cache.seenUrgentScreens = screenEmitterUrgentRevision();
    }
    if (cache.compositionDirty || cache.composedPower !== power || cache.composedDevicePower !== devicePower) {
      composeIrradiance(cache.architecture, cache.devices, power,
        cache.radiance.image.data as Uint16Array, cache.direction.image.data as Uint8Array, devicePower);
      cache.radiance.needsUpdate = true; cache.direction.needsUpdate = true;
      cache.compositionDirty = false; cache.composedPower = power; cache.composedDevicePower = devicePower;
    }
    if (elapsed >= cache.nextPool) {
      cache.nextPool = elapsed + 0.25;
      const candidates: { fixture: RegisteredFixture; score: number }[] = [];
      const liveLocations = new Set<string>();
      for (const fixture of fixtures) {
        if (fixture.bakedOnly) continue;
        let visible = fixture.intensity > 0.001;
        for (let ancestor: Object3D | null = fixture.anchor; visible && ancestor; ancestor = ancestor.parent) visible = ancestor.visible;
        if (!visible) continue;
        fixture.anchor.getWorldPosition(cache.position);
        fixture.target.getWorldPosition(cache.target);
        const key = locationKey(fixture.name, cache.position, cache.target);
        if (liveLocations.has(key)) continue;
        liveLocations.add(key);
        cache.projected.copy(cache.position).project(camera);
        if (cache.projected.z < -1 || cache.projected.z > 1 || Math.abs(cache.projected.x) > 1.2 || Math.abs(cache.projected.y) > 1.2) continue;
        const distance = camera.position.distanceTo(cache.position);
        // Sub-metre task pools need live detail because they are smaller than a cache cell.
        const taskDetail = fixture.distance <= 1.6 ? 5 : 1;
        candidates.push({ fixture, score: Math.sqrt(fixture.intensity) / Math.max(1, distance) * taskDetail * (cache.selected.has(fixture) ? 1.2 : 1) });
      }
      candidates.sort((a, b) => b.score - a.score); cache.selected.clear();
      // The adaptive render budget may drop the live pool; hidden lights leave the shaders entirely.
      // The campus view sees the interior through glass: baked pools only (see `isCampusOverview`).
      const budget = isCampusOverview() ? 0 : Math.min(LIVE_BEAM_BUDGET, getRenderBudget().liveBeams);
      cache.lights.forEach((light, i) => {
        light.visible = i < budget;
        const fixture = i < budget ? candidates[i]?.fixture : undefined;
        if (!fixture) { light.intensity = 0; return; }
        cache.selected.add(fixture); light.name = fixture.name;
        fixture.anchor.getWorldPosition(light.position); fixture.target.getWorldPosition(light.target.position);
        light.intensity = fixture.intensity * (fixture.distance <= 1.6 ? 1 : 0.18); light.color.copy(fixture.color);
        light.distance = fixture.distance; light.angle = fixture.angle; light.penumbra = fixture.penumbra;
      });
      cache.group.updateMatrixWorld(true);
      if (import.meta.env.DEV) (window as Window & { __EXTALIA_FIXTURE_LIGHTING__?: unknown; __EXTALIA_LIGHTING_AUDIT__?: unknown }).__EXTALIA_FIXTURE_LIGHTING__ = {
        registeredFixtures: fixtures.size, uniqueBakedFixtures: cache.bakedCount, liveBeamBudget: budget,
        screenEmitters: cache.deviceCount, screensByFloor: cache.devicesByFloor, devicePower,
        liveBeams: cache.lights.filter(light => light.intensity > 0).length, bakeMs: Math.round(cache.bakeMs),
        volumeDimensions: IRRADIANCE_GRID_DIMENSIONS, power
      };
      if (import.meta.env.DEV) (window as Window & { __EXTALIA_FIXTURE_LIGHTING__?: unknown; __EXTALIA_LIGHTING_AUDIT__?: unknown }).__EXTALIA_LIGHTING_AUDIT__ = (points: [number, number, number][]) => {
        const dims = IRRADIANCE_GRID_DIMENSIONS;
        const values = cache.radiance.image.data as Uint16Array;
        const result = points.map(point => {
          const coordinates = point.map((value, axis) =>
            (value - IRRADIANCE_GRID_MIN[axis]!) / (IRRADIANCE_GRID_MAX[axis]! - IRRADIANCE_GRID_MIN[axis]!) * dims[axis]! - 0.5);
          let r = 0, g = 0, b = 0;
          for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) for (let dz = 0; dz < 2; dz++) {
            const offsets = [dx, dy, dz];
            let weight = 1;
            const cell = coordinates.map((coordinate, axis) => {
              const lower = Math.floor(coordinate), fraction = coordinate - lower;
              weight *= offsets[axis] ? fraction : 1 - fraction;
              return Math.max(0, Math.min(dims[axis]! - 1, lower + offsets[axis]!));
            });
            const index = (cell[0]! + dims[0] * (cell[1]! + dims[1] * cell[2]!)) * 4;
            r += DataUtils.fromHalfFloat(values[index]!) * weight;
            g += DataUtils.fromHalfFloat(values[index + 1]!) * weight;
            b += DataUtils.fromHalfFloat(values[index + 2]!) * weight;
          }
          return { point, cachedIrradiance: r * 0.2126 + g * 0.7152 + b * 0.0722 };
        });
        const sources = Array.from(fixtures).map(fixture => {
          fixture.anchor.getWorldPosition(cache.position); fixture.target.getWorldPosition(cache.target);
          return { name: fixture.name, position: cache.position.toArray(), aim: cache.target.toArray(), intensity: fixture.intensity };
        });
        return { points: result, sources };
      };
    }
  });
  return <primitive object={cache.group} />;
}
