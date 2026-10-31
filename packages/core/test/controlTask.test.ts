import { describe, expect, it } from 'vitest';
import { parseControlTaskSnapshot, parseOrchestration, TASK_STATES, type ControlTaskProjectionContext, type Task, type TaskState } from '@extalia/protocol';
import { projectOrchestrationTask } from '../src/controlTask.js';

const uuid = (value: number) => `${value.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
const context = (): ControlTaskProjectionContext => ({ profileId: uuid(1), workspaceId: uuid(2), source: { family: 'orchestration.v1', system: 'extalia', instanceId: 'bridge-a', workspaceId: uuid(8), missionId: uuid(3) } });
function task(state: TaskState): Task {
  const value: Task = { schemaVersion: 1, id: uuid(4), missionId: uuid(3), dependsOn: [], state, attempt: 0, requirements: [], evidenceIds: [] };
  if (['assigned', 'running', 'waiting', 'awaiting_approval', 'verifying'].includes(state)) value.assignedAgentId = uuid(5);
  if (state === 'running') { value.attempt = 2; value.leaseId = uuid(6); }
  if (state === 'completed') value.verification = 'unverified';
  return value;
}

describe('legacy task projection preserves uncertainty and provenance', () => {
  it.each(TASK_STATES)('projects %s read-only without fabricating versions or authority', state => {
    const original = task(state), scope = context();
    expect(parseOrchestration('task', original).ok).toBe(true);
    const result = projectOrchestrationTask(original, scope);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toEqual({ ...scope.source, taskId: original.id, state, verification: original.verification ?? 'unknown', evidenceIds: original.evidenceIds });
    expect(result.value).toMatchObject({ definitionVersion: null, stateVersion: null, validation: 'unknown', acceptance: 'unknown', readOnly: true, dispatchEligible: false });
    expect(result.value).not.toHaveProperty('taskId');
    expect(result.value).not.toHaveProperty('missionId');
    expect(parseControlTaskSnapshot(result.value).ok).toBe(false);
    expect(parseOrchestration('task', result.value).ok).toBe(false);
  });
  it.each(['unverified', 'verified'] as const)('does not promote legacy completed + %s to v2 acceptance', verification => {
    const original = { ...task('completed'), verification, evidenceIds: [uuid(9)] };
    const result = projectOrchestrationTask(original, context());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ state: 'completed', reportedExecutionOutcome: 'succeeded', source: { verification }, validation: 'unknown', acceptance: 'unknown', definitionVersion: null, stateVersion: null, dispatchEligible: false });
  });
  it('does not turn assignments into leases or generic waits into retries', () => {
    for (const state of ['queued', 'assigned'] as const) {
      const result = projectOrchestrationTask(task(state), context());
      expect(result.ok && result.value.state).toBe('created');
      expect(result.ok && result.value.reportedExecutionOutcome).toBe('unknown');
    }
    const result = projectOrchestrationTask(task('waiting'), context());
    expect(result.ok && result.value.state).toBe('unknown');
    expect(result.ok && result.value.source.state).toBe('waiting');
  });
  it('distinguishes identical source UUIDs across installations and source workspaces', () => {
    const input = task('completed'), scope = context();
    const original = projectOrchestrationTask(input, scope);
    for (const source of [{ ...scope.source, instanceId: 'bridge-b' }, { ...scope.source, workspaceId: uuid(10) }]) {
      const result = projectOrchestrationTask(input, { ...scope, source });
      expect(result.ok).toBe(true);
      expect(result).not.toEqual(original);
      if (result.ok) expect(result.value.source).toMatchObject({ ...source, taskId: input.id, missionId: input.missionId });
    }
  });
  it('rejects foreign source missions, malformed scopes and other contract families', () => {
    expect(projectOrchestrationTask({ ...task('queued'), missionId: uuid(7) }, context())).toEqual({ ok: false, reason: 'foreign-mission' });
    const source = context().source;
    for (const scope of [null, {}, { ...context(), profileId: 'profile' }, { ...context(), source: { ...source, instanceId: '' } }, { ...context(), source: { ...source, system: 'other' } }]) expect(projectOrchestrationTask(task('queued'), scope)).toEqual({ ok: false, reason: 'invalid-scope' });
    for (const input of [null, {}, { ...task('queued'), state: 'provider-new-state' }, { ...task('queued'), state: 'superseded' }, { protocol: 'extalia.v0', body: { type: 'task.completed' } }]) expect(projectOrchestrationTask(input, context())).toEqual({ ok: false, reason: 'invalid-task' });
  });
  it('returns detached source data and preserves every legacy field unchanged', () => {
    const input = task('completed'), scope = context(); input.evidenceIds = [uuid(9)];
    const before = JSON.stringify({ input, scope });
    const result = projectOrchestrationTask(input, scope);
    expect(result.ok).toBe(true);
    if (result.ok) { result.value.source.evidenceIds.push(uuid(10)); result.value.source.instanceId = 'changed'; }
    expect(JSON.stringify({ input, scope })).toBe(before);
  });
});
