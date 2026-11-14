import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReactTypes from 'react';
import { OrthographicCamera, Vector3 } from 'three';
import { CameraView } from '../src/office/scene/CameraView';
import { CHARACTER_FOCUS_ZOOM, buildingMinimumZoom, buildingOverviewPose, characterFocusPose, floorMinimumZoom, floorOverviewPose, stackOverviewPose } from '../src/office/scene/cameraFocus';
import type { CharacterPositionSource } from '../src/office/scene/movement/positionStore';
import { createCameraDirectorState, stepCameraDirector } from '../src/office/cameraDirector';

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
  const frame = (seconds = 1) => hooks.frame({}, seconds);
  const pose = () => ({ position: camera.position.toArray(), target: controls.target.toArray(), zoom: camera.zoom });
  const manual = () => { camera.position.set(17, 24, 18); controls.target.set(-4, 2, 8); camera.zoom = 83; controls.update(); camera.updateProjectionMatrix(); return pose(); };
  render();
  return { render, frame, pose, manual, camera, controls, listeners };
}

beforeEach(() => { hooks.slots.length = 0; hooks.index = 0; hooks.layout.length = 0; hooks.effects.length = 0; vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} }); });
afterEach(() => { hooks.slots.forEach(slot => slot.cleanup?.()); vi.unstubAllGlobals(); });

