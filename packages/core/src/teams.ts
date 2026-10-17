import { generateFullName, MEMBER_GENDERS, type MemberGender } from './names.js';
import { assertNoCredentialFields } from './privacy.js';
import { decode, object, oneOf, optionalText, text, timestamp, type DecodeResult } from './validation.js';

export type { MemberGender };

/**
 * A subagent team belongs to one lead (managed Extalia Native) session. When
 * the team is enabled the lead hands a request's parts to the members whose
 * role they concern, without the user naming them (small or unrelated requests
 * it handles itself); each member runs on its own ordered model list (a subset
 * of the team's allowed models), so a model that runs out of quota falls back to the next one.
 */
export interface TeamMember {
  id: string;
  /** Full name, unique in the Office (for example "Elena Vael"). */
  name: string;
  /** Explicit metadata (from the user, a plan or the name generator); never inferred from the name. */
  gender?: MemberGender;
  role: string;
  task?: string;
  /** Preferred model first, then fallbacks; a subset of the team's `allowedModels`. Empty: the lead's model chain. */
  models: string[];
  /** Persona and working principles, up to 1000 characters. */
  soul?: string;
  /** `write` members may edit files inside `scope` (and run commands as the workspace allows); default `read`. */
  access?: MemberAccess;
  /** Workspace-relative directories, files or globs a write member may edit; empty or absent: the whole workspace. */
  scope?: string[];
  /** Workspace-relative paths the member must never edit; they win over `scope`. */
  forbidden?: string[];
}

export type MemberAccess = 'read' | 'write';
export const MEMBER_ACCESS: readonly MemberAccess[] = ['read', 'write'];

export interface AgentTeam {
  enabled: boolean;
  /** Models the team may use, ordered by priority (also the lead's fallback order). */
  allowedModels: string[];
  members: TeamMember[];
  /** What the team was planned for. */
  goal?: string;
  /** Execution rules every member follows (for example from a prompt's team spec). */
  rules?: string[];
  updatedAt?: string;
}

/** v0.0.39: up to 20 members (was 8). */
export const MAX_TEAM_MEMBERS = 20;
export const MAX_TEAM_MODELS = 20;
export const MAX_MEMBER_MODELS = 8;
export const MAX_TEAM_GOAL = 4000;
export const MAX_MEMBER_TASK = 1000;
export const MAX_MEMBER_NAME = 40;
export const MAX_MEMBER_ROLE = 60;
export const MAX_MEMBER_SOUL = 1000;
export const MAX_MEMBER_PATHS = 32;
export const MAX_MEMBER_PATH = 200;
export const MAX_TEAM_RULES = 20;
export const MAX_TEAM_RULE = 500;

/** Member ids double as Office subagent ids: short, URL- and file-name-safe. */
export const TEAM_MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Same shape as the platform's model ids: never readable as a command-line option. */
export const TEAM_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

function modelList(raw: unknown, field: string, max: number): string[] {
  if (!Array.isArray(raw)) throw new Error(`${field}: expected a list of model ids.`);
  if (raw.length > max) throw new Error(`${field}: at most ${max} models.`);
  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (typeof item !== 'string' || !TEAM_MODEL_PATTERN.test(item)) throw new Error(`${field}[${index}]: use a model id of up to 200 letters, digits and . _ : / @ + - characters.`);
    if (seen.has(item)) throw new Error(`${field}: "${item}" is listed twice.`);
    seen.add(item);
    return item;
  });
}

/**
 * A workspace-relative path or glob for a member's scope: `/` separators, no
 * leading `./`, no trailing `/`. Absolute paths, `~` and `..` are refused.
 */
export function normalizeMemberPath(raw: string): string {
  if (raw.includes('\0')) throw new Error('must be plain text');
  const value = raw.trim().replace(/\\/g, '/');
  if (!value) throw new Error('is empty');
  if (/[\r\n]/.test(value)) throw new Error('must be a single line');
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:/.test(value)) throw new Error(`"${value}" is not relative to the workspace`);
  const parts = value.split('/').filter(part => part && part !== '.');
  if (parts.includes('..')) throw new Error(`"${value}" leaves the workspace (..)`);
  if (!parts.length) throw new Error(`"${value}" names the workspace itself; leave the list empty instead`);
  return parts.join('/');
}

function pathList(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error(`${field}: expected a list of paths.`);
  if (raw.length > MAX_MEMBER_PATHS) throw new Error(`${field}: at most ${MAX_MEMBER_PATHS} paths.`);
  const paths: string[] = [];
  raw.forEach((item, index) => {
    if (typeof item !== 'string' || item.length > MAX_MEMBER_PATH) throw new Error(`${field}[${index}]: use a path of up to ${MAX_MEMBER_PATH} characters.`);
    let clean: string;
    try { clean = normalizeMemberPath(item); } catch (error) { throw new Error(`${field}[${index}]: ${error instanceof Error ? error.message : 'invalid path'}.`, { cause: error }); }
    if (!paths.includes(clean)) paths.push(clean);
  });
  return paths;
}

