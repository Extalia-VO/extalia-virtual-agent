import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import type { Point3 } from '../src/office/scene/layout';
import { doorAxes, doorHandle, doorLeafDistance, doorLeafPoint, doorPoint, DoorTraffic, type DoorInfo } from '../src/office/scene/interior/doorTraffic';
import { DOOR_BODY_CLEARANCE, doorClosePosition, doorEntryCloseHandWeight, doorEntryClosePosition, doorGripPosition, doorOpenPosition, doorOpenHandWeight, doorSwingSide, doorWalkPath } from '../src/office/scene/movement/doorChoreography';
import { createMover, placeSeated, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation } from '../src/office/scene/movement/navGraph';

const navigation = officeNavigation();
const elevators: ElevatorAccess = {
  request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
  confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }),
};

function scene(door: DoorInfo, side: 1 | -1, dt: number) {
  let now = 0;
  const mover = createMover('walker', gaitParameters(), doorPoint(door, 0, side * 3, [0, 0, 0]), door.yaw, false);
  mover.steps = [{ kind: 'walk', node: 'destination', to: doorPoint(door, 0, -side * 3, [0, 0, 0]), stairs: false }];
  const doors = new DoorTraffic({
    forEachDoor: visit => visit('door', door),
    forEachWalker: visit => {
      if (!['walking', 'doorwork'].includes(mover.phase)) return;
      visit({ id: mover.id, position: mover.position, target: mover.steps[mover.stepIndex]?.kind === 'walk' ? (mover.steps[mover.stepIndex] as { to: Point3 }).to : mover.position, updatedAt: now });
    },
  }, () => now);
  const env: MovementEnv = { navigation, elevators, doors };
  return { mover, doors, env, tick: () => { stepMover(mover, dt, env); now += dt * 1000; } };
}

