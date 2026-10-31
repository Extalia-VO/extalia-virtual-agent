import type { DaemonMissionRecoveryReview } from './daemonExecutions.js';
import {
  DAEMON_ERROR_CODES, DAEMON_MAX_DEADLINE_MS, DAEMON_MAX_FRAME_BYTES, DAEMON_OPS, DAEMON_PERMISSION_MODES,
  DAEMON_SCHEMA_VERSION, DAEMON_TOOL_ACCESS,
  type DaemonFrame, type DaemonFrameParseResult, type DaemonOp, type DaemonMissionSnapshot,
} from './daemon.js';
import { KNOWLEDGE_PARAMS, KNOWLEDGE_RESULTS, knowledgeJsonSchemaDefs } from './daemonKnowledgeRules.js';
import { EXECUTION_PARAMS, EXECUTION_RESULTS, executionAdmission, executions, executionRecords } from './daemonExecutionRules.js';
import { PLANNING_PARAMS, PLANNING_RESULTS } from './daemonPlanningRules.js';
import { SKILL_PARAMS, SKILL_RESULTS, skillJsonSchemaDefs, skillReason } from './daemonSkillRules.js';
import { schemaRef, type JsonSchema } from './jsonSchema.js';
import type { OrchestrationContractKind } from './orchestration.js';
import { parseOrchestration } from './orchestrationValidate.js';
import {
  array, boolean, count, digest, enumeration, fail, isPlainObject, literal, number, object, optional, positive,
  rule, text, timestamp, UUID_PATTERN, uuid, withSchema, type Rule,
} from './rules.js';
import { MISSION_STATES, TASK_STATES } from './transitions.js';

/** A complete orchestration contract (structure and semantics), errors re-rooted at `path`. */
const contract = (kind: OrchestrationContractKind, def: string) => rule((value, path, errors) => {
  const result = parseOrchestration(kind, value);
  if (!result.ok) for (const error of result.errors) errors.push(`${path}${error.slice(kind.length)}`);
}, schemaRef(def));
const op = withSchema(enumeration(DAEMON_OPS), schemaRef('DaemonOp'));
const access = withSchema(enumeration(DAEMON_TOOL_ACCESS), schemaRef('DaemonToolAccess'));
const taskState = withSchema(enumeration(TASK_STATES), schemaRef('TaskState'));
const capabilities = array(op, true, 1, DAEMON_OPS.length);
const version = text(64);

