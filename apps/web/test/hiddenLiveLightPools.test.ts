import type * as ReactTypes from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Color, Group, Object3D, OrthographicCamera, Scene, SpotLight } from 'three';
import { FixtureLighting, registerFixture } from '../src/office/scene/interior/lighting/FixtureLighting';
import { ScreenIllumination } from '../src/office/scene/interior/prefabs/screens/ScreenIllumination';
import { registerScreenEmitter } from '../src/office/scene/interior/prefabs/screens/screenEmitterRegistry';
import { setCampusOverview } from '../src/office/scene/environment/overviewLod';

type Frame = { camera: OrthographicCamera; clock: { elapsedTime: number }; size: { height: number } };
const hooks = vi.hoisted(() => ({
  frame: (_: Frame) => {}, effects: [] as (() => void | (() => void))[], cleanups: [] as (() => void)[],
  scene: undefined as Scene | undefined, tick: vi.fn(), project: vi.fn(() => 24), bake: vi.fn(), liveBeams: 6,
}));
vi.mock('react', async original => ({ ...await original<typeof ReactTypes>(),
  useMemo: (make: () => unknown) => make(), useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
}));
vi.mock('@react-three/fiber', () => ({
  useFrame: (frame: typeof hooks.frame) => { hooks.frame = frame; },
  useThree: (select?: (state: unknown) => unknown) => {
    const state = { scene: hooks.scene, gl: { shadowMap: { autoUpdate: true, needsUpdate: false } } };
    return select ? select(state) : state;
  },
}));
vi.mock('../src/office/scene/Environment', () => ({ useSolarEnvironment: () => ({
  state: { factors: { interiorLightFactor: 1, exteriorLightFactor: 1, nightFactor: 1 } }, lightsOn: false,
}) }));
vi.mock('../src/office/scene/environment/renderBudget', () => ({ getRenderBudget: () => ({ liveBeams: hooks.liveBeams, shadowRefreshSeconds: 0.5 }) }));
vi.mock('../src/office/scene/interior/prefabs/screens/screenTextureHost', () => ({ screenTextures: { tick: hooks.tick } }));
vi.mock('../src/office/scene/interior/prefabs/screens/screenView', () => ({ setScreenView: vi.fn(), projectedPanelHeight: hooks.project }));
vi.mock('../src/office/scene/interior/lighting/fixtureIrradiance', () => ({
  IRRADIANCE_GRID_DIMENSIONS: [1, 1, 1], IRRADIANCE_GRID_MIN: [0, 0, 0], IRRADIANCE_GRID_MAX: [1, 1, 1],
  bakeFixtureIrradiance: (...args: unknown[]) => { hooks.bake(...args); return { radiance: new Float32Array(4), direction: new Uint8Array(4) }; },
}));

function mount(component: typeof FixtureLighting | typeof ScreenIllumination): Group {
  const group = component().props.object as Group;
  hooks.scene!.add(group);
  for (const effect of hooks.effects.splice(0)) { const cleanup = effect(); if (cleanup) hooks.cleanups.push(cleanup); }
  return group;
}
function frame(time: number) {
  const camera = new OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  camera.position.z = 10; camera.updateMatrixWorld();
  hooks.frame({ camera, clock: { elapsedTime: time }, size: { height: 1000 } });
}
const lights = (group: Group) => group.children.filter((child): child is SpotLight => child instanceof SpotLight);

beforeEach(() => {
  vi.stubGlobal('window', {}); hooks.scene = new Scene(); hooks.liveBeams = 6;
  hooks.tick.mockClear(); hooks.project.mockClear(); hooks.bake.mockClear(); setCampusOverview(false);
});
afterEach(() => { hooks.cleanups.splice(0).reverse().forEach(cleanup => cleanup()); setCampusOverview(false); vi.unstubAllGlobals(); });

describe('hidden live-light pools', () => {
  it('keeps baked fixture light while skipping zero-budget selection, and refreshes the first revealed frame', () => {
    const anchor = new Group(), target = new Object3D();
    hooks.scene!.add(anchor, target);
    const position = vi.spyOn(anchor, 'getWorldPosition');
    hooks.cleanups.push(registerFixture({ anchor, target, color: new Color('white'), name: 'test', intensity: 5, distance: 3, angle: 1, penumbra: 0.5 }));
    setCampusOverview(true);
    const group = mount(FixtureLighting);
    frame(0);
    expect(hooks.bake).toHaveBeenCalled();
    expect(lights(group).every(light => !light.visible && light.intensity === 0)).toBe(true);
    position.mockClear();
    frame(0.01);
    expect(position).not.toHaveBeenCalled();
    anchor.position.x = 2;
    setCampusOverview(false); frame(0.02);
    expect(position).toHaveBeenCalled();
    expect(lights(group)[0]!.position.x).toBe(2);
    expect(lights(group)[0]!.intensity).toBeGreaterThan(0);
    hooks.liveBeams = 0; position.mockClear(); frame(0.03);
    expect(position).not.toHaveBeenCalled();
    expect(lights(group).every(light => !light.visible && light.intensity === 0)).toBe(true);
    anchor.position.x = 3; hooks.liveBeams = 6; frame(0.04);
    expect(lights(group)[0]!.position.x).toBe(3);
  });

  it('continues texture ticks without projecting hidden screen lights and retargets immediately after reveal', () => {
    const screen = new Group(); hooks.scene!.add(screen);
    hooks.cleanups.push(registerScreenEmitter({ group: screen, width: 1, height: 1, depth: 0.1, intensity: 1, color: [1, 1, 1] }));
    const group = mount(ScreenIllumination);
    frame(0); expect(hooks.project).toHaveBeenCalled();
    expect(lights(group).some(light => light.intensity > 0)).toBe(true);
    setCampusOverview(true); hooks.project.mockClear(); frame(0.01); frame(0.02);
    expect(hooks.project).not.toHaveBeenCalled();
    expect(hooks.tick).toHaveBeenCalledTimes(3);
    expect(lights(group).every(light => light.intensity === 0)).toBe(true);
    screen.position.x = 4; setCampusOverview(false); frame(0.03);
    expect(hooks.project).toHaveBeenCalled();
    expect(lights(group).find(light => light.intensity > 0)!.position.x).toBe(4);
    expect(group.visible).toBe(true);
  });
});
