import { describe, expect, it } from 'vitest';
import { gaitParameters } from '../src/office/scene/avatars/gait';
import { chairWorld, GRIP_STAND } from '../src/office/scene/movement/chairChoreography';
import { createMover, setPace, stepMover, type ElevatorAccess, type MovementEnv } from '../src/office/scene/movement/mover';
import { officeNavigation } from '../src/office/scene/movement/navGraph';
import { angleDelta, createWalkPose, writeWalkPose } from '../src/office/scene/movement/walkCycle';

const navigation = officeNavigation();
const elevators: ElevatorAccess = { request() {}, waitingSlot: () => null, canBoard: () => false, standingPosition: () => null, confirmBoarded: () => false, canExit: () => false, confirmExited: () => false, release() {}, door: () => ({ x: 0, z: 0 }) };
const env: MovementEnv = { navigation, elevators };

for (const kind of ['sit','stand'] as const) describe(`chair ${kind === 'sit' ? 'pull' : 'push'} steps`, () => {
  it('shows alternating leg motion in both maneuver directions, independent of frame rate and chair orientation', () => {
    for (const id of ['executive.leader','engineering.pod-a.seat-se']) for (const side of [-1,1] as const) for (const yaw of [0,Math.PI/2]) for (const dt of [1/60,1/30,.1]) {
      const seat={...navigation.seats.get(id)!,rotationY:yaw};
      const gait=gaitParameters({gait:side===1?'feminine':'masculine'});
      const pull=kind==='sit'?0:1;
      const mover=createMover('chair-steps',gait,chairWorld(seat,pull,GRIP_STAND[0],0,GRIP_STAND[1],[0,0,0],side),yaw,false);
      setPace(mover,1.3);
      mover.phase='chairing';mover.chairPull=pull;mover.chairSide=side;
      mover.chair={kind,seat,side,beat:2,timer:0,begun:false,path:[]};
      let walk=0,travel=0,phase=0;
      const knees: number[][]=[[],[]];
      const pose=createWalkPose();
      for (let frame=0;frame<180 && mover.chair?.beat===2;frame++) {
        const before=[...mover.position], oldPhase=mover.motion.phase;
        stepMover(mover,dt,env);
        travel+=Math.hypot(mover.position[0]-before[0]!,mover.position[2]-before[2]!);
        phase+=angleDelta(oldPhase,mover.motion.phase);
        walk=Math.max(walk,mover.motion.walk);
        writeWalkPose(pose,gait,mover.motion.phase,mover.motion.walk,.83,mover.motion.stride);
        for (let index=0;index<2;index++)knees[index]!.push(pose.knee[index]!);
        expect(mover.motion.sit).toBe(0);
        expect(Math.max(...mover.motion.reach.map(r=>r.weight))).toBe(1);
      }
      expect(walk).toBeGreaterThan(.5);
      for (const samples of knees) expect(Math.max(...samples)-Math.min(...samples)).toBeGreaterThan(.13);
      expect(phase*(kind==='sit'?-1:1)).toBeGreaterThan(Math.PI);
      // Short handling steps should cover the root travel, rather than skating for a whole beat.
      const stepLength=travel*Math.PI/Math.abs(phase);
      expect(stepLength).toBeGreaterThan(.25);
      expect(stepLength).toBeLessThan(.5);
    }
  });
});
