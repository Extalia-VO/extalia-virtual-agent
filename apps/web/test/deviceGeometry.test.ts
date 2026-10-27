import { describe, expect, it } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { Euler, Vector3 } from 'three';
import { LAPTOP, LAPTOP_LID_CENTER, MONITOR, monitorBankLayout, inLaptopScreenFrame } from '../src/office/scene/interior/prefabs/props/deviceGeometry';
import { Laptop } from '../src/office/scene/interior/prefabs/props/Laptop';
import { LaptopStand } from '../src/office/scene/interior/prefabs/props/DeskOrganizers';
import { Monitor } from '../src/office/scene/interior/prefabs/props/Monitor';
import { SmartScreen } from '../src/office/scene/interior/prefabs/screens/SmartScreen';
import { KEYBOARD_HEIGHT } from '../src/office/scene/interior/deskLayout';
import { Keyboard } from '../src/office/scene/interior/prefabs/props/Keyboard';
import { SingleWorkstation } from '../src/office/scene/interior/prefabs/workstations/SingleWorkstation';
import { TouchdownDesk } from '../src/office/scene/interior/prefabs/workspace/TouchdownDesk';
import { ExecutiveWorkstation } from '../src/office/scene/interior/prefabs/workstations/ExecutiveWorkstation';
import { TeamPod4 } from '../src/office/scene/interior/prefabs/workstations/TeamPod4';
import { RECEPTION_DESK_BLUEPRINT, SINGLE_WORKSTATION_BLUEPRINT } from '../src/office/scene/interior/spatialBlueprints';

type Element = ReactElement<Record<string, unknown>>;

function childrenOf(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(childrenOf);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...childrenOf(element.props.children as ReactNode)];
}

const close = (a: number, b: number, precision = 8) => expect(a).toBeCloseTo(b, precision);

/**
 * Where each monitor or laptop rests: its own feet height, or for a laptop on a
 * stand, the height of the group that sets the stand on the desk (the laptop
 * itself sits at 0 on the stand's top).
 */
function deviceSupports(node: ReactNode): number[] {
  const supports: number[] = [];
  const visit = (element: Element) => {
    const direct = (Array.isArray(element.props.children) ? element.props.children : [element.props.children]).flat(Infinity);
    const stand = direct.find(child => isValidElement(child) && child.type === LaptopStand) as Element | undefined;
    if (stand && element.type === 'group') {
      const inner = childrenOf(stand.props.children as ReactNode).find(child => child.type === Laptop);
      expect(inner).toBeDefined();
      close((inner!.props.position as number[])[1]!, 0);
      supports.push((element.props.position as number[])[1]!);
      return;
    }
    if (element.type === Monitor || element.type === Laptop) { supports.push((element.props.position as number[])[1]!); return; }
    for (const child of direct) if (isValidElement(child)) visit(child as Element);
  };
  const roots = Array.isArray(node) ? node : [node];
  for (const root of roots.flat(Infinity)) if (isValidElement(root)) visit(root as Element);
  return supports;
}

