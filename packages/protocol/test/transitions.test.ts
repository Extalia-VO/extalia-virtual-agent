import { describe, expect, it } from 'vitest';
import {
  canTransitionMission, canTransitionTask, MISSION_STATES, MISSION_TRANSITIONS, protocolContractFiles,
  TASK_STATES, TASK_TRANSITIONS, transitionTablesJson, type MissionState, type TaskState,
} from '../src/index.js';
import committed from '../schemas/transitions.json' with { type: 'json' };

const TERMINAL = ['completed', 'failed', 'cancelled'];

describe('shared state transition tables', () => {
  it('match the committed transitions.json the Rust daemon embeds', () => {
    expect(committed).toEqual(JSON.parse(protocolContractFiles()['transitions.json']!));
    expect(committed).toEqual(JSON.parse(JSON.stringify(transitionTablesJson())));
    // Key order is the state order of the contract unions.
    expect(Object.keys(committed.task)).toEqual([...TASK_STATES]);
    expect(Object.keys(committed.mission)).toEqual([...MISSION_STATES]);
  });

  it('list every state once, with known targets and no self-transitions', () => {
    for (const [states, table] of [[TASK_STATES, TASK_TRANSITIONS], [MISSION_STATES, MISSION_TRANSITIONS]] as const) {
      expect(Object.keys(table)).toEqual([...states]);
      for (const [from, targets] of Object.entries<readonly string[]>(table)) {
        expect(new Set(targets).size, from).toBe(targets.length);
        expect(targets, from).not.toContain(from);
        for (const to of targets) expect(states as readonly string[], `${from} -> ${to}`).toContain(to);
        if (TERMINAL.includes(from)) expect(targets, from).toEqual([]);
      }
    }
  });

  it('never resume unknown tasks or recovering missions (ADR 0013)', () => {
    expect(TASK_TRANSITIONS.unknown).toEqual(['failed', 'cancelled']);
    for (const to of ['queued', 'assigned', 'running'] as const) expect(canTransitionTask('unknown', to)).toBe(false);
    expect(MISSION_TRANSITIONS.recovering).toEqual(['failed', 'cancelled']);
    expect(canTransitionMission('recovering', 'running')).toBe(false);
  });

  it('answer membership through canTransitionTask and canTransitionMission', () => {
    for (const from of TASK_STATES) for (const to of TASK_STATES) expect(canTransitionTask(from, to)).toBe(TASK_TRANSITIONS[from].includes(to));
    for (const from of MISSION_STATES) for (const to of MISSION_STATES) expect(canTransitionMission(from, to)).toBe(MISSION_TRANSITIONS[from].includes(to));
    expect(canTransitionTask('constructor' as TaskState, 'queued')).toBe(false);
    expect(canTransitionMission('toString' as MissionState, 'running')).toBe(false);
  });

  it('are immutable', () => {
    expect(Object.isFrozen(TASK_TRANSITIONS) && Object.isFrozen(TASK_TRANSITIONS.queued)).toBe(true);
    expect(Object.isFrozen(MISSION_TRANSITIONS) && Object.isFrozen(MISSION_TRANSITIONS.running)).toBe(true);
  });
});
