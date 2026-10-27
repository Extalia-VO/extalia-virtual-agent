/**
 * Pure helpers for accountable lead mission planning: request validation, the
 * lead's JSON-only prompt, strict reply parsing and a deterministic fallback.
 * Nothing here executes work; a plan is reviewable data the user may launch.
 */
import { redact } from '@extalia/core';
import { isModelId } from './agentHost.js';
import { normalizeHostMissionRequest, type HostMissionRequest, type MissionPlan, type MissionPlanRequest, type MissionPlanTask } from './missions.js';

export const MISSION_PLAN_LIMITS = {
  goal: 4_000, maxTasks: 16, defaultMaxTasks: 6, connections: 8, models: 20,
  /** Eligible connection/model pairs offered to the lead. */
  candidates: 24,
  /** Characters of a lead reply that are parsed at all. */
  reply: 64_000,
  instructions: 4_000, role: 60, rationale: 300, title: 200,
  /** Defaults the planner writes into each task (editable before launch). */
  taskTimeoutMs: 180_000, taskSteps: 8, maxConcurrency: 4,
} as const;

/** The lead is asked once; after this the deterministic plan is used. */
export const MISSION_PLAN_TIMEOUT_MS = 45_000;

const TASK_ID = /^[a-z][a-z0-9_-]{0,63}$/;

/** A connection/model pair a planned task may use. `label` and `provider` are display-safe. */
export interface MissionPlanCandidate {
  connectionId: string;
  model: string;
  /** The connection's provider API or preset, for the lead's fit decision. */
  provider: string;
  /** The connection's display name. */
  label: string;
  /** The session lead's own connection and model. */
  lead?: boolean;
}

/** Role hints from the session's subagent team. */
export interface MissionPlanHint { role: string; task?: string; models: string[] }

export interface MissionPlanContext {
  goal: string;
  maxTasks: number;
  candidates: readonly MissionPlanCandidate[];
  hints?: readonly MissionPlanHint[];
  /** Masks host-known secrets (for example the lead's resolved credential) in echoed text. */
  mask?: (text: string) => string;
}

function requestError(message: string): never { throw new Error(message); }

function connectionIdOk(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value
    && ![...value].some(char => { const code = char.charCodeAt(0); return char === '/' || char === '\\' || code < 32 || code === 127; });
}

/** Validate a plan request from a client. Error messages are safe to show. */
export function normalizeMissionPlanRequest(raw: unknown): Required<Pick<MissionPlanRequest, 'goal' | 'maxTasks'>> & Pick<MissionPlanRequest, 'connectionIds' | 'models'> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return requestError('Invalid mission plan request.');
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) return requestError('Invalid mission plan request.');
  const value = raw as Record<string, unknown>;
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['goal', 'maxTasks', 'connectionIds', 'models'].includes(key))) return requestError('Invalid mission plan request.');
  if (typeof value.goal !== 'string' || !value.goal.trim()) return requestError('Describe the mission goal.');
  const goal = value.goal.replace(/\r\n/g, '\n').replace(/\0/g, '').trim();
  if (goal.length > MISSION_PLAN_LIMITS.goal) return requestError(`The goal is longer than ${MISSION_PLAN_LIMITS.goal} characters.`);
  let maxTasks: number = MISSION_PLAN_LIMITS.defaultMaxTasks;
  if (value.maxTasks !== undefined) {
    if (typeof value.maxTasks !== 'number' || !Number.isInteger(value.maxTasks) || value.maxTasks < 1 || value.maxTasks > MISSION_PLAN_LIMITS.maxTasks) return requestError(`Choose from 1 to ${MISSION_PLAN_LIMITS.maxTasks} tasks.`);
    maxTasks = value.maxTasks;
  }
  const list = (field: unknown, max: number, check: (item: unknown) => boolean, message: string): string[] | undefined => {
    if (field === undefined) return undefined;
    if (!Array.isArray(field) || field.length < 1 || field.length > max || !field.every(check) || new Set(field).size !== field.length) return requestError(message);
    return [...field] as string[];
  };
  const connectionIds = list(value.connectionIds, MISSION_PLAN_LIMITS.connections, connectionIdOk, `Choose from 1 to ${MISSION_PLAN_LIMITS.connections} distinct allowed connections.`);
  const models = list(value.models, MISSION_PLAN_LIMITS.models, isModelId, `Choose from 1 to ${MISSION_PLAN_LIMITS.models} distinct model ids.`);
  return { goal, maxTasks, ...(connectionIds ? { connectionIds } : {}), ...(models ? { models } : {}) };
}

