/**
 * Additive orchestration wire contracts. These do not replace extalia.v0 events,
 * execute work, grant permissions, verify evidence or provide durable storage.
 * IDs are UUIDs; engine/tool identifiers and external model names remain open.
 * Legacy v0 IDs need explicit mappings at an integration boundary; existing
 * event stores and adapters are not migrated by these contracts.
 */
import type { EventBody, EventSource, RiskLevel } from './events.js';

export const ORCHESTRATION_SCHEMA_VERSION = 1 as const;
export interface OrchestrationVersioned { schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION }
export type AgentOrigin = 'native' | 'observed';
export type MissionState = 'draft' | 'planning' | 'queued' | 'running' | 'waiting' | 'awaiting_approval' | 'reviewing' | 'completed' | 'failed' | 'cancelled' | 'recovering';
export type TaskState = 'queued' | 'blocked' | 'assigned' | 'running' | 'waiting' | 'awaiting_approval' | 'verifying' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type Verification = 'unverified' | 'verified';
export type EvidenceKind = 'test' | 'build' | 'diff' | 'artifact' | 'log' | 'review' | 'user_confirmation';

export interface Mission extends OrchestrationVersioned {
  id: string;
  workspaceId: string;
  leadAgentId: string;
  budgetId: string;
  state: MissionState;
  createdAt: string;
  updatedAt: string;
  /** Optimistic revision, independent of schemaVersion. */
  version: number;
}
export interface Task extends OrchestrationVersioned {
  id: string;
  missionId: string;
  parentTaskId?: string;
  dependsOn: string[];
  assignedAgentId?: string;
  state: TaskState;
  attempt: number;
  leaseId?: string;
  requirements: string[];
  evidenceIds: string[];
  /** Completed work must explicitly distinguish verified from unverified. */
  verification?: Verification;
  /**
   * `write`: a write-capable worker task (ADR 0028). Its worker edits only its own Git worktree, and
   * the journal admits its bounded edit activity (`missionJournalRole`). Absent: read-only.
   */
  access?: 'write';
}
export interface TaskGraph extends OrchestrationVersioned { missionId: string; tasks: Task[] }
export interface TaskAttempt extends OrchestrationVersioned {
  id: string;
  taskId: string;
  agentId: string;
  number: number;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  startedAt: string;
  endedAt?: string;
  evidenceIds: string[];
}
export interface Lease extends OrchestrationVersioned {
  id: string;
  taskId: string;
  attemptId: string;
  holderAgentId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}
/** Supported operations, never authorization to invoke those operations. */
export interface EngineCapabilities extends OrchestrationVersioned {
  observe: boolean;
  readMessages: boolean;
  readTools: boolean;
  pause: boolean;
  resume: boolean;
  control: boolean;
  delegate: boolean;
}
export interface AgentIdentity extends OrchestrationVersioned {
  id: string;
  origin: AgentOrigin;
  role: string;
  workspaceId: string;
  supervisorId?: string;
  engineId: string;
  modelProfileId?: string;
  capabilities: EngineCapabilities;
}
export interface AgentRegistry extends OrchestrationVersioned { workspaceId: string; agents: AgentIdentity[] }
export interface Provider extends OrchestrationVersioned {
  id: string;
  adapterId: string;
  /** Opaque credential-store reference; never a credential value. */
  credentialRef?: string;
  maxConcurrency: number;
}
export interface ModelProfile extends OrchestrationVersioned {
  id: string;
  providerId: string;
  model: string;
  toolCalling: boolean;
  streaming: boolean;
  vision: boolean;
  /** Configured or discovered context size; absent when unknown, never a guessed limit. */
  contextTokens?: number;
  /** Estimates only; actual provider billing can differ. */
  pricing?: { version: string; effectiveAt: string; inputUsdPerMillion: number; outputUsdPerMillion: number; estimated: true };
}
export interface Budget extends OrchestrationVersioned {
  id: string;
  workspaceId: string;
  maxTokens: number;
  spentTokens: number;
  maxCostUsd: number;
  spentCostUsd: number;
  maxDurationMs: number;
  maxActiveAgents: number;
  maxDelegationDepth: number;
}
export type AgentEventBody = EventBody
  | { type: 'mission.state'; state: MissionState }
  | { type: 'task.state'; state: TaskState };
