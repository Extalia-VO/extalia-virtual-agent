/* eslint-disable react-hooks/immutability -- the light pool is a bag of mutable Three.js lights updated from the frame loop. */
import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, Group, Object3D, SpotLight, Vector3 } from 'three';
import { useSolarEnvironment } from '../../../Environment';
import { getScreenEmitters, type ScreenEmitter } from './screenEmitterRegistry';
import {
  assignLightSlots, clusterLightCandidates, screenCastStrength, screenSpotIntensity, screenSpotShape, selectScreenLights, SCREEN_LIGHT_BUDGET,
  tiltedAim, type LightCandidate,
} from './screenLightBudget';
import { projectedPanelHeight, setScreenView } from './screenView';
import { screenTextures } from './screenTextureHost';
import { isCampusOverview } from '../../../environment/overviewLod';

/** Pool lights are re-targeted this often. */
const LIGHT_INTERVAL = 0.2;

declare global {
  interface Window {
    __EXTALIA_SCREEN_RUNTIME__?: () => unknown;
    /** Development audit: every smart screen with its resolved content, power state and world position. */
    __EXTALIA_SCREENS__?: () => unknown[];
  }
}

/**
 * Screen runtime, mounted once per scene:
 *  - drives the throttled live-texture updates (at most 2 Hz per surface, 8 surfaces per frame);
 *  - holds a small, fixed pool of real spot lights and gives them to the screens that matter most
 *    right now, so keyboards, hands and desks near a lit panel pick up its colour.
 * The pool lights only work in a dark room (night with the lamps off, see `screenCastStrength`); by
 * day or with the lamps on every pool light stays at zero and the panels are emissive only.
 * The pool size never changes, so the shader light count (and program cache) stays stable.
 */
