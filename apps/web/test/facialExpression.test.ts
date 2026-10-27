import { describe, expect, it } from 'vitest';
import { bindCharacterExpression, createFacialPose, expressionStateForAgent, resolveCharacterExpression, writeFacialPose } from '../src/office/scene/avatars/facialExpression';
import { createCharacterMotion } from '../src/office/scene/movement/walkCycle';

describe('shared cosmetic character expressions', () => {
  it('uses truthful reported activity and retains stale observed idle behavior', () => {
    expect(expressionStateForAgent({ status: 'working', control: 'managed' })).toBe('focused');
    expect(expressionStateForAgent({ status: 'working', control: 'observed', live: false })).toBe('idle');
    expect(expressionStateForAgent({ status: 'blocked' })).toBe('waiting');
    expect(expressionStateForAgent({ status: 'offline' })).toBe('offline');
  });
  it('shares the live motion binding with portraits, and cleans up only its own registration', () => {
    const motion = createCharacterMotion(true);
    const first = bindCharacterExpression('character', { state: 'focused', motion });
    expect(resolveCharacterExpression('character', 'idle')).toBe('focused');
    motion.walk = 1;
    expect(resolveCharacterExpression('character', 'idle')).toBe('moving');
    motion.walk = 0; motion.clip = 'chat-talk';
    expect(resolveCharacterExpression('character', 'idle')).toBe('talking');
    const next = bindCharacterExpression('character', { state: 'waiting' });
    first();
    expect(resolveCharacterExpression('character')).toBe('waiting');
    next();
    expect(resolveCharacterExpression('character')).toBe('idle');
  });
  it('gives the Office and portrait identical seeded facial phases regardless of mount time', () => {
    const face = createFacialPose(), portrait = createFacialPose();
    for (let time = 0; time < 80; time += 0.04) {
      writeFacialPose(face, 472, time, 'idle');
      writeFacialPose(portrait, 472, time, 'idle');
      expect(face).toEqual(portrait);
      expect(Object.values(face).every(Number.isFinite)).toBe(true);
      expect(face.blink).toBeGreaterThanOrEqual(0);
      expect(face.blink).toBeLessThanOrEqual(1);
    }
  });
  it('blinks and yawns occasionally at rest, while focused faces stay serious', () => {
    const rest = createFacialPose(), focused = createFacialPose();
    let blink = 0, yawn = 0, gaze = 0;
    for (let time = 0; time < 100; time += 0.04) {
      writeFacialPose(rest, 53, time, 'waiting');
      writeFacialPose(focused, 53, time, 'focused');
      blink = Math.max(blink, rest.blink); yawn = Math.max(yawn, rest.yawn); gaze = Math.max(gaze, Math.abs(rest.gazeX));
      expect(focused.yawn).toBe(0);
      expect(focused.brow).toBeGreaterThan(0);
    }
    expect(blink).toBeGreaterThan(0.9); expect(yawn).toBeGreaterThan(0.9); expect(gaze).toBeGreaterThan(0.5);
  });
  it('disables cosmetic movement for reduced motion and offline characters', () => {
    for (const state of ['idle', 'focused', 'waiting', 'talking', 'moving'] as const) {
      const a = writeFacialPose(createFacialPose(), 7, 0, state, true);
      const b = writeFacialPose(createFacialPose(), 7, 88, state, true);
      expect(a).toEqual(b);
      expect(a.blink + a.yawn + a.mouthOpen + Math.abs(a.headYaw)).toBe(0);
    }
    expect(writeFacialPose(createFacialPose(), 7, 19, 'offline')).toEqual(createFacialPose());
  });
});
