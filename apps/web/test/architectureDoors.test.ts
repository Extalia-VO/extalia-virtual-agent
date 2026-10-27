import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Children, createElement, isValidElement, type ReactNode } from 'react';
import type * as ReactTypes from 'react';
import { Group, Vector3, type Object3D } from 'three';
import { OpenDoor } from '../src/office/scene/interior/prefabs/architecture/OpenDoor';
import { SlidingDoor } from '../src/office/scene/interior/prefabs/architecture/SlidingDoor';
import { GlassPartition } from '../src/office/scene/interior/prefabs/architecture/GlassPartition';
import { WindowWall } from '../src/office/scene/interior/prefabs/architecture/WindowWall';
import { SolidWall } from '../src/office/scene/interior/prefabs/architecture/SolidWall';
import { StaticCampusBatch } from '../src/office/scene/StaticCampusBatch';

const state = vi.hoisted(() => ({
  imported: false, amount: 0,
  frame: undefined as ((_: unknown, delta: number) => void) | undefined,
  cleanup: undefined as (() => void) | undefined,
  portal: vi.fn(), slideStep: vi.fn(),
}));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof ReactTypes>(),
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => (() => void)) => { state.cleanup = effect(); },
}));
vi.mock('@react-three/fiber', () => ({ useFrame: (callback: typeof state.frame) => { state.frame = callback; } }));
vi.mock('../src/office/scene/interior/occupants/movingOccupants', () => ({ setDoorPortal: state.portal }));
vi.mock('../src/office/scene/interior/doorTrafficRegistry', () => ({
  doorTraffic: { amount: () => state.amount, slideStep: state.slideStep },
}));
// Exercise each prefab across the replacement boundary, leaving loader/GLB validation to its own suite.
vi.mock('../src/office/scene/interior/ArchitecturePart', () => ({
  ArchitecturePart: ({ model, children, position, modelScale }: {
    model: string; children: ReactNode; position?: number[]; modelScale?: number[];
  }) => createElement('group', { position }, state.imported
    ? createElement('group', { name: model, scale: modelScale }) : children),
}));

type Props = {
  children?: ReactNode; name?: string; position?: number[]; rotation?: number[]; scale?: number[];
  userData?: Record<string, unknown>; ref?: { current: Object3D | null }; args?: number[];
};
function mount(node: ReactNode, parent = new Group()): Group {
  Children.forEach(node, child => {
    if (!isValidElement<Props>(child)) return;
    if (child.type === StaticCampusBatch) {
      const batch = new Group(); batch.name = 'fallback-batch'; parent.add(batch);
      mount(child.props.children, batch);
    } else if (typeof child.type === 'function') {
      mount((child.type as (props: Props) => ReactNode)(child.props), parent);
    } else {
      const object = new Group();
      object.name = child.props.name ?? String(child.type);
      if (child.props.position) object.position.fromArray(child.props.position);
      if (child.props.rotation) object.rotation.fromArray([...child.props.rotation, 'XYZ'] as [number, number, number, 'XYZ']);
      if (child.props.scale) object.scale.fromArray(child.props.scale);
      if (child.props.userData) object.userData = { ...child.props.userData };
      if (child.props.args) object.userData.args = child.props.args;
      if (child.props.ref) child.props.ref.current = object;
      parent.add(object); mount(child.props.children, object);
    }
  });
  parent.updateWorldMatrix(true, true);
  return parent;
}
function models(root: Group) {
  const found: Object3D[] = [];
  root.traverse(object => { if (object.name.startsWith('architecture-')) found.push(object); });
  return found;
}
function batches(root: Group) {
  let count = 0; root.traverse(object => { if (object.name === 'fallback-batch') count++; }); return count;
}
function dynamicLeaves(root: Group) {
  const found: Object3D[] = [];
  root.traverse(object => { if (object.userData.officeDynamic) found.push(object); }); return found;
}

beforeEach(() => {
  state.imported = false; state.amount = 0; state.frame = undefined; state.cleanup = undefined;
  state.portal.mockReset(); state.slideStep.mockReset().mockImplementation(() => state.amount);
});

