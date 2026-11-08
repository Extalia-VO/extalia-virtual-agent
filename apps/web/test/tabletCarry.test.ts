import { describe, expect, it } from 'vitest';
import { blendHandGoals, createHandGoals, TABLET_CENTRE, writeHandGoals } from '../src/office/scene/avatars/handGoals';
import { deskReachForSeat } from '../src/office/scene/avatars/deskReach';
import { createCharacterMotion } from '../src/office/scene/movement/walkCycle';

const reach = deskReachForSeat(undefined);

describe('work tablet carried while walking', () => {
  it('holds the tablet with both hands at the chest while a busy character walks', () => {
    const goals = writeHandGoals(createHandGoals(), 'none', 3, 0, reach, 1, 0, 1, .45, 1);
    expect(goals.tablet).toBe(1);
    expect(goals.weight).toEqual([1, 1]);
    for (const hand of [0, 1] as const) {
      expect(Math.abs(goals.target[hand][1] - TABLET_CENTRE[1])).toBeLessThan(.05);
      expect(goals.target[hand][2]).toBeGreaterThan(.2);
    }
    expect(goals.target[0][0]).toBeLessThan(0);
    expect(goals.target[1][0]).toBeGreaterThan(0);
  });

  it('puts it away when seated or not carrying, and the shown tablet fades with the goal', () => {
    expect(writeHandGoals(createHandGoals(), 'typing', 3, 0, reach, 1, 1, 0, .45, 1).tablet).toBe(0);
    const idle = writeHandGoals(createHandGoals(), 'none', 3, 0, reach, 1, 0, 1, .45, 0);
    expect(idle.tablet).toBe(0);
    expect(idle.weight).toEqual([0, 0]);
    const shown = createHandGoals();
    const target = writeHandGoals(createHandGoals(), 'none', 3, 0, reach, 1, 0, 1, .45, 1);
    for (let i = 0; i < 30; i++) blendHandGoals(shown, target, .2);
    expect(shown.tablet).toBeGreaterThan(.95);
  });

  it('starts without a tablet', () => {
    expect(createCharacterMotion(false).carry).toBe(0);
  });
});
