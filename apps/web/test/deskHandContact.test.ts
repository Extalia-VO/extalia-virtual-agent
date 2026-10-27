import { describe, expect, it } from 'vitest';
import { blendHandGoals, createHandGoals, resolveDeskHandClip, writeHandGoals } from '../src/office/scene/avatars/handGoals';
import { deskReachForSeat } from '../src/office/scene/avatars/deskReach';

const seats = ['qa.station-1', 'research.laptop-2', 'engineering.pod-a.seat-ne', 'engineering.pod-c.seat-sw', 'executive.leader'];
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(...a.map((value, index) => value - b[index]!));

describe('desk hand contacts and activity transitions', () => {
  it('uses contact goals for seated callers without an explicit movement clip', () => {
    expect(resolveDeskHandClip('none', 1, true)).toBe('typing');
    expect(resolveDeskHandClip('none', 1, false)).toBe('desk-idle');
    expect(resolveDeskHandClip('none', 0, true)).toBe('none');
    expect(resolveDeskHandClip('lounge', 1, false)).toBe('lounge');
  });

  it('keeps typing over the actual alpha block and uses finger taps rather than large wrist travel', () => {
    for (const seat of seats) {
      const reach = deskReachForSeat(seat);
      for (let time = 0; time < 24; time += .17) {
        const goals = writeHandGoals(createHandGoals(), 'typing', time, 0, reach, 1.2, 1, 0);
        const center = goals.target[0].map((value, index) => (value + goals.target[1][index]!) / 2);
        expect(center[0], seat).toBeCloseTo(reach.typeWrist[0], 8);
        expect(center[2], seat).toBeCloseTo(reach.typeWrist[2], 8);
        expect(Math.abs(goals.target[0][1] - reach.typeWrist[1]), seat).toBeLessThan(.0037);
        expect(distance(goals.target[0], goals.target[1]), seat).toBeGreaterThan(.209);
        expect(distance(goals.target[0], goals.target[1]), seat).toBeLessThan(.211);
        for (const curl of goals.curl.flat()) expect(curl).toBeGreaterThanOrEqual(.22);
      }
    }
  });

  it('keeps the mouse palm on its stationary mouse and the other hand on its own keyboard side', () => {
    for (const seat of seats) {
      const reach = deskReachForSeat(seat), hand = reach.mouseHand;
      for (let time = 0; time < 24; time += .2) {
        const goals = writeHandGoals(createHandGoals(), 'mouse', time, 0, reach, 1.2, 1, 0);
        expect(distance(goals.target[hand], reach.mouseWrist), seat).toBeLessThan(.003);
        expect(goals.target[hand][1], seat).toBe(reach.mouseWrist[1]);
        expect(Math.sign(goals.target[1 - hand]![0] - reach.typeWrist[0]), seat).toBe(hand === 0 ? 1 : -1);
        expect(goals.direction[hand][0], seat).toBe(reach.mouseForward[0]);
        expect(goals.direction[hand][2], seat).toBe(reach.mouseForward[2]);
      }
    }
  });

  it('turns the thinking hand inward toward the chin while the mouse hand stays supported', () => {
    for (const seat of seats) {
      const reach = deskReachForSeat(seat), hand = reach.mouseHand, other = 1 - hand;
      const goals = writeHandGoals(createHandGoals(), 'thinking', 2, 0, reach, 1, 1, 0);
      expect(goals.direction[other]![1]).toBeGreaterThan(.9);
      expect(goals.target[other]![1]).toBeLessThan(1.01);
      expect(goals.palm[other]![0] * goals.target[other]![0]).toBeLessThan(0);
      expect(goals.target[hand]).toEqual([...reach.mouseWrist]);
    }
  });

  it('glides contacts, orientation and curl through every seated desk activity', () => {
    const reach = deskReachForSeat('qa.station-1');
    const shown = createHandGoals(), target = createHandGoals();
    for (const clip of ['typing', 'mouse', 'thinking', 'read-screen', 'lean-back', 'sip', 'phone', 'desk-idle'] as const) {
      writeHandGoals(target, clip, 2, 0, reach, 1, 1, 0);
      for (let frame = 0; frame < 120; frame++) {
        const before = shown.target.map(point => [...point]);
        blendHandGoals(shown, target, 1 - Math.exp(-1 / 60 * 5));
        expect([...shown.target.flat(), ...shown.direction.flat(), ...shown.palm.flat(), ...shown.curl.flat()].every(Number.isFinite)).toBe(true);
        for (const hand of [0, 1] as const) expect(distance(shown.target[hand], before[hand]!)).toBeLessThan(.13);
      }
      for (const hand of [0, 1] as const) expect(distance(shown.target[hand], target.target[hand])).toBeLessThan(.0001);
    }
  });
});
