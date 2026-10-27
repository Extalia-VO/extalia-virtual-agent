import { describe, expect, it, vi } from 'vitest';
import { SERVER_ROOM_BLUEPRINT, FITNESS_BLUEPRINT } from '../src/office/scene/interior/spatialBlueprints';
import PROFILE from '../src/office/scene/interior/interiorAssetProfile.json';
import { HospitalityState } from '../src/office/scene/movement/hospitality';
import { bikePedalPosition, treadmillStripePosition } from '../src/office/scene/interior/prefabs/furniture/GymEquipment';
import { advanceFitnessMechanism, bikeFootGoal, createFitnessLegSolution, fitnessHandGoal, solveFitnessLeg } from '../src/office/scene/interior/fitnessMechanics';
import { Group, Vector3 } from 'three';
import { createArmPoleSolution, solveArmPole } from '../src/office/scene/avatars/armPole';
import { createClipDriver, isSeatedClip, stepClipDriver } from '../src/office/scene/avatars/activityPose';
import { drawConsoleMatch, syncTabletopControllers } from '../src/office/scene/interior/prefabs/furniture/EntertainmentSuite';
import { ENTERTAINMENT_LAYOUT, entertainmentPoint } from '../src/office/scene/interior/entertainmentBlueprint';
import { F1_LAYOUT } from '../src/office/scene/interior/floor1Layout';
import { resourceById } from '../src/office/scene/interior/resourceRegistry';

vi.mock('../src/office/scene/interior/InteriorPart', () => ({ InteriorPart: () => null }));