describe('architecture visuals preserve live door contracts', () => {
  it.each(['left', 'right'] as const)('retains the %s hinge pivot, handle contacts and portal throughout a swing', hinge => {
    for (const glass of [false, true]) for (const imported of [false, true]) {
      state.imported = imported;
      const root = mount(OpenDoor({ floor: 2, roomId: 'room', role: 'entry', hinge, glass,
        width: 1.4, height: 2.2, openAngle: Math.PI / 2, position: [3, 4, 5], rotationY: .7 }));
      const leaf = dynamicLeaves(root)[0]!;
      expect(leaf.position.toArray()).toEqual([hinge === 'left' ? -.7 : .7, 0, 0]);
      expect(leaf.scale.toArray()).toEqual([hinge === 'left' ? 1 : -1, 1, 1]);
      expect(batches(root)).toBe(imported ? 0 : 1);
      if (imported) {
        expect(models(root).map(object => object.name)).toEqual(['architecture-hinged-frame',
          glass ? 'architecture-hinged-glass-leaf' : 'architecture-hinged-wood-leaf']);
        const authoredFrame = models(root)[0]!;
        expect(authoredFrame.scale.toArray()).toEqual([hinge === 'left' ? 1.4 : -1.4, 2.2 / 2.55, 1]);
        expect(authoredFrame.position.toArray()).toEqual([0, 0, 0]);
        // Mirroring only authored visuals leaves the passable opening and portal basis untouched.
        const portalFrame = root.getObjectByName('office-passable-door')!;
        expect(portalFrame.scale.toArray()).toEqual([1, 1, 1]);
        expect(models(root)[1]!.scale.toArray()).toEqual([1.4, 2.2 / 2.55, 1]);
      } else {
        const handles: Object3D[] = [];
        leaf.traverse(object => { if (Math.abs(object.position.z) === .1) handles.push(object); });
        expect(handles.map(handle => handle.position.toArray())).toEqual([[1.4 * .82, 1.1, -.1], [1.4 * .82, 1.1, .1]]);
      }
      for (const amount of [0, .4, 1]) {
        state.amount = amount; state.frame?.(null, 1 / 60);
        expect(leaf.rotation.y).toBe(amount * Math.PI / 2);
        const [id, portal] = state.portal.mock.lastCall!;
        expect(id).toBe('floor-2.room.entry');
        expect(portal).toMatchObject({ floor: 2, roomId: 'room', role: 'entry', center: [3, 4, 5],
          clearWidth: 1.4, height: 2.2, openAmount: amount, openAngle: Math.PI / 2, hinge, sliding: false });
        expect(portal.yaw).toBeCloseTo(.7);
      }
      state.cleanup?.(); expect(state.portal.mock.lastCall).toEqual(['floor-2.room.entry', null]);
    }
  });

  it('keeps closed sliding coverage, opposed travel, inward handles and automatic portal values in both modes', () => {
    for (const imported of [false, true]) {
      state.imported = imported;
      const root = mount(SlidingDoor({ floor: 3, roomId: 'room', role: 'slider', width: 3, height: 2.4,
        position: [2, 8, -4], rotationY: -.5 }));
      const [left, right] = dynamicLeaves(root);
      const leafWidth = 1.5 * .98;
      expect(batches(root)).toBe(imported ? 0 : 2);
      if (imported) {
        const [frame, leftModel, rightModel] = models(root);
        expect(frame!.name).toBe('architecture-sliding-frame');
        expect(leftModel!.scale.toArray()).toEqual([leafWidth, 2.4 / 2.65, 1]);
        expect(rightModel!.scale.toArray()).toEqual([-leafWidth, 2.4 / 2.65, 1]);
      } else {
        const handles: number[] = [];
        for (const leaf of [left!, right!]) leaf.traverse(object => {
          if (object.position.y === 1.15 && object.position.z === .045) handles.push(object.position.x);
        });
        expect(handles).toEqual([leafWidth / 2 - .09, -leafWidth / 2 + .09]);
      }
      for (const amount of [0, .3, 1]) {
        state.amount = amount; state.frame?.(null, 1 / 30);
        expect(left!.position.x).toBeCloseTo(-leafWidth / 2 - amount * leafWidth * .88, 12);
        expect(right!.position.x).toBeCloseTo(leafWidth / 2 + amount * leafWidth * .88, 12);
        expect(right!.position.x - left!.position.x).toBeGreaterThan(0);
        if (amount === 0) {
          expect(left!.position.x + leafWidth / 2).toBe(0);
          expect(right!.position.x - leafWidth / 2).toBe(0);
        }
        const [id, portal] = state.portal.mock.lastCall!;
        expect(id).toBe('floor-3.room.slider');
        expect(portal).toMatchObject({ floor: 3, roomId: 'room', role: 'slider', center: [2, 8, -4],
          clearWidth: 3, height: 2.4, openAmount: amount, openAngle: 0, sliding: true });
        expect(portal.yaw).toBeCloseTo(-.5);
        expect(state.slideStep.mock.lastCall?.[2]).toBe(1 / 30);
      }
      state.cleanup?.(); expect(state.portal.mock.lastCall).toEqual(['floor-3.room.slider', null]);
    }
  });

  it('repeats bounded glass panels, fits transoms, and retains the original window sill height', () => {
    state.imported = true;
    const partition = mount(GlassPartition({ width: 12, height: 3, doorGap: 2, doorHeight: 2.4 }));
    const panels = models(partition);
    expect(panels.filter(part => part.name === 'architecture-glass-panel')).toHaveLength(6);
    expect(panels.filter(part => part.name === 'architecture-glass-panel').every(part => part.scale.x <= 2.45)).toBe(true);
    const transom = panels.find(part => part.name === 'architecture-glass-transom')!;
    expect(transom.scale.x).toBe(2); expect(transom.scale.y).toBeCloseTo(.6 / .4);
    const windows = mount(WindowWall({ width: 8, height: 3.2, panels: 4 }));
    expect(models(windows)).toHaveLength(4);
    expect(models(windows).every(part => part.scale.x === 2 && part.scale.y === 3.2 / 2.55)).toBe(true);
    const sill = windows.children[0]!.children.find(part => part.position.z === .13)!;
    expect(sill.position.y).toBe(-3.2 / 2 + .04);
  });

  it('leaves full-height door openings clear while retaining shorter transoms and their fallback header', () => {
    const gap = 1.6;
    const shapes = (root: Group) => {
      const found: Object3D[] = [];
      root.traverse(object => { if (object.name === 'boxGeometry') found.push(object); });
      return found;
    };
    const centeredShapes = (root: Group) => shapes(root).filter(shape =>
      Math.abs(shape.getWorldPosition(new Vector3()).x) < .001);
    for (const imported of [false, true]) {
      state.imported = imported;
      for (const doorHeight of [2.55, 2.8]) {
        const root = mount(GlassPartition({ width: 6, height: 2.55, doorGap: gap, doorHeight }));
        expect(centeredShapes(root)).toHaveLength(0);
        expect(models(root).map(part => part.name)).toEqual(imported
          ? ['architecture-glass-panel', 'architecture-glass-panel'] : []);
        expect(shapes(root)).toHaveLength(imported ? 0 : 12);
      }
      const shorter = mount(GlassPartition({ width: 6, height: 2.55, doorGap: gap, doorHeight: 2.15 }));
      expect(models(shorter).filter(part => part.name === 'architecture-glass-panel')).toHaveLength(imported ? 2 : 0);
      if (imported) {
        expect(models(shorter).filter(part => part.name === 'architecture-glass-transom')).toHaveLength(1);
      } else {
        const center = centeredShapes(shorter);
        expect(center).toHaveLength(3);
        expect(center.map(shape => shape.userData.args[0])).toEqual([gap + .06, gap, gap + .04]);
        expect(center.map(shape => shape.getWorldPosition(new Vector3()).y)).toEqual([
          2.55 - .04, (2.55 + 2.15) / 2, 2.15 + .03,
        ]);
        expect(shapes(shorter)).toHaveLength(15);
      }
      // A shallow remaining band keeps its header, even below the transom-model threshold.
      const shallow = mount(GlassPartition({ width: 6, height: 2.55, doorGap: gap, doorHeight: 2.52 }));
      expect(centeredShapes(shallow)).toHaveLength(1);
      expect(centeredShapes(shallow)[0]!.userData.args).toEqual([gap + .06, .08, .09]);
    }
  });

  it('upgrades both wall axes and keeps non-wall structural blocks procedural', () => {
    state.imported = true;
    for (const size of [[6, 2.55, .11], [.11, 2.55, 6]] as [number, number, number][]) {
      const root = mount(SolidWall({ size }));
      expect(models(root)).toHaveLength(1);
      expect(models(root)[0]!.scale.toArray()).toEqual([6, 1, 1]);
      expect(models(root)[0]!.parent!.rotation.y).toBe(0);
      expect(root.children[0]!.children[0]!.rotation.y).toBe(size[2] > size[0] ? Math.PI / 2 : 0);
    }
    expect(models(mount(SolidWall({ size: [4, .1, 4] })))).toHaveLength(0);
  });
});