export interface AgentEvent extends OrchestrationVersioned {
  id: string;
  workspaceId: string;
  sessionId: string;
  missionId?: string;
  taskId?: string;
  agentId?: string;
  parentId?: string;
  correlationId?: string;
  source: EventSource;
  sourceTimestamp?: string;
  observedAt: string;
  /** Assigned by a future journal; parser does not establish ordering. */
  sequence?: number;
  confidence: 'reported' | 'observed' | 'inferred';
  body: AgentEventBody;
}
export interface ToolCall extends OrchestrationVersioned {
  id: string;
  workspaceId: string;
  taskId: string;
  attemptId: string;
  agentId: string;
  permissionId: string;
  tool: string;
  action: string;
  scope: string;
  /** SHA-256 of canonical exact parameters, computed by the caller. */
  parametersDigest: string;
  idempotencyKey: string;
  recovery: 'idempotent' | 'reconcile';
  state: 'proposed' | 'waiting_approval' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
}
export interface Permission extends OrchestrationVersioned {
  id: string;
  workspaceId: string;
  actorId: string;
  capability: string;
  action: string;
  scope: string;
  decision: 'allow' | 'deny' | 'ask';
  risk: RiskLevel;
}
export interface Approval extends OrchestrationVersioned {
  id: string;
  workspaceId: string;
  actorId: string;
  permissionId: string;
  toolCallId: string;
  action: string;
  scope: string;
  parametersDigest: string;
  risk: RiskLevel;
  requestedAt: string;
  expiresAt: string;
  status: 'pending' | 'granted' | 'rejected' | 'expired' | 'revoked';
  decidedAt?: string;
  /** User identity, distinct from the requesting worker identity. */
  decidedBy?: string;
}
export interface Evidence extends OrchestrationVersioned {
  id: string;
  workspaceId: string;
  taskId: string;
  kind: EvidenceKind;
  artifactId: string;
  digest: string;
  recordedAt: string;
  /** Recording a claim does not establish verification. */
  verification: Verification;
}
export interface AdapterCapabilities extends EngineCapabilities {
  adapterId: string;
  adapterVersion: string;
}
export interface ObservedSession extends OrchestrationVersioned {
  id: string;
  workspaceId: string;
  agentId: string;
  externalSessionId: string;
  /** Observation does not confer process control, even if an adapter supports it. */
  access: 'read-only';
  capabilities: AdapterCapabilities;
  freshness: 'current' | 'stale' | 'unknown' | 'offline' | 'ended';
  lastSeenAt?: string;
  observedAt: string;
  confidence: 'reported' | 'observed' | 'inferred';
}
export type MemoryScope =
  | { kind: 'mission'; workspaceId: string; missionId: string }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'global'; exportApprovalId: string };
export interface Experience extends OrchestrationVersioned {
  id: string;
  workspaceId: string;
  missionId: string;
  taskId: string;
  agentId: string;
  scope: MemoryScope;
  eventIds: string[];
  evidenceIds: string[];
  outcome: 'succeeded' | 'failed' | 'unknown';
  recordedAt: string;
  redacted: boolean;
}
export interface SkillCandidate extends OrchestrationVersioned {
  id: string;
  scope: MemoryScope;
  experienceIds: string[];
  evidenceIds: string[];
  counterexampleIds: string[];
  confidence: number;
  status: 'proposed' | 'validating' | 'review_pending' | 'rejected' | 'approved';
  validation: 'pending' | 'passed' | 'failed';
  privileged: boolean;
  reviewedBy?: string;
  reviewedAt?: string;
  activationApprovalId?: string;
  /** Candidate approval is not activation; the runtime must enforce review. */
  version: string;
}
/** Closed planning snapshot, allowing references to be validated before execution. */
export interface OrchestrationPlan extends OrchestrationVersioned {
  mission: Mission;
  graph: TaskGraph;
  registry: AgentRegistry;
  providers: Provider[];
  models: ModelProfile[];
  budget: Budget;
}
export interface OrchestrationContracts {
  mission: Mission;
  task: Task;
  taskGraph: TaskGraph;
  taskAttempt: TaskAttempt;
  lease: Lease;
  engineCapabilities: EngineCapabilities;
  agentIdentity: AgentIdentity;
  agentRegistry: AgentRegistry;
  provider: Provider;
  modelProfile: ModelProfile;
  budget: Budget;
  agentEvent: AgentEvent;
  toolCall: ToolCall;
  permission: Permission;
  approval: Approval;
  evidence: Evidence;
  adapterCapabilities: AdapterCapabilities;
  observedSession: ObservedSession;
  memoryScope: MemoryScope;
  experience: Experience;
  skillCandidate: SkillCandidate;
  plan: OrchestrationPlan;
}
export type OrchestrationContractKind = keyof OrchestrationContracts;
export type OrchestrationParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };
