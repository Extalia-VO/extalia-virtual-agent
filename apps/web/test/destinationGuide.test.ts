import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { FLOOR_HEIGHT, type Point3 } from '../src/office/scene/layout';
import { floorY, type RouteStep } from '../src/office/scene/movement/navGraph';
import { createMover, remainingFloorRoute, type Mover } from '../src/office/scene/movement/mover';

const walk = (to: Point3, stairs = false): RouteStep => ({ kind: 'walk', node: `node-${to.join('-')}`, to, stairs });

function walkerAt(position: Point3, steps: RouteStep[], stepIndex = 0): Mover {
  const mover = createMover('walker', gaitParameters(undefined), position, 0, false);
  mover.steps = steps;
  mover.stepIndex = stepIndex;
  return mover;
}

describe('remainingFloorRoute', () => {
  const level = floorY(1);

  it('starts at the character and follows the walk ahead on its floor', () => {
    const mover = walkerAt([0, level, 0], [walk([2, level, 0]), walk([2, level, 4])]);
    expect(remainingFloorRoute(mover)).toEqual([[0, level, 0], [2, level, 0], [2, level, 4]]);
  });

  it('skips steps already taken', () => {
    const mover = walkerAt([1, level, 0], [walk([2, level, 0]), walk([2, level, 4])], 1);
    expect(remainingFloorRoute(mover)).toEqual([[1, level, 0], [2, level, 4]]);
  });

  it('stops before stairs so nothing is drawn across floors', () => {
    const upper = floorY(2);
    const mover = walkerAt([0, level, 0], [walk([2, level, 0]), walk([2, level + 3, 0], true), walk([2, upper, 0])]);
    expect(remainingFloorRoute(mover)).toEqual([[0, level, 0], [2, level, 0]]);
  });

  it('stops at an elevator step', () => {
    const elevator: RouteStep = { kind: 'elevator', node: 'elevator-A', elevatorId: 'A', from: 1, to: 2, exit: [0, floorY(2), 0] };
    const mover = walkerAt([0, level, 0], [walk([2, level, 0]), elevator, walk([2, floorY(2), 0])]);
    expect(remainingFloorRoute(mover)).toEqual([[0, level, 0], [2, level, 0]]);
  });

  it('is empty when the character is not walking', () => {
    const mover = walkerAt([0, level, 0], [walk([2, level, 0])]);
    mover.phase = 'sitting';
    expect(remainingFloorRoute(mover)).toEqual([]);
  });

  it('is empty while the character is on the stairs between floors', () => {
    const mover = walkerAt([0, FLOOR_HEIGHT / 4, 0], [walk([2, FLOOR_HEIGHT / 4, 0])]);
    expect(remainingFloorRoute(mover)).toEqual([]);
  });
});
