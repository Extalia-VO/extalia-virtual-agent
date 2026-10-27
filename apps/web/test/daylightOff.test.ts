import type * as ReactTypes from 'react';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AmbientLight, DirectionalLight, HemisphereLight, Scene, type Color, type Fog, type Object3D } from 'three';
import { SceneLighting } from '../src/office/scene/environment/SceneLighting';
import { computeSceneEnvironment, type SceneEnvironmentInput, type SceneEnvironmentState } from '../src/office/scene/environment/sceneEnvironment';

type Effect = () => void | (() => void);
type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
const hooks = vi.hoisted(() => ({ slots: [] as Slot[], index: 0, layout: [] as Effect[], effects: [] as Effect[],
  frame: (_: unknown, _delta: number) => {},
  three: {} as { scene: Scene; gl: { shadowMap: { needsUpdate: boolean } } },
  environment: null as (SceneEnvironmentState & { reducedMotion: boolean }) | null,
}));
function changed(slot: Slot, deps?: readonly unknown[]) {
  return !deps || !slot.deps || deps.length !== slot.deps.length || deps.some((dep, i) => !Object.is(dep, slot.deps![i]));
}
vi.mock('react', async original => {
  const actual = await original<typeof ReactTypes>();
  const effect = (queue: Effect[]) => (run: Effect, deps?: readonly unknown[]) => {
    const slot = hooks.slots[hooks.index++] ??= {};
    if (changed(slot, deps)) {
      queue.push(() => { slot.cleanup?.(); slot.cleanup = run() || undefined; });
      slot.deps = deps;
    }
  };
  return { ...actual,
    useRef: (value: unknown) => { const slot = hooks.slots[hooks.index++] ??= { value: { current: value } }; return slot.value; },
    useMemo: (make: () => unknown, deps: readonly unknown[]) => {
      const slot = hooks.slots[hooks.index++] ??= {};
      if (changed(slot, deps)) { slot.value = make(); slot.deps = deps; }
      return slot.value;
    },
    useEffect: effect(hooks.effects), useLayoutEffect: effect(hooks.layout),
  };
});
vi.mock('@react-three/fiber', () => ({
  useThree: (select: (state: typeof hooks.three) => unknown) => select(hooks.three),
  useFrame: (run: typeof hooks.frame) => { hooks.frame = run; },
}));
vi.mock('../src/office/scene/Environment', () => ({ useSolarEnvironment: () => hooks.environment }));

function visit(node: ReactNode, run: (element: ReactElement<Record<string, unknown>>) => void) {
  Children.forEach(node, child => {
    if (!isValidElement(child)) return;
    const element = child as ReactElement<Record<string, unknown>>;
    run(element); visit(element.props.children as ReactNode, run);
  });
}
const noon = Date.UTC(2026, 2, 20, 12, 7);
const location = { latitude: 0, longitude: 0 };
function harness(initial: SceneEnvironmentInput) {
  const scene = new Scene(), ambient = new AmbientLight(), hemisphere = new HemisphereLight(), key = new DirectionalLight();
  hooks.three = { scene, gl: { shadowMap: { needsUpdate: false } } };
  const lights = { ambientLight: ambient, hemisphereLight: hemisphere, directionalLight: key };
  scene.add(ambient, hemisphere, key);
  let input = initial;
  const render = (next: Partial<SceneEnvironmentInput> = {}, reducedMotion = true) => {
    input = { ...input, ...next };
    hooks.environment = { ...computeSceneEnvironment(input), reducedMotion };
    hooks.index = 0;
    const tree = SceneLighting();
    // Mount the JSX refs onto real Three.js lights, as R3F does before layout effects.
    visit(tree, element => {
      const light = lights[element.type as keyof typeof lights];
      if (light) {
        (element.props.ref as { current: Object3D | null }).current = light;
        if (element.props.target) key.target = element.props.target as Object3D;
      } else if (element.type === 'primitive') scene.add(element.props.object as Object3D);
    });
    hooks.layout.splice(0).forEach(effect => effect()); hooks.effects.splice(0).forEach(effect => effect());
    hooks.frame({}, 1 / 60);
    return hooks.environment;
  };
  const snapshot = () => ({
    sky: (scene.background as Color).toArray(), fog: (scene.fog as Fog).color.toArray(),
    fogNear: (scene.fog as Fog).near, fogFar: (scene.fog as Fog).far,
    ambient: ambient.color.toArray(), ambientIntensity: ambient.intensity,
    hemisphere: hemisphere.color.toArray(), ground: hemisphere.groundColor.toArray(), hemiIntensity: hemisphere.intensity,
    key: key.color.toArray(), keyIntensity: key.intensity, keyPosition: key.position.toArray(), keyTarget: key.target.position.toArray(),
  });
  render();
  return { render, snapshot, scene, ambient, hemisphere, key };
}
type Snapshot = ReturnType<ReturnType<typeof harness>['snapshot']>;
function expectSameNaturalLight(actual: Snapshot, expected: Snapshot) {
  for (const name of Object.keys(expected) as Array<keyof Snapshot>) {
    const a = actual[name], b = expected[name];
    if (Array.isArray(a) && Array.isArray(b)) a.forEach((value, axis) => expect(value, `${name}[${axis}]`).toBeCloseTo(b[axis]!, 12));
    else expect(a, name).toBeCloseTo(b as number, 12);
  }
}

