import { describe, expect, it } from 'vitest';
import { createCameraNewcomers } from '../src/office/cameraNewcomers';

describe('newly working camera subjects', () => {
  it('baselines initial hydration and follows only a genuine new arrival with a live position', () => {
    const roster = createCameraNewcomers();
    expect(roster.update(['lead'], () => true, 0, true)).toEqual([]);
    expect(roster.update(['lead', 'worker'], id => id === 'lead', 100, true)).toEqual([]);
    expect(roster.update(['lead', 'worker'], () => true, 200, true)).toEqual(['worker']);
  });
  it('prioritizes newest delegations and detects an existing idle character starting work', () => {
    const roster = createCameraNewcomers();
    roster.update([], () => true, 0, true);
    roster.update(['existing'], () => true, 100, true);
    expect(roster.update(['existing', 'new'], () => true, 200, true)).toEqual(['new', 'existing']);
    expect(roster.update(['new'], () => true, 300, true)).toEqual(['new']);
  });
  it('expires arrivals and resets when disabled, without replaying old work', () => {
    const roster = createCameraNewcomers();
    roster.update([], () => true, 0, true);
    roster.update(['worker'], () => true, 100, true);
    expect(roster.update(['worker'], () => true, 30_101, true)).toEqual([]);
    roster.update(['worker'], () => true, 31_000, false);
    expect(roster.update(['worker'], () => true, 32_000, true)).toEqual([]);
  });
});
