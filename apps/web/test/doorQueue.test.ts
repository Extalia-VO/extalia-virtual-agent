import { describe, expect, it } from 'vitest';
import { DoorTraffic, doorAxes, doorHandedness, doorLeafDistance, doorPoint, TRACK_FRESH_MS, type DoorInfo, type WalkerInfo } from '../src/office/scene/interior/doorTraffic';
import type { Point3 } from '../src/office/scene/layout';

const base: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.6, height: 2.55, openAngle: Math.PI / 2, sliding: false };
function fixture(door = base) {
  let now = 0;
  const walkers = new Map<string, WalkerInfo>();
  const traffic = new DoorTraffic({ forEachDoor: visit => visit('door', door), forEachWalker: visit => walkers.forEach(visit) }, () => now);
  const point = (through: number): Point3 => doorPoint(door, 0, through, [0, 0, 0]);
  const add = (id: string, side: 1 | -1, distance = 3) => {
    const position = point(side * distance);
    walkers.set(id, { id, position, target: point(0), updatedAt: now });
    return position;
  };
  const join = (id: string, side: 1 | -1, distance = 3) => traffic.queue('door', door, id, walkers.get(id)?.position ?? point(side * distance), side);
  return { traffic, walkers, door, add, join, point, setNow(value: number) { now = value; } };
}