beforeEach(() => { hooks.slots.length = 0; hooks.index = 0; hooks.layout.length = 0; hooks.effects.length = 0; hooks.environment = null; });
afterEach(() => { hooks.slots.forEach(slot => slot.cleanup?.()); });

describe('Light Off preserves daylight in the actual scene lights', () => {
  it('keeps the Light theme sky, fog, sun, ambient and hemisphere identical to Auto', () => {
    const h = harness({ sky: 'day', epochMs: noon, location, lightOverride: 'auto' });
    const automatic = h.snapshot(), automaticEnvironment = hooks.environment!;
    expect(automatic.keyIntensity).toBeGreaterThan(1);
    const offEnvironment = h.render({ lightOverride: 'off' });
    expectSameNaturalLight(h.snapshot(), automatic);
    expect(offEnvironment.state.position).toEqual(automaticEnvironment.state.position);
    expect(offEnvironment.state.profile).toEqual(automaticEnvironment.state.profile);
    expect(offEnvironment.state.factors.interiorLightFactor).toBe(automaticEnvironment.state.factors.interiorLightFactor);
    h.render({ lightOverride: 'auto' }); expectSameNaturalLight(h.snapshot(), automatic);
  });

  it('preserves the real Solar noon sun and daylight fill when Off is selected', () => {
    const h = harness({ sky: 'sun', epochMs: noon, location, lightOverride: 'auto' });
    const automatic = h.snapshot(), solar = hooks.environment!;
    expect(solar.state.position.elevation).toBeGreaterThan(80);
    expect(solar.state.factors.nightFactor).toBe(0);
    const off = h.render({ lightOverride: 'off' });
    expectSameNaturalLight(h.snapshot(), automatic);
    expect(off.state.position).toEqual(solar.state.position);
    expect(off.state.keyDirection).toEqual(solar.state.keyDirection);
    expect(off.state.profile).toEqual(solar.state.profile);
    expect(off.state.factors.interiorLightFactor).toBe(solar.state.factors.interiorLightFactor);
  });

  it('still darkens Dark-theme nights and restores them without changing the sky profile or clock', () => {
    const h = harness({ sky: 'night', epochMs: noon, location, lightOverride: 'auto' });
    const automatic = h.snapshot(), night = hooks.environment!;
    const off = h.render({ lightOverride: 'off' }), dark = h.snapshot();
    expect(dark.keyIntensity).toBeLessThan(automatic.keyIntensity);
    expect(dark.ambientIntensity).toBeLessThan(automatic.ambientIntensity);
    expect(dark.hemiIntensity).toBeLessThan(automatic.hemiIntensity);
    expect(dark.sky.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(automatic.sky.reduce((sum, value) => sum + value, 0) + 1e-12);
    expect(dark.fog.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(automatic.fog.reduce((sum, value) => sum + value, 0) + 1e-12);
    expect(dark.keyPosition).toEqual(automatic.keyPosition);
    expect(dark.keyTarget).toEqual(automatic.keyTarget);
    expect(off.state.position).toEqual(night.state.position);
    expect(off.state.profile).toEqual(night.state.profile);
    expect(off.state.sky).toBe('night');
    expect(off.state.factors.interiorLightFactor).toBe(0);
    h.render({ lightOverride: 'auto' }); expectSameNaturalLight(h.snapshot(), automatic);
    h.render({ sky: 'day', lightOverride: 'off' });
    expect(h.snapshot().keyIntensity).toBeGreaterThan(automatic.keyIntensity);
    expect(hooks.environment!.state.factors.interiorLightFactor).toBeGreaterThan(0);
  });

  it('applies the full natural daylight on the first frame even when motion easing is enabled', () => {
    const h = harness({ sky: 'day', epochMs: noon, location, lightOverride: 'off' });
    const instant = h.snapshot();
    // Fresh mount: first-frame readiness bypasses easing, independently of reduced motion.
    hooks.slots.forEach(slot => slot.cleanup?.()); hooks.slots.length = 0;
    h.render({}, false);
    expectSameNaturalLight(h.snapshot(), instant);
  });
});