export function ScreenIllumination() {
  const { state, lightsOn } = useSolarEnvironment();
  const scene = useThree(three => three.scene);
  const cast = screenCastStrength(state.factors.nightFactor, lightsOn);
  const pool = useMemo(() => {
    const group = new Group();
    group.name = 'screen-spill-lighting';
    group.userData.officeDynamic = true;
    const lights = Array.from({ length: SCREEN_LIGHT_BUDGET }, () => {
      const light = new SpotLight(new Color('#b7d9ff'), 0, 1.9, 0.62, 1, 2);
      light.name = 'screen-spill-beam';
      light.target = new Object3D();
      group.add(light, light.target);
      return light;
    });
    return {
      group, lights, slots: Array.from({ length: SCREEN_LIGHT_BUDGET }, () => null as string | null),
      position: new Vector3(), forward: new Vector3(), scale: new Vector3(), at: new Vector3(), to: new Vector3(), tint: new Vector3(), temp: new Vector3(),
      normal: new Vector3(), ids: new WeakMap<ScreenEmitter, string>(), nextId: 1, nextUpdate: 0, spill: 0, ticks: 0, lastCandidates: 0,
    };
  }, []);
  useEffect(() => () => pool.lights.forEach(light => light.dispose()), [pool]);
  useEffect(() => { pool.spill = cast; pool.nextUpdate = 0; }, [pool, cast]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__EXTALIA_SCREEN_RUNTIME__ = () => ({
      budget: SCREEN_LIGHT_BUDGET,
      activeLights: pool.lights.filter(light => light.intensity > 0).length,
      lightIntensities: pool.lights.map(light => Math.round(light.intensity * 100) / 100),
      candidates: pool.lastCandidates,
      spill: pool.spill,
      textures: screenTextures.stats(),
      paints: screenTextures.paintCounts(),
    });
    window.__EXTALIA_SCREENS__ = () => {
      const found: unknown[] = [];
      const world = new Vector3();
      const facing = new Vector3();
      scene.traverse(node => {
        const diagnostics = node.userData.screenDiagnostics as Record<string, unknown> | undefined;
        if (!diagnostics) return;
        node.getWorldPosition(world);
        node.getWorldDirection(facing);
        const round = (value: number) => Math.round(value * 100) / 100;
        found.push({ ...diagnostics, visible: projectedPanelHeight(node, 0.4) > 0, position: [world.x, world.y, world.z].map(round), normal: [facing.x, facing.y, facing.z].map(round) });
      });
      return found;
    };
    return () => { delete window.__EXTALIA_SCREEN_RUNTIME__; delete window.__EXTALIA_SCREENS__; };
  }, [pool, scene]);

  useFrame(({ camera, clock, size }) => {
    setScreenView(camera, size.height);
    screenTextures.tick();
    // The campus view sees desks through glass only: the spill pool leaves the light set there.
    pool.group.visible = !isCampusOverview();
    if (clock.elapsedTime < pool.nextUpdate) return;
    pool.nextUpdate = clock.elapsedTime + LIGHT_INTERVAL;
    if (pool.spill <= 0.001) {
      // Daylight or lamps on: panels are emissive only, the pool throws no light.
      if (pool.lights.some(light => light.intensity !== 0)) pool.lights.forEach(light => { light.intensity = 0; });
      pool.slots.fill(null);
      pool.lastCandidates = 0;
      return;
    }

    const candidates: (LightCandidate & { emitter: ScreenEmitter; cluster?: string })[] = [];
    for (const emitter of getScreenEmitters()) {
      if (emitter.intensity <= 0.001) continue;
      const projectedHeight = projectedPanelHeight(emitter.group, emitter.height, 1.15);
      if (projectedHeight <= 0) continue;
      let id = pool.ids.get(emitter);
      if (!id) { id = `s${pool.nextId++}`; pool.ids.set(emitter, id); }
      candidates.push({
        id, emitter, intensity: emitter.intensity, projectedHeight,
        ...(emitter.priority !== undefined ? { priority: emitter.priority } : {}),
        ...(emitter.cluster ? { cluster: emitter.cluster } : {}),
      });
    }
    pool.lastCandidates = candidates.length;
    // The monitors of one desk share one light, so the budget goes to desks, not to individual panels.
    const clusters = clusterLightCandidates(candidates);
    const selected = selectScreenLights(clusters, SCREEN_LIGHT_BUDGET, new Set(pool.slots.filter((id): id is string => id !== null)));
    pool.slots = assignLightSlots(selected, pool.slots, SCREEN_LIGHT_BUDGET);
    const byId = new Map(clusters.map(cluster => [cluster.id, cluster]));
    pool.lights.forEach((light, index) => {
      const cluster = byId.get(pool.slots[index] ?? '');
      if (!cluster) { light.intensity = 0; return; }
      // Screens face their local +Z; the source and its normal follow the full world transform, including
      // a laptop lid's tilt and a wall display's rotation. A desk's light sits between its panels.
      pool.at.set(0, 0, 0); pool.normal.set(0, 0, 0); pool.tint.set(0, 0, 0);
      let total = 0, panel = 0;
      for (const member of cluster.members) {
        const emitter = candidates[member]!.emitter;
        pool.position.set(0, 0, emitter.depth / 2 + 0.035);
        emitter.group.localToWorld(pool.position);
        pool.at.add(pool.position);
        emitter.group.localToWorld(pool.forward.set(0, 0, emitter.depth / 2 + 1.035));
        pool.normal.add(pool.forward.sub(pool.position));
        pool.tint.add(pool.temp.set(emitter.color[0], emitter.color[1], emitter.color[2]).multiplyScalar(emitter.intensity));
        emitter.group.getWorldScale(pool.scale);
        panel = Math.max(panel, Math.sqrt(emitter.width * emitter.height) * pool.scale.z);
        total += emitter.intensity;
      }
      const count = cluster.members.length;
      const shape = screenSpotShape(panel);
      const [ax, ay, az] = tiltedAim([pool.normal.x, pool.normal.y, pool.normal.z], shape.tilt);
      light.position.copy(pool.at).divideScalar(count);
      light.target.position.set(light.position.x + ax * shape.throw, light.position.y + ay * shape.throw, light.position.z + az * shape.throw);
      light.distance = shape.distance;
      light.angle = shape.angle;
      light.penumbra = shape.penumbra;
      light.intensity = screenSpotIntensity(shape, total, pool.spill);
      const peak = Math.max(pool.tint.x, pool.tint.y, pool.tint.z, 1e-6);
      light.color.setRGB(pool.tint.x / peak, pool.tint.y / peak, pool.tint.z / peak);
    });
    pool.group.updateMatrixWorld(true);
  });
  return <primitive object={pool.group} />;
}