function decodeMember(raw: unknown, index: number, allowed: ReadonlySet<string>): TeamMember {
  const field = `members[${index}]`;
  const value = object(raw, field);
  const id = text(value.id, `${field}.id`, { singleLine: true, max: 64 });
  if (!TEAM_MEMBER_ID_PATTERN.test(id)) throw new Error(`${field}.id: use letters, digits, - and _.`);
  const name = text(value.name, `${field}.name`, { singleLine: true, max: MAX_MEMBER_NAME }).trim();
  const role = text(value.role, `${field}.role`, { singleLine: true, max: MAX_MEMBER_ROLE }).trim();
  const task = optionalText(value.task, `${field}.task`, { max: MAX_MEMBER_TASK, allowEmpty: true })?.trim();
  const models = modelList(value.models, `${field}.models`, MAX_MEMBER_MODELS);
  for (const model of models) if (!allowed.has(model)) throw new Error(`${field}.models: "${model}" is not one of the team's allowed models.`);
  const gender = value.gender === undefined ? undefined : oneOf(value.gender, MEMBER_GENDERS, `${field}.gender`);
  const soul = optionalText(value.soul, `${field}.soul`, { max: MAX_MEMBER_SOUL, allowEmpty: true })?.trim();
  const access = value.access === undefined ? undefined : oneOf(value.access, MEMBER_ACCESS, `${field}.access`);
  const scope = pathList(value.scope, `${field}.scope`);
  const forbidden = pathList(value.forbidden, `${field}.forbidden`);
  return {
    id, name, ...(gender ? { gender } : {}), role, ...(task ? { task } : {}), models,
    ...(soul ? { soul } : {}), ...(access ? { access } : {}), ...(scope?.length ? { scope } : {}), ...(forbidden?.length ? { forbidden } : {}),
  };
}

/** Strict reader for a team: bounded sizes, unique ids and names, member models from the allowed list. */
export function decodeAgentTeam(raw: unknown): DecodeResult<AgentTeam> {
  return decode(() => {
    assertNoCredentialFields(raw);
    const value = object(raw, 'team');
    if (typeof value.enabled !== 'boolean') throw new Error('enabled: expected true or false.');
    const allowedModels = modelList(value.allowedModels ?? [], 'allowedModels', MAX_TEAM_MODELS);
    if (!Array.isArray(value.members)) throw new Error('members: expected a list.');
    if (value.members.length > MAX_TEAM_MEMBERS) throw new Error(`members: at most ${MAX_TEAM_MEMBERS} members.`);
    const allowed = new Set(allowedModels);
    const members = value.members.map((item, index) => decodeMember(item, index, allowed));
    const ids = new Set<string>(), names = new Set<string>();
    for (const member of members) {
      if (ids.has(member.id)) throw new Error(`members: the id "${member.id}" is used twice.`);
      const key = member.name.toLowerCase();
      if (names.has(key)) throw new Error(`members: the name "${member.name}" is used twice.`);
      ids.add(member.id); names.add(key);
    }
    const team: AgentTeam = { enabled: value.enabled, allowedModels, members };
    const goal = optionalText(value.goal, 'goal', { max: MAX_TEAM_GOAL, allowEmpty: true })?.trim();
    if (goal) team.goal = goal;
    if (value.rules !== undefined) {
      if (!Array.isArray(value.rules)) throw new Error('rules: expected a list.');
      if (value.rules.length > MAX_TEAM_RULES) throw new Error(`rules: at most ${MAX_TEAM_RULES} rules.`);
      const rules = value.rules.map((rule, index) => text(rule, `rules[${index}]`, { max: MAX_TEAM_RULE }).trim());
      if (rules.length) team.rules = rules;
    }
    if (value.updatedAt !== undefined) team.updatedAt = timestamp(value.updatedAt, 'updatedAt');
    return team;
  });
}

/** Short friendly names (before v0.0.30); new members get full names from `generateFullName`. */
export const TEAM_NAMES: readonly string[] = [
  'Ava', 'Milo', 'Nova', 'Iris', 'Leo', 'Kai', 'Luna', 'Orion', 'Sage', 'Theo', 'Zara', 'Rio', 'Juno', 'Ezra', 'Mira', 'Finn',
  'Nora', 'Remy', 'Tess', 'Ivo', 'Lena', 'Otto', 'Pia', 'Rex', 'Suri', 'Tomas', 'Uma', 'Vera', 'Wren', 'Yara', 'Zeno', 'Ada',
];

/**
 * `count` names not in `taken` (case-insensitive). `seed` rotates the starting
 * point so a re-plan can offer different names; the same inputs always give the same names.
 */
