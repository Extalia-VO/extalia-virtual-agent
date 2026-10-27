/* eslint-disable react-hooks/immutability -- Three.js lights, fog and background are mutable renderer objects. */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, Fog, Object3D, Vector3, type AmbientLight, type DirectionalLight, type HemisphereLight } from 'three';
import { useSolarEnvironment } from '../Environment';
import { getRenderBudget, subscribeRenderBudget } from './renderBudget';
import { nightLightOverrideWeight } from './lightOverride';

/** Where the key light aims; the campus and every floor sit around it. */
const SCENE_CENTER: [number, number, number] = [2, 0, -4];
const KEY_DISTANCE = 90;

/**
 * Sky, fog and natural light (ambient, hemisphere, one shadowed sun/moon key light).
 * Values ease towards the current profile, so dawn, dusk and theme switches fade
 * instead of jumping; reduced motion applies them at once.
 */
export function SceneLighting() {
  const { state, lightOverride, reducedMotion } = useSolarEnvironment();
  const scene = useThree(three => three.scene);
  const gl = useThree(three => three.gl);
  const ambient = useRef<AmbientLight>(null);
  const hemisphere = useRef<HemisphereLight>(null);
  const key = useRef<DirectionalLight>(null);
  const live = useMemo(() => {
    const target = new Object3D();
    target.position.set(...SCENE_CENTER);
    return { sky: new Color(), fog: new Fog('#000000', 220, 600), target, scratch: new Color(), nightScratch: new Color(), direction: new Vector3(), aim: new Vector3(), ready: false };
  }, []);

  useLayoutEffect(() => {
    const previous = { background: scene.background, fog: scene.fog };
    scene.background = live.sky;
    scene.fog = live.fog;
    return () => { scene.background = previous.background; scene.fog = previous.fog; };
  }, [scene, live]);

  useEffect(() => {
    const applyShadowBudget = () => {
      const light = key.current;
      const size = getRenderBudget().shadowMapSize;
      if (!light || light.shadow.mapSize.x === size) return;
      light.shadow.mapSize.set(size, size);
      light.shadow.map?.dispose();
      light.shadow.map = null;
      gl.shadowMap.needsUpdate = true;
    };
    applyShadowBudget();
    return subscribeRenderBudget(applyShadowBudget);
  }, [gl]);

  useFrame((_, delta) => {
    const profile = state.profile;
    const dimming = nightLightOverrideWeight(lightOverride, state.factors.nightFactor);
    const k = reducedMotion || !live.ready ? 1 : 1 - Math.exp(-Math.min(delta, 0.1) * 2.4);
    live.ready = true;
    const ease = (color: Color, hex: string, night?: string) => {
      live.scratch.set(hex);
      if (night && dimming > 0) live.scratch.lerp(live.nightScratch.set(night), dimming);
      color.lerp(live.scratch, k);
    };
    ease(live.sky, profile.sky, '#0a1019');
    ease(live.fog.color, profile.fog, '#0a1019');
    live.fog.near += (profile.fogNear - live.fog.near) * k;
    live.fog.far += (profile.fogFar - live.fog.far) * k;
    if (ambient.current) {
      ease(ambient.current.color, profile.ambient, '#1c253b');
      const targetAmbient = profile.ambientIntensity + (Math.min(0.08, profile.ambientIntensity) - profile.ambientIntensity) * dimming;
      ambient.current.intensity += (targetAmbient - ambient.current.intensity) * k;
    }
    if (hemisphere.current) {
      ease(hemisphere.current.color, profile.hemiSky, '#1b2642');
      ease(hemisphere.current.groundColor, profile.hemiGround, '#080a10');
      const targetHemi = profile.hemiIntensity + (Math.min(0.16, profile.hemiIntensity) - profile.hemiIntensity) * dimming;
      hemisphere.current.intensity += (targetHemi - hemisphere.current.intensity) * k;
    }
    const light = key.current;
    if (light) {
      const sunUp = profile.sunIntensity >= profile.moonIntensity;
      ease(light.color, sunUp ? profile.sun : profile.moon);
      const naturalKey = profile.sunIntensity + profile.moonIntensity;
      const targetKey = naturalKey + (0.18 - naturalKey) * dimming;
      light.intensity += (targetKey - light.intensity) * k;
      const [x, y, z] = state.keyDirection;
      // A sun on the horizon still lights from just above it, never from below the ground.
      live.aim.set(x, Math.max(0.05, y), z).normalize();
      if (live.direction.lengthSq() === 0) live.direction.copy(live.aim);
      else live.direction.lerp(live.aim, k).normalize();
      light.position.copy(live.target.position).addScaledVector(live.direction, KEY_DISTANCE);
    }
  });

  return <>
    <ambientLight ref={ambient} intensity={0} />
    <hemisphereLight ref={hemisphere} intensity={0} />
    <primitive object={live.target} />
    <directionalLight ref={key} target={live.target} intensity={0} castShadow
      shadow-mapSize-width={1024} shadow-mapSize-height={1024} shadow-bias={-0.0002} shadow-normalBias={0.02}
      shadow-camera-left={-62} shadow-camera-right={62} shadow-camera-top={62} shadow-camera-bottom={-62}
      shadow-camera-near={1} shadow-camera-far={200} />
  </>;
}
