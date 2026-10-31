import { parseControlTaskProjectionContext, parseOrchestration, type ControlExecutionOutcome, type ControlTaskProjectionContext, type ControlTaskState, type TaskState, type Verification } from '@extalia/protocol';

/** Historical projection, deliberately not a ControlTaskSnapshot or an executable task. */
export interface LegacyTaskStateView {
  profileId: string;
  workspaceId: string;
  kind: 'legacy-task-view';
  state: ControlTaskState;
  reportedExecutionOutcome: ControlExecutionOutcome;
  source: ControlTaskProjectionContext['source'] & { taskId: string; state: TaskState; verification: Verification | 'unknown'; evidenceIds: string[] };
  definitionVersion: null;
  stateVersion: null;
  validation: 'unknown';
  acceptance: 'unknown';
  readOnly: true;
  dispatchEligible: false;
}
const STATES: Readonly<Record<TaskState, ControlTaskState>> = {
  queued: 'created', blocked: 'blocked', assigned: 'created', running: 'running', waiting: 'unknown',
  awaiting_approval: 'waiting_approval', verifying: 'validating', completed: 'completed', failed: 'failed', cancelled: 'cancelled', unknown: 'unknown',
};
const OUTCOMES: Readonly<Record<TaskState, ControlExecutionOutcome>> = {
  queued: 'unknown', blocked: 'unknown', assigned: 'unknown', running: 'running', waiting: 'unknown',
  awaiting_approval: 'unknown', verifying: 'unknown', completed: 'succeeded', failed: 'failed', cancelled: 'cancelled', unknown: 'unknown',
};
type ProjectionResult = { ok: true; value: LegacyTaskStateView } | { ok: false; reason: 'invalid-scope' | 'invalid-task' | 'foreign-mission' };

/** Context is caller-asserted; projection neither verifies ownership nor creates revisions. */
export function projectOrchestrationTask(value: unknown, context: unknown): ProjectionResult {
  const parsedScope = parseControlTaskProjectionContext(context);
  if (!parsedScope.ok) return { ok: false, reason: 'invalid-scope' };
  const parsed = parseOrchestration('task', value);
  if (!parsed.ok) return { ok: false, reason: 'invalid-task' };
  const task = parsed.value;
  if (task.missionId !== parsedScope.value.source.missionId) return { ok: false, reason: 'foreign-mission' };
  return { ok: true, value: {
    profileId: parsedScope.value.profileId, workspaceId: parsedScope.value.workspaceId, kind: 'legacy-task-view', state: STATES[task.state],
    reportedExecutionOutcome: OUTCOMES[task.state], source: { ...parsedScope.value.source, taskId: task.id, state: task.state, verification: task.verification ?? 'unknown', evidenceIds: [...task.evidenceIds] },
    definitionVersion: null, stateVersion: null, validation: 'unknown', acceptance: 'unknown', readOnly: true, dispatchEligible: false,
  } };
}
