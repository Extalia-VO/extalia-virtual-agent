import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReactTypes from 'react';
import { OrthographicCamera, Vector3 } from 'three';
import { CameraView } from '../src/office/scene/CameraView';
import { buildingMinimumZoom, buildingOverviewPose, characterFocusPose, floorOverviewPose, stackOverviewPose } from '../src/office/scene/cameraFocus';
import type { CharacterPositionSource } from '../src/office/scene/movement/positionStore';

type Effect = () => void | (() => void);
type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
const hooks = vi.hoisted(() => ({ slots: [] as Slot[], index: 0, layout: [] as Effect[], effects: [] as Effect[], frame: (_: unknown, _delta: number) => {}, scene: {} as Record<string, unknown> }));
function changed(slot: Slot, deps?: readonly unknown[]) { return !deps || !slot.deps || deps.some((dep, i) => !Object.is(dep, slot.deps![i])); }
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof ReactTypes>();
  const effect = (queue: Effect[]) => (run: Effect, deps?: readonly unknown[]) => {
    const slot = hooks.slots[hooks.index++] ??= {};
    if (changed(slot, deps)) { queue.push(() => { slot.cleanup?.(); slot.cleanup = run() || undefined; }); slot.deps = deps; }
  };
  return { ...actual,
    useRef: (value: unknown) => { const slot = hooks.slots[hooks.index++] ??= { value: { current: value } }; return slot.value; },
    useMemo: (make: () => unknown, deps: readonly unknown[]) => { const slot = hooks.slots[hooks.index++] ??= {}; if (changed(slot, deps)) { slot.value = make(); slot.deps = deps; } return slot.value; },
    useLayoutEffect: effect(hooks.layout), useEffect: effect(hooks.effects),
  };
});
vi.mock('@react-three/fiber', () => ({ useThree: (select: (scene: typeof hooks.scene) => unknown) => select(hooks.scene), useFrame: (run: typeof hooks.frame) => { hooks.frame = run; } }));
vi.mock('@react-three/drei', () => ({ OrbitControls: () => null }));

type Props = Parameters<typeof CameraView>[0];
function harness(initial: Partial<Props> = {}, size = { width: 1440, height: 900 }) {
  const camera = new OrthographicCamera(-size.width / 2, size.width / 2, size.height / 2, -size.height / 2, .1, 600);
  const listeners = new Map<string, () => void>();
  const controls = { target: new Vector3(), minZoom: 2, update: () => camera.lookAt(controls.target), addEventListener: (event: string, run: () => void) => listeners.set(event, run), removeEventListener: (event: string) => listeners.delete(event) };
  let props: Props = { view: 1, reducedMotion: true, ...initial };
  hooks.scene = { camera, controls, size };
  const render = (next: Partial<Props> = {}) => {
    props = { ...props, ...next }; hooks.index = 0;
    const node = CameraView(props);
    hooks.layout.splice(0).forEach(effect => effect()); hooks.effects.splice(0).forEach(effect => effect());
    return node;
  };
  const frame = () => hooks.frame({}, 1);
  const pose = () => ({ position: camera.position.toArray(), target: controls.target.toArray(), zoom: camera.zoom });
  const manual = () => { camera.position.set(17, 24, 18); controls.target.set(-4, 2, 8); camera.zoom = 83; controls.update(); camera.updateProjectionMatrix(); return pose(); };
  render();
  return { render, frame, pose, manual, camera, controls, listeners };
}

beforeEach(() => { hooks.slots.length = 0; hooks.index = 0; hooks.layout.length = 0; hooks.effects.length = 0; vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} }); });
afterEach(() => { hooks.slots.forEach(slot => slot.cleanup?.()); vi.unstubAllGlobals(); });

