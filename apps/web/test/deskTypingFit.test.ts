import { describe, expect, it } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { armWrist3D, solveArm3D, type Arm3DSolution } from '../src/office/scene/avatars/armIk';
import { DEFAULT_SEAT_FORWARD, deskReachForSeat, seatRootInParent, toChildFrame } from '../src/office/scene/avatars/deskReach';
import { ExecutiveWorkstation } from '../src/office/scene/interior/prefabs/workstations/ExecutiveWorkstation';
import { SingleWorkstation } from '../src/office/scene/interior/prefabs/workstations/SingleWorkstation';
import { TouchdownDesk } from '../src/office/scene/interior/prefabs/workspace/TouchdownDesk';
import { Keyboard } from '../src/office/scene/interior/prefabs/props/Keyboard';
import { EXECUTIVE_OFFICE_BLUEPRINT, SINGLE_WORKSTATION_BLUEPRINT } from '../src/office/scene/interior/spatialBlueprints';
import { OFFICE_CHAIR_SEAT_BLUEPRINT } from '../src/office/scene/interior/furnitureSeatBlueprint';
import { KEYBOARD_DIMENSIONS, type KeyboardKind } from '../src/office/scene/interior/deskLayout';

type Element = ReactElement<Record<string, unknown>>;
type XYZ = readonly [number, number, number];

function childrenOf(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(childrenOf);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...childrenOf(element.props.children as ReactNode)];
}

function keyboardOf(node: ReactNode): Element {
  const keyboard = childrenOf(node).find(element => element.type === Keyboard);
  expect(keyboard).toBeDefined();
  return keyboard!;
}

function close(actual: number, expected: number, precision = 8) {
  expect(actual).toBeCloseTo(expected, precision);
}

function verifySeatKeyboard(node: ReactNode, seatId: string | undefined, seatRoot: readonly [number, number], yaw: number) {
  const props = keyboardOf(node).props;
  const position = props.position as XYZ;
  // Keycaps are instanced at +.021 m with a .012 m thickness above Keyboard's origin.
  const renderedKeyTop: XYZ = [position[0], position[1] + 0.021 + 0.012 / 2, position[2]];
  const reach = deskReachForSeat(seatId);
  const expected = toChildFrame(renderedKeyTop, [seatRoot[0], 0, seatRoot[1]], yaw);
  expected.forEach((value, index) => close(reach.keyboard[index]!, value));
  close(reach.typeWrist[0], reach.keyboard[0]);
  close(reach.typeWrist[1] - reach.keyboard[1], 0.05);
  expect(reach.typeWrist[2]).toBeLessThan(reach.keyboard[2]);

  // The rendered chassis takes its footprint from the keyboard kind it is given;
  // prove it sits inside the rendered single-desk top.
  const size = KEYBOARD_DIMENSIONS[(props.kind as KeyboardKind | undefined) ?? 'compact'];
  void node;
  if (seatId !== undefined) return;  // the bounds below are the single desk's top
  expect(Math.abs(position[0]) + size.width / 2).toBeLessThan(SINGLE_WORKSTATION_BLUEPRINT.topSize[0] / 2);
  expect(Math.abs(position[2]) + size.depth / 2).toBeLessThan(SINGLE_WORKSTATION_BLUEPRINT.topSize[2] / 2);
}