export function generateMemberNames(count: number, taken: Iterable<string> = [], seed = 0): string[] {
  const used = new Set([...taken].map(name => name.toLowerCase()));
  const names: string[] = [];
  const start = Math.abs(Math.trunc(seed)) % TEAM_NAMES.length;
  for (let round = 0; names.length < count; round++) {
    for (let index = 0; index < TEAM_NAMES.length && names.length < count; index++) {
      const base = TEAM_NAMES[(start + index) % TEAM_NAMES.length]!;
      const name = round ? `${base} ${round + 1}` : base;
      if (used.has(name.toLowerCase())) continue;
      used.add(name.toLowerCase());
      names.push(name);
    }
  }
  return names;
}

let memberCounter = 0;
/** A new member id (`m-` + time + randomness). */
export function newTeamMemberId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const random = crypto?.randomUUID?.().replace(/-/g, '').slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `m-${Date.now().toString(36)}${random}${(memberCounter++ % 36).toString(36)}`;
}

/** Rough capability class of a model id, from common naming (`opus`, `pro` … `haiku`, `flash`, `mini` …). */
export type ModelStrength = 'strong' | 'standard' | 'light';

const LIGHT_TOKENS = new Set(['haiku', 'flash', 'mini', 'nano', 'lite', 'small', 'tiny', 'luna', 'fast', 'instant', 'quick']);
const STRONG_TOKENS = new Set(['opus', 'pro', 'ultra', 'large', 'high', 'max', 'sol', 'reasoning', 'reasoner', 'thinking', 'xl']);

export function modelStrength(model: string): ModelStrength {
  const tokens = model.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
  if (tokens.some(token => LIGHT_TOKENS.has(token) || /^[1-9](\.\d)?b$/.test(token))) return 'light';
  if (tokens.some(token => STRONG_TOKENS.has(token) || /^\d{2,}b$/.test(token))) return 'strong';
  return 'standard';
}

/** `models` rotated so member `index` prefers a different model; the rest stay as its fallbacks. */
export function rotatedModels(models: readonly string[], index: number): string[] {
  if (!models.length) return [];
  const start = index % models.length;
  return [...models.slice(start), ...models.slice(0, start)].slice(0, MAX_MEMBER_MODELS);
}

export interface TeamPlanRequest {
  /** What the team is for; empty: a general-purpose team for the workspace (see `context`). */
  goal: string;
  count: number;
  /** Models the user ticked, by priority. Empty: the plan picks from `candidateModels`. */
  allowedModels: string[];
  /** Current members: kept (id, name, role, task) for the first `count` places when re-planning. */
  members?: TeamMember[];
  /**
   * Set by the host, never by a client: the workspace's models the plan may choose from
   * when no model is ticked (see `pickTeamModels`).
   */
  candidateModels?: string[];
  /** Set by the host: what a plan without a goal is based on. */
  context?: TeamPlanContext;
}

export interface TeamPlanContext {
  workspace?: string;
  /** Titles of the workspace's recent sessions, newest first. */
  recentTitles?: string[];
}

export interface TeamPlan {
  members: TeamMember[];
  source: 'model' | 'heuristic';
  note?: string;
  /**
   * When the request ticked no model: the models the plan used, in priority order
   * (the team's `allowedModels` to save). Absent when the request had allowed models.
   */
  allowedModels?: string[];
  /** v0.0.39: why a member got its models (by planned member id), when the plan said so. */
  modelReasons?: Record<string, string>;
}

/** v0.0.39: models a plan gives one member by default (the planner may give more when they help). */
export const DEFAULT_MEMBER_MODELS = 3;
export const MAX_MODEL_REASON = 160;

interface RoleTemplate {
  role: string;
  strength: ModelStrength;
  task: (goal: string) => string;
  /** Working principles, mental model, priorities and dislikes (the member's soul). */
  soul: readonly [string, string, string, string];
}

