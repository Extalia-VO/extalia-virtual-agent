/**
 * The task and mission state transition tables of the orchestration contract: the single
 * source for TypeScript and the Rust daemon, which loads the generated
 * `packages/protocol/schemas/transitions.json` at compile time.
 *
 * A table lists the changes an actor may request (`task.transition`, a lead's
 * `mission.state` event). Self-transitions are not listed. Restart recovery is a store
 * rewrite outside these tables: in-flight tasks become `unknown` and active missions
 * `recovering` (ADRs 0013, 0014). `unknown` and `recovering` are resolved, never resumed:
 * they lead only to `failed` or `cancelled`, so unknown work is never replayed.
 */
import type { MissionState, TaskState } from './orchestration.js';

export const MISSION_STATES = ['draft', 'planning', 'queued', 'running', 'waiting', 'awaiting_approval', 'reviewing', 'completed', 'failed', 'cancelled', 'recovering'] as const satisfies readonly MissionState[];
export const TASK_STATES = ['queued', 'blocked', 'assigned', 'running', 'waiting', 'awaiting_approval', 'verifying', 'completed', 'failed', 'cancelled', 'unknown'] as const satisfies readonly TaskState[];
// Compile-time checks that every state of each union is listed.
const _everyMissionState: readonly (typeof MISSION_STATES)[number][] = [] as MissionState[];
const _everyTaskState: readonly (typeof TASK_STATES)[number][] = [] as TaskState[];

type Table<S extends string> = Readonly<Record<S, readonly S[]>>;
const freeze = <S extends string>(table: Record<S, readonly S[]>): Table<S> =>
  Object.freeze(Object.fromEntries(Object.entries<readonly S[]>(table).map(([from, to]) => [from, Object.freeze([...to])])) as Record<S, readonly S[]>);

/**
 * Task changes. The native runtime emits queued -> running/blocked/cancelled (and failed
 * for a task-local fault before start) and running -> completed/failed/cancelled/unknown;
 * the rest follows the contract's state meanings.
 */
export const TASK_TRANSITIONS: Table<TaskState> = freeze<TaskState>({
  queued: ['assigned', 'running', 'blocked', 'cancelled', 'failed'],
  blocked: ['queued', 'cancelled', 'failed'],
  assigned: ['running', 'queued', 'blocked', 'cancelled', 'failed'],
  running: ['waiting', 'awaiting_approval', 'verifying', 'completed', 'failed', 'cancelled', 'unknown'],
  waiting: ['running', 'failed', 'cancelled', 'unknown'],
  awaiting_approval: ['running', 'failed', 'cancelled', 'unknown'],
  verifying: ['running', 'completed', 'failed', 'cancelled', 'unknown'],
  completed: [],
  failed: [],
  cancelled: [],
  unknown: ['failed', 'cancelled'],
});

/**
 * Mission changes. The native runtime emits draft/planning/queued -> running and
 * running -> completed/failed/cancelled/recovering; the rest follows the state meanings.
 */
export const MISSION_TRANSITIONS: Table<MissionState> = freeze<MissionState>({
  draft: ['planning', 'queued', 'running', 'cancelled', 'failed'],
  planning: ['queued', 'running', 'cancelled', 'failed'],
  queued: ['running', 'cancelled', 'failed'],
  running: ['waiting', 'awaiting_approval', 'reviewing', 'completed', 'failed', 'cancelled', 'recovering'],
  waiting: ['running', 'failed', 'cancelled', 'recovering'],
  awaiting_approval: ['running', 'failed', 'cancelled', 'recovering'],
  reviewing: ['running', 'completed', 'failed', 'cancelled', 'recovering'],
  completed: [],
  failed: [],
  cancelled: [],
  recovering: ['failed', 'cancelled'],
});

const allows = (table: Readonly<Record<string, readonly string[]>>, from: string, to: string) =>
  Object.hasOwn(table, from) && table[from]!.includes(to);
/** Whether `from -> to` is a listed task change; false for self-transitions and unknown names. */
export const canTransitionTask = (from: TaskState, to: TaskState): boolean => allows(TASK_TRANSITIONS, from, to);
/** Whether `from -> to` is a listed mission change; false for self-transitions and unknown names. */
export const canTransitionMission = (from: MissionState, to: MissionState): boolean => allows(MISSION_TRANSITIONS, from, to);

/** Content of the generated `transitions.json` read by the Rust daemon; keys and targets keep table order. */
export function transitionTablesJson(): { $comment: string; mission: Table<MissionState>; task: Table<TaskState> } {
  return {
    $comment: 'Generated from @extalia/protocol (MISSION_TRANSITIONS, TASK_TRANSITIONS) by tooling/generate-schemas.mjs; do not edit. Self-transitions are not listed.',
    mission: MISSION_TRANSITIONS,
    task: TASK_TRANSITIONS,
  };
}
