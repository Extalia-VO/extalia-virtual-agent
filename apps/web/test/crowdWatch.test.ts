import { describe, expect, it } from 'vitest';
import { CrowdWatch, type CrowdWatchActor } from '../src/office/scene/movement/crowdWatch';

const actor = (id: string, x: number, extra: Partial<CrowdWatchActor> = {}): CrowdWatchActor => ({
  id, floor: 1, position: [x, 0, 0], movementIntent: true, eligible: true, intentionalWait: false, ...extra,
});
function advance(watch: CrowdWatch, actors: readonly CrowdWatchActor[], seconds: number) {
  let decision = watch.update(actors, 0);
  for (let step = 0; step < Math.round(seconds * 10); step++) decision = watch.update(actors, .1);
  return decision;
}

describe('physical crowd watch arbitration', () => {
  it('reports two overlapping actors immediately but gives one initiative only after persistence', () => {
    const watch = new CrowdWatch(), actors = [actor('b', .4), actor('a', 0)];
    expect(watch.update(actors, .1)).toMatchObject({ groups: [{ members: ['a', 'b'], overlapping: true }], initiative: null });
    expect(advance(watch, actors, 2.8).initiative).toBeNull();
    const decision = advance(watch, actors, .2);
    expect(decision.initiative).toMatchObject({ actorId: 'a', members: ['a', 'b'], reason: 'overlap' });
    expect(watch.update([...actors].reverse(), .1).initiative?.actorId).toBe('a');
  });

  it('finds connected three-person and twenty-person clusters without requiring every pair to overlap', () => {
    for (const size of [3, 20]) {
      const watch = new CrowdWatch();
      const actors = Array.from({ length: size }, (_, index) => actor(`person-${String(index).padStart(2, '0')}`, index * .5));
      const snapshot = advance(watch, actors, 3.1);
      expect(snapshot.groups).toHaveLength(1);
      expect(snapshot.groups[0]!.members).toHaveLength(size);
      expect(snapshot.initiative?.actorId).toBe('person-00');
    }
  });

  it('detects persistent face-to-face blocked intent outside the overlap radius', () => {
    const actors = [actor('a', 0, { target: [2, 0, 0] }), actor('b', 1, { target: [-2, 0, 0] })];
    expect(advance(new CrowdWatch(), actors, 4.1).initiative).toMatchObject({ actorId: 'a', reason: 'blocked' });
    expect(advance(new CrowdWatch(), [actors[0]!, { ...actors[1]!, target: [2, 0, 0] }], 4.1).initiative).toMatchObject({ actorId: 'a', reason: 'blocked' });
    expect(advance(new CrowdWatch(), actors.map(a => ({ ...a, movementIntent: false })), 8).groups).toEqual([]);
  });

  it('detects a stationary one-way tail without requiring the leading actor to face back', () => {
    const watch = new CrowdWatch(), actors = [actor('a-tail', 0, { target: [2, 0, 0] }), actor('b-head', 1, { target: [1, 0, 3] })];
    expect(advance(watch, actors, 2.9).groups).toEqual([]);
    const decision = advance(watch, actors, 1.2);
    expect(decision.groups).toMatchObject([{ members: ['a-tail', 'b-head'], overlapping: false }]);
    expect(decision.initiative).toMatchObject({ actorId: 'a-tail', reason: 'blocked' });
    const away = [actor('a-tail', 0, { target: [-2, 0, 0] }), actor('b-head', 1, { target: [2, 0, 0] })];
    expect(advance(new CrowdWatch(), away, 8).groups).toEqual([]);
  });

  it.each([true, false])('lets a movable peer make room for a protected held actor, with facing %s', facing => {
    const watch = new CrowdWatch();
    const protectedActor = actor('a-held-chair', 0, { eligible: false, intentionalWait: true, target: [facing ? 2 : -2, 0, 0] });
    const waitingPeer = actor('b-movable', facing ? 1 : .6, { target: [2, 0, 0] });
    expect(advance(watch, [protectedActor, waitingPeer], 4).groups).toEqual([]);
    const stalled = [{ ...protectedActor, intentionalWait: false }, waitingPeer];
    const decision = advance(watch, stalled, 1.2);
    expect(decision.groups).toMatchObject([{ members: ['a-held-chair', 'b-movable'], overlapping: false }]);
    expect(decision.initiative).toMatchObject({ actorId: 'b-movable', reason: 'blocked' });
    watch.failed('b-movable');
    for (let frame = 0; frame < 100; frame++) expect(watch.update(stalled, .1).initiative?.actorId).not.toBe('a-held-chair');
  });

  it('reports protected overlapping bodies but nominates only a movable peer', () => {
    const protectedActor = actor('a', 0, { eligible: false, intentionalWait: true });
    const decision = advance(new CrowdWatch(), [protectedActor, actor('b', .4)], 3.1);
    expect(decision.groups[0]!.members).toEqual(['a', 'b']);
    expect(decision.initiative?.actorId).toBe('b');
    expect(advance(new CrowdWatch(), [protectedActor, actor('b', .4, { eligible: false, intentionalWait: true })], 9).initiative).toBeNull();
    expect(advance(new CrowdWatch(), [protectedActor, actor('b', 1, { target: [-2, 0, 0] })], 9).groups).toEqual([]);
  });

  it('lets an eligible queue waiter repair overlap with a protected seated actor', () => {
    const watch = new CrowdWatch();
    const actors = [actor('a-seated', 0, { eligible: false, intentionalWait: true, movementIntent: false }),
      actor('b-queued', .4, { intentionalWait: true })];
    const decision = advance(watch, actors, 3.1);
    expect(decision.groups[0]).toMatchObject({ members: ['a-seated', 'b-queued'], overlapping: true });
    expect(decision.initiative).toMatchObject({ actorId: 'b-queued', reason: 'overlap' });
    expect(watch.update(actors, .1).initiative?.actorId).toBe('b-queued');
    watch.failed('b-queued');
    expect(advance(watch, actors, 2).initiative).toBeNull();
  });

  it('uses one global lease and rotates a failed nominee after cooldown', () => {
    const watch = new CrowdWatch(), actors = [actor('a', 0), actor('b', .4), actor('c', 5), actor('d', 5.4)];
    expect(advance(watch, actors, 3.1).initiative?.actorId).toBe('a');
    watch.failed('not-the-nominee');
    expect(watch.update(actors, 0).initiative?.actorId).toBe('a');
    watch.failed('a');
    expect(advance(watch, actors, .9).initiative).toBeNull();
    expect(advance(watch, actors, .1).initiative?.actorId).toBe('b');
    watch.failed('b');
    expect(advance(watch, actors, 1).initiative?.actorId).toBe('c');
  });

  it('expires an unacknowledged lease and eventually retries failed peers', () => {
    const watch = new CrowdWatch(), actors = [actor('a', 0), actor('b', .4)];
    expect(advance(watch, actors, 3).initiative?.actorId).toBe('a');
    expect(advance(watch, actors, 4).initiative).toBeNull();
    expect(advance(watch, actors, 1).initiative?.actorId).toBe('b');
    watch.failed('b');
    expect(advance(watch, actors, 1).initiative).toBeNull();
    expect(advance(watch, actors, 6).initiative?.actorId).toBe('a');
  });

  it.each(['failed', 'expired'] as const)('tries all twenty blocked nominees before retrying %s escapes when only the highest ID can move', outcome => {
    const watch = new CrowdWatch();
    const actors = Array.from({ length: 20 }, (_, index) => actor(`person-${String(index).padStart(2, '0')}`, index * .5));
    const attempts: string[] = [];
    let escaped = false, lastNominee: string | null = null, elapsed = 0;
    const attemptEscape = (id: string) => { attempts.push(id); return id === 'person-19'; };
    // Simulate the caller's geometry check: nineteen candidates have no safe
    // retreat. An expired lease must rotate just like an explicit rejection.
    for (; elapsed < 110 && !escaped; elapsed += .1) {
      const decision = watch.update([...actors].reverse(), .1), nominee = decision.initiative?.actorId ?? null;
      if (!nominee) { lastNominee = null; continue; }
      if (nominee === lastNominee) continue;
      lastNominee = nominee;
      escaped = attemptEscape(nominee);
      if (escaped) watch.resolved(nominee);
      else if (outcome === 'failed') watch.failed(nominee);
    }
    expect(escaped).toBe(true);
    expect(attempts).toEqual(actors.map(actor => actor.id));
    expect(elapsed).toBeLessThan(outcome === 'failed' ? 24 : 102);
  });

  it('ignores subthreshold foot jitter and clears initiative after actual displacement', () => {
    const watch = new CrowdWatch();
    let snapshot = watch.update([actor('a', 0), actor('b', .4)], 0);
    for (let frame = 0; frame < 31; frame++) snapshot = watch.update([actor('a', frame % 2 ? .015 : -.015), actor('b', .4)], .1);
    expect(snapshot.initiative?.actorId).toBe('a');
    expect(watch.update([actor('a', -.2), actor('b', .4)], .1).initiative).toBeNull();
  });

  it('caps simulated time and ignores negative or nonfinite deltas', () => {
    const watch = new CrowdWatch(), actors = [actor('a', 0), actor('b', .4)];
    watch.update(actors, 0);
    for (const dt of [1e6, -1, NaN, Infinity]) expect(watch.update(actors, dt).initiative).toBeNull();
    expect(advance(watch, actors, 2.8).initiative).toBeNull();
    expect(advance(watch, actors, .1).initiative?.actorId).toBe('a');
  });

  it('cleans vanished actors and restarts their no-motion timer on reappearance or floor change', () => {
    const watch = new CrowdWatch(), actors = [actor('a', 0), actor('b', .4)];
    expect(advance(watch, actors, 3.1).initiative?.actorId).toBe('a');
    expect(watch.update([], .1)).toEqual({ groups: [], initiative: null });
    expect(advance(watch, actors, 1.1).initiative).toBeNull();
    expect(advance(watch, actors, 2).initiative?.actorId).toBe('a');
    expect(watch.update(actors.map(a => ({ ...a, floor: 2 })), .1).initiative).toBeNull();
    expect(advance(new CrowdWatch(), [actors[0]!, { ...actors[1]!, floor: 2 }], 9).groups).toEqual([]);
  });

  it('releases when eligibility changes and does not mutate caller positions or route targets', () => {
    const watch = new CrowdWatch();
    const actors = [actor('a', 0, { target: [4, 0, 0] }), actor('b', .4)];
    const original = structuredClone(actors);
    expect(advance(watch, actors, 3.1).initiative?.actorId).toBe('a');
    expect(watch.update([{ ...actors[0]!, eligible: false }, actors[1]!], .1).initiative).toBeNull();
    expect(advance(watch, [{ ...actors[0]!, eligible: false }, actors[1]!], 1).initiative?.actorId).toBe('b');
    watch.resolved('b');
    expect(watch.update(actors, 0).initiative).toBeNull();
    expect(actors).toEqual(original);
  });
});