/** The launchable request for a plan (review-only labels removed). */
export function missionPlanToRequest(plan: Pick<MissionPlan, 'title' | 'tasks' | 'maxConcurrency'>): HostMissionRequest {
  return {
    title: plan.title, maxConcurrency: plan.maxConcurrency,
    tasks: plan.tasks.map(({ role: _role, rationale: _rationale, ...task }) => ({ ...task, dependsOn: [...task.dependsOn] })),
  };
}

/**
 * Dependency levels of a task list (level 0 has no dependencies), for DAG views and concurrency.
 * Returns `undefined` when a dependency is missing or the graph has a cycle.
 */
export function missionTaskLevels(tasks: readonly Pick<MissionPlanTask, 'id' | 'dependsOn'>[]): string[][] | undefined {
  const ids = new Set(tasks.map(task => task.id));
  if (ids.size !== tasks.length || tasks.some(task => task.dependsOn.some(id => id === task.id || !ids.has(id)))) return undefined;
  const level = new Map<string, number>();
  let remaining = [...tasks];
  while (remaining.length) {
    const ready = remaining.filter(task => task.dependsOn.every(id => level.has(id)));
    if (!ready.length) return undefined;
    for (const task of ready) level.set(task.id, Math.max(-1, ...task.dependsOn.map(id => level.get(id)!)) + 1);
    remaining = remaining.filter(task => !level.has(task.id));
  }
  const levels: string[][] = [];
  for (const task of tasks) (levels[level.get(task.id)!] ??= []).push(task.id);
  return levels;
}

/** The pair key used to check that a task stays within the eligible set. */
const pairKey = (connectionId: string, model: string) => JSON.stringify([connectionId, model]);

/**
 * Validate a plan against the eligible pairs and the host request normalizer.
 * Throws when a task uses another pair or the graph is not launchable.
 */
export function checkMissionPlan(plan: MissionPlan, candidates: readonly MissionPlanCandidate[]): MissionPlan {
  const allowed = new Set(candidates.map(candidate => pairKey(candidate.connectionId, candidate.model)));
  if (plan.tasks.some(task => !allowed.has(pairKey(task.connectionId, task.model)))) throw new Error('A planned task uses a connection or model that is not allowed.');
  const normalized = normalizeHostMissionRequest(missionPlanToRequest(plan));
  return {
    ...plan, title: normalized.title, maxConcurrency: normalized.maxConcurrency ?? 3,
    tasks: normalized.tasks.map((task, index) => ({
      ...task, ...(plan.tasks[index]!.role ? { role: plan.tasks[index]!.role } : {}), ...(plan.tasks[index]!.rationale ? { rationale: plan.tasks[index]!.rationale } : {}),
    })),
  };
}

/** Single-line, redacted, bounded text. */
function line(value: string, max: number, mask: (text: string) => string = text => text): string {
  // eslint-disable-next-line no-control-regex
  const clean = redact(mask(value)).replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Multi-line, redacted text (control characters other than newline and tab removed). */
function block(value: string, mask: (text: string) => string = text => text): string {
  // eslint-disable-next-line no-control-regex
  return redact(mask(value.replace(/\r\n/g, '\n'))).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
}

/** Candidates ordered lead first, then alternating across connections (so neighbours differ in provider). */
function interleaved(candidates: readonly MissionPlanCandidate[]): MissionPlanCandidate[] {
  const groups = new Map<string, MissionPlanCandidate[]>();
  const ordered = [...candidates].sort((a, b) => Number(Boolean(b.lead)) - Number(Boolean(a.lead)));
  for (const candidate of ordered) groups.set(candidate.connectionId, [...(groups.get(candidate.connectionId) ?? []), candidate]);
  const lists = [...groups.values()], result: MissionPlanCandidate[] = [];
  for (let index = 0; result.length < ordered.length; index += 1) for (const list of lists) if (list[index]) result.push(list[index]!);
  return result;
}

function concurrencyFor(tasks: readonly Pick<MissionPlanTask, 'id' | 'dependsOn'>[]): number {
  const widest = Math.max(1, ...(missionTaskLevels(tasks) ?? [tasks.map(task => task.id)]).map(level => level.length));
  return Math.min(MISSION_PLAN_LIMITS.maxConcurrency, widest);
}

const ANGLES: readonly { key: string; role: string; title: string; focus: string }[] = [
  { key: 'architecture', role: 'Architect', title: 'Analyze architecture and design', focus: 'module boundaries, data flow and design decisions' },
  { key: 'risks', role: 'Reviewer', title: 'Review correctness risks', focus: 'likely bugs, edge cases and error handling' },
  { key: 'tests', role: 'QA analyst', title: 'Assess tests and quality gates', focus: 'existing tests, coverage gaps and how the goal could be verified' },
  { key: 'security', role: 'Security reviewer', title: 'Review security and privacy', focus: 'trust boundaries, secrets handling, input validation and privacy' },
  { key: 'performance', role: 'Performance analyst', title: 'Review performance', focus: 'hot paths, resource use and scalability concerns' },
  { key: 'docs', role: 'Documentation reviewer', title: 'Review documentation', focus: 'documentation accuracy, gaps and onboarding clarity' },
  { key: 'dependencies', role: 'Dependency auditor', title: 'Audit dependencies', focus: 'third-party packages, versions and licensing signals' },
  { key: 'ux', role: 'UX reviewer', title: 'Review user experience', focus: 'user-facing flows, copy, accessibility and error states' },
];

const READ_ONLY_NOTE = 'You can only read, list and search files in the workspace. Do not claim that anything was changed, built or tested. Cite file paths for findings.';

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'analysis';
}

/**
 * Deterministic plan: survey → parallel analyses → synthesis, spread across
 * connections (the lead's own pair surveys and synthesizes). Team roles become
 * analysis angles when the session has a team.
 */
export function heuristicMissionPlan(context: MissionPlanContext): MissionPlan {
  if (!context.candidates.length) throw new Error('No eligible connection and model.');
  const mask = context.mask ?? ((text: string) => text);
  const goal = block(context.goal, mask).slice(0, MISSION_PLAN_LIMITS.goal);
  const goalLine = line(goal, 120);
  const count = Math.max(1, Math.min(MISSION_PLAN_LIMITS.maxTasks, Math.floor(context.maxTasks)));
  const order = interleaved(context.candidates);
  const lead = order[0]!;
  const pick = (index: number) => order[index % order.length]!;
  const task = (id: string, title: string, role: string, instructions: string, pair: MissionPlanCandidate, dependsOn: string[], steps: number, rationale: string): MissionPlanTask => ({
    id, title: line(title, MISSION_PLAN_LIMITS.title), role: line(role, MISSION_PLAN_LIMITS.role), instructions: `${instructions}\n\n${READ_ONLY_NOTE}\n\nMission goal:\n${goal}`,
    connectionId: pair.connectionId, model: pair.model, dependsOn, timeoutMs: MISSION_PLAN_LIMITS.taskTimeoutMs, maxSteps: steps, rationale: line(rationale, MISSION_PLAN_LIMITS.rationale),
  });
  const tasks: MissionPlanTask[] = [];
  if (count === 1) {
    tasks.push(task('analyze', 'Analyze the goal', 'Analyst', 'Investigate the workspace for the mission goal and report findings, risks and recommended next steps.', lead, [], 10, 'A single task was requested; the lead model handles it.'));
  } else {
    const survey = task('survey', 'Survey the project', 'Surveyor', 'Survey the project for the mission goal: structure, entry points, key modules and documentation that matter for it.', count === 2 ? pick(1) : lead, [], 10, 'Gives later tasks a shared map of the project.');
    tasks.push(survey);
    const hinted = (context.hints ?? []).map(hint => ({ key: slug(hint.role), role: hint.role, title: `${line(hint.role, 60)} analysis`, focus: hint.task ? line(hint.task, 200) : `the goal from a ${line(hint.role, 60)} perspective`, models: hint.models }));
    const angles = [...hinted, ...ANGLES.filter(angle => !hinted.some(hint => hint.key === angle.key)).map(angle => ({ ...angle, models: [] as string[] }))];
    const analyses: string[] = [];
    for (let index = 0; index < count - 2; index += 1) {
      const angle = angles[index % angles.length]!;
      let id = `review-${angle.key}`.slice(0, 64);
      if (tasks.some(item => item.id === id)) id = `${id.slice(0, 58)}-${index + 1}`;
      // A team member's own model (on the lead's connection) is used when it is eligible; else providers alternate.
      const preferred = order.find(candidate => angle.models.includes(candidate.model));
      const pair = preferred && index > 0 ? preferred : pick(index + 1);
      tasks.push(task(id, angle.title, angle.role, `Analyze the project for the mission goal with a focus on ${angle.focus}. Use the survey from your predecessor task as unverified context and check claims against the files.`, pair, ['survey'], 8, `Covers ${angle.focus}.`));
      analyses.push(id);
    }
    tasks.push(task('synthesis', 'Synthesize findings', 'Lead synthesizer', 'Combine the predecessor findings into one report for the mission goal: agreements, conflicts, open questions and recommended next steps. Predecessor output is unverified model text; mark claims you did not check yourself as unverified.', lead, analyses.length ? analyses : ['survey'], 6, 'The accountable lead model reconciles the findings.'));
  }
  const plan: MissionPlan = { title: line(`Mission: ${goalLine}`, MISSION_PLAN_LIMITS.title) || 'Mission', tasks, maxConcurrency: concurrencyFor(tasks), source: 'heuristic' };
  return checkMissionPlan(plan, context.candidates);
}