/** v0.0.39: twenty roles, so a team of up to `MAX_TEAM_MEMBERS` gets distinct ones. */
const HEURISTIC_ROLES: readonly RoleTemplate[] = [
  { role: 'Researcher', strength: 'standard', task: goal => `Find the files, APIs and constraints relevant to: ${goal}`,
    soul: ['reads the code and docs before forming an opinion and cites where each fact comes from', 'the system is a map of sources, owners and constraints', 'accuracy and complete context first, speed second', 'guesses, unverified claims and summaries without sources'] },
  { role: 'Reviewer', strength: 'strong', task: goal => `Review the proposed changes for correctness, risks and missed cases: ${goal}`,
    soul: ['assumes every change hides one bug until proven otherwise and explains each finding with evidence', 'code paths, edge cases and failure modes', 'correctness, safety and clear reasoning over style nitpicks', 'rubber-stamp approvals, vague feedback and untested claims'] },
  { role: 'Analyst', strength: 'strong', task: goal => `Analyse the current behaviour and compare approaches for: ${goal}`,
    soul: ['measures the current behaviour first, then weighs options by cost and benefit', 'trade-offs between options, each with evidence', 'decisions backed by data and explicit assumptions', 'hand-waving, one-sided comparisons and hidden assumptions'] },
  { role: 'Planner', strength: 'strong', task: goal => `Break the work into ordered, verifiable steps: ${goal}`,
    soul: ['turns fuzzy goals into small, ordered steps that each end in a check', 'dependencies, milestones and the critical path', 'a plan others can follow and verify, with risks named early', 'big-bang changes, steps without a definition of done and scope creep'] },
  { role: 'Tester', strength: 'standard', task: goal => `Identify the tests and checks that prove the result, and gaps in coverage: ${goal}`,
    soul: ['proves behaviour with repeatable checks before trusting it', 'inputs, expected outputs and the cases between them', 'covering risky paths and regressions first', 'flaky tests, untested branches and "works on my machine"'] },
  { role: 'Documenter', strength: 'light', task: goal => `Find the docs and notes that must change, and draft the wording: ${goal}`,
    soul: ['writes for the next reader: short sentences, concrete examples, nothing stale', 'what a newcomer needs to know, in what order', 'docs that match the code and are easy to scan', 'jargon, outdated instructions and walls of text'] },
  { role: 'Scout', strength: 'light', task: goal => `Do quick lookups (names, paths, versions) the others need for: ${goal}`,
    soul: ['answers fast and precisely, then gets out of the way', 'where things live: names, paths, versions and owners', 'speed and exactness on small questions', 'long detours, speculation and answering more than was asked'] },
  { role: 'Architect', strength: 'strong', task: goal => `Check how the change fits the structure and dependency rules: ${goal}`,
    soul: ['protects clear boundaries and keeps changes consistent with the existing structure', 'modules, dependency direction and the contracts between them', 'long-term maintainability and simple designs', 'leaky abstractions, circular dependencies and clever one-offs'] },
  { role: 'Implementer', strength: 'standard', task: goal => `Propose concrete, minimal code changes for: ${goal}`,
    soul: ['makes the smallest change that works and fits the existing style', 'the code path from input to result', 'working code, small diffs and verified behaviour', 'rewrites nobody asked for and unfinished changes'] },
  { role: 'Debugger', strength: 'strong', task: goal => `Reproduce and find the root cause of failures related to: ${goal}`,
    soul: ['reproduces first, then narrows down one hypothesis at a time', 'symptoms, causes and the evidence that links them', 'the root cause over a quick patch', 'random changes, ignoring logs and fixing symptoms only'] },
  { role: 'Security Reviewer', strength: 'strong', task: goal => `Look for security and privacy risks (input handling, secrets, permissions) in: ${goal}`,
    soul: ['thinks like an attacker and treats every input as untrusted', 'trust boundaries, data flows and who can do what', 'least privilege, safe defaults and no leaked secrets', 'secrets in code, missing validation and "nobody will try that"'] },
  { role: 'Performance Analyst', strength: 'strong', task: goal => `Find performance costs and hot paths, and suggest measured improvements for: ${goal}`,
    soul: ['measures before and after every optimisation', 'hot paths, allocations and the cost of each call', 'user-visible speed and resource use, backed by numbers', 'premature optimisation and guesses without profiles'] },
  { role: 'UX Reviewer', strength: 'standard', task: goal => `Review the user-facing flow, wording and states for: ${goal}`,
    soul: ['walks through the flow as a first-time user would', 'tasks, states and the feedback the user gets at each step', 'clarity, consistency and recoverable errors', 'confusing labels, dead ends and silent failures'] },
  { role: 'Accessibility Checker', strength: 'standard', task: goal => `Check keyboard, screen-reader and contrast accessibility for: ${goal}`,
    soul: ['checks every control with the keyboard and a screen reader in mind', 'semantics, focus order and contrast', 'interfaces everyone can use', 'mouse-only controls, missing labels and low contrast'] },
  { role: 'Refactorer', strength: 'standard', task: goal => `Find duplication and simplifications that make the code easier to change for: ${goal}`,
    soul: ['improves structure in small, behaviour-preserving steps', 'duplication, coupling and naming', 'readable code that is easy to change', 'copy-paste, dead code and refactors mixed with features'] },
  { role: 'Integrator', strength: 'standard', task: goal => `Check how the parts connect (APIs, configs, data flow) for: ${goal}`,
    soul: ['follows data across boundaries end to end', 'interfaces, configs and the contracts between components', 'parts that work together, not only alone', 'mismatched contracts and untested seams'] },
  { role: 'Data Modeler', strength: 'strong', task: goal => `Review data shapes, schemas and migrations for: ${goal}`,
    soul: ['designs data first and keeps it valid at every boundary', 'entities, relations and how they change over time', 'integrity, compatibility and safe migrations', 'ambiguous fields, lossy migrations and unchecked input'] },
  { role: 'Dependency Auditor', strength: 'light', task: goal => `List the libraries and versions involved and flag outdated or risky ones for: ${goal}`,
    soul: ['checks what the project really depends on before adding more', 'packages, versions and licences', 'few, maintained and compatible dependencies', 'unpinned versions, abandoned packages and needless additions'] },
  { role: 'Release Manager', strength: 'light', task: goal => `Prepare the changelog, version notes and release checklist for: ${goal}`,
    soul: ['ships in small, reversible steps with clear notes', 'what changed, who is affected and how to roll back', 'predictable releases and honest changelogs', 'surprise changes, missing notes and skipped checks'] },
  { role: 'Summarizer', strength: 'light', task: goal => `Condense findings and decisions into short status notes for: ${goal}`,
    soul: ['turns long threads into a few clear lines', 'decisions, open questions and next steps', 'brevity and accuracy', 'padding, repetition and losing the key point'] },
];