describe('Office camera requests', () => {
  it('receipts explicit focus only after the final interpolated pose, once, using the latest callback', () => {
    const original = vi.fn(), latest = vi.fn();
    const point: [number, number, number] = [3, 0, 7];
    const h = harness({ focusId: 'agent', focus: point, reducedMotion: false, onFocusFinished: original });
    h.render({ focusRequest: 1 });
    expect(original).not.toHaveBeenCalled();
    h.frame(.2); h.render({ onFocusFinished: latest }); h.frame(.2);
    expect(latest).not.toHaveBeenCalled();
    h.frame(.5);
    expect(h.pose().target).toEqual(characterFocusPose(point, undefined, [210, 0]).target.map(value => expect.closeTo(value, 8)));
    expect(latest.mock.calls).toEqual([[1, true]]);
    expect(original).not.toHaveBeenCalled();
    h.frame(); h.render(); h.frame();
    expect(latest.mock.calls).toEqual([[1, true]]);
  });

  it('receipts reduced-motion focus once on its first applied frame', () => {
    const onFocusFinished = vi.fn();
    const h = harness({ focusId: 'agent', focus: [3, 0, 7], onFocusFinished });
    h.render({ focusRequest: 7 });
    expect(onFocusFinished).not.toHaveBeenCalled();
    h.frame(0);
    expect(h.pose().zoom).toBe(CHARACTER_FOCUS_ZOOM);
    expect(onFocusFinished.mock.calls).toEqual([[7, true]]);
    h.frame(); h.frame();
    expect(onFocusFinished.mock.calls).toEqual([[7, true]]);
  });

  it('never receipts passive selection, Follow, room focus or automatic director movement', () => {
    const onFocusFinished = vi.fn();
    const live = { position: () => [3, 0, 7], floor: () => 1 } as unknown as CharacterPositionSource;
    const h = harness({ onFocusFinished, live });
    h.render({ focusId: 'agent', focus: [3, 0, 7] }); h.frame();
    h.render({ following: true }); h.frame();
    h.render({ following: false, focusPoint: { point: [8, 0, 2] } }); h.frame();
    h.render({ automaticShot: { phase: 'focus', mode: 'tour', targetId: 'agent', fromId: null } }); h.frame();
    h.listeners.get('start')?.(); h.frame();
    expect(onFocusFinished).not.toHaveBeenCalled();
  });

  it('keeps an entered explicit focus alive through passive selection and seat updates', () => {
    const onFocusFinished = vi.fn();
    const h = harness({ focusId: 'agent', focus: [3, 0, 7], reducedMotion: false, onFocusFinished });
    h.render({ focusRequest: 1 }); h.frame(.2);
    h.render({ focusId: 'other', focus: [-4, 0, 9] }); h.frame(1);
    expect(onFocusFinished.mock.calls).toEqual([[1, true]]);
    expect(h.pose().target).toEqual(characterFocusPose([3, 0, 7], undefined, [210, 0]).target.map(value => expect.closeTo(value, 8)));
  });

  it('keeps explicit cross-floor focus when a suspended director clears its older shot later', () => {
    const onFocusFinished = vi.fn();
    const point: [number, number, number] = [3, 6.4, 7];
    const live = { position: (id: string) => id === 'agent' ? point : [-4, 0, 2], floor: (id: string) => id === 'agent' ? 2 : 1 } as unknown as CharacterPositionSource;
    const h = harness({ live, reducedMotion: false, onFocusFinished, automaticShot: { phase: 'focus', mode: 'tour', targetId: 'previous', fromId: null } });
    h.frame(.1);
    h.render({ view: 2, focusId: 'agent', focusRequest: 1 }); h.frame(.2);
    h.render({ automaticShot: null });
    expect(onFocusFinished).not.toHaveBeenCalled();
    h.frame(.7); h.frame(1);
    expect(onFocusFinished.mock.calls).toEqual([[1, true]]);
    const focused = h.pose(); point[0] += 2; h.frame(1);
    expect(h.pose()).toEqual(focused);
  });

  it('cancels the replaced request before completing its successor and suppresses stale success', () => {
    const onFocusFinished = vi.fn();
    const h = harness({ focusId: 'agent', focus: [3, 0, 7], reducedMotion: false, onFocusFinished });
    h.render({ focusRequest: 1 }); h.frame(.2);
    h.render({ focusRequest: 2, focus: [-4, 0, 9] });
    expect(onFocusFinished.mock.calls).toEqual([[1, false]]);
    h.frame(.2);
    expect(onFocusFinished.mock.calls).toEqual([[1, false]]);
    h.frame(1); h.frame(1);
    expect(onFocusFinished.mock.calls).toEqual([[1, false], [2, true]]);
  });

  it.each(['view', 'floor', 'room', 'automatic', 'manual'] as const)('cancels entered focus when superseded by %s', replacement => {
    const onFocusFinished = vi.fn();
    const h = harness({ focusId: 'agent', focus: [3, 0, 7], reducedMotion: false, onFocusFinished });
    h.render({ focusRequest: 1 }); h.frame(.2);
    if (replacement === 'view') h.render({ viewRequest: 1 });
    if (replacement === 'floor') h.render({ view: 2 });
    if (replacement === 'room') h.render({ focusPoint: { point: [8, 0, 2] } });
    if (replacement === 'automatic') h.render({ automaticShot: { phase: 'focus', mode: 'tour', targetId: 'agent', fromId: null }, automaticSeat: [3, 0, 7] });
    if (replacement === 'manual') h.listeners.get('start')?.();
    expect(onFocusFinished.mock.calls).toEqual([[1, false]]);
    h.frame(2); h.frame(2);
    expect(onFocusFinished.mock.calls).toEqual([[1, false]]);
  });

  it('cancels an entered focus on wheel zoom while retaining Follow', () => {
    const windowListeners = new Map<string, () => void>();
    vi.stubGlobal('window', { addEventListener: (event: string, listener: () => void) => windowListeners.set(event, listener), removeEventListener: (event: string) => windowListeners.delete(event) });
    const position: [number, number, number] = [3, 0, 7];
    const live = { position: () => position, floor: () => 1 } as unknown as CharacterPositionSource;
    const onFocusFinished = vi.fn(), onFollowEnd = vi.fn();
    const h = harness({ focusId: 'agent', live, following: true, reducedMotion: false, onFocusFinished, onFollowEnd });
    h.render({ focusRequest: 1 }); h.frame(.2);
    windowListeners.get('wheel')?.(); h.listeners.get('start')?.();
    expect(onFocusFinished.mock.calls).toEqual([[1, false]]);
    const before = h.pose(); position[0] += 2; h.frame(1);
    expect(h.pose().target[0]).toBeCloseTo(before.target[0]! + 2, 8);
    expect(onFollowEnd).not.toHaveBeenCalled();
    expect(onFocusFinished.mock.calls).toEqual([[1, false]]);
  });

  it('retains the request identity if entrance admission restarts an unfinished focus', () => {
    const onFocusFinished = vi.fn();
    const livePosition = { current: undefined as [number, number, number] | undefined };
    const live = { position: () => livePosition.current, floor: () => 1 } as unknown as CharacterPositionSource;
    const h = harness({ focusId: 'agent', focus: [3, 0, 7], live, reducedMotion: false, onFocusFinished });
    h.render({ focusRequest: 1 }); h.frame(.2);
    livePosition.current = [8, 0, 3]; h.frame(.2);
    expect(onFocusFinished).not.toHaveBeenCalled();
    h.frame(1); h.frame(1);
    expect(onFocusFinished.mock.calls).toEqual([[1, true]]);
    expect(h.pose().target).toEqual(characterFocusPose(livePosition.current, undefined, [210, 0]).target.map(value => expect.closeTo(value, 8)));
  });

  it('waits to admit a request without a position and cancels its predecessor immediately', () => {
    const onFocusFinished = vi.fn();
    const h = harness({ focusId: 'agent', focus: [3, 0, 7], reducedMotion: false, onFocusFinished });
    h.render({ focusRequest: 1 }); h.frame(.2);
    h.render({ focusRequest: 2, focusId: 'waiting', focus: undefined }); h.frame(2);
    expect(onFocusFinished.mock.calls).toEqual([[1, false]]);
    h.render({ focus: [8, 0, 3] }); h.frame(1);
    expect(onFocusFinished.mock.calls).toEqual([[1, false], [2, true]]);
  });

  it('uses the floor-aware director to pan at constant zoom, ease gently and keep following without restarting', () => {
    const positions: Record<string, [number, number, number]> = { a: [-8, 0, -4], b: [8, 0, 4] };
    const live = { position: (id: string) => positions[id], floor: () => 1 } as unknown as CharacterPositionSource;
    let state = createCameraDirectorState();
    const shot = (now: number) => {
      const result = stepCameraDirector(state, { now, enabled: true, suspended: false, lastInteractionAt: 0,
        workingIds: ['a', 'b'], attentionIds: [], random: 0, currentFloor: 1, floorOf: () => 1 });
      state = result.state; return result.command;
    };
    const h = harness({ live, reducedMotion: false });
    h.render({ automaticShot: shot(60_000), focusId: 'a' }); h.frame(2);
    const initial = h.pose();
    const next = shot(90_000);
    expect(next?.phase).toBe('focus');
    h.render({ automaticShot: next, focusId: 'b' }); h.frame(.1);
    const early = h.pose();
    expect(early.zoom).toBe(initial.zoom);
    expect(Math.abs(early.target[0]! - initial.target[0]!)).toBeLessThan(.2);
    for (let i = 0; i < 19; i++) {
      h.render({ automaticShot: next }); h.frame(.1);
      expect(h.pose().zoom).toBe(CHARACTER_FOCUS_ZOOM);
    }
    const focused = h.pose();
    expect(focused.target).toEqual(characterFocusPose(positions.b!, undefined, [210, 0]).target.map(value => expect.closeTo(value, 8)));
    positions.b![0] += 1; h.frame(.1);
    expect(h.pose().target[0]).toBeCloseTo(focused.target[0]! + 1, 8);
    h.listeners.get('start')?.();
    const manual = h.pose(); positions.b![0] += 3; h.frame(.5);
    expect(h.pose()).toEqual(manual);
  });

  it('retains the overview transition only when the next automatic target is on another floor', () => {
    const live = { position: (id: string) => id === 'a' ? [-8, 0, -4] : [8, 6.4, 4], floor: (id: string) => id === 'a' ? 1 : 2 } as unknown as CharacterPositionSource;
    const onFollowFloor = vi.fn();
    let state = createCameraDirectorState();
    const shot = (now: number, currentFloor: number) => {
      const result = stepCameraDirector(state, { now, enabled: true, suspended: false, lastInteractionAt: 0,
        workingIds: ['a', 'b'], attentionIds: [], random: 0, currentFloor, floorOf: id => live.floor(id) });
      state = result.state; return result.command;
    };
    const h = harness({ live, onFollowFloor, reducedMotion: false });
    h.render({ automaticShot: shot(60_000, 1), focusId: 'a' }); h.frame(2);
    const overview = shot(90_000, 1); expect(overview?.phase).toBe('overview');
    h.render({ automaticShot: overview }); h.frame(.8);
    expect(h.pose().zoom).toBeLessThan(CHARACTER_FOCUS_ZOOM);
    const travel = shot(90_900, 1); expect(travel?.phase).toBe('travel');
    h.render({ automaticShot: travel }); h.frame(.8);
    expect(onFollowFloor).toHaveBeenCalledWith(2);
    const focus = shot(91_800, 2); expect(focus?.phase).toBe('focus');
    h.render({ automaticShot: focus, focusId: 'b', view: 2 }); h.frame(2);
    expect(h.pose().zoom).toBe(CHARACTER_FOCUS_ZOOM);
    expect(h.pose().target[1]).toBeCloseTo(6.4 + .95, 8);
  });
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
    expect(h.pose()).toEqual(expect.objectContaining({ zoom: CHARACTER_FOCUS_ZOOM, target: characterFocusPose(position, undefined, [210, 0]).target.map(value => expect.closeTo(value, 8)), position: characterFocusPose(position, undefined, [210, 0]).position.map(value => expect.closeTo(value, 8)) }));
    const located = h.pose(); position[0] += 4; h.render({ focus: [1, 0, 0] }); h.frame(); expect(h.pose()).toEqual(located);
    const manual = h.manual(); h.render(); h.frame(); expect(h.pose()).toEqual(manual);
    h.render({ focusRequest: 2 }); h.frame(); expect(h.pose()).toEqual(expect.objectContaining({ zoom: CHARACTER_FOCUS_ZOOM, target: characterFocusPose(position, undefined, [210, 0]).target.map(value => expect.closeTo(value, 8)), position: characterFocusPose(position, undefined, [210, 0]).position.map(value => expect.closeTo(value, 8)) }));
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

  it('clamps outward zoom to the fitted view and retains close-up zoom', () => {
    const h = harness({ view: 'campus' }); const pose = h.pose();
    h.camera.zoom = 2; h.frame();
    expect(h.camera.zoom).toBeCloseTo(buildingMinimumZoom(1440, 900, pose.position as [number, number, number], pose.target as [number, number, number]), 8);
    h.camera.zoom = 260; h.frame(); expect(h.camera.zoom).toBe(260);
    for (const view of [1, 2, 3, 'stack'] as const) {
      h.render({ view, viewRequest: view === 'stack' ? 4 : view });
      const overview = h.pose();
      const minimum = floorMinimumZoom(overview.zoom);
      h.camera.zoom = 2; h.frame();
      expect(h.camera.zoom).toBeCloseTo(minimum, 8);
      expect(h.controls.minZoom).toBeCloseTo(minimum, 8);
      expect(h.pose().position).toEqual(overview.position);
      expect(h.pose().target).toEqual(overview.target);
      h.camera.zoom = 83; h.frame(); expect(h.camera.zoom).toBe(83);
    }
  });

  it('keeps the tall-phone Building pose but raises zoom only enough to cover the finite backdrop', () => {
    const h = harness({ view: 'campus' }, { width: 390, height: 844 });
    const preset = buildingOverviewPose(390, 844);
    h.frame(); expect(h.pose().position).toEqual(preset.position); expect(h.pose().target).toEqual(preset.target);
    expect(h.camera.zoom).toBeCloseTo(buildingMinimumZoom(390, 844, preset.position, preset.target), 8);
    const initial = h.pose(); h.camera.zoom = 2; h.frame(); expect(h.pose()).toEqual(initial);
  });

  it.each([[390, 844], [1920, 1080], [3840, 2160]])('scales the floor zoom-out boundary to a %i×%i viewport without blocking character focus', (width, height) => {
    const h = harness({}, { width, height });
    const minimum = Math.min(CHARACTER_FOCUS_ZOOM, floorOverviewPose(0, width, height).zoom * 0.85);
    h.camera.zoom = 2; h.frame();
    expect(h.camera.zoom).toBeCloseTo(minimum, 8);
    expect(minimum).toBeLessThanOrEqual(CHARACTER_FOCUS_ZOOM);
    h.render({ focusId: 'agent', focus: [2, 0, 4], focusRequest: 1 }); h.frame(); h.frame();
    expect(h.camera.zoom).toBe(CHARACTER_FOCUS_ZOOM);
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