describe('desk typing fit', () => {
  it('keeps every single-workstation keyboard mode and touchdown keys aligned to the rendered seat frame', () => {
    const chair = SINGLE_WORKSTATION_BLUEPRINT.chairPosition;
    const root = seatRootInParent([chair[0], chair[2]], SINGLE_WORKSTATION_BLUEPRINT.chairRotationY, SINGLE_WORKSTATION_BLUEPRINT.seatForward);
    for (const device of ['laptop', 'all-in-one', 'dual-monitor'] as const) {
      verifySeatKeyboard(SingleWorkstation({ device }), undefined, root, SINGLE_WORKSTATION_BLUEPRINT.chairRotationY);
    }
    verifySeatKeyboard(TouchdownDesk({ data: { title: 'Test', subtitle: 'Ready', status: 'STANDBY' } }), undefined, root, SINGLE_WORKSTATION_BLUEPRINT.chairRotationY);
  });

  it('keeps executive keys and the shifted chair on the same rendered desk frame with armrest clearance', () => {
    const screens = [0, 1, 2].map(() => ({ title: 'Test', subtitle: 'Ready', status: 'STANDBY' as const })) as [
      { title: string; subtitle: string; status: 'STANDBY' },
      { title: string; subtitle: string; status: 'STANDBY' },
      { title: string; subtitle: string; status: 'STANDBY' },
    ];
    const workstation = ExecutiveWorkstation({ screens, plant: false, includeCabinet: false });
    const seat = EXECUTIVE_OFFICE_BLUEPRINT.leaderSeat;
    // The leader's avatar root sits the office anchor's 4 cm forward of the chair (resourceRegistry).
    verifySeatKeyboard(workstation, 'executive.leader', seatRootInParent([seat.position[0], seat.position[2]], seat.rotationY, DEFAULT_SEAT_FORWARD), seat.rotationY);

    const chair = childrenOf(workstation).find(element => typeof element.type === 'function' &&
      (element.type as { name?: string }).name === 'ExecutiveChair');
    expect(chair).toBeDefined();
    const chairPosition = chair!.props.position as XYZ;
    const padFront = chairPosition[2] + OFFICE_CHAIR_SEAT_BLUEPRINT.armPadZ + OFFICE_CHAIR_SEAT_BLUEPRINT.armPadSize[2] / 2;
    // At x=.35 the executive desktop's rear boundary is z=-.57 (the outline
    // passes from [2.16,-.57] to [-1,-.57]). The pads remain behind it.
    expect(padFront).toBeLessThan(-0.57);
    expect(-0.57 - padFront).toBeGreaterThan(0.05);
  });

  it('extends both typing hands farther across the desk while preserving elbow flex for a shorter source arm', () => {
    const reach = deskReachForSeat(undefined);
    // Representative 170 cm source-avatar arm dimensions measured in world
    // space. Shoulder anchor reflects the source GLB rest rig and seated hip.
    const upper = 0.210;
    const lower = 0.202;
    const shoulder: XYZ = [-0.168, 0.46 + 0.11 + 0.48262 * (170 / 185), -0.077];
    const solve = (goal: XYZ) => {
      const out: Arm3DSolution = { pitch: 0, elbow: 0, abduction: 0, error: 0 };
      return solveArm3D(goal[0] - shoulder[0], goal[1] - shoulder[1], goal[2] - shoulder[2], upper, lower, out);
    };
    // The left typing hand is 10.5 cm left of the alpha-block centre; using
    // the centre itself would incorrectly ask one shoulder to reach both hands.
    const leftWrist: XYZ = [reach.typeWrist[0] - 0.105, reach.typeWrist[1], reach.typeWrist[2]];
    const current = solve(leftWrist);
    const wrist: [number, number, number] = [0, 0, 0];
    armWrist3D(current.pitch, current.abduction, current.elbow, upper, lower, wrist);
    const requestedDistance = Math.hypot(leftWrist[0] - shoulder[0], leftWrist[1] - shoulder[1], leftWrist[2] - shoulder[2]);
    expect(requestedDistance).toBeLessThan(upper + lower - 0.002);
    expect(Math.abs(current.elbow)).toBeGreaterThan(0.1);
    expect(current.error).toBeLessThan(1e-4);
    close(Math.hypot(...wrist), requestedDistance, 4);

    const previousWrist: XYZ = [leftWrist[0], leftWrist[1], leftWrist[2] - 0.05];
    const previous = solve(previousWrist);
    expect(Math.abs(current.elbow)).toBeLessThan(Math.abs(previous.elbow));
    expect(reach.keyboard[2]).toBeCloseTo(0.40, 8);
  });
});
