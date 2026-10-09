import { describe, expect, it } from 'vitest';
import { CHARACTER_FOCUS_ZOOM, cameraProgress, characterFocusPose, panelClearance } from '../src/office/scene/cameraFocus';

describe('office camera focus', () => {
  it('frames a seat from the floor view angle', () => {
    const pose = characterFocusPose([-8.7, 6.4, -4.2]);
    expect(pose.zoom).toBe(CHARACTER_FOCUS_ZOOM);
    expect(pose.target).toEqual([-8.7, 6.4 + 0.95, -4.2]);
    const offset = pose.position.map((value, axis) => value - pose.target[axis]!);
    expect(Math.hypot(...offset)).toBeCloseTo(52, 5);
    expect(offset.every(value => value > 0)).toBe(true);
  });

  it('shifts in screen space without changing the viewing direction', () => {
    const plain = characterFocusPose([0, 0, 0]);
    const shifted = characterFocusPose([0, 0, 0], 36, [180, 0]);
    const moved = shifted.target.map((value, axis) => value - plain.target[axis]!);
    // 180 px at zoom 36 is 5 world units, horizontally and across the view direction.
    expect(Math.hypot(...moved)).toBeCloseTo(5, 5);
    expect(moved[1]).toBeCloseTo(0, 5);
    const direction = plain.position.map((value, axis) => value - plain.target[axis]!);
    expect(moved.reduce((sum, value, axis) => sum + value * direction[axis]!, 0)).toBeCloseTo(0, 5);
    expect(shifted.position.map((value, axis) => value - shifted.target[axis]!)).toEqual(direction.map(value => expect.closeTo(value, 5)));
  });

  it('clears the panel on wide and narrow screens and respects reduced motion', () => {
    expect(panelClearance(1200, 800)).toEqual([210, 0]);
    expect(panelClearance(390, 800)[1]).toBeLessThan(0);
    expect(cameraProgress(0.4, 0.8, true)).toBe(1);
    expect(cameraProgress(0, 0.8, false)).toBe(0);
    expect(cameraProgress(0.8, 0.8, false)).toBe(1);
    expect(cameraProgress(0.4, 0.8, false)).toBeGreaterThan(0.5);
  });
});
