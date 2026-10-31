/** Task-state claims only. Parsing cannot establish acceptance, settlement or CAS authority. */
import { CONTROL_PROTOCOL_VERSION, CONTROL_SCHEMA_VERSION } from './control.js';
import type { JsonSchema } from './jsonSchema.js';
import { array, enumeration, identifier, label, literal, object, optional, positive, rule, uuid } from './rules.js';

export const CONTROL_TASK_STATES = ['created', 'blocked', 'ready', 'leased', 'running', 'waiting_approval', 'retry_wait', 'validating', 'completed', 'failed', 'cancelling', 'cancelled', 'unknown', 'manual_intervention', 'superseded'] as const;
export type ControlTaskState = typeof CONTROL_TASK_STATES[number];
export type ControlExecutionOutcome = 'not_started' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export type ControlTaskValidation = { state: 'not_run' | 'pending' | 'unknown' } | { state: 'passed' | 'failed'; recordRef: string };
export type ControlTaskAcceptance = { state: 'not_reviewed' | 'pending' | 'unknown' }
  | { state: 'accepted' | 'rejected'; recordRef: string }
  | { state: 'waived'; recordRef: string; reason: string };
export interface ControlTaskScope { profileId: string; workspaceId: string; missionId: string }
/** Caller-asserted view scope, not a legacy-to-canonical task or mission mapping. */
export interface ControlTaskProjectionContext {
  profileId: string;
  workspaceId: string;
  source: { family: 'orchestration.v1'; system: 'extalia'; instanceId: string; workspaceId: string; missionId: string };
}
export interface ControlTaskSnapshot extends ControlTaskScope {
  protocol: typeof CONTROL_PROTOCOL_VERSION;
  schemaVersion: typeof CONTROL_SCHEMA_VERSION;
  kind: 'task-snapshot';
  taskId: string;
  /** Independent positive revisions, never inferred from a legacy version or attempt. */
  definitionVersion: number;
  stateVersion: number;
  state: ControlTaskState;
  executionOutcome: ControlExecutionOutcome;
  executionId?: string;
  validation: ControlTaskValidation;
  /** Unresolved claim: consumers must verify the referenced actor, policy and exact versions before effects. */
  acceptance: ControlTaskAcceptance;
  evidenceIds: string[];
}
type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };
const scopeFields = { profileId: uuid, workspaceId: uuid, missionId: uuid };
const projectionContext = object({ profileId: uuid, workspaceId: uuid, source: object({ family: literal('orchestration.v1'), system: literal('extalia'), instanceId: identifier, workspaceId: uuid, missionId: uuid }) });
const validationResolved = object({ state: enumeration(['passed', 'failed']), recordRef: identifier });
const validationUnresolved = object({ state: enumeration(['not_run', 'pending', 'unknown']) });
const validation = rule((value, path, errors) => {
  const state = value && typeof value === 'object' ? (value as Record<string, unknown>).state : undefined;
  (state === 'passed' || state === 'failed' ? validationResolved : validationUnresolved).check(value, path, errors);
}, { oneOf: [validationResolved.schema, validationUnresolved.schema] });
const waiver = object({ state: literal('waived'), recordRef: identifier, reason: label });
const acceptanceResolved = object({ state: enumeration(['accepted', 'rejected']), recordRef: identifier });
const acceptanceUnresolved = object({ state: enumeration(['not_reviewed', 'pending', 'unknown']) });
const acceptance = rule((value, path, errors) => {
  const state = value && typeof value === 'object' ? (value as Record<string, unknown>).state : undefined;
  (state === 'waived' ? waiver : state === 'accepted' || state === 'rejected' ? acceptanceResolved : acceptanceUnresolved).check(value, path, errors);
}, { oneOf: [waiver.schema, acceptanceResolved.schema, acceptanceUnresolved.schema] });
const snapshot = object({ protocol: literal(CONTROL_PROTOCOL_VERSION), schemaVersion: literal(CONTROL_SCHEMA_VERSION), kind: literal('task-snapshot'), ...scopeFields, taskId: uuid,
  definitionVersion: positive, stateVersion: positive, state: enumeration(CONTROL_TASK_STATES),
  executionOutcome: enumeration(['not_started', 'running', 'succeeded', 'failed', 'cancelled', 'unknown']), executionId: optional(uuid), validation, acceptance, evidenceIds: array(uuid, true) });

export function parseControlTaskProjectionContext(value: unknown): Result<ControlTaskProjectionContext> {
  const errors: string[] = []; projectionContext.check(value, '$', errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: value as ControlTaskProjectionContext };
}
export function parseControlTaskSnapshot(value: unknown): Result<ControlTaskSnapshot> {
  const errors: string[] = []; snapshot.check(value, '$', errors);
  if (errors.length) return { ok: false, errors };
  const task = value as ControlTaskSnapshot;
  if (!['not_started', 'unknown'].includes(task.executionOutcome) && !task.executionId) errors.push('$.executionId: required for a known started execution.');
  if (task.acceptance.state === 'accepted' && (task.executionOutcome !== 'succeeded' || task.validation.state !== 'passed' || task.evidenceIds.length === 0)) errors.push('$.acceptance: accepted output requires successful execution and passed validation with evidence.');
  if (task.state === 'completed' && (task.executionOutcome !== 'succeeded' || !['accepted', 'waived'].includes(task.acceptance.state))) errors.push('$.state: completed requires successful execution and explicit acceptance or waiver.');
  return errors.length ? { ok: false, errors } : { ok: true, value: task };
}
export function controlTaskJsonSchemaDefs(): Record<string, JsonSchema> {
  return { ControlTaskSnapshot: { ...snapshot.schema, allOf: [
    { if: { properties: { executionOutcome: { enum: ['running', 'succeeded', 'failed', 'cancelled'] } } }, then: { required: ['executionId'] } },
    { if: { properties: { acceptance: { properties: { state: { const: 'accepted' } } } } }, then: { properties: { executionOutcome: { const: 'succeeded' }, validation: { properties: { state: { const: 'passed' } } }, evidenceIds: { minItems: 1 } } } },
    { if: { properties: { state: { const: 'completed' } } }, then: { properties: { executionOutcome: { const: 'succeeded' }, acceptance: { properties: { state: { enum: ['accepted', 'waived'] } } } } } },
  ] } };
}
