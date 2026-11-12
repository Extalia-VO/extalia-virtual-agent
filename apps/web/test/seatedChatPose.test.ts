import { describe, expect, it } from 'vitest';
import { createActivityPose, createClipDriver, isSeatedClip, stepClipDriver, writeActivityPose, type ActivityClip } from '../src/office/scene/avatars/activityPose';

const conversations = [
  ['seated-chat-talk', 'chat-talk'],
  ['seated-chat-listen', 'chat-listen'],
] as const satisfies readonly (readonly [ActivityClip, ActivityClip])[];

describe('seated conversation gestures', () => {
  it.each(conversations)('keeps %s expressive at full sit while preserving the authored seat and legs', (seated, standing) => {
    expect(isSeatedClip(seated)).toBe(true);
    expect(isSeatedClip(standing)).toBe(false);
    for (const time of [0, .7, 2.4, 9, 21.5]) {
      const gesture = writeActivityPose(createActivityPose(), seated, time, .4, 1.1);
      // The same upper-body conversation is shared, with no root or leg offsets
      // that could lift a character off the sofa's authored seated pose.
      expect(gesture).toEqual(writeActivityPose(createActivityPose(), standing, time, .4, 1.1));
      expect(gesture.thigh).toEqual([0, 0]);
      expect(gesture.knee).toEqual([0, 0]);
      expect(gesture.bob).toBe(0);
      for (const value of Object.values(gesture).flat()) expect(Number.isFinite(value)).toBe(true);

      const driver = createClipDriver();
      const shown = stepClipDriver(driver, seated, time, .2, 1, 0, .4, 1.1);
      expect(driver.target).toEqual(gesture);
      expect(Math.abs(shown.elbow[0])).toBeGreaterThan(.3);
      expect(shown.thigh).toEqual([0, 0]);
      expect(shown.knee).toEqual([0, 0]);
    }
  });

  it.each(conversations)('fades %s while standing up or walking without changing standing conversation weighting', (seated, standing) => {
    const driver = createClipDriver();
    stepClipDriver(driver, seated, 2, 1, 1, 0, 0, 1);
    const before = Math.abs(driver.shown.elbow[0]);
    stepClipDriver(driver, seated, 2, .2, .5, 0, 0, 1);
    expect(driver.target.elbow[0]).toBeCloseTo(writeActivityPose(createActivityPose(), seated, 2).elbow[0] * .5);
    stepClipDriver(driver, seated, 2, 1, 0, 1, 0, 1);
    for (const value of Object.values(driver.target).flat()) expect(value).toBeCloseTo(0);
    expect(Math.abs(driver.shown.elbow[0])).toBeLessThan(before * .02);

    const standingDriver = createClipDriver();
    stepClipDriver(standingDriver, standing, 2, .2, 0, 0, 0, 1);
    expect(Math.abs(standingDriver.target.elbow[0])).toBeGreaterThan(.6);
    stepClipDriver(standingDriver, standing, 2, .2, 1, 0, 0, 1);
    for (const value of Object.values(standingDriver.target).flat()) expect(value).toBeCloseTo(0);
    stepClipDriver(standingDriver, standing, 2, .2, 0, 1, 0, 1);
    for (const value of Object.values(standingDriver.target).flat()) expect(value).toBeCloseTo(0);
  });
});