const STRONG_ROLE = /architect|review|audit|design|plan|analy|secur|debug|reason|strateg|lead|expert|principal|data model|perf/i;
const LIGHT_ROLE = /scout|doc|writ|summar|lookup|search|triage|format|translat|note|clerk|monitor|changelog|release|copy/i;

function roleTemplate(role: string): RoleTemplate | undefined {
  const key = role.toLowerCase().replace(/\s+\d+$/, '');
  return HEURISTIC_ROLES.find(item => key === item.role.toLowerCase()) ?? HEURISTIC_ROLES.find(item => key.startsWith(item.role.toLowerCase()));
}

/** v0.0.39: the model strength a role needs (complex roles: strong; quick lookups and docs: light). */
export function roleStrength(role: string): ModelStrength {
  const template = roleTemplate(role);
  if (template) return template.strength;
  if (LIGHT_ROLE.test(role)) return 'light';
  if (STRONG_ROLE.test(role)) return 'strong';
  return 'standard';
}

/** v0.0.39: a role-based soul (persona) for a member, focused on `goal`. */
export function roleSoul(role: string, goal: string): string {
  const name = role.replace(/\s+/g, ' ').trim() || 'Member';
  const [principles, model, priorities, dislikes] = roleTemplate(name)?.soul ?? [
    `owns the ${name.toLowerCase()} part of the work and checks it before handing it back`,
    `the goal, the parts of the project it touches and who depends on the result`,
    'useful, verified results over speed',
    'guessing, scope creep and unexplained results',
  ];
  const focus = shortGoal(goal);
  return [
    `Principles: ${principles}.`, `Mental model: ${model}.`, `Priorities: ${priorities}.`, `Dislikes: ${dislikes}.`,
    ...(focus ? [`Focus: ${focus}`] : []),
  ].join(' ').slice(0, MAX_MEMBER_SOUL);
}

/** Model ids that are not chat models (embeddings, speech, images, moderation …); never offered to a team. */
const NON_CHAT_MODEL = /(^|[^a-z])(embed|embedding|embeddings|tts|whisper|transcribe|speech|audio|dall-e|dalle|image|imagen|moderation|rerank|realtime)([^a-z]|$)/i;

const modelProvider = (model: string) => model.includes('/') ? model.slice(0, model.indexOf('/')) : '';

/**
 * Up to `max` models for a plan to choose from when the user ticked none: chat
 * models only, `preferred` (for example the default model) first, then the
 * rest spread over strengths (strong, standard, light in turn) and providers
 * (the part before `/`), so a large router catalog gives a small, diverse set.
 */
export function pickTeamModels(models: readonly string[], preferred: readonly string[] = [], max = MAX_TEAM_MODELS): string[] {
  const valid = (model: string) => TEAM_MODEL_PATTERN.test(model) && !NON_CHAT_MODEL.test(model);
  const limit = Math.max(0, Math.min(MAX_TEAM_MODELS, Math.trunc(max)));
  const picked = [...new Set(preferred.filter(valid))].slice(0, limit);
  const rest = [...new Set(models.filter(valid))].filter(model => !picked.includes(model));
  /** One strength's models with providers taking turns. */
  const spread = (list: string[]) => {
    const groups = new Map<string, string[]>();
    for (const model of list) groups.set(modelProvider(model), [...(groups.get(modelProvider(model)) ?? []), model]);
    const queues = [...groups.values()], order: string[] = [];
    while (queues.some(queue => queue.length)) for (const queue of queues) { const next = queue.shift(); if (next) order.push(next); }
    return order;
  };
  const buckets = (['strong', 'standard', 'light'] as const).map(strength => spread(rest.filter(model => modelStrength(model) === strength)));
  while (picked.length < limit && buckets.some(bucket => bucket.length)) {
    for (const bucket of buckets) { const next = bucket.shift(); if (next && picked.length < limit) picked.push(next); }
  }
  return picked;
}