const missionCreate = object({ mission: contract('mission', 'Mission'), graph: contract('taskGraph', 'TaskGraph') });
const commitEvent = contract('agentEvent', 'AgentEvent');
const transitionShape = object({ missionId: uuid, taskId: uuid, eventId: uuid, from: taskState, to: taskState, supervisorId: optional(uuid) });
const transition = rule((value, path, errors) => {
  const before = errors.length;
  transitionShape.check(value, path, errors);
  if (errors.length !== before) return;
  const params = value as { from: string; to: string; supervisorId?: string };
  if (params.supervisorId !== undefined && (params.to !== 'running' || !['queued', 'assigned'].includes(params.from))) fail(`${path}.supervisorId`, 'supervisor is only valid for a fresh execution admission', errors);
}, { ...transitionShape.schema, allOf: [{ if: { required: ['supervisorId'] }, then: { properties: { from: { enum: ['queued', 'assigned'] }, to: { const: 'running' } } } }] });
const transitionResultShape = object({ missionId: uuid, taskId: uuid, state: taskState, sequence: positive, admission: optional(executionAdmission) });
const transitionResult = rule((value, path, errors) => {
  const before = errors.length;
  transitionResultShape.check(value, path, errors);
  if (errors.length !== before) return;
  const result = value as { missionId: string; taskId: string; state: string; admission?: { missionId: string; taskId: string } };
  if (result.admission && (result.state !== 'running' || result.admission.missionId !== result.missionId || result.admission.taskId !== result.taskId)) fail(`${path}.admission`, 'admission must match the running transition', errors);
}, { ...transitionResultShape.schema, allOf: [{ if: { required: ['admission'] }, then: { properties: { state: { const: 'running' } } } }] });
const heartbeatClaims = (result: boolean) => {
  const shape = object({ missionId: uuid, leases: array(object({
    taskId: uuid, leaseId: uuid, holderAgentId: uuid,
    ...(result ? { acquiredAt: timestamp, expiresAt: timestamp } : {}),
  }), false, 1, 64) });
  return rule((value, path, errors) => {
    const before = errors.length;
    shape.check(value, path, errors);
    if (errors.length !== before) return;
    const { leases } = value as { leases: { taskId: string; leaseId: string; acquiredAt?: string; expiresAt?: string }[] };
    if (new Set(leases.map(lease => lease.taskId)).size !== leases.length || new Set(leases.map(lease => lease.leaseId)).size !== leases.length) fail(`${path}.leases`, 'duplicate task or lease ID', errors);
    if (result && leases.some(lease => Date.parse(lease.expiresAt!) <= Date.parse(lease.acquiredAt!))) fail(`${path}.leases`, 'expiry must follow acquisition', errors);
  }, shape.schema);
};
const snapshotShape = object({
  missionId: uuid, workspaceId: uuid, version: positive, state: enumeration(MISSION_STATES), updatedAt: timestamp,
  sequence: number(1, true, 8192),
  tasks: array(object({ taskId: uuid, assignedAgentId: optional(uuid), state: taskState, attempt: count }), false, 1, 64),
  leases: array(object({ leaseId: uuid, taskId: uuid, holderAgentId: uuid, acquiredAt: timestamp, expiresAt: timestamp }), false, 0, 64),
});
const snapshot = rule((value, path, errors) => {
  const before = errors.length;
  snapshotShape.check(value, path, errors);
  if (errors.length !== before) return;
  const result = value as DaemonMissionSnapshot;
  const tasks = new Map(result.tasks.map(task => [task.taskId, task]));
  if (tasks.size !== result.tasks.length) fail(`${path}.tasks`, 'duplicate task ID', errors);
  const leaseIds = new Set<string>(), leasedTasks = new Set<string>();
  for (const lease of result.leases) {
    if (leaseIds.has(lease.leaseId) || leasedTasks.has(lease.taskId)) fail(`${path}.leases`, 'duplicate lease or task ID', errors);
    leaseIds.add(lease.leaseId); leasedTasks.add(lease.taskId);
    const task = tasks.get(lease.taskId);
    if (!task || task.assignedAgentId !== lease.holderAgentId || !['running', 'waiting', 'awaiting_approval', 'verifying'].includes(task.state)) fail(`${path}.leases`, 'lease does not match a running task and holder', errors);
    if (Date.parse(lease.expiresAt) < Date.parse(lease.acquiredAt)) fail(`${path}.leases`, 'lease expiry precedes acquisition', errors);
  }
  for (const task of result.tasks) {
    if (['assigned', 'running', 'waiting', 'awaiting_approval', 'verifying'].includes(task.state) && !task.assignedAgentId) fail(`${path}.tasks`, 'in-flight task requires an assignee', errors);
    if (['running', 'waiting', 'awaiting_approval', 'verifying'].includes(task.state) && !leasedTasks.has(task.taskId)) fail(`${path}.leases`, 'running task requires its lease', errors);
  }
}, { ...snapshotShape.schema, allOf: [{
  if: { properties: { leases: { maxItems: 0 } } },
  then: { properties: { tasks: { items: { properties: { state: { not: { enum: ['running', 'waiting', 'awaiting_approval', 'verifying'] } } } } } } },
}] });
const reviewShape = object({
  kind: literal('extalia-recovery-review-v1'), snapshot, executions: executionRecords,
  missionDigest: digest, graphDigest: digest, reviewDigest: digest, missingAdmissionTaskIds: array(uuid, true, 0, 64), worktreeOwnership: literal('unverified'),
});
const recoveryReview = rule((value, path, errors) => {
  const before = errors.length;
  reviewShape.check(value, path, errors);
  if (errors.length !== before) return;
  const review = value as DaemonMissionRecoveryReview;
  executions.check({ missionId: review.snapshot.missionId, executions: review.executions }, path, errors);
  if (errors.length !== before) return;
  const admitted = new Set<string>();
  for (const { admission } of review.executions) {
    const task = review.snapshot.tasks.find(task => task.taskId === admission.taskId);
    if (!task || task.assignedAgentId !== admission.holderAgentId || task.attempt !== admission.attempt
      || admission.workspaceId !== review.snapshot.workspaceId || admission.missionVersion > review.snapshot.version) fail(`${path}.executions`, 'execution does not match the reviewed snapshot', errors);
    const lease = review.snapshot.leases.find(lease => lease.taskId === admission.taskId);
    if (lease && lease.leaseId !== admission.leaseId) fail(`${path}.executions`, 'admission does not match the reviewed lease', errors);
    admitted.add(admission.taskId);
  }
  const missing = review.snapshot.tasks.filter(task => !admitted.has(task.taskId)).map(task => task.taskId);
  if (review.missingAdmissionTaskIds.length !== missing.length || review.missingAdmissionTaskIds.some(id => !missing.includes(id))) fail(`${path}.missingAdmissionTaskIds`, 'missing membership must exactly match the graph', errors);
}, { ...reviewShape.schema, allOf: [{
  if: { properties: { executions: { maxItems: 0 } } },
  then: { properties: { missingAdmissionTaskIds: { minItems: 1 } } },
}, {
  if: { properties: { missingAdmissionTaskIds: { maxItems: 0 } } },
  then: { properties: { executions: { minItems: 1 } } },
}] });
const PARAMS: Record<DaemonOp, Rule> = {
  hello: object({ clientVersion: version, capabilities }),
  // Not expressible in JSON Schema: the graph must belong to the created mission.
  'mission.create': rule((value, path, errors) => {
    const before = errors.length;
    missionCreate.check(value, path, errors);
    const params = value as { mission: { id: string }; graph: { missionId: string } };
    if (errors.length === before && params.graph.missionId !== params.mission.id) fail(`${path}.graph.missionId`, 'graph belongs to another mission', errors);
  }, missionCreate.schema),
  'mission.snapshot': object({ missionId: uuid }),
  'mission.heartbeat': heartbeatClaims(false),
  'task.transition': transition,
  'event.commit': object({
    event: rule((value, path, errors) => {
      commitEvent.check(value, path, errors);
      if (isPlainObject(value) && !Object.hasOwn(value, 'missionId')) fail(`${path}.missionId`, 'required for mission control events', errors);
    }, { allOf: [commitEvent.schema, { type: 'object', required: ['missionId'] }] }),
  }),
  'permission.check': object({
    access,
    mode: enumeration(DAEMON_PERMISSION_MODES),
    workspacePermissions: object({ fileWrite: enumeration(['ask', 'allow']), commands: enumeration(['ask', 'allow']) }),
    sessionGrants: array(access, true, 0, DAEMON_TOOL_ACCESS.length),
  }),
  health: object({}),
  ...EXECUTION_PARAMS,
  ...PLANNING_PARAMS,
  ...SKILL_PARAMS,
  ...KNOWLEDGE_PARAMS,
};
const RESULTS: Record<DaemonOp, Rule> = {
  hello: object({ daemonVersion: version, capabilities, maxFrameBytes: number(1, true, DAEMON_MAX_FRAME_BYTES) }),
  'mission.create': object({ missionId: uuid, version: positive }),
  'mission.snapshot': snapshot,
  'mission.recoveryReview': recoveryReview,
  'mission.heartbeat': heartbeatClaims(true),
  'task.transition': transitionResult,
  'event.commit': object({ eventId: uuid, missionId: uuid, sequence: positive, duplicate: boolean }),
  'permission.check': object({ decision: enumeration(['allow', 'ask', 'deny']) }),
  health: object({ status: enumeration(['ok', 'degraded']), uptimeMs: count }),
  ...EXECUTION_RESULTS,
  ...PLANNING_RESULTS,
  ...SKILL_RESULTS,
  ...KNOWLEDGE_RESULTS,
};
const pascal = (name: string) => name.split('.').map(part => `${part[0]!.toUpperCase()}${part.slice(1)}`).join('');
const schemaVersion = literal(DAEMON_SCHEMA_VERSION);
const REQUESTS = Object.fromEntries(DAEMON_OPS.map(name => [name, object({
  schemaVersion, kind: literal('request'), requestId: uuid, op: literal(name),
  deadlineMs: optional(number(1, true, DAEMON_MAX_DEADLINE_MS)),
  params: withSchema(PARAMS[name], schemaRef(`Daemon${pascal(name)}Params`)),
})])) as Record<DaemonOp, Rule>;
const RESPONSES = Object.fromEntries(DAEMON_OPS.map(name => [name, object({
  schemaVersion, kind: literal('response'), requestId: uuid, op: literal(name),
  result: withSchema(RESULTS[name], schemaRef(`Daemon${pascal(name)}Result`)),
})])) as Record<DaemonOp, Rule>;
const ERROR = object({
  schemaVersion, kind: literal('error'), requestId: optional(uuid),
  error: object({ code: withSchema(enumeration(DAEMON_ERROR_CODES), schemaRef('DaemonErrorCode')), message: optional(text(500)), reason: optional(skillReason.ref) }),
});

