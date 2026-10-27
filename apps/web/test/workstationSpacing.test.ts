import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { createHandGoals, writeHandGoals } from '../src/office/scene/avatars/handGoals';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { deskReachForSeat } from '../src/office/scene/avatars/deskReach';
import { deskInputPlacement, deskLayout, KEYBOARD_DIMENSIONS, MOUSE_PAD, rotateXZ, EXECUTIVE_DESK_TOP, EXECUTIVE_KEYBOARD_BASE } from '../src/office/scene/interior/deskLayout';
import { OFFICE_RESOURCES } from '../src/office/scene/interior/resourceRegistry';
import { SINGLE_WORKSTATION_BLUEPRINT as SINGLE } from '../src/office/scene/interior/spatialBlueprints';
import { SingleWorkstation } from '../src/office/scene/interior/prefabs/workstations/SingleWorkstation';
import { ExecutiveWorkstation } from '../src/office/scene/interior/prefabs/workstations/ExecutiveWorkstation';
import { Monitor } from '../src/office/scene/interior/prefabs/props/Monitor';
import { MONITOR } from '../src/office/scene/interior/prefabs/props/deviceGeometry';

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const e = node as Element;
  return [e, ...elements(e.props.children as ReactNode)];
}

describe('workstation spacing', () => {
  it('keeps every office workstation mouse on the avatar right and extends the typing distance', () => {
    const desks = OFFICE_RESOURCES.filter(r => r.kind === 'workstation' && r.interaction.seatStyle === 'office');
    expect(desks.length).toBeGreaterThan(30);
    for (const desk of desks) {
      const reach = deskReachForSeat(desk.id);
      expect(reach.mouseHand, desk.id).toBe(0);
      // Derive the anatomical side independently of the desk frame helpers.
      const forward = new Vector3(Math.sin(desk.rotationY), 0, Math.cos(desk.rotationY));
      const right = forward.clone().cross(new Vector3(0, 1, 0));
      const delta = new Vector3(reach.mouse[0] - reach.keyboard[0], 0, reach.mouse[2] - reach.keyboard[2])
        .applyAxisAngle(new Vector3(0, 1, 0), desk.rotationY);
      expect(delta.dot(right), desk.id).toBeGreaterThan(0.15);
      const goals = writeHandGoals(createHandGoals(), 'mouse', 0, 0, reach, 1, 1, 0);
      expect(new Vector3(...goals.target[0]).distanceTo(new Vector3(...reach.mouseWrist)), desk.id).toBeLessThan(0.003);
      expect(reach.keyboard[2], desk.id).toBeGreaterThan(0.38);
      expect(reach.keyboard[2], desk.id).toBeLessThan(0.45);
      expect(reach.typeWrist[2], desk.id).toBeLessThan(reach.keyboard[2]);
    }
  });

  it('contains the keyboard and every rotated pointer-pad corner on a single desktop', () => {
    for (let i = 0; i < 500; i++) {
      const layout = deskLayout(`station-${i}`);
      const p = deskInputPlacement([0, 0.8, SINGLE.keyboardZ], 0, 0.785, layout);
      const size = KEYBOARD_DIMENSIONS[layout.keyboardKind];
      for (const [center, yaw, w, d] of [[p.keyboard, p.keyboardYaw, size.width, size.depth], [p.pad, p.mouseYaw, MOUSE_PAD.width, MOUSE_PAD.depth]] as const) {
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          const [x, z] = rotateXZ(sx * w / 2, sz * d / 2, yaw);
          expect(Math.abs(center[0] + x), `station-${i}`).toBeLessThan(SINGLE.topSize[0] / 2);
          expect(Math.abs(center[2] + z), `station-${i}`).toBeLessThan(SINGLE.topSize[2] / 2);
          if (center === p.keyboard) expect(SINGLE.topSize[2] / 2 - (center[2] + z), `station-${i} palm-rest strip`).toBeGreaterThan(0.105);
        }
      }
    }
  });

  it('varies the mouse within its pad while preserving support and distance from the keyboard', () => {
    const layouts = Array.from({ length: 500 }, (_, i) => deskLayout(`station-${i}`));
    expect(new Set(layouts.map(l => l.mouseOnPad[0].toFixed(4))).size).toBeGreaterThan(30);
    expect(new Set(layouts.map(l => l.mouseOnPad[1].toFixed(4))).size).toBeGreaterThan(30);
    for (const layout of layouts) {
      expect(Math.abs(layout.mouseOnPad[0]) + 0.064 / 2).toBeLessThan(MOUSE_PAD.width / 2);
      expect(Math.abs(layout.mouseOnPad[1]) + 0.116 / 2).toBeLessThan(MOUSE_PAD.depth / 2);
    }
  });

  it('leaves a visible gap between the executive keyboard and main monitor base', () => {
    const screens = [1, 2, 3].map(() => ({ title: 'Test', subtitle: '', status: 'STANDBY' as const }));
    const node = ExecutiveWorkstation({ screens: screens as [typeof screens[number], typeof screens[number], typeof screens[number]], leaderResourceId: 'executive.leader', plant: false, includeCabinet: false });
    const main = elements(node).find(e => e.type === Monitor && e.props.slot === 1)!;
    const position = main.props.position as [number, number, number];
    const keys = deskInputPlacement(EXECUTIVE_KEYBOARD_BASE, Math.PI, EXECUTIVE_DESK_TOP, deskLayout('executive.leader'));
    expect(position[2] - MONITOR.baseDepth / 2 - (keys.keyboard[2] + KEYBOARD_DIMENSIONS[keys.keyboardKind].depth / 2)).toBeGreaterThan(0.20);
    expect(position[2] + 0.81).toBeGreaterThan(0.75);
  });

  it('keeps PC and dual-monitor bases behind the keyboard and supported by the desk', () => {
    for (const device of ['all-in-one', 'dual-monitor'] as const) {
      const node = SingleWorkstation({ device });
      const screens = elements(node).filter(e => e.type === Monitor);
      expect(screens.length).toBe(device === 'dual-monitor' ? 2 : 1);
      for (const screen of screens) {
        const p = screen.props.position as [number, number, number];
        expect(p[2] + MONITOR.baseDepth / 2).toBeLessThan(SINGLE.keyboardZ - KEYBOARD_DIMENSIONS.full.depth / 2 - 0.05);
        expect(Math.abs(p[2]) + MONITOR.baseDepth / 2).toBeLessThan(SINGLE.topSize[2] / 2);
      }
    }
  });

  it('varies the two executive pointers while preserving their right-hand side', () => {
    const a = deskReachForSeat('executive.leader'), b = deskReachForSeat('executive-studio.ceo');
    expect(a.mouse).not.toEqual(b.mouse);
    expect(a.mouseHand).toBe(0); expect(b.mouseHand).toBe(0);
  });
});
