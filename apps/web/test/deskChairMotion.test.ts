import { describe, expect, it } from 'vitest';
import { CHAIR_TURN, chairOffset, chairTurnSign, DeskChairMotion } from '../src/office/scene/interior/deskChairs';

describe('scripted desk chair motion', () => {
  it('follows every supplied pull exactly without adding a second easing lag', () => {
    const motion = new DeskChairMotion();
    for (const pull of [0, 0.13, 0.47, 1, 0.72, 0.001, 0]) {
      motion.setTarget('chair', pull, -1);
      motion.advance(1 / 60);
      expect(motion.pull('chair')).toBe(pull);
      expect(motion.side('chair')).toBe(-1);
    }
  });

  it('invalidates the renderer when only the interaction side changes', () => {
    const motion = new DeskChairMotion();
    motion.setTarget('chair', 0.6, 1);
    motion.advance(1 / 30);
    const version = motion.version();
    motion.setTarget('chair', 0.6, -1);
    motion.advance(1 / 30);
    expect(motion.pull('chair')).toBe(0.6);
    expect(motion.side('chair')).toBe(-1);
    expect(motion.version()).toBeGreaterThan(version);
    expect(chairOffset(1, 'chair', 1).turn).toBe(CHAIR_TURN);
    expect(chairOffset(1, 'chair', -1).turn).toBe(-CHAIR_TURN);
  });

  it('keeps the last side during abandoned-chair cleanup and restores its default once tucked', () => {
    const motion = new DeskChairMotion();
    const side = -chairTurnSign('chair') as 1 | -1;
    motion.setTarget('chair', 1, side);
    motion.advance(1 / 30);
    motion.advance(1 / 30);
    expect(motion.pull('chair')).toBeGreaterThan(0);
    expect(motion.pull('chair')).toBeLessThan(1);
    expect(motion.side('chair')).toBe(side);
    for (let frame = 0; frame < 90; frame++) motion.advance(1 / 30);
    expect(motion.pull('chair')).toBe(0);
    expect(motion.side('chair')).toBe(chairTurnSign('chair'));
  });

  it('preserves resource-based turn directions for callers without an interaction side', () => {
    const motion = new DeskChairMotion();
    for (const id of ['chair-a', 'chair-b', 'chair-c']) {
      motion.setTarget(id, 1);
      motion.advance(1 / 30);
      expect(motion.side(id)).toBe(chairTurnSign(id));
      expect(chairOffset(1, id).turn).toBe(CHAIR_TURN * chairTurnSign(id));
    }
  });
});
