import type {
  AgentHostApi, ConnectionView, HostMissionBudget, HostMissionRequest, HostMissionRun, HostMissionTask, HostState, MissionPlan, MissionPlanRequest, MissionPlanTask, SessionSummary,
} from '@extalia/platform';
import { isModelId, MISSION_BUDGET_LIMITS, normalizeHostMissionRequest } from '@extalia/platform';
import type { MissionState } from '@extalia/protocol';
import type { Workspace } from '@extalia/core';

/*
 * v0.0.43 missions: pure helpers for the Missions page. Nothing here talks to a
 * provider; the host stays the authority (it re-validates every request).
 */

export type { MissionPlan, MissionPlanRequest, MissionPlanTask };
type PlanMethod = (sessionId: string, request: MissionPlanRequest) => Promise<MissionPlan>;

/** The host's lead planner, feature-detected: an older Desktop preload may not expose it. */
export function missionPlanner(agents: AgentHostApi): PlanMethod | undefined {
  const method = (agents as unknown as { planNativeMission?: unknown }).planNativeMission;
  return typeof method === 'function' ? (sessionId, request) => (method as PlanMethod).call(agents, sessionId, request) : undefined;
}

export const MAX_TASKS = 16;
export const DEFAULT_PLAN_TASKS = 6;
export const MAX_GOAL = 4000;
export const MAX_INSTRUCTIONS = 16_000;
export const TASK_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export type Eligibility = 'eligible' | 'observed' | 'hermes' | 'no-folder';

/** Only managed Extalia Native sessions in a native workspace with a project folder can run missions. */
export function missionEligibility(state: HostState, session: SessionSummary): Eligibility {
  if (session.control !== 'managed') return 'observed';
  const workspace = state.workspaces.find(item => item.id === session.workspaceId);
  if (session.runtime || workspace?.runtimeId === 'hermes') return 'hermes';
  if (!workspace?.projectLocation) return 'no-folder';
  return 'eligible';
}

export function eligibleSessions(state: HostState): SessionSummary[] {
  return state.sessions.filter(session => missionEligibility(state, session) === 'eligible');
}

/** The workspace primary connection (implicit) plus its explicit mission allowlist, limited to saved connections. */
export function allowedConnections(state: HostState, workspace: Workspace | undefined): ConnectionView[] {
  if (!workspace || workspace.runtimeId === 'hermes') return [];
  const ids = [...new Set([workspace.providerProfileId, ...(workspace.missionConnectionIds ?? [])].filter((id): id is string => Boolean(id)))];
  return ids.flatMap(id => state.connections.filter(connection => connection.id === id));
}

/** Configured model ids of a connection: its model and its orchestration tier models. */
export function connectionModels(connection: ConnectionView, extra: readonly string[] = []): string[] {
  const tiers = Object.values(connection.orchestration?.tiers ?? {});
  return [...new Set([connection.model, ...tiers, ...extra])].filter(isModelId);
}

/** connectionId → model ids that a task may use. `models` (optional) narrows every list. */
export type AllowedPairs = ReadonlyMap<string, readonly string[]>;

export function allowedPairs(connections: readonly ConnectionView[], options: { primaryId?: string | undefined; primaryExtra?: readonly string[]; models?: readonly string[] | undefined; planned?: readonly MissionPlanTask[] } = {}): AllowedPairs {
  const pairs = new Map<string, string[]>();
  for (const connection of connections) {
    const planned = (options.planned ?? []).filter(task => task.connectionId === connection.id).map(task => task.model);
    let list = connectionModels(connection, [...(connection.id === options.primaryId ? options.primaryExtra ?? [] : []), ...planned]);
    if (options.models?.length) list = list.filter(model => options.models!.includes(model));
    if (list.length) pairs.set(connection.id, list);
  }
  return pairs;
}

/** A plan task as edited on the page: numbers in the units the form shows. */
export interface DraftTask {
  /** Stable React key; never sent. */
  key: string;
  id: string;
  title: string;
  role: string;
  rationale: string;
  instructions: string;
  connectionId: string;
  model: string;
  dependsOn: string[];
  /** Seconds (the host takes milliseconds). */
  timeoutSeconds: number;
  maxSteps: number;
}

/** Optional budget limits as typed in the form; an empty field means "no limit" (ADR 0015). */
export interface DraftBudget {
  durationMinutes: string;
  maxTokens: string;
  maxTaskTokens: string;
}
export const emptyBudget = (): DraftBudget => ({ durationMinutes: '', maxTokens: '', maxTaskTokens: '' });
export const MAX_BUDGET_MINUTES = MISSION_BUDGET_LIMITS.maxDurationMs / 60_000;

type BudgetIssue = 'budgetDuration' | 'budgetTokens' | 'budgetTaskTokens';
/** Parse the form's budget: valid limits, plus issue codes for fields that are not whole numbers in range. */
export function budgetFromDraft(draft: DraftBudget | undefined): { limits: Omit<HostMissionBudget, 'maxConcurrency'>; issues: BudgetIssue[] } {
  const limits: Omit<HostMissionBudget, 'maxConcurrency'> = {};
  const issues: BudgetIssue[] = [];
  const whole = (text: string, max: number): number | null | undefined => {
    const value = text.trim();
    if (!value) return undefined;
    if (!/^\d+$/.test(value)) return null;
    const number = Number(value);
    return number >= 1 && number <= max ? number : null;
  };
  const minutes = whole(draft?.durationMinutes ?? '', MAX_BUDGET_MINUTES);
  if (minutes === null) issues.push('budgetDuration'); else if (minutes !== undefined) limits.maxDurationMs = minutes * 60_000;
  const tokens = whole(draft?.maxTokens ?? '', MISSION_BUDGET_LIMITS.maxTokens);
  if (tokens === null) issues.push('budgetTokens'); else if (tokens !== undefined) limits.maxTokens = tokens;
  const taskTokens = whole(draft?.maxTaskTokens ?? '', MISSION_BUDGET_LIMITS.maxTokens);
  if (taskTokens === null || (taskTokens !== undefined && tokens !== undefined && tokens !== null && taskTokens > tokens)) issues.push('budgetTaskTokens');
  else if (taskTokens !== undefined) limits.maxTaskTokens = taskTokens;
  return { limits, issues };
}

export interface DraftPlan {
  title: string;
  maxConcurrency: number;
  /** Optional runtime budget; absent or empty fields mean no limit. */
  budget?: DraftBudget;
  source: 'model' | 'heuristic' | 'manual';
  note?: string;
  leadModel?: string;
  tasks: DraftTask[];
}

let keySeed = 0;
const nextKey = () => `task-${++keySeed}`;

export function draftFromPlan(plan: MissionPlan): DraftPlan {
  return {
    title: plan.title, maxConcurrency: plan.maxConcurrency, source: plan.source,
    ...(plan.note ? { note: plan.note } : {}), ...(plan.leadModel ? { leadModel: plan.leadModel } : {}),
    tasks: plan.tasks.map(task => ({
      key: nextKey(), id: task.id, title: task.title, role: task.role ?? '', rationale: task.rationale ?? '', instructions: task.instructions,
      connectionId: task.connectionId, model: task.model, dependsOn: [...(task.dependsOn ?? [])],
      timeoutSeconds: Math.max(1, Math.round((task.timeoutMs ?? 60_000) / 1000)), maxSteps: task.maxSteps ?? 8,
    })),
  };
}

/** A fresh task id not used by the plan (`task-2`, `task-3`, …). */
export function freshTaskId(tasks: readonly DraftTask[]): string {
  const used = new Set(tasks.map(task => task.id));
  for (let index = tasks.length + 1; ; index += 1) if (!used.has(`task-${index}`)) return `task-${index}`;
}

export function blankTask(tasks: readonly DraftTask[], pairs: AllowedPairs): DraftTask {
  const [connectionId, models] = [...pairs.entries()][0] ?? ['', []];
  return { key: nextKey(), id: freshTaskId(tasks), title: '', role: '', rationale: '', instructions: '', connectionId, model: models[0] ?? '', dependsOn: [], timeoutSeconds: 60, maxSteps: 8 };
}

export function blankPlan(goal: string, pairs: AllowedPairs): DraftPlan {
  const first = blankTask([], pairs);
  const title = goal.trim().split('\n')[0]!.slice(0, 120);
  return { title, maxConcurrency: 3, source: 'manual', tasks: [{ ...first, id: 'task-1', title, instructions: goal.trim() }] };
}

/** Rename a task and keep every dependency pointing at it. */
export function renameTask(plan: DraftPlan, key: string, id: string): DraftPlan {
  const previous = plan.tasks.find(task => task.key === key)?.id;
  return { ...plan, tasks: plan.tasks.map(task => task.key === key ? { ...task, id }
    : previous ? { ...task, dependsOn: task.dependsOn.map(dependency => dependency === previous ? id : dependency) } : task) };
}

/** Remove a task and every dependency on it. */
export function removeTask(plan: DraftPlan, key: string): DraftPlan {
  const removed = plan.tasks.find(task => task.key === key)?.id;
  return { ...plan, tasks: plan.tasks.filter(task => task.key !== key).map(task => ({ ...task, dependsOn: task.dependsOn.filter(dependency => dependency !== removed) })) };
}

export function toggleDependency(plan: DraftPlan, key: string, dependency: string): DraftPlan {
  return { ...plan, tasks: plan.tasks.map(task => task.key !== key ? task
    : { ...task, dependsOn: task.dependsOn.includes(dependency) ? task.dependsOn.filter(id => id !== dependency) : [...task.dependsOn, dependency] }) };
}

/** The request the host receives: role/rationale stay in the page, seconds become milliseconds. */
export function requestFromDraft(plan: DraftPlan): HostMissionRequest {
  const { limits } = budgetFromDraft(plan.budget);
  return {
    title: plan.title.trim(), maxConcurrency: plan.maxConcurrency,
    // Older hosts reject an unknown `budget`; send it only when a limit is set.
    ...(Object.keys(limits).length ? { budget: { ...limits, maxConcurrency: plan.maxConcurrency } } : {}),
    tasks: plan.tasks.map(task => ({
      id: task.id, title: task.title.trim(), instructions: task.instructions, connectionId: task.connectionId, model: task.model.trim(),
      dependsOn: [...task.dependsOn], timeoutMs: task.timeoutSeconds * 1000, maxSteps: task.maxSteps,
    })),
  };
}

export type IssueCode =
  | 'titleRequired' | 'titleInvalid' | 'noTasks' | 'tooManyTasks' | 'concurrency'
  | 'idInvalid' | 'idDuplicate' | 'taskTitle' | 'instructionsRequired' | 'instructionsLong'
  | 'connectionNotAllowed' | 'modelInvalid' | 'modelNotAllowed' | 'dependencyMissing' | 'dependencySelf' | 'cycle'
  | 'timeout' | 'maxSteps' | 'rejected' | BudgetIssue;

export interface PlanIssue { code: IssueCode; taskKey?: string; field?: 'id' | 'title' | 'instructions' | 'connection' | 'model' | 'dependsOn' | 'timeout' | 'maxSteps'; detail?: string }

const CONTROL = (text: string) => [...text].some(char => { const code = char.charCodeAt(0); return code < 32 || code === 127 || char === ' ' || char === ' '; });

/** Task ids that sit on a dependency cycle (only among existing ids). */
export function cycleMembers(tasks: readonly Pick<DraftTask, 'id' | 'dependsOn'>[]): Set<string> {
  const ids = new Set(tasks.map(task => task.id));
  const edges = new Map(tasks.map(task => [task.id, task.dependsOn.filter(id => ids.has(id) && id !== task.id)]));
  // Peel off tasks whose dependencies are all resolved; whatever remains is on (or behind) a cycle.
  const resolved = new Set<string>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [id, deps] of edges) if (!resolved.has(id) && deps.every(dep => resolved.has(dep))) { resolved.add(id); progressed = true; }
  }
  const remaining = [...edges.keys()].filter(id => !resolved.has(id));
  // Keep only tasks that can reach themselves (exclude ones merely waiting behind a cycle).
  const onCycle = new Set<string>();
  for (const start of remaining) {
    const stack = [...(edges.get(start) ?? [])], seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (id === start) { onCycle.add(start); break; }
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(edges.get(id) ?? []));
    }
  }
  return onCycle;
}

/**
 * Field-level problems for inline display; the host's own normalizer runs last
 * as the final authority (any rejection it still finds is reported as `rejected`).
 */
