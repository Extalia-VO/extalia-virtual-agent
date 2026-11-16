import { describe, expect, it } from 'vitest';
import { isDeskChair } from '../src/office/scene/interior/deskChairs';
import type { Point3 } from '../src/office/scene/layout';
import { BEAT_S, CHAIR_FRONT_APPROACH, GRIP_STAND, chairWalkPath, chairWorld, scootPull, sittingCentre, smooth01, standPull, type ChairSide } from '../src/office/scene/movement/chairChoreography';
import { chooseChairManeuverSide, type ChairManeuverClear } from '../src/office/scene/movement/chairManeuverClearance';
import { officeNavigation, type SeatApproach } from '../src/office/scene/movement/navGraph';

const seats = officeNavigation().seats;
const engineering = seats.get('engineering.pod-a.seat-se')!;
const distance = (a: Readonly<Point3>, b: Readonly<Point3>) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const initial = (seat: SeatApproach, kind: 'sit' | 'stand'): Point3 => kind === 'stand' ? [...seat.seat] : chairWalkPath(seat, 'grip-walk', 1)[0]!;
const local = (seat: SeatApproach, point: Readonly<Point3>): readonly [number, number] => {
  const dx = point[0] - seat.seat[0], dz = point[2] - seat.seat[2], c = Math.cos(seat.rotationY), s = Math.sin(seat.rotationY);
  return [dx * c - dz * s, dx * s + dz * c];
};
/** Foreign wall, expressed in this seat's local room frame, with a swept body radius. */
const wall = (side: ChairSide): ChairManeuverClear => (seat, from, to, radius = .29) => {
  const a = local(seat, from), b = local(seat, to);
  let enter = 0, exit = 1;
  for (const [start, end, min, max] of [[a[0], b[0], side === 1 ? 1.1 : -1.3, side === 1 ? 1.3 : -1.1], [a[1], b[1], -3, 2]]) {
    const delta = end! - start!;
    if (Math.abs(delta) < 1e-9) { if (start! < min! - radius || start! > max! + radius) return true; }
    else {
      const first = (min! - radius - start!) / delta, second = (max! + radius - start!) / delta;
      enter = Math.max(enter, Math.min(first, second)); exit = Math.min(exit, Math.max(first, second));
      if (enter > exit) return true;
    }
  }
  return false;
};

describe('complete authored chair maneuver side clearance', () => {
  it.each(['sit', 'stand'] as const)('preserves both requested %s variations when all authored resources are clear', kind => {
    const resources = [...seats.values()].filter(seat => isDeskChair(seat.seatId));
    expect(resources.length).toBeGreaterThan(40);
    for (const seat of resources) for (const side of [-1, 1] as const) {
      const from = kind === 'sit' ? seat.staging : seat.seat;
      const before = structuredClone({ seat, from });
      expect(chooseChairManeuverSide(seat, kind, from, side, (owner, _a, _b, radius) => {
        expect(owner).toBe(seat); expect(radius).toBe(.29); return true;
      })).toBe(side);
      expect({ seat, from }).toEqual(before);
    }
  });

  for (const id of ['library.laptop', 'knowledge.laptop']) for (const kind of ['sit', 'stand'] as const) {
    it.each([-1, 1] as const)(`chooses the opposite ${kind} side around a foreign wall at ${id}: blocked=%s`, blocked => {
      const seat = seats.get(id)!;
      const opposite = -blocked as ChairSide;
      expect(chooseChairManeuverSide(seat, kind, initial(seat, kind), blocked, wall(blocked))).toBe(opposite);
      expect(chooseChairManeuverSide(seat, kind, initial(seat, kind), opposite, wall(blocked))).toBe(opposite);
    });
  }

  it.each(['sit', 'stand'] as const)('rejects %s when both complete maneuvers meet foreign walls', kind => {
    for (const preferred of [-1, 1] as const) expect(chooseChairManeuverSide(engineering, kind, initial(engineering, kind), preferred,
      (seat, from, to, radius) => wall(1)(seat, from, to, radius) && wall(-1)(seat, from, to, radius))).toBeNull();
  });

  it('checks the actual pull curve between its authored endpoints', () => {
    const middle = chairWorld(engineering, smooth01(.5), GRIP_STAND[0], 0, GRIP_STAND[1], [0, 0, 0], 1);
    const vertices = [chairWorld(engineering, 0, GRIP_STAND[0], 0, GRIP_STAND[1], [0, 0, 0], 1),
      chairWorld(engineering, 1, GRIP_STAND[0], 0, GRIP_STAND[1], [0, 0, 0], 1), ...chairWalkPath(engineering, 'walk-sit', 1)];
    expect(vertices.every(point => distance(point, middle) > .01)).toBe(true);
    let intermediateChecked = false;
    expect(chooseChairManeuverSide(engineering, 'sit', initial(engineering, 'sit'), 1, (_seat, _from, to) => {
      if (distance(to, middle) < 1e-8) { intermediateChecked = true; return false; }
      return true;
    })).toBe(-1);
    expect(intermediateChecked).toBe(true);
  });

  it('checks the intermediate rising and front-step curve before walking out', () => {
    const middle = chairWorld(engineering, standPull(.75), 0, 0, CHAIR_FRONT_APPROACH * smooth01((.75 - .6) / .4), [0, 0, 0], 1);
    expect(distance(middle, engineering.seat)).toBeGreaterThan(.01);
    let intermediateChecked = false;
    expect(chooseChairManeuverSide(engineering, 'stand', engineering.seat, 1, (_seat, _from, to) => {
      if (distance(to, middle) < 1e-8) { intermediateChecked = true; return false; }
      return true;
    })).toBe(-1);
    expect(intermediateChecked).toBe(true);
  });

  it.each(['lower', 'scoot', 'push'] as const)('checks intermediate %s roots as well as walking vertices', beat => {
    const kind = beat === 'push' ? 'stand' : 'sit';
    const middle = beat === 'lower' ? chairWorld(engineering, 1, 0, 0, CHAIR_FRONT_APPROACH * (1 - smooth01(.5)), [0, 0, 0], 1)
      : beat === 'scoot' ? sittingCentre(engineering, scootPull(BEAT_S.scoot * .5), [0, 0, 0], 1)
        : chairWorld(engineering, 1 - smooth01(.5), GRIP_STAND[0], 0, GRIP_STAND[1], [0, 0, 0], 1);
    let intermediateChecked = false;
    const selected = chooseChairManeuverSide(engineering, kind, initial(engineering, kind), 1, (_seat, _from, to) => {
      if (distance(to, middle) < 1e-8) { intermediateChecked = true; return false; }
      return true;
    });
    expect(intermediateChecked).toBe(true);
    expect(selected).toBe(-1);
  });

  it('rejects blocked initial access and nonfinite positions instead of changing the actor position', () => {
    const from = [...engineering.staging] as Point3;
    expect(chooseChairManeuverSide(engineering, 'sit', from, 1, () => false)).toBeNull();
    expect(from).toEqual(engineering.staging);
    expect(chooseChairManeuverSide(engineering, 'sit', [NaN, 0, 0], 1, () => true)).toBeNull();
  });
});