describe('Office camera requests', () => {
  it('preserves manual orbit, pan and zoom through character selection, details, seat/activity changes and panel resizing', () => {
    const h = harness(); const manual = h.manual();
    h.render({ focusId: 'agent', focus: [2, 0, 4] }); h.frame(); expect(h.pose()).toEqual(manual);
    h.render({ focusId: 'other', focus: [-6, 0, 2] }); h.frame(); expect(h.pose()).toEqual(manual);
    h.render({ focus: [8, 0, 9] }); h.frame(); expect(h.pose()).toEqual(manual);
    hooks.scene.size = { width: 1100, height: 760 };
    h.render(); h.frame(); expect(h.pose()).toEqual(manual);
    h.render({ focusId: null, focus: undefined }); h.frame(); expect(h.pose()).toEqual(manual);
  });

  it('Locate frames the live position once, and only another request reframes the same character', () => {
    const position: [number, number, number] = [3, 0, 7];
    const live = { position: () => position, floor: () => 1 } as unknown as CharacterPositionSource;
    const h = harness({ focusId: 'agent', focus: [0, 0, 0], live }); h.manual();
    h.render({ focusRequest: 1 }); h.frame();
    expect(h.pose()).toEqual(expect.objectContaining({ zoom: 36, target: characterFocusPose(position, undefined, [210, 0]).target.map(value => expect.closeTo(value, 8)), position: characterFocusPose(position, undefined, [210, 0]).position.map(value => expect.closeTo(value, 8)) }));
    const located = h.pose(); position[0] += 4; h.render({ focus: [1, 0, 0] }); h.frame(); expect(h.pose()).toEqual(located);
    const manual = h.manual(); h.render(); h.frame(); expect(h.pose()).toEqual(manual);
    h.render({ focusRequest: 2 }); h.frame(); expect(h.pose()).toEqual(expect.objectContaining({ zoom: 36, target: characterFocusPose(position, undefined, [210, 0]).target.map(value => expect.closeTo(value, 8)), position: characterFocusPose(position, undefined, [210, 0]).position.map(value => expect.closeTo(value, 8)) }));
  });

  it('fits each explicit floor/All floors request at the latest canvas size, including same-view reset', () => {
    const h = harness(); h.manual(); hooks.scene.size = { width: 1200, height: 720 };
    h.render({ view: 2, viewRequest: 1 }); expect(h.pose()).toEqual(floorOverviewPose(6.4, 1200, 720));
    h.manual(); h.render({ viewRequest: 2 }); expect(h.pose()).toEqual(floorOverviewPose(6.4, 1200, 720));
    h.render({ view: 'stack', viewRequest: 3 }); expect(h.pose()).toEqual(stackOverviewPose(1200, 720));
  });

  it('handles a cross-floor Locate in one commit without a later overview replacing its focus', () => {
    const point: [number, number, number] = [-5, 12.8, 9];
    const h = harness(); h.manual();
    h.render({ view: 3, viewRequest: 1, focusId: 'upstairs', focus: point, focusRequest: 1 }); h.frame();
    expect(h.pose().target).toEqual(characterFocusPose(point, undefined, [210, 0]).target.map(value => expect.closeTo(value, 8)));
    const located = h.pose(); h.render({ focus: [...point] }); h.frame(); expect(h.pose()).toEqual(located);
    hooks.scene.size = { width: 1280, height: 720 }; h.render(); h.frame(); expect(h.pose()).toEqual(located);
  });

  it('keeps the Building initial framing unchanged', () => {
    const h = harness({ view: 'campus' }); h.frame(); expect(h.pose()).toEqual(buildingOverviewPose(1440, 900));
  });

  it('clamps outward zoom only in Building mode and retains close-up zoom', () => {
    const h = harness({ view: 'campus' }); const pose = h.pose();
    h.camera.zoom = 2; h.frame();
    expect(h.camera.zoom).toBeCloseTo(buildingMinimumZoom(1440, 900, pose.position as [number, number, number], pose.target as [number, number, number]), 8);
    h.camera.zoom = 260; h.frame(); expect(h.camera.zoom).toBe(260);
    h.render({ view: 1, viewRequest: 1 }); h.camera.zoom = 2; h.frame(); expect(h.camera.zoom).toBe(2); expect(h.controls.minZoom).toBe(2);
  });

  it('keeps the tall-phone Building pose but raises zoom only enough to cover the finite backdrop', () => {
    const h = harness({ view: 'campus' }, { width: 390, height: 844 });
    const preset = buildingOverviewPose(390, 844);
    h.frame(); expect(h.pose().position).toEqual(preset.position); expect(h.pose().target).toEqual(preset.target);
    expect(h.camera.zoom).toBeCloseTo(buildingMinimumZoom(390, 844, preset.position, preset.target), 8);
    const initial = h.pose(); h.camera.zoom = 2; h.frame(); expect(h.pose()).toEqual(initial);
  });

  it('freezes outward zoom after panning beyond the ground without snapping inward, and releases it when panned back', () => {
    const h = harness({ view: 'campus' }); h.manual();
    h.camera.position.x += 1000; h.controls.target.x += 1000; h.controls.update();
    const panned = h.pose(); h.frame();
    expect(h.pose()).toEqual(panned); expect(h.controls.minZoom).toBe(panned.zoom);
    h.camera.position.x -= 1000; h.controls.target.x -= 1000; h.controls.update(); h.frame();
    expect(h.controls.minZoom).toBeLessThan(panned.zoom);
    h.camera.zoom = 20; h.frame(); expect(h.camera.zoom).toBe(20);
  });

  it('Follow tracks horizontal/vertical travel without resetting on automatic floor changes; explicit views stop it', () => {
    const position: [number, number, number] = [3, 0, 7]; let floor = 1;
    const live = { position: () => position, floor: () => floor } as unknown as CharacterPositionSource;
    const onFollowFloor = vi.fn(), onFollowEnd = vi.fn();
    const h = harness({ focusId: 'agent', focus: [0, 0, 0], live, onFollowFloor, onFollowEnd });
    h.render({ following: true }); h.frame(); const focused = h.pose();
    position[0] += 2; position[1] += 6.4; floor = 2; h.frame();
    expect(onFollowFloor).toHaveBeenCalledWith(2);
    expect(h.pose().zoom).toBe(focused.zoom);
    expect(h.pose().target).toEqual([focused.target[0]! + 2, focused.target[1]! + 6.4, focused.target[2]]);
    const tracked = h.pose(); h.render({ view: 2 }); expect(h.pose()).toEqual(tracked);
    h.render({ view: 3, viewRequest: 1 }); expect(onFollowEnd).toHaveBeenCalledOnce(); expect(h.pose()).toEqual(floorOverviewPose(12.8, 1440, 900));
  });
});
