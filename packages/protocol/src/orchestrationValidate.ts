import { EVENT_CHANNELS, PROTOCOL_VERSION } from './events.js';
import { schemaRef, type JsonSchema } from './jsonSchema.js';
import { eventBodyJsonSchema, EVENT_SPECS, EVENT_TYPES, isUtcTimestamp, parseEvent } from './validate.js';
import {
  array, boolean, count, digest, enumeration, fail, identifier, label, literal, nonnegative, number,
  object, optional, positive, rule, runtimeId, text, timestamp, uuid, withSchema, type Rule,
} from './rules.js';
import {
  ORCHESTRATION_SCHEMA_VERSION,
  type AgentEvent, type AgentRegistry, type Approval, type Experience, type Lease,
  type ObservedSession, type OrchestrationContractKind, type OrchestrationContracts,
  type OrchestrationParseResult, type OrchestrationPlan, type SkillCandidate,
  type Task, type TaskAttempt, type TaskGraph,
} from './orchestration.js';
import { MISSION_STATES, TASK_STATES } from './transitions.js';

const version = literal(ORCHESTRATION_SCHEMA_VERSION);
const versioned = (fields: Record<string, Rule>) => object({ schemaVersion: version, ...fields });
const ids = array(uuid, true);
/** `$defs` name of a contract kind in the generated JSON Schema files. */
const defName = (kind: OrchestrationContractKind) => kind === 'plan' ? 'OrchestrationPlan' : `${kind[0]!.toUpperCase()}${kind.slice(1)}`;
const ref = (kind: OrchestrationContractKind): Rule => rule((value, path, errors) => {
  schemas[kind].check(value, path, errors);
  // Semantic checks are only safe after the complete structural check succeeds.
}, schemaRef(defName(kind)));
const missionState = enumeration(MISSION_STATES);
const taskState = enumeration(TASK_STATES);
const verification = enumeration(['unverified', 'verified']);
const confidence = enumeration(['reported', 'observed', 'inferred']);
const risk = enumeration(['low', 'medium', 'high']);
const capabilityFields = { observe: boolean, readMessages: boolean, readTools: boolean, pause: boolean, resume: boolean, control: boolean, delegate: boolean };
const source = object({ runtime: runtimeId, channel: enumeration(EVENT_CHANNELS), adapter: optional(runtimeId), adapterVersion: optional(text(64)) });
const scopeFields: Record<'mission' | 'workspace' | 'global', Record<string, Rule>> = {
  mission: { kind: literal('mission'), workspaceId: uuid, missionId: uuid },
  workspace: { kind: literal('workspace'), workspaceId: uuid },
  global: { kind: literal('global'), exportApprovalId: uuid },
};
const memoryScope = rule((value, path, errors) => {
  const kind = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).kind : undefined;
  object(kind === 'mission' || kind === 'workspace' ? scopeFields[kind] : scopeFields.global).check(value, path, errors);
}, { oneOf: Object.values(scopeFields).map(fields => object(fields).schema) });
const controlBodies = { 'mission.state': object({ type: literal('mission.state'), state: missionState }), 'task.state': object({ type: literal('task.state'), state: taskState }) };
const eventBody = rule((value, path, errors) => {
  const type = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).type : undefined;
  if (type === 'mission.state' || type === 'task.state') {
    controlBodies[type].check(value, path, errors);
    return;
  }
  const result = parseEvent({ v: PROTOCOL_VERSION, id: 'validation', sessionId: 'validation', at: '2026-01-01T00:00:00Z', agentId: 'validation', taskId: 'validation', source: { runtime: 'extalia', channel: 'system' }, body: value });
  if (!result.ok) for (const error of result.errors) fail(path, error, errors);
}, schemaRef('AgentEventBody'));
const schemas: Record<OrchestrationContractKind, Rule> = {
  mission: versioned({ id: uuid, workspaceId: uuid, leadAgentId: uuid, budgetId: uuid, state: missionState, createdAt: timestamp, updatedAt: timestamp, version: positive }),
  task: versioned({ id: uuid, missionId: uuid, parentTaskId: optional(uuid), dependsOn: ids, assignedAgentId: optional(uuid), state: taskState, attempt: count, leaseId: optional(uuid), requirements: array(label, true), evidenceIds: ids, verification: optional(verification), access: optional(literal('write')) }),
  taskGraph: versioned({ missionId: uuid, tasks: array(ref('task')) }),
  taskAttempt: versioned({ id: uuid, taskId: uuid, agentId: uuid, number: positive, state: enumeration(['running', 'succeeded', 'failed', 'cancelled', 'unknown']), startedAt: timestamp, endedAt: optional(timestamp), evidenceIds: ids }),
  lease: versioned({ id: uuid, taskId: uuid, attemptId: uuid, holderAgentId: uuid, acquiredAt: timestamp, heartbeatAt: timestamp, expiresAt: timestamp }),
  engineCapabilities: versioned(capabilityFields),
  agentIdentity: versioned({ id: uuid, origin: enumeration(['native', 'observed']), role: label, workspaceId: uuid, supervisorId: optional(uuid), engineId: runtimeId, modelProfileId: optional(uuid), capabilities: ref('engineCapabilities') }),
  agentRegistry: versioned({ workspaceId: uuid, agents: array(ref('agentIdentity')) }),
  provider: versioned({ id: uuid, adapterId: runtimeId, credentialRef: optional(identifier), maxConcurrency: positive }),
  modelProfile: versioned({ id: uuid, providerId: uuid, model: label, toolCalling: boolean, streaming: boolean, vision: boolean, contextTokens: optional(positive), pricing: optional(object({ version: identifier, effectiveAt: timestamp, inputUsdPerMillion: nonnegative, outputUsdPerMillion: nonnegative, estimated: literal(true) })) }),
  budget: versioned({ id: uuid, workspaceId: uuid, maxTokens: count, spentTokens: count, maxCostUsd: nonnegative, spentCostUsd: nonnegative, maxDurationMs: count, maxActiveAgents: positive, maxDelegationDepth: count }),
  agentEvent: versioned({ id: uuid, workspaceId: uuid, sessionId: uuid, missionId: optional(uuid), taskId: optional(uuid), agentId: optional(uuid), parentId: optional(uuid), correlationId: optional(uuid), source: withSchema(source, schemaRef('EventSource')), sourceTimestamp: optional(timestamp), observedAt: timestamp, sequence: optional(count), confidence, body: eventBody }),
  toolCall: versioned({ id: uuid, workspaceId: uuid, taskId: uuid, attemptId: uuid, agentId: uuid, permissionId: uuid, tool: identifier, action: label, scope: label, parametersDigest: digest, idempotencyKey: identifier, recovery: enumeration(['idempotent', 'reconcile']), state: enumeration(['proposed', 'waiting_approval', 'running', 'succeeded', 'failed', 'cancelled', 'unknown']) }),
  permission: versioned({ id: uuid, workspaceId: uuid, actorId: uuid, capability: identifier, action: label, scope: label, decision: enumeration(['allow', 'deny', 'ask']), risk }),
  approval: versioned({ id: uuid, workspaceId: uuid, actorId: uuid, permissionId: uuid, toolCallId: uuid, action: label, scope: label, parametersDigest: digest, risk, requestedAt: timestamp, expiresAt: timestamp, status: enumeration(['pending', 'granted', 'rejected', 'expired', 'revoked']), decidedAt: optional(timestamp), decidedBy: optional(uuid) }),
  evidence: versioned({ id: uuid, workspaceId: uuid, taskId: uuid, kind: enumeration(['test', 'build', 'diff', 'artifact', 'log', 'review', 'user_confirmation']), artifactId: uuid, digest, recordedAt: timestamp, verification }),
  adapterCapabilities: versioned({ ...capabilityFields, adapterId: runtimeId, adapterVersion: text(64) }),
  observedSession: versioned({ id: uuid, workspaceId: uuid, agentId: uuid, externalSessionId: identifier, access: literal('read-only'), capabilities: ref('adapterCapabilities'), freshness: enumeration(['current', 'stale', 'unknown', 'offline', 'ended']), lastSeenAt: optional(timestamp), observedAt: timestamp, confidence }),
  memoryScope,
  experience: versioned({ id: uuid, workspaceId: uuid, missionId: uuid, taskId: uuid, agentId: uuid, scope: ref('memoryScope'), eventIds: ids, evidenceIds: ids, outcome: enumeration(['succeeded', 'failed', 'unknown']), recordedAt: timestamp, redacted: boolean }),
  skillCandidate: versioned({ id: uuid, scope: ref('memoryScope'), experienceIds: array(uuid, true, 1), evidenceIds: ids, counterexampleIds: ids, confidence: number(0, false, 1), status: enumeration(['proposed', 'validating', 'review_pending', 'rejected', 'approved']), validation: enumeration(['pending', 'passed', 'failed']), privileged: boolean, reviewedBy: optional(uuid), reviewedAt: optional(timestamp), activationApprovalId: optional(uuid), version: identifier }),
  plan: versioned({ mission: ref('mission'), graph: ref('taskGraph'), registry: ref('agentRegistry'), providers: array(ref('provider')), models: array(ref('modelProfile')), budget: ref('budget') }),
};