describe('physical door passage FIFO', () => {
  it('enrolls same-frame approaches from both directions deterministically before the caller can overtake', () => {
    const h = fixture();
    h.add('c', 1); h.add('b', -1); h.add('a', 1);
    expect(h.join('c', 1)).toMatchObject({ granted: false, index: 2 });
    expect(h.join('a', 1)).toEqual({ granted: true, index: 0, position: null });
    h.traffic.hold('door', 'a', 1, 2);
    expect(h.traffic.request('door', h.door, 'b')).toBe('wait');
    h.traffic.finishPass('door', 'a');
    expect(h.join('b', -1)).toEqual({ granted: true, index: 0, position: null });
    expect(h.traffic.request('door', h.door, 'b')).toBe('pass');
    expect(h.traffic.request('door', h.door, 'c')).toBe('wait');
    h.traffic.finishPass('door', 'b');
    expect(h.join('c', 1).granted).toBe(true);
  });

  it('keeps older opposite-side tickets ahead of a closer late arrival', () => {
    const h = fixture();
    h.add('first', 1, 2); h.join('first', 1);
    h.setNow(10); h.add('opposite', -1, 3); h.join('opposite', -1);
    h.setNow(20); h.add('late', 1, 1);
    expect(h.join('late', 1)).toMatchObject({ granted: false, index: 2 });
    h.traffic.finishPass('door', 'first');
    expect(h.join('opposite', -1).granted).toBe(true);
    expect(h.join('late', 1).granted).toBe(false);
  });

  it('retains the exclusive crossing ticket when the hand releases an already-open leaf', () => {
    const h = fixture();
    h.add('a', 1); h.add('b', -1); h.join('a', 1); h.join('b', -1);
    expect(h.traffic.claim('door', 'a')).toBe(true);
    h.traffic.hold('door', 'a', 1, 2); h.traffic.release('door', 'a');
    expect(h.traffic.request('door', h.door, 'b')).toBe('wait');
    expect(h.traffic.claim('door', 'b')).toBe(false);
    h.traffic.finishPass('door', 'a');
    expect(h.traffic.request('door', h.door, 'b')).toBe('pass');
  });

  it('preserves an in-flight operator at the head when the first waiter creates a queue', () => {
    const h = fixture();
    h.traffic.claim('door', 'operator');
    expect(h.join('waiter', -1)).toMatchObject({ granted: false, index: 1 });
    expect(h.join('operator', 1)).toMatchObject({ granted: true, index: 0 });
    h.traffic.finishPass('door', 'operator');
    expect(h.join('waiter', -1).granted).toBe(true);
  });

  it('cancels a head without immediately reenrolling its old tracked route', () => {
    const h = fixture();
    h.add('a', 1); h.add('b', -1); h.join('a', 1); h.join('b', -1);
    h.traffic.claim('door', 'a'); h.traffic.cancel('door', 'a');
    expect(h.join('b', -1).granted).toBe(true);
    expect(h.traffic.hasWaiting('door', 'b')).toBe(false);
    // An explicit new crossing is allowed immediately, behind the current head.
    expect(h.join('a', 1)).toMatchObject({ granted: false, index: 1 });
  });

  it('retains an external operator reservation until explicit release without treating it as an expired physical ticket', () => {
    const h = fixture();
    h.traffic.claim('door', 'external-operator');
    expect(h.join('waiter', -1).granted).toBe(false);
    h.setNow(TRACK_FRESH_MS * 4);
    expect(h.join('waiter', -1).granted).toBe(false);
    expect(h.traffic.amount('door')).toBe(0);
    h.traffic.release('door', 'external-operator');
    expect(h.join('waiter', -1)).toMatchObject({ granted: true, index: 0 });
  });

  it('drops a stale or removed head and its operator claim while a waiting actor keeps refreshing', () => {
    const h = fixture();
    h.add('a', 1); h.add('b', -1); h.join('a', 1); h.join('b', -1);
    h.traffic.claim('door', 'a');
    h.walkers.delete('a'); h.setNow(TRACK_FRESH_MS + 1);
    expect(h.join('b', -1)).toMatchObject({ granted: true, index: 0 });
    expect(h.traffic.claim('door', 'b')).toBe(true);
    expect(h.traffic.hasQueued('door', 'b')).toBe(false);
  });

  it('does not close over a distant queue tail and lets only the final passer close', () => {
    const h = fixture();
    h.join('a', 1); h.join('tail', -1, 7);
    h.traffic.hold('door', 'a', 1, 2);
    expect(h.traffic.approachers(h.door, 'a')).toEqual([]);
    expect(h.traffic.hold('door', 'a', 0, 2)).toBe(1);
    h.traffic.finishPass('door', 'a');
    expect(h.join('tail', -1, 7).granted).toBe(true);
    expect(h.traffic.hold('door', 'tail', 0, 2)).toBe(0);
    h.traffic.finishPass('door', 'tail');
    expect(h.traffic.hasQueued('door')).toBe(false);
  });

  it('ignores a completed passer waiting off-lane for its onward route, without ignoring a physical body at the threshold', () => {
    const h = fixture();
    h.add('completed', 1, 2); h.add('last', -1, 3);
    h.join('completed', 1); h.join('last', -1);
    h.traffic.hold('door', 'completed', 1, 2);
    const parked = doorPoint(h.door, 1.52, 2.5, [0, 0, 0]);
    h.walkers.set('completed', { id: 'completed', position: parked, target: h.point(.8), updatedAt: 0 });
    h.traffic.finishPass('door', 'completed');
    const snapshot = { ...h.door, center: [...h.door.center] as Point3 };
    expect(h.traffic.approachers(snapshot, 'last')).toEqual([]);
    expect(h.join('last', -1).granted).toBe(true);
    expect(h.traffic.hasQueued('door', 'last')).toBe(false);
    expect(h.traffic.hold('door', 'last', 0, 2)).toBe(0);
    // Departure is scoped to this physical door, not a global ignore list.
    const nextDoor = { ...h.door, center: [0, 0, 1.5] as Point3 };
    expect(h.traffic.approachers(nextDoor, 'last').map(walker => walker.id)).toEqual(['completed']);
    h.walkers.set('completed', { id: 'completed', position: h.point(-.5), target: h.point(-.8), updatedAt: 0 });
    expect(h.traffic.occupied(snapshot, 'last')).toBe(true);
    expect(h.traffic.clearForSwing(snapshot, 'last', 0, 1)).toBe(false);
  });

  it('keeps an already queued final closer open for a fresh late arrival before it takes a ticket', () => {
    const h = fixture();
    h.add('closer', 1); h.join('closer', 1);
    h.traffic.hold('door', 'closer', 1, 2);
    h.setNow(20); h.add('late', -1, 3.5);
    expect(h.traffic.hasQueued('door', 'closer')).toBe(false);
    expect(h.traffic.hold('door', 'closer', 0, .5)).toBe(1);
    h.traffic.finishPass('door', 'closer');
    expect(h.join('late', -1).granted).toBe(true);
    h.walkers.delete('closer');
    expect(h.traffic.hold('door', 'late', 0, 2)).toBe(0);
  });

  for (const hinge of ['left', 'right'] as const) for (const openAngle of [-Math.PI / 2, Math.PI / 2]) {
    it(`parks distinct waiting bodies off the threshold and swing: ${hinge}, ${openAngle}`, () => {
      const h = fixture({ ...base, center: [4, 6.4, -3], floor: 2, yaw: Math.PI / 3, hinge, openAngle });
      const entries = [['a', 1], ['b', -1], ['c', -1], ['d', 1]] as const;
      for (const [id, side] of entries) h.add(id, side);
      h.join('a', 1);
      const positions: Point3[] = [];
      for (const [id, side] of entries.slice(1)) {
        const turn = h.join(id, side), position = turn.position!;
        expect(turn.granted).toBe(false);
        expect(position[1]).toBe(6.4);
        const axes = doorAxes(h.door, position);
        expect(axes.through * side).toBeGreaterThan(h.door.clearWidth + .8);
        expect(axes.across * doorHandedness(h.door)).toBeGreaterThan(h.door.clearWidth / 2 + .7);
        for (let fraction = 0; fraction <= 1; fraction += .05) expect(doorLeafDistance(h.door, fraction, position)).toBeGreaterThan(.6);
        for (const previous of positions) expect(Math.hypot(position[0] - previous[0], position[2] - previous[2])).toBeGreaterThan(.79);
        positions.push(position);
      }
    });
  }

  it('keeps a sliding leaf open for explicit tickets outside the normal approach radius', () => {
    const h = fixture({ ...base, sliding: true });
    h.join('a', 1, 7); h.join('b', -1, 7);
    expect(h.traffic.slideStep('door', h.door, 1)).toBeGreaterThan(.99);
    expect(h.traffic.request('door', h.door, 'b')).toBe('wait');
    h.traffic.finishPass('door', 'a'); h.traffic.finishPass('door', 'b');
    h.setNow(1001);
    expect(h.traffic.slideStep('door', h.door, 1)).toBeLessThan(.01);
  });

  it('uses fresh bodies for occupancy and allows an optional earlier doorway lookahead', () => {
    const h = fixture();
    h.add('stale', 1, .5); h.setNow(TRACK_FRESH_MS + 1);
    expect(h.traffic.occupied(h.door, '')).toBe(false);
    expect(h.traffic.doorAhead(h.point(3.8), h.point(0))).toBeNull();
    expect(h.traffic.doorAhead(h.point(3.8), h.point(0), 4)?.id).toBe('door');
    expect(h.traffic.doorAhead(h.point(1), h.point(0))?.id).toBe('door');
  });
});
