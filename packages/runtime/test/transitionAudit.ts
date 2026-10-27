/**
 * Checks every state change a native mission emits against the shared tables of
 * `@extalia/protocol` (`TASK_TRANSITIONS`, `MISSION_TRANSITIONS`), which the Rust daemon
 * also applies. Mission test files route `runNativeMission` through `auditTransitions`
 * (via `vi.mock`) and call `expectAuditedTransitions()` once at top level.
 */
import { afterAll, afterEach, expect } from 'vitest';
import {
  canTransitionMission, canTransitionTask,
  type AgentEvent, type MissionState, type OrchestrationPlan, type TaskState,
} from '@extalia/protocol';
import type * as Runtime from '../src/index.js';
import type { NativeMissionOptions, runNativeMission } from '../src/index.js';

/** `from -> to` changes in `events` (emission order) that the shared tables do not list. */
export function disallowedTransitions(plan: OrchestrationPlan, events: readonly AgentEvent[]): string[] {
  let mission: MissionState = plan.mission.state;
  const tasks = new Map<string, TaskState>(plan.graph.tasks.map(task => [task.id, task.state]));
  const disallowed: string[] = [];
  for (const { body, taskId } of events) {
    if (body.type === 'mission.state') {
      if (!canTransitionMission(mission, body.state)) disallowed.push(`mission ${mission} -> ${body.state}`);
      mission = body.state;
    } else if (body.type === 'task.state') {
      const from = taskId ? tasks.get(taskId) : undefined;
      if (!from || !canTransitionTask(from, body.state)) disallowed.push(`task ${from ?? 'missing'} -> ${body.state}`);
      if (taskId) tasks.set(taskId, body.state);
    }
  }
  return disallowed;
}

const violations: string[] = [];
let audited = 0;

/**
 * The runtime module with `runNativeMission` checking both the events offered to the
 * commit sink (what a daemon would be asked to apply) and the returned journal.
 */
export function auditTransitions(original: unknown): typeof Runtime {
  const runtime = original as typeof Runtime;
  const run: typeof runNativeMission = options => {
    const offered: AgentEvent[] = [];
    const sinks: Partial<NativeMissionOptions> = {};
    const { commitEvent, commitEventAsync } = options;
    if (typeof commitEvent === 'function') sinks.commitEvent = (event, ...rest) => { offered.push(structuredClone(event)); return commitEvent(event, ...rest); };
    if (typeof commitEventAsync === 'function') sinks.commitEventAsync = (event, ...rest) => { offered.push(structuredClone(event)); return commitEventAsync(event, ...rest); };
    return runtime.runNativeMission({ ...options, ...sinks }).then(result => {
      audited++;
      violations.push(...disallowedTransitions(options.plan, offered), ...disallowedTransitions(options.plan, result.events));
      return result;
    });
  };
  return { ...runtime, runNativeMission: run };
}

/** Fail the test whose missions emitted an unlisted change, and the file if no mission was audited. */
export function expectAuditedTransitions(): void {
  afterEach(() => { expect(violations.splice(0)).toEqual([]); });
  afterAll(() => { expect(audited).toBeGreaterThan(0); });
}