function ordered(start: string, end: string, path: string, errors: string[], strict = false): void {
  if (strict ? Date.parse(end) <= Date.parse(start) : Date.parse(end) < Date.parse(start)) fail(path, `must be ${strict ? 'after' : 'at or after'} the start timestamp`, errors);
}
function uniqueById<T extends { id: string }>(values: T[], path: string, errors: string[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of values) {
    if (result.has(item.id)) fail(path, 'duplicate ID', errors);
    result.set(item.id, item);
  }
  return result;
}
function acyclic(edges: Map<string, string[]>, path: string, errors: string[]): void {
  const visiting = new Set<string>(), visited = new Set<string>();
  const walk = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of edges.get(id) ?? []) if (edges.has(dependency) && !walk(dependency)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  for (const id of edges.keys()) if (!walk(id)) { fail(path, 'cycle detected', errors); return; }
}
const ASSIGNED_TASK_STATES = ['assigned', 'running', 'waiting', 'awaiting_approval', 'verifying'];
function checkTask(task: Task, path: string, errors: string[]): void {
  if (task.dependsOn.includes(task.id) || task.parentTaskId === task.id) fail(path, 'task cannot reference itself', errors);
  if (ASSIGNED_TASK_STATES.includes(task.state) && !task.assignedAgentId) fail(`${path}.assignedAgentId`, 'required for assigned work', errors);
  if (task.state === 'running' && (!task.leaseId || task.attempt === 0)) fail(path, 'running work needs a lease and a positive attempt number', errors);
  if (task.state === 'completed' && !task.verification) fail(`${path}.verification`, 'completed work must declare verification', errors);
  if (task.verification === 'verified' && (task.state !== 'completed' || task.evidenceIds.length === 0)) fail(path, 'verified work must be completed and cite evidence', errors);
}
function checkGraph(graph: TaskGraph, path: string, errors: string[]): void {
  const tasks = uniqueById(graph.tasks, `${path}.tasks`, errors);
  const dependencies = new Map<string, string[]>(), parents = new Map<string, string[]>();
  for (const task of graph.tasks) {
    checkTask(task, `${path}.tasks[${task.id}]`, errors);
    if (task.missionId !== graph.missionId) fail(path, 'task belongs to another mission', errors);
    for (const id of [...task.dependsOn, ...(task.parentTaskId ? [task.parentTaskId] : [])]) if (!tasks.has(id)) fail(path, `unknown task reference ${id}`, errors);
    if (['running', 'verifying', 'completed'].includes(task.state) && task.dependsOn.some(id => tasks.get(id)?.state !== 'completed')) fail(path, 'started or completed work requires completed dependencies', errors);
    dependencies.set(task.id, task.dependsOn);
    parents.set(task.id, task.parentTaskId ? [task.parentTaskId] : []);
  }
  acyclic(dependencies, `${path}.dependsOn`, errors);
  acyclic(parents, `${path}.parentTaskId`, errors);
}
function checkRegistry(registry: AgentRegistry, path: string, errors: string[]): void {
  const agents = uniqueById(registry.agents, `${path}.agents`, errors);
  const supervisors = new Map<string, string[]>();
  for (const agent of registry.agents) {
    if (agent.workspaceId !== registry.workspaceId) fail(path, 'agent belongs to another workspace', errors);
    if (agent.supervisorId && !agents.has(agent.supervisorId)) fail(path, 'unknown supervisor reference', errors);
    supervisors.set(agent.id, agent.supervisorId ? [agent.supervisorId] : []);
  }
  acyclic(supervisors, `${path}.supervisorId`, errors);
}
function checkPlan(plan: OrchestrationPlan, path: string, errors: string[]): void {
  const { mission, graph, registry, budget } = plan;
  checkSemantic('mission', mission, `${path}.mission`, errors);
  checkGraph(graph, `${path}.graph`, errors);
  checkRegistry(registry, `${path}.registry`, errors);
  if (graph.missionId !== mission.id || registry.workspaceId !== mission.workspaceId || budget.workspaceId !== mission.workspaceId || budget.id !== mission.budgetId) fail(path, 'mission, graph, registry and budget references must agree', errors);
  const agents = new Map(registry.agents.map(agent => [agent.id, agent]));
  const providers = uniqueById(plan.providers, `${path}.providers`, errors);
  const models = uniqueById(plan.models, `${path}.models`, errors);
  const lead = agents.get(mission.leadAgentId);
  if (!lead || lead.origin !== 'native' || lead.supervisorId) fail(path, 'mission lead must be a registered native root agent', errors);
  for (const model of plan.models) if (!providers.has(model.providerId)) fail(path, 'unknown model provider reference', errors);
  for (const agent of registry.agents) if (agent.modelProfileId && !models.has(agent.modelProfileId)) fail(path, 'unknown agent model profile reference', errors);
  for (const task of graph.tasks) if (task.assignedAgentId) {
    const agent = agents.get(task.assignedAgentId);
    if (!agent || agent.origin !== 'native') fail(path, 'task assignee must be a registered native agent', errors);
  }
}
const RESOLVED_APPROVAL_STATUSES = ['granted', 'rejected', 'revoked'];
function checkApproval(approval: Approval, path: string, errors: string[]): void {
  ordered(approval.requestedAt, approval.expiresAt, path, errors, true);
  if ((approval.decidedAt === undefined) !== (approval.decidedBy === undefined)) fail(path, 'decision timestamp and actor must appear together', errors);
  if (RESOLVED_APPROVAL_STATUSES.includes(approval.status) && !approval.decidedAt) fail(path, 'resolved approval requires a decision record', errors);
  if (approval.status === 'pending' && approval.decidedAt) fail(path, 'pending approval cannot contain a decision', errors);
  if (approval.decidedBy === approval.actorId) fail(path, 'requesting agent cannot approve its own action', errors);
  if (approval.decidedAt) {
    ordered(approval.requestedAt, approval.decidedAt, path, errors);
    if (['granted', 'rejected'].includes(approval.status)) ordered(approval.decidedAt, approval.expiresAt, path, errors, true);
  }
}
function checkSemantic(kind: OrchestrationContractKind, value: unknown, path: string, errors: string[]): void {
  switch (kind) {
    case 'mission': {
      const mission = value as OrchestrationContracts['mission'];
      ordered(mission.createdAt, mission.updatedAt, path, errors);
      break;
    }
    case 'task': checkTask(value as Task, path, errors); break;
    case 'taskGraph': checkGraph(value as TaskGraph, path, errors); break;
    case 'agentRegistry': checkRegistry(value as AgentRegistry, path, errors); break;
    case 'plan': checkPlan(value as OrchestrationPlan, path, errors); break;
    case 'taskAttempt': {
      const attempt = value as TaskAttempt;
      if (['succeeded', 'failed', 'cancelled'].includes(attempt.state) && !attempt.endedAt) fail(path, 'terminal attempt requires endedAt', errors);
      if (attempt.state === 'running' && attempt.endedAt) fail(path, 'running attempt cannot have endedAt', errors);
      if (attempt.endedAt) ordered(attempt.startedAt, attempt.endedAt, path, errors);
      break;
    }
    case 'lease': {
      const lease = value as Lease;
      ordered(lease.acquiredAt, lease.heartbeatAt, path, errors);
      ordered(lease.heartbeatAt, lease.expiresAt, path, errors, true);
      break;
    }
    case 'approval': checkApproval(value as Approval, path, errors); break;
    case 'agentEvent': {
      const event = value as AgentEvent;
      if (event.taskId && !event.missionId) fail(path, 'task events require mission context', errors);
      if (event.body.type === 'mission.state' && !event.missionId) fail(path, 'mission state requires missionId', errors);
      else if (event.body.type === 'task.state' && !event.taskId) fail(path, 'task state requires taskId', errors);
      else if (event.body.type !== 'mission.state' && event.body.type !== 'task.state') {
        const parsed = parseEvent({ v: PROTOCOL_VERSION, id: event.id, at: event.observedAt, sessionId: event.sessionId, source: event.source, agentId: event.agentId, taskId: event.taskId, body: event.body });
        if (!parsed.ok) for (const error of parsed.errors) fail(path, error, errors);
      }
      break;
    }
    case 'observedSession': {
      const session = value as ObservedSession;
      if (!session.capabilities.observe) fail(path, 'observed session requires observation capability', errors);
      if (session.freshness === 'current' && !session.lastSeenAt) fail(path, 'current session requires lastSeenAt', errors);
      if (session.lastSeenAt) ordered(session.lastSeenAt, session.observedAt, path, errors);
      break;
    }
    case 'experience': {
      const experience = value as Experience;
      if (experience.scope.kind !== 'global' && experience.scope.workspaceId !== experience.workspaceId) fail(path, 'experience scope belongs to another workspace', errors);
      if (experience.scope.kind === 'mission' && experience.scope.missionId !== experience.missionId) fail(path, 'experience scope belongs to another mission', errors);
      break;
    }
    case 'skillCandidate': {
      const candidate = value as SkillCandidate;
      if ((candidate.reviewedAt === undefined) !== (candidate.reviewedBy === undefined)) fail(path, 'review timestamp and actor must appear together', errors);
      if (['rejected', 'approved'].includes(candidate.status) && !candidate.reviewedAt) fail(path, 'reviewed candidate requires a review record', errors);
      if (candidate.status === 'approved' && (candidate.validation !== 'passed' || candidate.evidenceIds.length === 0)) fail(path, 'approved candidate requires passed validation and evidence', errors);
      if (candidate.activationApprovalId && (candidate.status !== 'approved' || !candidate.privileged)) fail(path, 'activation approval belongs only to an approved privileged candidate', errors);
      if (candidate.privileged && candidate.status === 'approved' && !candidate.activationApprovalId) fail(path, 'privileged candidate requires activation approval', errors);
      break;
    }
  }
}