describe('server and recreation scene contracts', () => {
  it('faces every server front into its inspection aisle, clear of the cabinet and on the finished floor', () => {
    SERVER_ROOM_BLUEPRINT.rackPositions.forEach((rack, index) => {
      const target = SERVER_ROOM_BLUEPRINT.rackInspectionPoints[index]!;
      const front = [Math.sin(SERVER_ROOM_BLUEPRINT.rackRotationY), Math.cos(SERVER_ROOM_BLUEPRINT.rackRotationY)];
      const gap = (target[0] - rack[0]) * front[0]! + (target[1] - rack[2]) * front[1]!;
      expect(gap).toBeGreaterThan(PROFILE.serverRack.depth / 2 + 0.6);
      expect(Math.abs(target[1] - rack[2])).toBeLessThan(0.01);
      // Rack positions now denote their supporting floor rather than the old cabinet centre.
      expect(rack[1]).toBe(0);
    });
    expect(SERVER_ROOM_BLUEPRINT.rackPositions[1]![2] - SERVER_ROOM_BLUEPRINT.rackPositions[0]![2]).toBeGreaterThan(PROFILE.serverRack.width);
  });

  it('keeps pedals opposite on a circular X axle and wraps the running belt inside its deck', () => {
    for (const phase of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      const left = bikePedalPosition(-1, phase), right = bikePedalPosition(1, phase);
      expect(Math.hypot(left[1], left[2])).toBeCloseTo(0.18, 6);
      expect(right[1]).toBeCloseTo(-left[1], 6); expect(right[2]).toBeCloseTo(-left[2], 6);
      expect(left[0]).toBe(-0.27); expect(right[0]).toBe(0.27);
    }
    for (const travel of [0, 0.13, 1.44, 152.7]) for (let index = 0; index < 8; index++) {
      expect(treadmillStripePosition(index, travel)).toBeGreaterThanOrEqual(-0.72);
      expect(treadmillStripePosition(index, travel)).toBeLessThanOrEqual(0.72);
    }
    expect(PROFILE.treadmill.deckHeight).toBe(FITNESS_BLUEPRINT.treadmillDeckHeight);
    expect(PROFILE.bike.seatHeight).toBe(FITNESS_BLUEPRINT.bikeSeatHeight);
    expect(PROFILE.yogaMat.surfaceHeight).toBe(FITNESS_BLUEPRINT.matSurfaceHeight);
  });

  it('shares equipment phases with exact reachable pedal endpoints and cable hand goals', () => {
    const mechanism = { active: false, phase: 0, travel: 0, pull: 0 };
    advanceFitnessMechanism(mechanism, false, 0.1); expect(mechanism.phase).toBe(0);
    advanceFitnessMechanism(mechanism, true, 0.1); expect(mechanism.phase).toBeCloseTo(0.34, 6);
    const stoppedPhase = mechanism.phase; advanceFitnessMechanism(mechanism, false, 1); expect(mechanism.phase).toBe(stoppedPhase);
    for (const phase of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) for (const side of [-1, 1]) {
      const foot = bikeFootGoal(side, phase, 0.08);
      const pedal = bikePedalPosition(-side, phase);
      expect(foot[1] - 0.08 - 0.0175).toBeCloseTo(0.38 + pedal[1], 6);
      expect(foot[2]).toBeCloseTo(FITNESS_BLUEPRINT.bikeSeat[1] - pedal[2], 6);
      const hip = [side * 0.13, 0.97, 0];
      const target: [number, number, number] = [foot[0] - hip[0]!, foot[1] - hip[1]!, foot[2]];
      const result = solveFitnessLeg(target, 0.43, 0.43, createFitnessLegSolution());
      const knee = new Vector3(0, -0.43, 0).applyQuaternion(result.upper);
      const ankle = new Vector3(0, -0.43, 0).applyQuaternion(result.lower).applyQuaternion(result.upper).add(knee);
      expect(ankle.distanceTo(new Vector3(...target))).toBeLessThan(1e-5);
      expect(result.error).toBeLessThan(1e-5);
    }
    const handle = fitnessHandGoal(FITNESS_BLUEPRINT.cableRow.id, -1, mechanism)!;
    expect(handle[2]).toBeCloseTo(FITNESS_BLUEPRINT.cableHandle[2] - mechanism.pull * 0.3, 6);
    expect(fitnessHandGoal('qa.station-1', 1, mechanism)).toBeUndefined();
    // Metric fallback shoulders: the previous bike bar at z=.68 and cable z=.7 exceeded arm reach.
    for (const [id, shoulderY] of [[FITNESS_BLUEPRINT.bikes[0]!.id, 1.4], [FITNESS_BLUEPRINT.cableRow.id, 1.07]] as const) {
      for (const pull of [0, 0.5, 1]) {
        const hand = fitnessHandGoal(id, 1, { ...mechanism, pull })!;
        const target: [number, number, number] = [hand[0] - 0.17, hand[1] - shoulderY, hand[2]];
        const solve = solveArmPole(target, 0.25, 0.25, 1, createArmPoleSolution());
        const wrist = new Vector3(0, -0.25, 0).applyQuaternion(solve.lower).applyQuaternion(solve.upper).add(new Vector3(0, -0.25, 0).applyQuaternion(solve.upper));
        expect(Math.hypot(...target)).toBeLessThan(0.5);
        expect(wrist.distanceTo(new Vector3(...target))).toBeLessThan(0.001);
      }
    }
    expect(PROFILE.bike.handlebarPosition).toEqual([0, 1.22, -0.08]);
    expect(isSeatedClip('bench-curl')).toBe(true); expect(isSeatedClip('cable-row')).toBe(true);
    const curl = stepClipDriver(createClipDriver(), 'bench-curl', 1, 1, 1, 0, 0, 1);
    expect(Math.abs(curl.elbow[0])).toBeGreaterThan(0.3);
  });

  it('removes each tabletop controller when its actual player arrives and restores it on release', () => {
    const table = new Group(); table.add(new Group(), new Group());
    const state = new HospitalityState(); state.reserveGame(['player-a', 'player-b'], 0);
    syncTabletopControllers(table, state.entertainment(), false);
    expect(table.children.map(child => child.visible)).toEqual([true, true]);
    state.arriveGame('player-a', 20); syncTabletopControllers(table, state.entertainment(), false);
    expect(table.children.map(child => child.visible)).toEqual([false, true]);
    state.arriveGame('player-b', 100); syncTabletopControllers(table, state.entertainment(), false);
    expect(table.children.map(child => child.visible)).toEqual([false, false]);
    syncTabletopControllers(table, state.entertainment(), true);
    expect(table.children.map(child => child.visible)).toEqual([true, true]);
    state.releaseActor('player-a'); syncTabletopControllers(table, state.entertainment(), false);
    expect(table.children.map(child => child.visible)).toEqual([true, true]);
  });

  it('paints the same shared match ball, paddles and scores after both players arrive', () => {
    const state = new HospitalityState(); state.reserveGame(['player-a', 'player-b'], 0);
    state.arriveGame('player-a', 20); expect(state.entertainment()!.startedAt).toBeNull();
    state.arriveGame('player-b', 100); state.advance(12100, 12);
    const match = state.entertainment()!;
    const context = { fillRect: vi.fn(), strokeRect: vi.fn(), setLineDash: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fillText: vi.fn(), arc: vi.fn(), fill: vi.fn() };
    drawConsoleMatch(context as unknown as CanvasRenderingContext2D, match, 768, 414);
    expect(context.fillText.mock.calls.map(call => call[0])).toEqual(match.score.map(String));
    expect(context.arc).toHaveBeenCalledWith(44 + match.ball[0] * 680, 30 + match.ball[1] * 354, 9, 0, Math.PI * 2);
    state.releaseActor('player-a'); expect(state.entertainment()).toBeNull();
  });

  it('splits the F1 entertainment room into a west TV lounge and east game corner aligned with seat and station targets', () => {
    expect(ENTERTAINMENT_LAYOUT.tvX).toBeLessThan(0);
    expect(ENTERTAINMENT_LAYOUT.sofa[0]).toBeLessThan(0);
    expect(ENTERTAINMENT_LAYOUT.armchair[0]).toBeLessThan(0);
    expect(ENTERTAINMENT_LAYOUT.table[0]).toBeLessThan(0);
    expect(ENTERTAINMENT_LAYOUT.miniBar[0]).toBeLessThan(0);
    expect(ENTERTAINMENT_LAYOUT.arcades[0]).toBeGreaterThan(0);
    expect(ENTERTAINMENT_LAYOUT.arcades[1]).toBeGreaterThan(ENTERTAINMENT_LAYOUT.arcades[0]);
    expect(ENTERTAINMENT_LAYOUT.foosball[0]).toBeGreaterThan(0);

    const [roomCx, roomCz] = F1_LAYOUT.entertainment.center;
    const [authCx, authCz] = ENTERTAINMENT_LAYOUT.authoredCenter;
    const shiftX = roomCx - authCx;
    const shiftZ = roomCz - authCz;

    const screen = resourceById('entertainment.tv-control')!;
    const [screenAuthX, screenAuthZ] = entertainmentPoint(ENTERTAINMENT_LAYOUT.tvX, -2.2);
    expect(screen.position[0]).toBeCloseTo(screenAuthX + shiftX, 5);
    expect(screen.position[2]).toBeCloseTo(screenAuthZ + shiftZ, 5);

    const arcade = resourceById('entertainment.arcade')!;
    const [arcadeAuthX, arcadeAuthZ] = entertainmentPoint(ENTERTAINMENT_LAYOUT.arcades[0], ENTERTAINMENT_LAYOUT.arcadeZ + 1.4);
    expect(arcade.position[0]).toBeCloseTo(arcadeAuthX + shiftX, 5);
    expect(arcade.position[2]).toBeCloseTo(arcadeAuthZ + shiftZ, 5);

    const foosball1 = resourceById('entertainment.foosball-1')!;
    const foosball2 = resourceById('entertainment.foosball-2')!;
    expect(foosball1.position[0]).toBeCloseTo(roomCx + ENTERTAINMENT_LAYOUT.foosball[0] - 0.6, 5);
    expect(foosball2.position[0]).toBeCloseTo(roomCx + ENTERTAINMENT_LAYOUT.foosball[0], 5);
    expect(foosball1.position[2]).toBeLessThan(foosball2.position[2]);
  });
});
