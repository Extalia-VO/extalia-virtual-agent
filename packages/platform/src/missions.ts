import type { DaemonMissionExecutions, DaemonMissionRecoveryReview, DaemonMissionSnapshot, TaskState } from '@extalia/protocol';
import { isModelId } from './agentHost.js';

export interface HostMissionTaskInput {
  id: string;
  title: string;
  instructions: string;
  connectionId: string;
  model: string;
  dependsOn: string[];
  timeoutMs?: number;
  maxSteps?: number;
  /**
   * `write`: a write-capable worker (ADR 0028). It edits files only in its own Git worktree under the
   * data folder, never in the project checkout; its changes reach a branch only through an approved
   * integration. Omitted or `read`: read-only, as before. Normalized requests carry the field only for `write`.
   */
  access?: 'read' | 'write';
}

/**
 * Runtime budget for one mission (ADR 0015). Every limit is optional except the
 * concurrency mirror; an omitted limit is not enforced. Token limits count only
 * provider-reported input + output tokens and are checked at call boundaries.
 */
export interface HostMissionBudget {
  /** Wall-clock ceiling for the whole mission, 1 s – 24 h. */
  maxDurationMs?: number;
  /** Reported input + output tokens for the whole mission, 1 – 100,000,000. */
  maxTokens?: number;
  /** Reported input + output tokens per task, 1 – 100,000,000 and ≤ maxTokens. */
  maxTaskTokens?: number;
  /** Tasks at once, 1 – 8; always equal to the request's `maxConcurrency`. */
  maxConcurrency?: number;
}

export interface HostMissionRequest {
  title: string;
  tasks: HostMissionTaskInput[];
  maxConcurrency?: number;
  budget?: HostMissionBudget;
}

/**
 * Provider-reported token usage. Counts are absent when no call reported them.
 * `unknownTasks` counts tasks with at least one call whose usage was not
 * reported (including failed, cancelled or unacknowledged calls): totals are
 * then a lower bound, never an estimate.
 */
export interface HostMissionUsage {
  inputTokens?: number;
  outputTokens?: number;
  unknownTasks: number;
}

/** Per-task usage; `unknown` marks a call whose usage was not reported. Absent: no call was made. */
export interface HostMissionTaskUsage {
  inputTokens?: number;
  outputTokens?: number;
  unknown?: true;
}

/** Why the mission stopped admitting work: a reported limit, unprovable usage under a token budget, or the deadline. */
export type HostMissionBudgetExhaustion = 'tokens' | 'usage-unknown' | 'duration';

export interface HostMissionTask {
  id: string;
  taskId: string;
  agentId: string;
  title: string;
  /** Alias edges from the submitted DAG. Absent only on legacy records with unknown graph shape. */
  dependsOn?: string[];
  connectionId: string;
  model: string;
  state: TaskState;
  answer?: string;
  verification?: 'unverified';
  reason?: string;
  evidenceIds: string[];
  /** Absent on legacy records (unknown) and on tasks that never called a provider. */
  usage?: HostMissionTaskUsage;
  /**
   * `write`: a write-capable worker (ADR 0028) with its own Git worktree; the journal admits its bounded
   * edit activity and its changes are reviewed and integrated through the worktree methods. Absent: read-only.
   */
  access?: 'write';
}

/** Persisted ownership; absent on old records means unknown, regardless of current settings. */
export type HostMissionAuthority = { backend: 'typescript' } | { backend: 'rust'; profileId: string; workspaceId: string; supervisorId?: string };
/** Only host-restart uncertainty can be repaired from an already-terminal canonical snapshot. */
export interface HostMissionRecovery { source: 'host-restart' | 'execution-uncertain'; at: string }
export type HostMissionRecoveryReason = 'authority-unknown' | 'authority-typescript' | 'profile-mismatch' | 'identity-mismatch'
  | 'local-active' | 'execution-uncertain' | 'canonical-nonterminal' | 'tasks-nonterminal' | 'leases-present'
  | 'core-unavailable' | 'snapshot-unsupported' | 'checkpoint-unavailable';
export interface HostMissionRecoveryResult {
  run: HostMissionRun;
  status: 'refreshed' | 'quarantined' | 'unavailable';
  reason?: HostMissionRecoveryReason;
  snapshot?: DaemonMissionSnapshot;
  /** Available only when state and evidence came from one canonical read transaction. */
  reviewInspection?: { status: 'available'; review: DaemonMissionRecoveryReview } | { status: 'unsupported' | 'unavailable' };
  executionInspection?: { status: 'available'; executions: DaemonMissionExecutions['executions'] } | { status: 'unsupported' | 'unavailable' };
}