const when = (field: string, values: readonly string[], then: JsonSchema): JsonSchema => ({ if: { required: [field], properties: { [field]: { enum: [...values] } } }, then });
const whenBody = (types: readonly string[], field: string): JsonSchema => ({ if: { required: ['body'], properties: { body: { type: 'object', required: ['type'], properties: { type: { enum: [...types] } } } } }, then: { required: [field] } });
const requiringEnvelope = (field: 'agentId' | 'taskId') => EVENT_TYPES.filter(type => EVENT_SPECS[type].requires?.includes(field));
/**
 * The part of `checkSemantic` JSON Schema can express. Validator-only (receivers must
 * still apply them): timestamp ordering, task self-references, graph/registry/plan
 * references, cycles and dependency completion, duplicate IDs, self-approval, and
 * lengths counted in UTF-16 code units (JSON Schema counts code points).
 */
const SEMANTIC_SCHEMAS: Partial<Record<OrchestrationContractKind, JsonSchema>> = {
  task: { allOf: [
    when('state', ASSIGNED_TASK_STATES, { required: ['assignedAgentId'] }),
    when('state', ['running'], { required: ['leaseId'], properties: { attempt: { type: 'integer', minimum: 1 } } }),
    when('state', ['completed'], { required: ['verification'] }),
    when('verification', ['verified'], { properties: { state: { const: 'completed' }, evidenceIds: { type: 'array', minItems: 1 } } }),
  ] },
  agentEvent: {
    dependentRequired: { taskId: ['missionId'] },
    allOf: [whenBody(['mission.state'], 'missionId'), whenBody(['task.state', ...requiringEnvelope('taskId')], 'taskId'), whenBody(requiringEnvelope('agentId'), 'agentId')],
  },
  approval: {
    dependentRequired: { decidedAt: ['decidedBy'], decidedBy: ['decidedAt'] },
    allOf: [when('status', RESOLVED_APPROVAL_STATUSES, { required: ['decidedAt'] }), when('status', ['pending'], { not: { required: ['decidedAt'] } })],
  },
};

