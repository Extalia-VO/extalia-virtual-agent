import { describe, expect, it } from 'vitest';
import { budgetComposition, createBudgetController, observeBudgetComposition, SLOW_WINDOWS, updateBudget, type BudgetRosterMember } from '../src/office/scene/environment/renderBudget';

const member = (id: string): BudgetRosterMember => ({ id, phase: 'seated', opacity: 1, floorLow: 1, floorHigh: 1 });
const input = () => ({ view: 'campus' as string | number, admittedIdentity: '["first","second"]', roster: [member('first'), member('second')],
  geometries: 1000, textures: 150, avatarEpoch: 4 });
const probing = () => {
  const controller = createBudgetController();
  for (let i = 0; i < SLOW_WINDOWS; i++) updateBudget(controller, { fps: 25, rawFps: 25 });
  expect(controller).toMatchObject({ level: 3, decision: 'probe-down' });
  return controller;
};

describe('adaptive pixel trials keep exact scene composition', () => {
  it.each(['view', 'admitted', 'replacement', 'arrival', 'departure', 'phase', 'floor', 'geometries', 'textures', 'avatar-epoch'] as const)(
    'invalidates an unproven reduction after a %s change, however small', change => {
      const before = input(), after = input(), controller = probing(), guard = { key: budgetComposition(before).key };
      if (change === 'view') after.view = 'stack';
      if (change === 'admitted') after.admittedIdentity = '["first","replacement"]';
      if (change === 'replacement') after.roster[1] = member('replacement');
      if (change === 'arrival') after.roster.push(member('third'));
      if (change === 'departure') after.roster.pop();
      if (change === 'phase') after.roster[1]!.phase = 'walking';
      if (change === 'floor') after.roster[1]!.floorHigh = 2;
      if (change === 'geometries') after.geometries++;
      if (change === 'textures') after.textures++;
      if (change === 'avatar-epoch') after.avatarEpoch++;
      // One apparently fast candidate window must not survive a composition change.
      updateBudget(controller, { fps: 40, rawFps: 40 });
      expect(observeBudgetComposition(controller, guard, budgetComposition(after))).toBe(true);
      expect(controller).toMatchObject({ level: 2, decision: 'invalidated', history: [], baselineMs: null, candidateMs: null });
      expect(controller.probe).toBeUndefined();
      expect(observeBudgetComposition(controller, guard, budgetComposition(after))).toBe(false);
    });

  it('detects gradual one-actor/resource changes that never cross a 25 percent load threshold', () => {
    const current = input(); current.roster = Array.from({ length: 48 }, (_, i) => member(`actor-${i}`));
    const controller = createBudgetController(), guard = { key: budgetComposition(current).key };
    for (let i = 0; i < 4; i++) {
      current.roster.pop(); current.geometries--; current.textures--;
      expect(observeBudgetComposition(controller, guard, budgetComposition(current))).toBe(true);
      expect(controller.decision).toBe('invalidated');
    }
  });

  it('does not reset for mere roster ordering and never stores mutable mover objects in its key', () => {
    const current = input(), before = budgetComposition(current), controller = probing(), guard = { key: before.key };
    current.roster.reverse();
    expect(observeBudgetComposition(controller, guard, budgetComposition(current))).toBe(false);
    current.roster[0]!.phase = 'walking';
    expect(before.key).toBe(guard.key);
    expect(observeBudgetComposition(controller, guard, budgetComposition(current))).toBe(true);
  });

  it('keeps fading/uncertain composition out of trials even when the categorical key stays unchanged', () => {
    const current = input(), controller = probing(); current.roster[0]!.opacity = .3;
    const composition = budgetComposition(current), guard = { key: composition.key };
    expect(composition.transient).toBe(true);
    expect(observeBudgetComposition(controller, guard, composition)).toBe(true);
    current.roster[0]!.opacity = .8;
    expect(budgetComposition(current).key).toBe(composition.key);
    expect(observeBudgetComposition(controller, guard, budgetComposition(current))).toBe(true);
    current.roster[0]!.opacity = NaN;
    expect(budgetComposition(current).transient).toBe(true);
    current.roster[0]!.opacity = 1;
    expect(observeBudgetComposition(controller, guard, budgetComposition(current))).toBe(true);
    expect(observeBudgetComposition(controller, guard, budgetComposition(current))).toBe(false);
  });
});