/** The models a plan used: every member's first choice in member order, then their fallbacks. */
export function planModelOrder(members: readonly Pick<TeamMember, 'models'>[]): string[] {
  const order: string[] = [];
  for (const member of members) if (member.models[0] && !order.includes(member.models[0])) order.push(member.models[0]);
  for (const member of members) for (const model of member.models) if (!order.includes(model)) order.push(model);
  return order.slice(0, MAX_TEAM_MODELS);
}

const STRENGTH_ORDER: Record<ModelStrength, readonly ModelStrength[]> = {
  strong: ['strong', 'standard', 'light'], standard: ['standard', 'strong', 'light'], light: ['light', 'standard', 'strong'],
};

/** How often each model is already a member's first choice (`first`) or a fallback (`fallback`); spreads picks. */
export interface ModelUsage { first: Map<string, number>; fallback: Map<string, number> }

export function modelUsage(members: readonly Pick<TeamMember, 'models'>[] = []): ModelUsage {
  const usage: ModelUsage = { first: new Map(), fallback: new Map() };
  for (const member of members) {
    member.models.forEach((model, index) => {
      const map = index ? usage.fallback : usage.first;
      map.set(model, (map.get(model) ?? 0) + 1);
    });
  }
  return usage;
}

/**
 * v0.0.39: the models that suit a role, from `pool` (in priority order): the
 * least used model of the strength the role needs (else the closest strength),
 * then — when the pool has another — one fallback, preferring another provider
 * and a close strength. One or two models, never the whole pool; `usage` is
 * updated so the next member spreads over the other models.
 */
export function suitedModels(role: string, pool: readonly string[], usage: ModelUsage = modelUsage(), size = 2): string[] {
  const models = [...new Set(pool)];
  if (!models.length) return [];
  const wanted = roleStrength(role);
  const rank = (model: string) => STRENGTH_ORDER[wanted].indexOf(modelStrength(model));
  const least = (list: readonly string[], map: Map<string, number>, score: (model: string) => number = () => 0) =>
    list.reduce<string | undefined>((best, model) => {
      if (best === undefined) return model;
      const a = score(model) * 100 + (map.get(model) ?? 0), b = score(best) * 100 + (map.get(best) ?? 0);
      return a < b ? model : best;
    }, undefined)!;
  const first = least(models, usage.first, rank);
  usage.first.set(first, (usage.first.get(first) ?? 0) + 1);
  const picked = [first];
  while (picked.length < Math.max(1, Math.min(size, MAX_MEMBER_MODELS))) {
    const rest = models.filter(model => !picked.includes(model));
    if (!rest.length) break;
    const providers = new Set(picked.map(modelProvider));
    const next = least(rest, usage.fallback, model => (providers.has(modelProvider(model)) ? 3 : 0) + rank(model));
    usage.fallback.set(next, (usage.fallback.get(next) ?? 0) + 1);
    picked.push(next);
  }
  return picked;
}

/** The model pool of a request: the ticked models, else the host's candidates (the plan chooses). */
function modelPool(request: TeamPlanRequest): { models: string[]; choosing: boolean } {
  if (request.allowedModels.length) return { models: request.allowedModels, choosing: false };
  const candidates = (request.candidateModels ?? []).filter(model => TEAM_MODEL_PATTERN.test(model)).slice(0, MAX_TEAM_MODELS);
  return { models: candidates, choosing: candidates.length > 0 };
}

/** What a plan without a goal is about: the workspace (and its recent sessions). */
function fallbackGoal(request: TeamPlanRequest): string {
  const workspace = request.context?.workspace?.replace(/\s+/g, ' ').trim().slice(0, 80);
  return workspace ? `ongoing work in the ${workspace} project` : 'ongoing work in this project';
}

/** The goal a plan works with: the user's, or a general one for the workspace. */
export function planGoal(request: TeamPlanRequest): string {
  return shortGoal(request.goal) || fallbackGoal(request);
}

function shortGoal(goal: string): string {
  const clean = goal.replace(/\s+/g, ' ').trim();
  return clean.length > 160 ? `${clean.slice(0, 159).trimEnd()}…` : clean;
}

function clampCount(count: number): number {
  return Math.max(1, Math.min(MAX_TEAM_MEMBERS, Math.trunc(count) || 1));
}

/**
 * `count` generated full names (with their gender) that none of `taken` or each
 * other use; `seed` makes them deterministic.
 */
export function generateMemberIdentities(count: number, taken: Iterable<string>, seed: string): { name: string; gender: MemberGender }[] {
  const used = new Set([...taken].map(name => name.toLowerCase()));
  const identities: { name: string; gender: MemberGender }[] = [];
  for (let index = 0; index < count; index++) {
    const identity = generateFullName(`${seed}#${index}`, used);
    used.add(identity.name.toLowerCase());
    identities.push(identity);
  }
  return identities;
}