/** `$defs` of the daemon wire contract; orchestration contracts are referenced by name. */
export function daemonJsonSchemaDefs(): Record<string, JsonSchema> {
  const defs: Record<string, JsonSchema> = {
    DaemonFrame: { oneOf: [schemaRef('DaemonRequest'), schemaRef('DaemonResponse'), schemaRef('DaemonErrorFrame')] },
    DaemonRequest: { oneOf: DAEMON_OPS.map(name => REQUESTS[name].schema) },
    DaemonResponse: { oneOf: DAEMON_OPS.map(name => RESPONSES[name].schema) },
    DaemonErrorFrame: ERROR.schema,
    DaemonOp: enumeration(DAEMON_OPS).schema,
    DaemonErrorCode: enumeration(DAEMON_ERROR_CODES).schema,
    DaemonToolAccess: enumeration(DAEMON_TOOL_ACCESS).schema,
    TaskState: enumeration(TASK_STATES).schema,
    ...skillJsonSchemaDefs(),
    ...knowledgeJsonSchemaDefs(),
  };
  for (const name of DAEMON_OPS) {
    defs[`Daemon${pascal(name)}Params`] = PARAMS[name].schema;
    defs[`Daemon${pascal(name)}Result`] = RESULTS[name].schema;
  }
  return defs;
}