export interface HostMissionRun {
  id: string;
  sessionId: string;
  workspaceId: string;
  title: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'recovering';
  createdAt: string;
  updatedAt: string;
  transient: boolean;
  authority?: HostMissionAuthority;
  recovery?: HostMissionRecovery;
  tasks: HostMissionTask[];
  /** Normalized budget the mission ran with. Absent on records from older hosts. */
  budget?: HostMissionBudget;
  /** Reported usage. Absent on records from older hosts: usage is unknown. */
  usage?: HostMissionUsage;
  /** Set once a mission-wide budget stopped admission or running work. */
  budgetExhausted?: HostMissionBudgetExhaustion;
}

export const MISSION_BUDGET_LIMITS = {
  minDurationMs: 1_000, maxDurationMs: 86_400_000, maxTokens: 100_000_000, maxConcurrency: 8,
} as const;
const MAX_USAGE = 1_000_000_000_000;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
/** Strict persisted ownership/provenance decoder, shared by checkpoint and sidecar validation. */
export function isHostMissionRecoveryMetadata(run: Pick<HostMissionRun, 'authority' | 'recovery'>): boolean {
  try {
    if (run.authority !== undefined) {
      const authority = object(run.authority, ['backend', 'profileId', 'workspaceId', 'supervisorId'], ['backend']);
      if (authority.backend === 'typescript' && Object.keys(authority).some(key => key !== 'backend')) return false;
      if (authority.backend !== 'typescript' && authority.backend !== 'rust') return false;
      if (authority.backend === 'rust' && (typeof authority.profileId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(authority.profileId)
        || typeof authority.workspaceId !== 'string' || !UUID.test(authority.workspaceId)
        || (authority.supervisorId !== undefined && (typeof authority.supervisorId !== 'string' || !UUID.test(authority.supervisorId))))) return false;
    }
    if (run.recovery !== undefined) {
      const recovery = object(run.recovery, ['source', 'at'], ['source', 'at']);
      if (!['host-restart', 'execution-uncertain'].includes(recovery.source as string) || typeof recovery.at !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(recovery.at) || new Date(recovery.at).toISOString() !== recovery.at) return false;
    }
    return true;
  } catch { return false; }
}

const TASK_ID = /^[a-z][a-z0-9_-]{0,63}$/;

function fail(): never { throw new Error('Invalid native mission request.'); }

/** Require a plain data object with only the listed own string keys. */
function object(value: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return fail();
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key))) return fail();
  const record = value as Record<string, unknown>;
  for (const key of required) if (!Object.hasOwn(record, key)) return fail();
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return fail();
  }
  return record;
}

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return fail();
  return value;
}

function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') return fail();
  const title = value.trim();
  if (!title || title.length > 200 || [...title].some(char => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 || char === '\u2028' || char === '\u2029';
  })) return fail();
  return title;
}

function normalizeTask(raw: unknown): HostMissionTaskInput {
  const value = object(raw, ['id', 'title', 'instructions', 'connectionId', 'model', 'dependsOn', 'timeoutMs', 'maxSteps', 'access'],
    ['id', 'title', 'instructions', 'connectionId', 'model']);
  if (typeof value.id !== 'string' || !TASK_ID.test(value.id)) return fail();
  const title = cleanTitle(value.title);
  if (typeof value.instructions !== 'string' || value.instructions.length < 1 || value.instructions.length > 16_000 || !value.instructions.trim()) return fail();
  if (typeof value.connectionId !== 'string' || !value.connectionId.trim() || value.connectionId.trim() !== value.connectionId || value.connectionId.length > 200
    || [...value.connectionId].some(char => {
      const code = char.charCodeAt(0);
      return char === '/' || char === '\\' || code < 32 || code === 127;
    })) return fail();
  if (!isModelId(value.model)) return fail();
  let dependsOn: string[] = [];
  if (value.dependsOn !== undefined) {
    if (!Array.isArray(value.dependsOn) || value.dependsOn.length > 16) return fail();
    dependsOn = value.dependsOn.map(dependency => {
      if (typeof dependency !== 'string' || !TASK_ID.test(dependency)) return fail();
      return dependency;
    });
    if (new Set(dependsOn).size !== dependsOn.length) return fail();
  }
  const task: HostMissionTaskInput = {
    id: value.id, title, instructions: value.instructions, connectionId: value.connectionId,
    model: value.model, dependsOn: [...dependsOn],
    timeoutMs: boundedInt(value.timeoutMs, 50, 600_000, 60_000),
    maxSteps: boundedInt(value.maxSteps, 1, 20, 8),
  };
  if (value.access !== undefined && value.access !== 'read' && value.access !== 'write') return fail();
  if (value.access === 'write') task.access = 'write';
  return task;
}

/**
 * Strictly validate an untrusted budget. Unknown keys, non-integers and
 * out-of-range values are rejected (never clamped); a per-task token limit
 * above the mission limit is contradictory and rejected too.
 */