/** A kept member's identity and access fields (everything but role, task, models and soul). */
function keptFields(member: TeamMember): Omit<TeamMember, 'role' | 'task' | 'models' | 'soul'> {
  const { role: _role, task: _task, models: _models, soul: _soul, ...rest } = member;
  return rest;
}

/**
 * Deterministic plan: kept members first, then roles in a fixed order. Every
 * member gets the one or two models of the pool (the ticked models, else the
 * host's candidates) that suit its role (see `suitedModels`) and a role-based
 * soul; kept members keep their soul and the models still in the pool.
 * New members get generated full names that none of `taken` (names elsewhere in the Office) use.
 */
export function planTeamHeuristic(request: TeamPlanRequest, newId: () => string = newTeamMemberId, taken: Iterable<string> = []): TeamMember[] {
  const count = clampCount(request.count);
  const goal = planGoal(request);
  const pool = modelPool(request).models;
  const kept = (request.members ?? []).slice(0, count);
  const usedRoles = new Set(kept.map(member => member.role.toLowerCase()));
  const freeRoles = HEURISTIC_ROLES.filter(item => !usedRoles.has(item.role.toLowerCase()));
  const identities = generateMemberIdentities(count - kept.length, [...taken, ...kept.map(member => member.name)], goal);
  const members: TeamMember[] = kept.map(member => ({
    ...keptFields(member), role: member.role, ...(member.task ? { task: member.task } : {}),
    models: [...new Set(member.models)].filter(model => pool.includes(model)).slice(0, MAX_MEMBER_MODELS),
    soul: member.soul?.trim() || roleSoul(member.role, goal),
  }));
  for (let index = kept.length; index < count; index++) {
    const template = freeRoles[(index - kept.length) % Math.max(1, freeRoles.length)] ?? HEURISTIC_ROLES[index % HEURISTIC_ROLES.length]!;
    let role = template.role;
    if (members.some(member => member.role.toLowerCase() === role.toLowerCase())) role = `${role} ${index + 1}`;
    const identity = identities[index - kept.length]!;
    members.push({
      id: newId(), name: identity.name, gender: identity.gender, role, task: template.task(goal).slice(0, MAX_MEMBER_TASK), models: [], soul: roleSoul(role, goal),
    });
  }
  const usage = modelUsage(members);
  return members.map(member => member.models.length ? member : { ...member, models: suitedModels(member.role, pool, usage) });
}