export function validatePlan(plan: DraftPlan, pairs: AllowedPairs): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const title = plan.title.trim();
  if (!title) issues.push({ code: 'titleRequired' });
  else if (title.length > 200 || CONTROL(title)) issues.push({ code: 'titleInvalid' });
  if (!plan.tasks.length) issues.push({ code: 'noTasks' });
  if (plan.tasks.length > MAX_TASKS) issues.push({ code: 'tooManyTasks' });
  if (!Number.isInteger(plan.maxConcurrency) || plan.maxConcurrency < 1 || plan.maxConcurrency > 8) issues.push({ code: 'concurrency' });
  for (const code of budgetFromDraft(plan.budget).issues) issues.push({ code });
  const counts = new Map<string, number>();
  for (const task of plan.tasks) counts.set(task.id, (counts.get(task.id) ?? 0) + 1);
  const ids = new Set(plan.tasks.map(task => task.id));
  for (const task of plan.tasks) {
    const at = (code: IssueCode, field: PlanIssue['field'], detail?: string) => issues.push({ code, taskKey: task.key, field, ...(detail ? { detail } : {}) });
    if (!TASK_ID_PATTERN.test(task.id)) at('idInvalid', 'id');
    else if ((counts.get(task.id) ?? 0) > 1) at('idDuplicate', 'id');
    const taskTitle = task.title.trim();
    if (!taskTitle || taskTitle.length > 200 || CONTROL(taskTitle)) at('taskTitle', 'title');
    if (!task.instructions.trim()) at('instructionsRequired', 'instructions');
    else if (task.instructions.length > MAX_INSTRUCTIONS) at('instructionsLong', 'instructions');
    const models = pairs.get(task.connectionId);
    if (!models) at('connectionNotAllowed', 'connection');
    else if (!isModelId(task.model.trim())) at('modelInvalid', 'model');
    else if (!models.includes(task.model.trim())) at('modelNotAllowed', 'model');
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) at('dependencySelf', 'dependsOn');
      else if (!ids.has(dependency)) at('dependencyMissing', 'dependsOn', dependency);
    }
    if (!Number.isInteger(task.timeoutSeconds) || task.timeoutSeconds < 1 || task.timeoutSeconds > 600) at('timeout', 'timeout');
    if (!Number.isInteger(task.maxSteps) || task.maxSteps < 1 || task.maxSteps > 20) at('maxSteps', 'maxSteps');
  }
  const cycle = cycleMembers(plan.tasks);
  for (const task of plan.tasks) if (cycle.has(task.id)) issues.push({ code: 'cycle', taskKey: task.key, field: 'dependsOn' });
  if (!issues.length) {
    try { normalizeHostMissionRequest(requestFromDraft(plan)); } catch { issues.push({ code: 'rejected' }); }
  }
  return issues;
}

/**
 * Dependency levels for the DAG view: level 0 has no dependencies, every other task sits one
 * column after its deepest dependency. Tasks on a cycle or behind a missing dependency go last.
 */
export function dagLevels<T extends { id: string; dependsOn: readonly string[] }>(tasks: readonly T[]): T[][] {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (task: T): number => {
    const known = level.get(task.id);
    if (known !== undefined) return known;
    if (visiting.has(task.id)) return Number.POSITIVE_INFINITY;
    visiting.add(task.id);
    let value = 0;
    for (const id of task.dependsOn) {
      const dependency = byId.get(id);
      value = Math.max(value, dependency && dependency !== task ? depth(dependency) + 1 : Number.POSITIVE_INFINITY);
    }
    visiting.delete(task.id);
    level.set(task.id, value);
    return value;
  };
  const finite = tasks.map(task => depth(task)).filter(Number.isFinite);
  const last = finite.length ? Math.max(...finite) + 1 : 0;
  const columns: T[][] = [];
  for (const task of tasks) {
    const value = Number.isFinite(level.get(task.id)!) ? level.get(task.id)! : last;
    (columns[value] ??= []).push(task);
  }
  return columns.filter(Boolean);
}

export type TaskTone = 'queued' | 'running' | 'ok' | 'error' | 'off' | 'warn';

export function taskTone(state: HostMissionTask['state'] | MissionState): TaskTone {
  switch (state) {
    case 'completed': return 'ok';
    case 'failed': return 'error';
    case 'cancelled': return 'off';
    case 'unknown': case 'recovering': case 'blocked': case 'awaiting_approval': return 'warn';
    case 'reviewing': case 'running': case 'assigned': case 'verifying': case 'waiting': return 'running';
    default: return 'queued';
  }
}