/** `$defs` for every orchestration contract (structure plus expressible semantics), keyed by `$defs` name. */
export function orchestrationJsonSchemaDefs(): Record<string, JsonSchema> {
  const defs: Record<string, JsonSchema> = {
    EventSource: source.schema,
    AgentEventBody: { oneOf: [...Object.values(controlBodies).map(body => body.schema), ...EVENT_TYPES.map(eventBodyJsonSchema)] },
  };
  for (const kind of Object.keys(schemas) as OrchestrationContractKind[]) defs[defName(kind)] = { ...schemas[kind].schema, ...SEMANTIC_SCHEMAS[kind] };
  return defs;
}

/**
 * Validate a bounded JSON wire record, rejecting unknown fields and invalid
 * internal references. Successful parsing does not authorize or execute work.
 * References outside the supplied record need a store/policy check by callers.
 */
export function parseOrchestration<K extends OrchestrationContractKind>(kind: K, raw: unknown): OrchestrationParseResult<OrchestrationContracts[K]> {
  const errors: string[] = [];
  if (!Object.hasOwn(schemas, kind)) return { ok: false, errors: ['Unknown orchestration contract kind.'] };
  schemas[kind].check(raw, kind, errors);
  if (!errors.length) checkSemantic(kind, raw, kind, errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: raw as OrchestrationContracts[K] };
}

/** Match exact action identity; caller must still authenticate the approver and enforce policy. */
export function approvalMatchesToolCall(approval: Approval, toolCall: OrchestrationContracts['toolCall'], at: string): boolean {
  if (!parseOrchestration('approval', approval).ok || !parseOrchestration('toolCall', toolCall).ok || !isUtcTimestamp(at)) return false;
  return approval.status === 'granted' && approval.toolCallId === toolCall.id
    && approval.workspaceId === toolCall.workspaceId && approval.actorId === toolCall.agentId
    && approval.permissionId === toolCall.permissionId && approval.action === toolCall.action
    && approval.scope === toolCall.scope && approval.parametersDigest === toolCall.parametersDigest
    && Date.parse(at) >= Date.parse(approval.decidedAt!) && Date.parse(at) < Date.parse(approval.expiresAt);
}