export function normalizeHostMissionBudget(raw: unknown, concurrencyFallback = 3): HostMissionBudget {
  const value = object(raw, ['maxDurationMs', 'maxTokens', 'maxTaskTokens', 'maxConcurrency']);
  const optional = (key: string, min: number, max: number) => value[key] === undefined ? undefined : boundedInt(value[key], min, max, 0);
  const maxDurationMs = optional('maxDurationMs', MISSION_BUDGET_LIMITS.minDurationMs, MISSION_BUDGET_LIMITS.maxDurationMs);
  const maxTokens = optional('maxTokens', 1, MISSION_BUDGET_LIMITS.maxTokens);
  const maxTaskTokens = optional('maxTaskTokens', 1, MISSION_BUDGET_LIMITS.maxTokens);
  if (maxTokens !== undefined && maxTaskTokens !== undefined && maxTaskTokens > maxTokens) return fail();
  const maxConcurrency = boundedInt(value.maxConcurrency, 1, MISSION_BUDGET_LIMITS.maxConcurrency, concurrencyFallback);
  return {
    ...(maxDurationMs !== undefined ? { maxDurationMs } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(maxTaskTokens !== undefined ? { maxTaskTokens } : {}), maxConcurrency,
  };
}

const usageCount = (value: unknown) => value === undefined || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_USAGE;

/** Shape check for retained mission usage (strict keys, bounded integers). */
export function isHostMissionUsage(raw: unknown, taskCount: number): raw is HostMissionUsage {
  try {
    const value = object(raw, ['inputTokens', 'outputTokens', 'unknownTasks'], ['unknownTasks']);
    return usageCount(value.inputTokens) && usageCount(value.outputTokens) && typeof value.unknownTasks === 'number'
      && Number.isSafeInteger(value.unknownTasks) && value.unknownTasks >= 0 && value.unknownTasks <= taskCount;
  } catch { return false; }
}

/** Shape check for retained per-task usage. */
export function isHostMissionTaskUsage(raw: unknown): raw is HostMissionTaskUsage {
  try {
    const value = object(raw, ['inputTokens', 'outputTokens', 'unknown']);
    return usageCount(value.inputTokens) && usageCount(value.outputTokens) && (value.unknown === undefined || value.unknown === true);
  } catch { return false; }
}

/** Strictly validate untrusted host input; returns a detached, normalized DAG request. */
export function normalizeHostMissionRequest(raw: unknown): HostMissionRequest {
  const value = object(raw, ['title', 'tasks', 'maxConcurrency', 'budget'], ['title', 'tasks']);
  const title = cleanTitle(value.title);
  if (!Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > 16) return fail();
  for (let index = 0; index < value.tasks.length; index += 1) {
    if (!Object.hasOwn(value.tasks, index)) return fail();
  }
  const tasks = value.tasks.map(normalizeTask);
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) return fail();
    ids.add(task.id);
  }
  for (const task of tasks) {
    if (task.dependsOn.some(id => id === task.id || !ids.has(id))) return fail();
  }
  const pending = new Set(tasks.map(task => task.id));
  const visited = new Set<string>();
  while (pending.size) {
    let progressed = false;
    for (const task of tasks) {
      if (!pending.has(task.id) || task.dependsOn.some(id => !visited.has(id))) continue;
      pending.delete(task.id);
      visited.add(task.id);
      progressed = true;
    }
    if (!progressed) return fail();
  }
  const maxConcurrency = boundedInt(value.maxConcurrency, 1, 8, 3);
  if (value.budget === undefined) return { title, tasks, maxConcurrency };
  const budget = normalizeHostMissionBudget(value.budget, maxConcurrency);
  // One concurrency value: the legacy top-level field and the budget must agree.
  if (value.maxConcurrency !== undefined && budget.maxConcurrency !== maxConcurrency) return fail();
  return { title, tasks, maxConcurrency: budget.maxConcurrency!, budget };
}

/**
 * A request to the session's lead agent to propose (never start) a read-only
 * mission. Connections default to every connection the workspace allows for
 * missions; `models` optionally narrows the eligible model ids.
 */
export interface MissionPlanRequest {
  goal: string;
  /** 1–16, default 6. */
  maxTasks?: number;
  /** A subset of the workspace-allowed mission connections; default all allowed. */
  connectionIds?: string[];
  /** Optional allow-list of model ids. */
  models?: string[];
}

/** A proposed task: a valid `HostMissionTaskInput` plus review-only labels. */
export interface MissionPlanTask extends HostMissionTaskInput {
  role?: string;
  rationale?: string;
}

/**
 * A proposed, editable mission. Its tasks (without `role`/`rationale`) pass
 * `normalizeHostMissionRequest` and use only connection/model pairs the
 * workspace allowed when it was planned. Planning starts nothing.
 */
export interface MissionPlan {
  title: string;
  tasks: MissionPlanTask[];
  maxConcurrency: number;
  /** `model`: the lead split the goal; `heuristic`: a deterministic plan (see `note`). */
  source: 'model' | 'heuristic';
  note?: string;
  /** The lead model asked (or that would have been asked) for this plan. */
  leadModel?: string;
}