export const isTerminalRun = (run: Pick<HostMissionRun, 'state'>) => run.state !== 'running';

/** A recovering run admits nothing new, so a task its checkpoint shows queued never started (ADRs 0013, 0016). */
export const isNeverStarted = (run: Pick<HostMissionRun, 'state'>, task: Pick<HostMissionTask, 'state'>) => run.state === 'recovering' && task.state === 'queued';

/** Counts for progress text. Progress is task states only; there is no verified evidence yet. */
export function missionProgress(run: Pick<HostMissionRun, 'tasks'>): { total: number; completed: number; running: number; failed: number; unresolved: number; evidence: number } {
  const count = (states: readonly string[]) => run.tasks.filter(task => states.includes(task.state)).length;
  return {
    total: run.tasks.length, completed: count(['completed']), running: count(['running', 'assigned', 'verifying', 'waiting']),
    failed: count(['failed']), unresolved: count(['unknown']), evidence: run.tasks.reduce((sum, task) => sum + task.evidenceIds.length, 0),
  };
}

/** Compatibility cache for older hosts that do not retain dependency metadata. In memory only. */
const submitted = new Map<string, HostMissionRequest>();
export function rememberSubmitted(missionId: string, request: HostMissionRequest): void {
  submitted.set(missionId, request);
  if (submitted.size > 32) submitted.delete(submitted.keys().next().value!);
}
export function submittedPlan(missionId: string): HostMissionRequest | undefined { return submitted.get(missionId); }

/** Prefer retained edges so reopened missions keep their DAG. Missing legacy edges stay unknown. */
export function missionGraphTasks(run: Pick<HostMissionRun, 'id' | 'tasks'>): (HostMissionTask & { dependsOn: string[] })[] | undefined {
  if (run.tasks.every(task => Array.isArray(task.dependsOn))) {
    return run.tasks.map(task => ({ ...task, dependsOn: [...task.dependsOn!] }));
  }
  const plan = submittedPlan(run.id);
  if (!plan || plan.tasks.length !== run.tasks.length) return undefined;
  const byId = new Map(plan.tasks.map(task => [task.id, task]));
  if (!run.tasks.every(task => byId.has(task.id))) return undefined;
  return run.tasks.map(task => ({ ...task, dependsOn: [...(byId.get(task.id)!.dependsOn ?? [])] }));
}

/** A short, stable label for a worker identity (full id in a tooltip). */
export const shortId = (id: string) => id.replace(/-/g, '').slice(0, 8);

/**
 * Usage against budget for the monitor (ADR 0015). `tokens` is the reported
 * input + output sum, or undefined when nothing was reported; `lowerBound`
 * means some usage went unreported, so the real total may be higher. Records
 * from older hosts carry no usage at all: `reported` is false.
 */
export interface MissionBudgetView {
  reported: boolean;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  unknownTasks: number;
  lowerBound: boolean;
  maxTokens?: number;
  maxTaskTokens?: number;
  maxDurationMs?: number;
  exhausted?: HostMissionRun['budgetExhausted'];
}
export function missionBudgetView(run: Pick<HostMissionRun, 'usage' | 'budget' | 'budgetExhausted'>): MissionBudgetView {
  const usage = run.usage;
  const tokens = usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined) ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : undefined;
  // One side unreported (e.g. input only) is also incomplete.
  const partial = Boolean(usage && (usage.inputTokens === undefined) !== (usage.outputTokens === undefined));
  return {
    reported: Boolean(usage), unknownTasks: usage?.unknownTasks ?? 0, lowerBound: Boolean(usage && (usage.unknownTasks > 0 || partial)),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}), ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(run.budget?.maxTokens !== undefined ? { maxTokens: run.budget.maxTokens } : {}),
    ...(run.budget?.maxTaskTokens !== undefined ? { maxTaskTokens: run.budget.maxTaskTokens } : {}),
    ...(run.budget?.maxDurationMs !== undefined ? { maxDurationMs: run.budget.maxDurationMs } : {}),
    ...(run.budgetExhausted ? { exhausted: run.budgetExhausted } : {}),
  };
}