describe('door leaf choreography', () => {
  it('keeps the closer within handle reach and clear of the latch jamb throughout mirrored swings', () => {
    for (const hinge of ['left', 'right'] as const) for (const sign of [-1, 1]) for (const side of [-1, 1] as const) {
      for (const width of [1, 1.15, 1.6, 1.8]) for (const openAngle of [sign * Math.PI / 2, sign * Math.PI * 0.38]) {
        const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: width, height: 2.55, openAngle, hinge, sliding: false };
        for (let sample = 0; sample <= 200; sample++) {
          const amount = sample / 200;
          const position = doorClosePosition(door, amount, side, [0, 0, 0]);
          const handle = doorHandle(door, amount, side, [0, 0, 0]);
          expect(Math.hypot(position[0] - handle[0], position[2] - handle[2])).toBeLessThan(0.47);
          expect(doorLeafDistance(door, amount, position)).toBeGreaterThanOrEqual(DOOR_BODY_CLEARANCE);
          const at = doorAxes(door, position);
          for (const jamb of [-width / 2, width / 2]) expect(Math.hypot(at.across - jamb, at.through)).toBeGreaterThan(0.34);
        }
      }
    }
  });

  it('turns beside the free-edge handle using a shorter path than walking to the far apron and back', () => {
    const length = (from: Readonly<Point3>, path: readonly Point3[]) => {
      let total = 0, previous = from;
      for (const point of path) { total += Math.hypot(point[0] - previous[0], point[2] - previous[2]); previous = point; }
      return total;
    };
    for (const hinge of ['left', 'right'] as const) for (const sign of [-1, 1]) for (const side of [-1, 1] as const) {
      for (const width of [1, 1.6]) {
        const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: width, height: 2.55, openAngle: sign * Math.PI / 2, hinge, sliding: false };
        const s = scene(door, side, 1 / 60);
        const exitSide = -side as 1 | -1;
        const opening = doorGripPosition(door, 1, side, [0, 0, 0]);
        const far = doorPoint(door, 0, exitSide * (exitSide === doorSwingSide(door) ? width + 0.65 : 0.7), [0, 0, 0]);
        const oldClose = doorGripPosition(door, 1, exitSide, [0, 0, 0]);
        const oldDistance = length(opening, doorWalkPath(door, 1, opening, far)!) + length(far, doorWalkPath(door, 1, far, oldClose)!);
        let travelled = 0, previous: Point3 | null = null, turnedToClose = false;
        for (let frame = 0; frame < 60 * 20; frame++) {
          s.tick();
          if (previous) { travelled += Math.hypot(s.mover.position[0] - previous[0], s.mover.position[2] - previous[2]); previous = [...s.mover.position]; }
          if (!previous && s.mover.door?.beat === 'passage') previous = [...s.mover.position];
          if (s.mover.door?.kind === 'close' && s.mover.door.beat === 'grip') {
            const handle = doorHandle(door, s.doors.amount('door'), s.mover.door.side, [0, 0, 0]);
            expect(Math.hypot(handle[0] - s.mover.position[0], handle[2] - s.mover.position[2])).toBeLessThan(0.53);
            expect(travelled).toBeLessThan(oldDistance * 0.8);
            turnedToClose = true;
            break;
          }
        }
        expect(turnedToClose).toBe(true);
      }
    }
  });

  it('keeps the entry-close arc inside, clear of jambs and the moving tip, with reachable tug contacts', () => {
    for (const hinge of ['left','right'] as const) for (const sign of [-1,1]) for (const width of [1,1.15,1.6,1.8]) for (const angle of [Math.PI/2,Math.PI*.38]) {
      const door: DoorInfo = {floor:1,center:[3,0,-7],yaw:Math.PI/2,clearWidth:width,height:2.55,openAngle:sign*angle,hinge,sliding:false};
      const arrival=doorSwingSide(door), entry=-arrival as 1|-1;
      for (let i=0;i<=200;i++) {
        const amount=i/200, p=doorEntryClosePosition(door,amount,entry,[0,0,0]);
        const at=doorAxes(door,p);
        expect(at.through*arrival).toBeGreaterThan(.33);
        expect(doorLeafDistance(door,amount,p)).toBeGreaterThanOrEqual(.419999);
        for (const jamb of [-width/2,width/2]) expect(Math.hypot(at.across-jamb,at.through)).toBeGreaterThan(.34);
        if (doorEntryCloseHandWeight(door,amount,1)>0) {
          const h=doorHandle(door,amount,entry,[0,0,0]);
          expect(Math.hypot(p[0]-h[0],p[2]-h[2])).toBeLessThan(.53);
          const theta=amount*door.openAngle;
          const face=(at.across+(hinge==='left'?1:-1)*width/2)*Math.sin(theta)+at.through*Math.cos(theta);
          expect(face*entry).toBeGreaterThan(.34);
        }
      }
    }
  });

  it('closes a pushed-in room entry from the reachable face without walking behind its open leaf', () => {
    for (const hinge of ['left', 'right'] as const) for (const sign of [-1, 1]) for (const width of [1, 1.15, 1.6, 1.8]) {
      const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: width, height: 2.55, openAngle: sign * Math.PI / 2, hinge, sliding: false };
      const arrival = doorSwingSide(door), side = -arrival as 1 | -1, q = hinge === 'left' ? 1 : -1;
      const s = scene(door, side, 1 / 60);
      let regripped = false;
      for (let frame = 0; frame < 60 * 35; frame++) {
        s.tick();
        const act = s.mover.door;
        if (act?.kind === 'close') {
          const at = doorAxes(door, s.mover.position);
          expect(at.through * arrival).toBeGreaterThan(.33);
          expect(at.across * q).toBeGreaterThanOrEqual(-width / 2 + .33);
          if (act.beat === 'grip') {
            regripped = true;
            // Keep the accessible pushing face; do not plan around the free tip to its rear face.
            expect(act.side).toBe(side);
            const h = doorHandle(door, s.doors.amount('door'), act.side, [0,0,0]);
            expect(Math.hypot(h[0]-s.mover.position[0],h[2]-s.mover.position[2])).toBeLessThan(.53);
          }
        }
        if (s.mover.phase === 'gone') break;
      }
      expect(regripped).toBe(true);
      expect(s.mover.phase).toBe('gone');
      expect(s.doors.amount('door')).toBe(0);
      expect(s.doors.claim('door', 'next')).toBe(true);
    }
  });

  it('pulls toward the latch side and releases before the handle leaves reach', () => {
    for (const hinge of ['left', 'right'] as const) for (const sign of [-1, 1]) for (const width of [1, 1.15, 1.6, 1.8]) {
      const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: width, height: 2.55, openAngle: sign * Math.PI / 2, hinge, sliding: false };
      const side = doorSwingSide(door), q = hinge === 'left' ? 1 : -1;
      for (let i = 0; i <= 1000; i++) {
        const amount = i / 1000;
        const p = doorOpenPosition(door, amount, side, [0, 0, 0]);
        const at = doorAxes(door, p);
        expect(at.across * q).toBeGreaterThanOrEqual(width * .32 - 1e-8);
        expect(Math.abs(at.through)).toBeLessThanOrEqual(.681);
        expect(doorLeafDistance(door, amount, p)).toBeGreaterThan(.37);
        for (const jamb of [-width / 2, width / 2]) expect(Math.hypot(at.across - jamb, at.through)).toBeGreaterThan(.34);
        if (doorOpenHandWeight(door, amount, side) > 0) {
          const h = doorHandle(door, amount, side, [0, 0, 0]);
          expect(Math.hypot(h[0] - p[0], h[2] - p[2])).toBeLessThan(.53);
        }
      }
      const s = scene(door, side, 1 / 60);
      let started = false, regripped = false;
      for (let frame = 0; frame < 60 * 35; frame++) {
        s.tick();
        started ||= s.mover.door?.beat === 'swing';
        if (started && s.mover.door) expect(Math.abs(doorAxes(door, s.mover.position).through)).toBeLessThan(.75);
        if (s.mover.door?.kind === 'close' && s.mover.door.beat === 'grip') regripped = true;
        if (s.mover.phase === 'gone') break;
      }
      expect(regripped).toBe(true);
      expect(s.mover.phase).toBe('gone');
      expect(s.doors.amount('door')).toBe(0);
      expect(s.doors.claim('door', 'next')).toBe(true);
    }
  });

  it('uses the reachable entry face for a free walker assigned to close an already-open leaf', () => {
    for (const hinge of ['left','right'] as const) for (const sign of [-1,1]) for (const yaw of [0,Math.PI/2,Math.PI,-Math.PI/2]) {
      const door: DoorInfo = {floor:1,center:[4,0,-6],yaw,clearWidth:1.15,height:2.55,openAngle:sign*Math.PI/2,hinge,sliding:false};
      const arrival=doorSwingSide(door), entry=-arrival as 1|-1;
      const s=scene(door,entry,1/60);
      s.doors.hold('door','previous',1,2); s.doors.release('door','previous');
      doorPoint(door,0,arrival*.5,s.mover.position);
      s.doors.moved(s.mover.id,doorPoint(door,0,entry*.5,[0,0,0]),s.mover.position);
      expect(s.doors.duty(s.mover.id)).not.toBeNull();
      let gripped=false;
      for (let frame=0;frame<60*25;frame++) {
        s.tick();
        if (s.mover.door?.beat==='grip') {
          gripped=true;
          expect(s.mover.door.kind).toBe('close');
          expect(s.mover.door.side).toBe(entry);
          expect(doorAxes(door,s.mover.position).across*(hinge==='left'?1:-1)).toBeGreaterThan(-door.clearWidth/2+.33);
        }
        if (s.mover.phase==='gone')break;
      }
      expect(gripped).toBe(true);
      expect(s.doors.amount('door')).toBe(0);
      expect(s.doors.duty(s.mover.id)).toBeNull();
      expect(s.mover.phase).toBe('gone');
    }
  });

  it('mirrors the hinge and handle in the same frame as the rendered leaf', () => {
    for (const hinge of ['left', 'right'] as const) {
      const door: DoorInfo = { floor: 1, center: [3, 0, 7], yaw: Math.PI / 2, clearWidth: 1.2, height: 2.5, openAngle: hinge === 'left' ? Math.PI / 2 : -Math.PI / 2, hinge, sliding: false };
      const grip = doorHandle(door, 1, 1, [0, 0, 0]);
      const expected = doorLeafPoint(door, 1, 0.82 * door.clearWidth, 0.1, [0, 0, 0]);
      expect(grip[0]).toBeCloseTo(expected[0], 10);
      expect(grip[2]).toBeCloseTo(expected[2], 10);
      expect(grip[1]).toBeCloseTo(1.25, 10);
      expect(doorAxes(door, doorLeafPoint(door, 1, door.clearWidth, 0, [0, 0, 0])).through).toBeCloseTo(-1.2, 10);
    }
  });

  for (const hinge of ['left', 'right'] as const) for (const sign of [-1, 1]) for (const side of [-1, 1] as const) {
    it(`clears the leaf and jambs throughout ${hinge} hinge, angle ${sign}, approach ${side}`, () => {
      for (const width of [1, 1.15, 1.6]) for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const door: DoorInfo = { floor: 1, center: [4, 0, -6], yaw, clearWidth: width, height: 2.55, openAngle: sign * Math.PI / 2, hinge, sliding: false };
        const s = scene(door, side, yaw === 0 ? 0.1 : 1 / 60);
        let opened = false, closed = false, backward = false, forward = false, turned = false;
        let lastAmount = 0, closingTravel = 0;
        const before: Point3 = [0, 0, 0];
        for (let frame = 0; frame < 60 * 45; frame++) {
          before[0] = s.mover.position[0]; before[1] = s.mover.position[1]; before[2] = s.mover.position[2];
          const oldYaw = s.mover.yaw;
          s.tick();
          const amount = s.doors.amount('door');
          if (s.mover.door?.kind === 'close' && s.mover.door.beat === 'swing') for (let sample = 1; sample < 5; sample++) {
            const t = sample / 5;
            const between: Point3 = [before[0] + (s.mover.position[0] - before[0]) * t, before[1], before[2] + (s.mover.position[2] - before[2]) * t];
            expect(doorLeafDistance(door, lastAmount + (amount - lastAmount) * t, between)).toBeGreaterThanOrEqual(DOOR_BODY_CLEARANCE - 0.006);
          }
          expect(doorLeafDistance(door, amount, s.mover.position)).toBeGreaterThanOrEqual(DOOR_BODY_CLEARANCE - 0.006);
          const p = doorAxes(door, s.mover.position);
          for (const jamb of [-width / 2, width / 2]) expect(Math.hypot(p.across - jamb, p.through)).toBeGreaterThanOrEqual(0.33);
          if (Math.abs(p.through) < 0.03) expect(Math.abs(p.across)).toBeLessThan(width / 2 - 0.3);
          if (amount !== lastAmount) {
            if (s.mover.door?.kind === 'open' && side === doorSwingSide(door)) {
              expect(Math.max(...s.mover.motion.reach.map(r => r.weight))).toBeCloseTo(doorOpenHandWeight(door, amount, side), 6);
            } else if (s.mover.door?.entryCloseStart !== undefined) {
              expect(Math.max(...s.mover.motion.reach.map(r => r.weight))).toBeCloseTo(doorEntryCloseHandWeight(door, amount, s.mover.door.entryCloseStart), 6);
            } else expect(Math.max(...s.mover.motion.reach.map(r => r.weight))).toBeGreaterThan(0.9);
            const dot = (s.mover.position[0] - before[0]) * Math.sin(s.mover.yaw) + (s.mover.position[2] - before[2]) * Math.cos(s.mover.yaw);
            backward ||= dot < -1e-5; forward ||= dot > 1e-5;
            if (amount < lastAmount) closingTravel += dot;
          }
          turned ||= Math.abs(s.mover.yaw - oldYaw) > 0.01;
          opened ||= amount >= (side === doorSwingSide(door) ? 0.5 : 0.99);
          closed ||= opened && amount === 0;
          lastAmount = amount;
          if (s.mover.phase === 'gone') break;
        }
        expect(opened).toBe(true); expect(closed).toBe(true);
        // Both directions close with a pull; push entries release their short tug
        // and let the reserved swing finish while moving clear inside the room.
        expect(side === doorSwingSide(door) ? backward : forward).toBe(true);
        if (side === doorSwingSide(door)) expect(closingTravel).toBeLessThan(-0.05);
        expect(turned).toBe(true);
        expect(doorAxes(door, s.mover.position).through * side).toBeLessThan(-2.9);
        expect(s.mover.motion.reach.every(r => r.weight === 0)).toBe(true);
      }
    });
  }

  it('routes round the free tip rather than through the leaf or hinge wall', () => {
    const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.15, height: 2.55, openAngle: -Math.PI / 2, sliding: false };
    const from = doorGripPosition(door, 1, 1, [0, 0, 0]);
    const to = doorGripPosition(door, 1, -1, [0, 0, 0]);
    const path = doorWalkPath(door, 1, from, to)!;
    expect(path.length).toBeGreaterThan(1);
    expect(Math.max(...path.map(p => p[2]))).toBeGreaterThan(door.clearWidth + 0.3);
    let last = from;
    for (const point of path) {
      for (let t = 0; t <= 1; t += 0.01) {
        const p: Point3 = [last[0] + (point[0] - last[0]) * t, 0, last[2] + (point[2] - last[2]) * t];
        expect(doorLeafDistance(door, 1, p)).toBeGreaterThanOrEqual(DOOR_BODY_CLEARANCE - 1e-6);
      }
      last = point;
    }
  });

  it('waits for a real reservation and does not time out through a shut door', () => {
    const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.15, height: 2.55, openAngle: -Math.PI / 2, sliding: false };
    const s = scene(door, -1, 1 / 30);
    s.doors.claim('door', 'other');
    for (let i = 0; i < 30 * 12; i++) s.tick();
    expect(s.mover.phase).toBe('doorwork'); expect(s.mover.position[2]).toBeLessThan(-1.5);
    expect(s.doors.amount('door')).toBe(0);
    s.doors.release('door', 'other');
    for (let i = 0; i < 30 * 35; i++) s.tick();
    expect(s.mover.position[2]).toBeGreaterThan(2.9);
    expect(s.doors.amount('door')).toBe(0);
  });

  it('reopens safely when a route reverses immediately after a near-door close', () => {
    const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.2, height: 2.55, openAngle: -Math.PI / 2, sliding: false };
    const s = scene(door, -1, 1 / 60);
    let closed = false;
    for (let frame = 0; frame < 60 * 30; frame++) {
      s.tick();
      if (s.mover.phase === 'walking' && s.doors.amount('door') === 0 && s.mover.position[2] > 0.3) { closed = true; break; }
    }
    expect(closed).toBe(true);
    s.mover.steps = [{ kind: 'walk', node: 'return', to: [0, 0, -3], stairs: false }];
    s.mover.stepIndex = 0;
    let reopened = false;
    for (let frame = 0; frame < 60 * 30; frame++) {
      s.tick();
      reopened ||= s.doors.amount('door') >= 0.5;
      expect(doorLeafDistance(door, s.doors.amount('door'), s.mover.position)).toBeGreaterThan(0.33);
      if (s.mover.phase === 'gone') break;
    }
    expect(reopened).toBe(true);
    expect(s.mover.position[2]).toBeLessThan(-2.9);
    expect(s.doors.amount('door')).toBe(0);
  });

  it('releases ownership when reduced motion places a walker directly on a seat', () => {
    const door: DoorInfo = { floor: 1, center: [0, 0, 0], yaw: 0, clearWidth: 1.15, height: 2.55, openAngle: -Math.PI / 2, sliding: false };
    const s = scene(door, -1, 1 / 30);
    for (let i = 0; i < 100; i++) s.tick();
    expect(s.mover.door).not.toBeNull();
    placeSeated(s.mover, [...navigation.seats.values()][0]!, s.env);
    expect(s.doors.claim('door', 'other')).toBe(true);
    expect(s.mover.door).toBeNull();
  });
});
