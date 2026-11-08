import { describe, expect, it } from 'vitest';
import { missionEntry } from '../src/missions/missionNavigation';

describe('status-panel mission navigation', () => {
  const runs = [{ id: 'newer', sessionId: 'current' }, { id: 'recovering', sessionId: 'current' }, { id: 'foreign', sessionId: 'other' }];
  it('opens the requested retained recovery rather than the newest mission', () => {
    expect(missionEntry(runs, 'current', 'recovering')).toBe(runs[1]);
  });
  it('does not substitute a different mission when the requested record disappeared or belongs to another session', () => {
    expect(missionEntry(runs, 'current', 'missing')).toBeUndefined();
    expect(missionEntry(runs, 'current', 'foreign')).toBeUndefined();
    expect(missionEntry(runs, undefined, 'recovering')).toBeUndefined();
  });
  it('keeps newest-first navigation when there is no specific target', () => {
    expect(missionEntry(runs, 'current')).toBe(runs[0]);
  });
});
