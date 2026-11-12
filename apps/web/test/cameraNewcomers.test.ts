import { describe, expect, it } from 'vitest';
import { createCameraNewcomers } from '../src/office/cameraNewcomers';

describe('newly admitted and activated camera subjects', () => {
  it('announces a newly admitted idle character only after its live position is ready', () => {
    const roster = createCameraNewcomers();
    expect(roster.update([], () => true, 0, true, ['idle-existing'])).toEqual([]);
    expect(roster.update([], id => id === 'idle-existing', 100, true, ['idle-existing', 'idle-new'])).toEqual([]);
    expect(roster.spawnedIds()).toEqual(['idle-new']);
    expect(roster.update([], () => true, 200, true, ['idle-existing', 'idle-new'])).toEqual(['idle-new']);
    expect(roster.update([], () => true, 300, true, ['idle-existing'])).toEqual([]);
    expect(roster.spawnedIds()).toEqual([]);
  });
  it('does not announce work from an off-shift or unadmitted character', () => {
    const roster = createCameraNewcomers();
    roster.update([], () => true, 0, true, ['admitted']);
    expect(roster.update(['queued'], () => true, 100, true, ['admitted'])).toEqual([]);
    expect(roster.spawnedIds()).toEqual([]);
    expect(roster.update(['queued'], () => true, 200, true, ['admitted', 'queued'])).toEqual(['queued']);
  });
  it('expires idle spawns and baselines the roster again after automatic camera is disabled', () => {
    const roster = createCameraNewcomers();
    roster.update([], () => true, 0, true, []);
    expect(roster.update([], () => true, 100, true, ['idle'])).toEqual(['idle']);
    expect(roster.update([], () => true, 30_101, true, ['idle'])).toEqual([]);
    roster.update([], () => true, 31_000, false, ['idle']);
    expect(roster.update([], () => true, 32_000, true, ['idle'])).toEqual([]);
  });
  it('separates genuine roster additions from an existing idle agent restarting work', () => {
    const roster = createCameraNewcomers();
    roster.update(['lead'], () => true, 0, true, ['lead', 'idle']);
    expect(roster.spawnedIds()).toEqual([]);
    expect(roster.update(['lead', 'idle'], () => true, 100, true, ['lead', 'idle'])).toEqual(['idle']);
    expect(roster.spawnedIds()).toEqual([]);
    roster.update(['lead', 'idle', 'new'], () => true, 200, true, ['lead', 'idle', 'new']);
    expect(roster.spawnedIds()).toEqual(['new']);
    roster.update(['lead', 'idle', 'new'], () => true, 30_201, true, ['lead', 'idle', 'new']);
    expect(roster.spawnedIds()).toEqual([]);
  });
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