describe('desk device physical geometry', () => {
  it('joins two and three equal displays into a level panoramic bank at every desk orientation', () => {
    for (const count of [2, 3] as const) for (const yaw of [0, Math.PI, Math.PI / 4]) {
      const bank = monitorBankLayout(count, .56, [.25, .8455, .04], yaw);
      const edge = (index: number, side: number) => {
        const display = bank[index]!;
        return new Vector3(side * (display.width + MONITOR.bezel) / 2, 0, MONITOR.depth / 2)
          .applyEuler(new Euler(0, display.rotationY, 0)).add(new Vector3(...display.position));
      };
      for (let index = 0; index < count - 1; index++) {
        const seam = edge(index + 1, -1).sub(edge(index, 1)).applyEuler(new Euler(0, -yaw, 0));
        close(seam.x, .008); close(seam.z, 0); close(seam.y, 0);
      }
      for (const display of bank) {
        close(display.position[1], .8455); close(display.width, .56); close(display.height, .315);
      }
    }
    const single = childrenOf(SingleWorkstation({ device: 'dual-monitor' })).filter(child => child.type === Monitor);
    expect(single.map(display => display.props.position)).toEqual(monitorBankLayout(2, .54, [0, .785, -.20]).map(display => display.position));
    const data = { title: 'Test', subtitle: 'Ready', status: 'STANDBY' };
    const executive = childrenOf(ExecutiveWorkstation({ screens: [data, data, data] })).filter(child => child.type === Monitor);
    expect(new Set(executive.map(display => display.props.width)).size).toBe(1);
    expect(new Set(executive.map(display => display.props.height)).size).toBe(1);
  });

  it('supports both reception stands behind the solid transaction counter', () => {
    const { workShelfCenter: center, workShelfSize: size, monitorOffsetsX: xs, monitorOffsetZ: z } = RECEPTION_DESK_BLUEPRINT;
    // The counter body ends at .38; the rear shelf must expose the whole stand.
    expect(center[2] - size[2] / 2).toBeGreaterThan(0.38);
    for (const [index, x] of xs.entries()) {
      for (const dx of [-MONITOR.baseWidth / 2, MONITOR.baseWidth / 2]) {
        for (const dz of [0.008 - MONITOR.baseDepth / 2, 0.008 + MONITOR.baseDepth / 2]) {
          const corner = new Vector3(dx, 0, dz).applyEuler(new Euler(0, monitorBankLayout(2, .50)[index]!.rotationY, 0));
          expect(Math.abs(x + corner.x - center[0])).toBeLessThan(size[0] / 2);
          expect(Math.abs(z + corner.z - center[2])).toBeLessThan(size[2] / 2);
        }
      }
    }
  });
  it('keeps monitor feet on the supplied tabletop and panel clearance fixed across sizes', () => {
    for (const [width, height] of [[0.42, 0.25], [0.78, 0.49]] as const) {
      const tableY = 0.8455;
      const element = Monitor({ position: [0, tableY, 0], width, height });
      const descendants = childrenOf(element);
      const screen = descendants.find(child => child.type === SmartScreen);
      expect(screen).toBeDefined();
      const screenProps = screen!.props;
      close((screenProps.position as number[])[1]! - ((screenProps.height as number) + (screenProps.bezel as number)) / 2, MONITOR.clearance);

      const base = descendants.find(child => child.type === 'mesh' &&
        childrenOf(child).some(grandchild => grandchild.type === 'boxGeometry' &&
          (grandchild.props.args as number[])[0] === MONITOR.baseWidth));
      expect(base).toBeDefined();
      const box = childrenOf(base!).find(child => child.type === 'boxGeometry')!;
      close((base!.props.position as number[])[1]! - (box.props.args as number[])[1]! / 2, 0);
      close((element.props.position as number[])[1]! + (base!.props.position as number[])[1]! - (box.props.args as number[])[1]! / 2, tableY);
    }

    const defaults = Monitor({});
    const panel = childrenOf(defaults).find(child => child.type === SmartScreen)!;
    close(panel.props.width as number, MONITOR.width);
    close((panel.props.width as number) / (panel.props.height as number), MONITOR.aspect);
  });

  it('keeps the laptop deck on the table, joins the tilted lid at its hinge, and fits the screen inside the shell', () => {
    const element = Laptop({ position: [0, 0.785, 0] });
    const descendants = childrenOf(element);
    const deck = descendants.find(child => child.type === 'mesh' &&
      childrenOf(child).some(grandchild => grandchild.type === 'boxGeometry' &&
        (grandchild.props.args as number[])[0] === LAPTOP.width && (grandchild.props.args as number[])[1] === LAPTOP.deckHeight));
    expect(deck).toBeDefined();
    const deckGeometry = childrenOf(deck!).find(child => child.type === 'boxGeometry')!;
    close((deck!.props.position as number[])[1]! - (deckGeometry.props.args as number[])[1]! / 2, 0);

    const screen = descendants.find(child => child.type === SmartScreen)!;
    const lidEdge = new Vector3(0, -LAPTOP.lidHeight / 2, 0)
      .applyEuler(new Euler(LAPTOP.tilt, 0, 0))
      .add(new Vector3(...LAPTOP_LID_CENTER));
    close(lidEdge.y, LAPTOP.deckHeight);
    close(lidEdge.z, LAPTOP.hingeZ);

    const panelWidth = (screen.props.width as number) + (screen.props.bezel as number);
    const panelHeight = (screen.props.height as number) + (screen.props.bezel as number);
    expect(panelWidth).toBeLessThan(LAPTOP.width);
    expect(panelHeight).toBeLessThan(LAPTOP.lidHeight);
    // Screen-shell back faces meet at the lid front plane without overlapping.
    close(LAPTOP.screenOffset - 0.01 / 2, LAPTOP.lidDepth / 2);
  });

  it('maps the laptop glow pool back onto the physical keyboard deck', () => {
    const screen = childrenOf(Laptop({})).find(child => child.type === SmartScreen)!;
    const pool = screen.props.deskPool as { center: readonly [number, number, number]; rotationX?: number };
    const expectedFrame = inLaptopScreenFrame(0, LAPTOP.deckHeight + 0.002, 0.025);
    pool.center.forEach((value, index) => close(value, expectedFrame[index]!));
    // The pool frame rotates points around its own centre; its centre is already
    // expressed in the tilted screen's local coordinates.
    const inScreen = new Vector3(...pool.center).add(new Vector3(0, 0, LAPTOP.screenOffset));
    const inDevice = inScreen.applyEuler(new Euler(LAPTOP.tilt, 0, 0)).add(new Vector3(...LAPTOP_LID_CENTER));
    expect(inDevice.distanceTo(new Vector3(0, LAPTOP.deckHeight + 0.002, 0.025))).toBeLessThan(1e-8);
  });

  it('keeps reusable single and touchdown device feet aligned with their shared tabletop', () => {
    const top = SINGLE_WORKSTATION_BLUEPRINT.topY + SINGLE_WORKSTATION_BLUEPRINT.topSize[1] / 2;
    for (const device of ['laptop', 'all-in-one', 'dual-monitor'] as const) {
      const supports = deviceSupports(SingleWorkstation({ device }));
      expect(supports).toHaveLength(device === 'dual-monitor' ? 2 : 1);
      for (const y of supports) close(y, top);
    }

    const data = { title: 'Test', subtitle: 'Ready', status: 'STANDBY' };
    const touchdown = childrenOf(TouchdownDesk({ data }));
    const touchdownMonitor = touchdown.find(child => child.type === Monitor)!;
    close((touchdownMonitor.props.position as number[])[1]!, top);
  });

  it('keeps every team-pod device at its raised cap and executive displays at desk level', () => {
    const pod = childrenOf(TeamPod4({
      podId: 'pod-a',
      floorState: { agents: [], allocations: [], language: 'en' },
    }));
    const stations = pod.filter(element => typeof element.type === 'function' && element.props.station);
    expect(stations.length).toBeGreaterThan(0);
    for (const station of stations) {
      const stationTree = childrenOf((station.type as (props: Record<string, unknown>) => ReactNode)(station.props));
      const deviceSet = stationTree.find(element => typeof element.type === 'function' && element.props.variant);
      expect(deviceSet).toBeDefined();
      const devices = childrenOf((deviceSet!.type as (props: Record<string, unknown>) => ReactNode)(deviceSet!.props));
      const supports = deviceSupports((deviceSet!.type as (props: Record<string, unknown>) => ReactNode)(deviceSet!.props));
      expect(supports.length).toBeGreaterThan(0);
      for (const y of supports) close(y, 0.802);
      void devices;
    }

    const data = { title: 'Test', subtitle: 'Ready', status: 'STANDBY' };
    const executive = childrenOf(ExecutiveWorkstation({ screens: [data, data, data] }));
    const keyboard = executive.find(element => element.type === Keyboard);
    expect(keyboard).toBeDefined();
    const deskPlane = 0.8455; // Physical leather blotter top.
    close((keyboard!.props.position as number[])[1]! - KEYBOARD_HEIGHT / 2, deskPlane);
    const displays = executive.filter(element => element.type === Monitor);
    expect(displays).toHaveLength(3);
    for (const display of displays) {
      const feetY = (display.props.position as number[])[1]!;
      expect(feetY).toBeGreaterThanOrEqual(deskPlane);
      expect(feetY - deskPlane).toBeLessThan(0.01);
    }
  });
});