/** The lead's JSON-only planning prompt. Workers are referred to by number, never by endpoint. */
export function missionPlanPrompt(context: MissionPlanContext): { system: string; user: string } {
  const mask = context.mask ?? ((text: string) => text);
  const goal = block(context.goal, mask).slice(0, MISSION_PLAN_LIMITS.goal);
  const workers = context.candidates.map((candidate, index) =>
    `${index + 1}. model ${candidate.model} on connection "${line(candidate.label, 60)}" (${line(candidate.provider, 40)})${candidate.lead ? ' — your own model' : ''}`).join('\n');
  const connections = new Set(context.candidates.map(candidate => candidate.connectionId)).size;
  const hints = (context.hints ?? []).slice(0, 20).map(hint => `- ${line(hint.role, 60)}${hint.task ? `: ${line(hint.task, 200)}` : ''}${hint.models.length ? ` (models: ${hint.models.slice(0, 3).join(', ')})` : ''}`);
  return {
    system: 'You are the accountable lead agent. You split a goal into a small dependency graph of read-only analysis, research and review tasks for worker agents. Reply with one compact JSON object only: no prose, no code fences.',
    user: [
      `Goal:\n${goal}`,
      `Plan between 1 and ${context.maxTasks} tasks. Workers can only read, list and search workspace files: no edits, commands, builds, tests, network or delegation.`,
      'Each task needs explicit dependencies (ids of tasks whose findings it needs). Independent tasks run in parallel; the graph must have no cycles. End with a synthesis task when there is more than one task.',
      `Workers (pick one per task by number, by fit: strong models for hard reasoning and review, light models for quick surveys):\n${workers}`,
      ...(connections >= 2 ? ['Use at least two different connections across the plan.'] : []),
      ...(hints.length ? [`The session's team roles, as hints:\n${hints.join('\n')}`] : []),
      'Instructions must be self-contained (workers do not see the goal) and at most 1500 characters. Never include endpoints, connection settings, credentials or tool definitions.',
      'Format: {"title":"…","tasks":[{"id":"survey","title":"…","role":"…","instructions":"…","worker":1,"dependsOn":[],"rationale":"…"}]}',
      'ids: lowercase letters, digits, - or _, starting with a letter, unique. title at most 120 characters; role one to three words; rationale at most 20 words.',
    ].join('\n'),
  };
}

/** The JSON object of a reply: reasoning blocks and one code fence are tolerated, other prose is not. */
function replyJson(reply: string): unknown {
  if (reply.length > MISSION_PLAN_LIMITS.reply) throw new Error('The reply is too long.');
  let visible = reply.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(visible);
  if (fenced) visible = fenced[1]!.trim();
  if (!visible.startsWith('{') || !visible.endsWith('}')) throw new Error('The reply is not a JSON object.');
  return JSON.parse(visible);
}

function plainObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected an object.');
  const keys = Object.keys(value);
  const extra = keys.find(key => !allowed.includes(key));
  if (extra !== undefined) throw new Error(`Unexpected field "${extra.slice(0, 40)}".`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, max: number, field: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field}: expected text.`);
  if (value.length > max) throw new Error(`${field}: too long.`);
  return value;
}

/**
 * Parse a lead reply strictly. Unknown fields, unknown workers, cycles, missing
 * dependencies, invalid ids, oversized text or more than
 * `maxTasks` tasks reject the whole reply (the caller then uses the heuristic).
 * Echoed text is redacted. When at least two connections are eligible and the
 * reply uses one, one parallel task moves to another connection (noted).
 */
export function parseMissionPlanReply(reply: string, context: MissionPlanContext): MissionPlan {
  const mask = context.mask ?? ((text: string) => text);
  const value = plainObject(replyJson(reply), ['title', 'tasks']);
  const title = boundedString(value.title, MISSION_PLAN_LIMITS.title, 'title')!;
  if (!Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > Math.min(context.maxTasks, MISSION_PLAN_LIMITS.maxTasks)) throw new Error('tasks: wrong number of tasks.');
  const ids = new Set<string>();
  const tasks = value.tasks.map((raw, index): MissionPlanTask => {
    const field = `tasks[${index}]`;
    const entry = plainObject(raw, ['id', 'title', 'role', 'instructions', 'worker', 'dependsOn', 'rationale']);
    if (typeof entry.id !== 'string' || !TASK_ID.test(entry.id) || ids.has(entry.id)) throw new Error(`${field}.id: invalid or duplicate.`);
    ids.add(entry.id);
    const taskTitle = boundedString(entry.title, MISSION_PLAN_LIMITS.title, `${field}.title`)!;
    const instructions = boundedString(entry.instructions, MISSION_PLAN_LIMITS.instructions, `${field}.instructions`)!;
    const role = boundedString(entry.role, MISSION_PLAN_LIMITS.role, `${field}.role`, false);
    const rationale = boundedString(entry.rationale, MISSION_PLAN_LIMITS.rationale, `${field}.rationale`, false);
    if (typeof entry.worker !== 'number' || !Number.isInteger(entry.worker) || entry.worker < 1 || entry.worker > context.candidates.length) throw new Error(`${field}.worker: unknown worker.`);
    const pair = context.candidates[entry.worker - 1]!;
    const dependsOn = entry.dependsOn === undefined ? [] : entry.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.length > MISSION_PLAN_LIMITS.maxTasks || !dependsOn.every(id => typeof id === 'string' && TASK_ID.test(id))) throw new Error(`${field}.dependsOn: invalid.`);
    return {
      id: entry.id, title: line(taskTitle, MISSION_PLAN_LIMITS.title, mask), instructions: block(instructions, mask), connectionId: pair.connectionId, model: pair.model,
      dependsOn: [...dependsOn as string[]], timeoutMs: MISSION_PLAN_LIMITS.taskTimeoutMs, maxSteps: MISSION_PLAN_LIMITS.taskSteps,
      ...(role ? { role: line(role, MISSION_PLAN_LIMITS.role, mask) } : {}), ...(rationale ? { rationale: line(rationale, MISSION_PLAN_LIMITS.rationale, mask) } : {}),
    };
  });
  const levels = missionTaskLevels(tasks);
  if (!levels) throw new Error('tasks: missing dependency or cycle.');
  if (tasks.some(task => !task.title || !task.instructions)) throw new Error('tasks: empty text after redaction.');
  let note: string | undefined;
  const connections = new Set(context.candidates.map(candidate => candidate.connectionId));
  if (connections.size >= 2 && tasks.length >= 2 && new Set(tasks.map(task => task.connectionId)).size === 1) {
    const used = tasks[0]!.connectionId;
    const wide = [...levels].reverse().find(level => level.length >= 2);
    const moveId = wide ? wide[wide.length - 1]! : tasks[0]!.id;
    const moving = tasks.find(task => task.id === moveId)!;
    const other = interleaved(context.candidates).find(candidate => candidate.connectionId !== used)!;
    moving.connectionId = other.connectionId; moving.model = other.model;
    note = `Task "${moving.title}" was moved to ${other.model} on "${line(other.label, 60)}" so the mission uses two providers.`;
  }
  const plan: MissionPlan = {
    title: line(title, MISSION_PLAN_LIMITS.title, mask) || 'Mission', tasks, maxConcurrency: concurrencyFor(tasks), source: 'model', ...(note ? { note } : {}),
  };
  return checkMissionPlan(plan, context.candidates);
}