/** The short JSON-only prompt for a model that splits a goal into members, their souls and their models. */
export function teamPlanPrompt(request: TeamPlanRequest): { system: string; user: string } {
  const count = clampCount(request.count);
  const pool = modelPool(request);
  const listed = pool.models.map((model, index) => `${index + 1}. ${model} (${modelStrength(model)})`).join('\n');
  const models = pool.choosing
    ? `No model was chosen by the user. The team may use these models of the workspace (strength in brackets):\n${listed}`
    : `Allowed models in the user's priority order (strength in brackets):\n${listed || '(none: every member uses the lead model)'}`;
  const kept = (request.members ?? []).slice(0, count).map((member, index) => `${index + 1}. ${member.role}${member.task ? `: ${member.task.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
  const goal = shortGoal(request.goal);
  const recent = (request.context?.recentTitles ?? []).map(title => title.replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean).slice(0, 5);
  const context = goal ? [] : [
    `No goal was given: plan a general-purpose team for ${fallbackGoal(request)} that can take on the usual requests there (research, design, implementation review, testing, docs).`,
    ...(recent.length ? [`Recent sessions in this workspace:\n${recent.map(title => `- ${title}`).join('\n')}`] : []),
  ];
  const brief = count > 8;
  const entry = pool.models.length ? '{"role":"…","task":"…","soul":"…","models":["<best fit>","<fallback>"],"why":"…"}' : '{"role":"…","task":"…","soul":"…"}';
  const format = `Format (compact JSON, no other keys): {"members":[${entry}]${pool.choosing ? ',"models":["<every model you used, most important first>"]' : ''}} with exactly ${count} members.`;
  return {
    system: 'You split software work into a team of helper agents and give each one a persona. Reply with one compact JSON object only, no prose and no code fences.',
    user: [
      ...(goal ? [`Goal: ${goal}`] : context),
      `Team size: exactly ${count} members.`,
      models,
      ...(kept.length ? [`Current roles to keep or refine, in order:\n${kept.join('\n')}`] : []),
      `Per member: a distinct role (one or two words), a one-sentence task, and a soul: ${brief ? 'one or two short sentences' : 'two or three sentences'} on the member's working principles, mental model, priorities and what it dislikes, derived from the goal and its role.`,
      ...(pool.models.length ? [
        `The ${pool.choosing ? 'listed' : 'allowed'} models are what the team may use, not what every member gets. Give each member only the models that fit its role, best first:`,
        `usually 1 to ${DEFAULT_MEMBER_MODELS}, more only when it clearly helps. Later models are fallbacks when one runs out of quota, so prefer a fallback from another provider.`,
        'Strong models for hard reasoning, design, debugging and review; light, fast models for quick lookups, docs and summaries; standard models for typical work. Spread members across models.',
        '"why": at most 12 words on why these models fit the role.',
      ] : []),
      format,
    ].join('\n'),
  };
}

/** The first JSON object in a model reply (reasoning blocks, code fences and surrounding prose are ignored). */
function extractJson(reply: string): unknown {
  const visible = reply.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(visible)?.[1] ?? visible;
  const start = fenced.indexOf('{'), end = fenced.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object');
  return JSON.parse(fenced.slice(start, end + 1));
}

const clip = (value: string, max: number) => {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
};

/**
 * Parse and validate a model's team plan strictly. Names and ids are not taken
 * from the model: kept members keep theirs, new members get generated ones.
 * Every member's models are its own ordered subset of the pool (models outside
 * it are dropped; a member with none left fails the plan); a member without a
 * soul gets a role-based one. When the plan chose the models (none ticked),
 * `allowedModels` is the order it used.
 * Throws when the reply is not a usable plan (the caller falls back to the heuristic).
 */
export function parseTeamPlanResult(reply: string, request: TeamPlanRequest, newId: () => string = newTeamMemberId, taken: Iterable<string> = []): { members: TeamMember[]; allowedModels?: string[]; modelReasons?: Record<string, string> } {
  const count = clampCount(request.count);
  const value = object(extractJson(reply), 'plan');
  if (!Array.isArray(value.members)) throw new Error('members: expected a list.');
  if (value.members.length !== count) throw new Error(`members: expected ${count} entries.`);
  const pool = modelPool(request);
  const goal = planGoal(request);
  const kept = (request.members ?? []).slice(0, count);
  const identities = generateMemberIdentities(count - kept.length, [...taken, ...kept.map(member => member.name)], goal);
  const roles = new Set<string>();
  const entries = value.members.map((raw, index) => {
    const field = `members[${index}]`;
    const entry = object(raw, field);
    const role = text(entry.role, `${field}.role`, { singleLine: true, max: MAX_MEMBER_ROLE }).trim();
    if (roles.has(role.toLowerCase())) throw new Error(`${field}.role: duplicate role.`);
    roles.add(role.toLowerCase());
    const task = text(entry.task, `${field}.task`, { max: MAX_MEMBER_TASK }).replace(/\s+/g, ' ').trim();
    const soul = typeof entry.soul === 'string' && entry.soul.trim() ? clip(entry.soul, MAX_MEMBER_SOUL) : roleSoul(role, goal);
    const why = typeof entry.why === 'string' && entry.why.trim() ? clip(entry.why, MAX_MODEL_REASON) : undefined;
    const listed = Array.isArray(entry.models) ? entry.models : typeof entry.model === 'string' ? [entry.model] : [];
    const models = [...new Set(listed.filter((model): model is string => typeof model === 'string').map(model => model.trim()))]
      .filter(model => pool.models.includes(model)).slice(0, MAX_MEMBER_MODELS);
    if (pool.models.length && !models.length) throw new Error(`${field}.models: no allowed model.`);
    return { role, task, soul, why, models };
  });
  let allowed = request.allowedModels;
  if (pool.choosing) {
    const used = planModelOrder(entries);
    // The model's own priority order when it lists exactly the models it used; else the order of first use.
    const listed = Array.isArray(value.models) ? [...new Set(value.models.filter((model): model is string => typeof model === 'string').map(model => model.trim()))] : [];
    allowed = listed.length === used.length && used.every(model => listed.includes(model)) ? listed : used;
  }
  const reasons: Record<string, string> = {};
  const members = entries.map(({ role, task, soul, why, models }, index): TeamMember => {
    const previous = kept[index];
    const identity = previous ? undefined : identities[index - kept.length]!;
    const member: TeamMember = previous
      ? { ...keptFields(previous), role, task, models, soul }
      : { id: newId(), name: identity!.name, gender: identity!.gender, role, task, models, soul };
    if (why) reasons[member.id] = why;
    return member;
  });
  const checked = decodeAgentTeam({ enabled: true, allowedModels: allowed, members });
  if (!checked.ok) throw new Error(checked.errors.join(' '));
  return {
    members: checked.value.members, ...(pool.choosing ? { allowedModels: [...allowed] } : {}),
    ...(Object.keys(reasons).length ? { modelReasons: reasons } : {}),
  };
}

/** `parseTeamPlanResult` without the chosen model order. */
export function parseTeamPlan(reply: string, request: TeamPlanRequest, newId: () => string = newTeamMemberId, taken: Iterable<string> = []): TeamMember[] {
  return parseTeamPlanResult(reply, request, newId, taken).members;
}