const inParams = (error: string) => /^frame\.params[.:[]/.test(error);

/**
 * Validate one decoded daemon frame. Rejections carry a stable error code and, when
 * the frame names a valid one, its `requestId` so the receiver can answer it.
 * Success does not authorize the operation; the daemon still applies its own policy.
 */
export function parseDaemonFrame(raw: unknown): DaemonFrameParseResult {
  const requestId = isPlainObject(raw) && typeof raw.requestId === 'string' && UUID_PATTERN.test(raw.requestId) ? raw.requestId : undefined;
  const reject = (code: Extract<DaemonFrameParseResult, { ok: false }>['code'], errors: string[]): DaemonFrameParseResult => ({ ok: false, code, errors, ...(requestId ? { requestId } : {}) });
  if (!isPlainObject(raw)) return reject('invalid_frame', ['frame: expected a plain object.']);
  if (typeof raw.schemaVersion !== 'number' || !Number.isSafeInteger(raw.schemaVersion)) return reject('invalid_frame', ['frame.schemaVersion: expected an integer.']);
  if (raw.schemaVersion !== DAEMON_SCHEMA_VERSION) return reject('unsupported_schema_version', [`frame.schemaVersion: ${raw.schemaVersion > DAEMON_SCHEMA_VERSION ? 'newer' : 'older'} than supported version ${DAEMON_SCHEMA_VERSION}.`]);
  const errors: string[] = [];
  if (raw.kind === 'error') ERROR.check(raw, 'frame', errors);
  else if (raw.kind !== 'request' && raw.kind !== 'response') return reject('invalid_frame', ['frame.kind: expected one of request, response, error.']);
  else if (typeof raw.op !== 'string') return reject('invalid_frame', ['frame.op: required operation name.']);
  else if (!(DAEMON_OPS as readonly string[]).includes(raw.op)) return reject('unknown_op', [`frame.op: unknown operation ${JSON.stringify(raw.op)}.`]);
  else (raw.kind === 'request' ? REQUESTS : RESPONSES)[raw.op as DaemonOp].check(raw, 'frame', errors);
  if (!errors.length) return { ok: true, frame: raw as unknown as DaemonFrame };
  return reject(raw.kind === 'request' && errors.every(inParams) ? 'invalid_request' : 'invalid_frame', errors);
}
