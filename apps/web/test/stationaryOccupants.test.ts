import { describe, expect, it, vi } from 'vitest';
import { forEachTrackedWalker, getMovingOccupantsSnapshot, getNearbyMovingOccupantsSnapshot, trackMovingOccupant, trackStationaryOccupant } from '../src/office/scene/interior/occupants/movingOccupants';
import type { Point3 } from '../src/office/scene/layout';
import { MovementDirector } from '../src/office/scene/movement/director';
import { officeNavigation } from '../src/office/scene/movement/navGraph';
import { allocateOfficeAgents } from '../src/office/scene/interior/seating';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import type { OfficeAgent } from '../src/office/presence';
import type { ElevatorAccess } from '../src/office/scene/movement/mover';

describe('stationary character clearance', () => {
  it('keeps seated bodies visible to nearby walkers without door-opening intent or stale timeout', () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const position: Point3 = [1, 0, 2];
    try {
      trackStationaryOccupant('seated-body', position);
      position[0] = 20;
      now = 60_000;
      const body = getNearbyMovingOccupantsSnapshot('observer', [0, 0, 0]).find(x => x.id === 'seated-body');
      expect(body?.position).toEqual([1, 0, 2]);
      expect(body?.velocity).toEqual([0, 0, 0]);
      expect(getNearbyMovingOccupantsSnapshot('seated-body', [0, 0, 0]).some(x => x.id === 'seated-body')).toBe(false);
      expect(getNearbyMovingOccupantsSnapshot('observer', [0, 6.4, 0]).some(x => x.id === 'seated-body')).toBe(false);
      const doorWalkers: string[] = [];
      forEachTrackedWalker(id => doorWalkers.push(id));
      expect(doorWalkers).not.toContain('seated-body');
    } finally { trackStationaryOccupant('seated-body', null); clock.mockRestore(); }
    expect(getMovingOccupantsSnapshot().some(x => x.id === 'seated-body')).toBe(false);
  });

  it('reports a transitioning character once and removes its body when it leaves', () => {
    try {
      trackStationaryOccupant('transition-body', [0, 0, 0]);
      trackMovingOccupant('transition-body', [0.1, 0, 0], [1, 0, 0]);
      expect(getNearbyMovingOccupantsSnapshot('observer', [0, 0, 0]).filter(x => x.id === 'transition-body')).toHaveLength(1);
      trackMovingOccupant('transition-body', null);
      expect(getMovingOccupantsSnapshot().find(x => x.id === 'transition-body')?.motion).toBe('idle');
    } finally { trackStationaryOccupant('transition-body', null); trackMovingOccupant('transition-body', null); }
    expect(getMovingOccupantsSnapshot().some(x => x.id === 'transition-body')).toBe(false);
  });

  it.each(['remove', 'dispose'] as const)('releases a seated presence on %s, including reduced motion', cleanup => {
    const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null,
      confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
    const director = new MovementDirector({ navigation: officeNavigation(), elevators, trackBody: trackStationaryOccupant }, () => 0);
    const agent: OfficeAgent = { id: 'seated-presence', sessionId: 'seated-session', agentId: 'primary', displayName: 'Agent', control: 'managed', status: 'idle', running: false };
    try {
      director.update({ allocations: allocateOfficeAgents([agent]), agents: [agent], reducedMotion: true, gaitOf: () => gaitParameters() });
      expect(getMovingOccupantsSnapshot().some(x => x.id === agent.id)).toBe(true);
      if (cleanup === 'dispose') director.dispose();
      else director.update({ allocations: [], agents: [], reducedMotion: true, gaitOf: () => gaitParameters() });
      expect(getMovingOccupantsSnapshot().some(x => x.id === agent.id)).toBe(false);
    } finally { director.dispose(); }
  });
});
