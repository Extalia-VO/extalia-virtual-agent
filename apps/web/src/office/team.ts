import {
  MAX_MEMBER_MODELS, MAX_MEMBER_PATHS, MAX_MEMBER_SOUL, MAX_TEAM_MEMBERS, MAX_TEAM_MODELS, applyTeamSpec, generateFullName, newTeamMemberId, normalizeMemberPath,
  modelUsage, parseTeamSpec, planModelOrder, rotatedModels, suitedModels, type MemberAccess, type MemberGender, type TeamSpec,
} from '@extalia/core';
import type { Workspace } from '@extalia/core';
import type { AgentHostApi, AgentTeam, HostState, SessionOptions, SessionSummary, TeamMember, TeamPlan, TeamPlanRequest } from '@extalia/platform';
import { isModelId } from '@extalia/platform';

/*
 * v0.0.29 subagent teams (UI side): pure helpers for the team setup dialog.
 * Hosts from before v0.0.29 lack the team methods at runtime, so every call is
 * feature-detected and the team controls stay hidden there.
 */

export type { AgentTeam, TeamMember, TeamPlan, TeamPlanRequest };
export { rotatedModels };
export const TEAM_MAX_MEMBERS = MAX_TEAM_MEMBERS;
export const TEAM_MIN_MEMBERS = 1;
export const TEAM_MAX_ALLOWED_MODELS = MAX_TEAM_MODELS;
export const TEAM_MAX_MEMBER_MODELS = MAX_MEMBER_MODELS;
export const TEAM_MAX_SOUL = MAX_MEMBER_SOUL;
export const TEAM_MAX_PATHS = MAX_MEMBER_PATHS;
export type { MemberAccess, MemberGender, TeamSpec };

/** Teams need a host that can plan and save them; older hosts hide every team control. */
export function teamSupported(agents: AgentHostApi): boolean {
  const host = agents as Partial<Pick<AgentHostApi, 'planTeam' | 'saveSessionTeam'>>;
  return typeof host.planTeam === 'function' && typeof host.saveSessionTeam === 'function';
}

/** v0.0.47: hosts that keep a workspace default team (`saveWorkspaceTeam`); older ones fall back to an unsaved draft. */
export function workspaceTeamSupported(agents: AgentHostApi): boolean {
  return typeof (agents as Partial<Pick<AgentHostApi, 'saveWorkspaceTeam'>>).saveWorkspaceTeam === 'function';
}

export function teamApi(agents: AgentHostApi) {
  const host = agents as Partial<Pick<AgentHostApi, 'getSessionTeam' | 'saveSessionTeam' | 'saveWorkspaceTeam' | 'planTeam'>>;
  return {
    saveDefault: (workspaceId: string, team: AgentTeam | null): Promise<HostState> => typeof host.saveWorkspaceTeam === 'function'
      ? host.saveWorkspaceTeam.call(agents, workspaceId, team) : Promise.reject(new Error('This host cannot save a default team.')),
    get: (sessionId: string) => typeof host.getSessionTeam === 'function' ? host.getSessionTeam.call(agents, sessionId) : Promise.resolve(undefined),
    save: (sessionId: string, team: AgentTeam | null) => typeof host.saveSessionTeam === 'function'
      ? host.saveSessionTeam.call(agents, sessionId, team) : Promise.reject(new Error('This host cannot save subagent teams.')),
    plan: (workspaceId: string, request: TeamPlanRequest) => typeof host.planTeam === 'function'
      ? host.planTeam.call(agents, workspaceId, request) : Promise.reject(new Error('This host cannot plan subagent teams.')),
  };
}

/** Session options with a team for a new session (`createSession(workspaceId, { ...options, team })`). */
export type TeamSessionOptions = SessionOptions & { team?: AgentTeam | null };

/* ── v0.0.47 ui: the workspace default team ── */

/** The `Team · N` summary of a full team. */
export function teamSummary(team: AgentTeam | undefined): { enabled: boolean; size: number } | undefined {
  return team ? { enabled: team.enabled, size: team.members.length } : undefined;
}

/**
 * What the team dialog edits: a session's own team, the workspace default
 * (saved on the host at once), or an unsaved draft for the one new session a
 * prompt starts (a reviewed prompt team, or hosts without workspace teams).
 */
export type TeamDialogScope = 'session' | 'workspace' | 'draft';

export function teamDialogScope(input: { sessionId?: string | undefined; fromPrompt?: boolean; workspaceDefaults: boolean }): TeamDialogScope {
  if (input.sessionId) return 'session';
  return input.fromPrompt || !input.workspaceDefaults ? 'draft' : 'workspace';
}

/** The dock's team chip: the targeted session's team, else the workspace default (persisted on the host, so it survives a reload). */
export function dockTeamStatus(input: { target?: SessionSummary | undefined; workspace?: Pick<Workspace, 'team'> | undefined; workspaceDefaults: boolean }): { enabled: boolean; size: number } | undefined {
  if (input.target) return sessionTeamSummary(input.target);
  return teamSummary(input.workspaceDefaults ? input.workspace?.team : undefined);
}

/**
 * The team sent with `createSession` for a new session. Without a draft or a
 * prompt team nothing is sent, so the host gives the session a copy of the
 * workspace default (every entry point behaves the same). A prompt team not
 * reviewed yet merges into the draft, else into the default, and is sent.
 */
export function teamForNewSession(input: {
  draft?: AgentTeam | undefined; workspaceTeam?: AgentTeam | undefined; spec?: TeamSpec | undefined; reviewed: boolean; taken: Iterable<string>; seed: string;
}): { team?: AgentTeam } | { error: string } {
  if (input.spec && !input.reviewed) return teamFromSpec(input.spec, input.draft ?? input.workspaceTeam, input.taken, input.seed);
  return input.draft ? { team: input.draft } : {};
}

/** The team summary a session reports, if any (tolerates hosts that send a partial one). */
export function sessionTeamSummary(session: SessionSummary | undefined): { enabled: boolean; size: number } | undefined {
  const team = session?.team as { enabled?: unknown; size?: unknown } | undefined;
  if (!team || typeof team !== 'object') return undefined;
  return { enabled: team.enabled === true, size: typeof team.size === 'number' && Number.isFinite(team.size) ? Math.max(0, Math.floor(team.size)) : 0 };
}

/** Moves one item of a list from `from` to `to` (clamped); returns a new list. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  if (target === from) return next;
  const [item] = next.splice(from, 1) as [T];
  next.splice(target, 0, item);
  return next;
}

/** Ticks or unticks a model in the ordered allowed list: new ones go last, at most 20. */
export function toggleAllowedModel(allowed: readonly string[], model: string, on: boolean): string[] {
  const without = allowed.filter(item => item !== model);
  if (!on) return without;
  if (allowed.includes(model)) return [...allowed];
  return without.length >= TEAM_MAX_ALLOWED_MODELS ? without : [...without, model];
}

/** A typed model id to add to the allowed list, or the reason it cannot be added. */
export function customModel(allowed: readonly string[], raw: string): { model: string } | { error: 'invalid' | 'duplicate' | 'full' } {
  const model = raw.trim();
  if (!isModelId(model)) return { error: 'invalid' };
  if (allowed.includes(model)) return { error: 'duplicate' };
  if (allowed.length >= TEAM_MAX_ALLOWED_MODELS) return { error: 'full' };
  return { model };
}

/**
 * A member's model order limited to the allowed models: unknown and repeated
 * ids are dropped, the order is kept. v0.0.39: an empty result falls back to
 * the one or two allowed models that suit `role` (ties spread by the member's
 * position), never to every allowed model.
 */
export function restrictModels(models: readonly string[], allowed: readonly string[], index = 0, role = ''): string[] {
  const kept = [...new Set(models)].filter(model => allowed.includes(model)).slice(0, TEAM_MAX_MEMBER_MODELS);
  return kept.length ? kept : suitedModels(role, rotatedModels(allowed, index));
}

/**
 * v0.0.39: the models the picker offers to tick: the listed ones not yet
 * allowed, filtered by `query` (case-insensitive; every space-separated word
 * must appear in the id). Selected models are shown separately in their order.
 */
export function filterModels(offered: readonly string[], allowed: readonly string[], query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set(offered)].filter(model => !allowed.includes(model) && words.every(word => model.toLowerCase().includes(word)));
}

/** Adds (last) or removes a model from a member's order, never leaving it empty while allowed models exist. */
export function toggleMemberModel(models: readonly string[], model: string, allowed: readonly string[], on: boolean): string[] {
  if (!allowed.includes(model)) return [...models];
  if (on) return models.includes(model) || models.length >= TEAM_MAX_MEMBER_MODELS ? [...models] : [...models, model];
  const next = models.filter(item => item !== model);
  return next.length ? next : [...models];
}

/**
 * v0.0.30: a fictional full name ("First Last") for `seed` that none of `taken`
 * uses (case-insensitive), from the one Office-wide generator; the same inputs
 * give the same name. `gender` is explicit metadata; without it the seed picks one.
 */
export function generateIdentity(taken: Iterable<string>, seed: string, gender?: MemberGender): { name: string; gender: MemberGender } {
  return generateFullName(seed, new Set(taken), gender);
}

/** A full name for `seed` that none of `taken` uses (see `generateIdentity`). */
export function generateName(taken: readonly string[], seed: string, gender?: MemberGender): string {
  return generateIdentity(taken, seed, gender).name;
}

/** A new member id (also the member's Office subagent id), unique among `ids`. */
export function newMemberId(ids: readonly string[], create: () => string = newTeamMemberId): string {
  for (;;) {
    const id = create();
    if (!ids.includes(id)) return id;
  }
}

/** Fields the user changed by hand; a re-plan keeps them. */
export type EditedField = 'name' | 'role' | 'task' | 'models' | 'gender' | 'soul' | 'access' | 'scope' | 'forbidden';
export interface DraftMember extends TeamMember { edited?: EditedField[] }

export function markEdited(member: DraftMember, field: EditedField): EditedField[] {
  return member.edited?.includes(field) ? member.edited : [...(member.edited ?? []), field];
}

/**
 * A member added by hand: a free full name (unique against `taken` too, e.g. the whole office), a generic role,
 * and the one or two allowed models that suit it, preferring those the other members use least.
 */
export function manualMember(members: readonly TeamMember[], allowed: readonly string[], role: string, create?: () => string, taken: Iterable<string> = []): DraftMember {
  const id = newMemberId(members.map(member => member.id), create);
  const identity = generateIdentity([...taken, ...members.map(member => member.name)], id);
  return { id, name: identity.name, gender: identity.gender, role, models: suitedModels(role, allowed, modelUsage(members)) };
}

/**
 * Merges a fresh plan into the current members. Planned members match current
 * ones by id, then by position; a matched member keeps its id (so its avatar
 * stays) and every field the user edited, while the rest (and the model
 * order, unless edited) come from the plan. Names stay unique and every
 * model order is limited to the allowed models.
 */
export function mergePlan(current: readonly DraftMember[], planned: readonly TeamMember[], allowed: readonly string[], taken: Iterable<string> = []): DraftMember[] {
  const outside = [...taken];
  const byId = new Map(current.map(member => [member.id, member]));
  const claimed = new Set<string>();
  const matches = planned.map(member => {
    const match = byId.get(member.id);
    if (match && !claimed.has(match.id)) { claimed.add(match.id); return match; }
    return undefined;
  });
  const free = current.filter(member => !claimed.has(member.id));
  const result: DraftMember[] = [];
  planned.forEach((plan, index) => {
    let base = matches[index];
    if (!base) { base = free.shift(); if (base) claimed.add(base.id); }
    const edited = base?.edited ?? [];
    const keep = (field: EditedField) => Boolean(base && edited.includes(field));
    const task = keep('task') ? base!.task : plan.task;
    const models = restrictModels(keep('models') ? base!.models : plan.models, allowed, index, keep('role') ? base!.role : plan.role);
    const ids = result.map(member => member.id);
    let id = base?.id ?? plan.id;
    if (!id || ids.includes(id)) id = newMemberId(ids);
    let name = (keep('name') ? base!.name : plan.name).trim();
    let gender = keep('gender') || keep('name') ? base!.gender : plan.gender ?? base?.gender;
    const used = result.map(member => member.name.toLowerCase());
    if (!name || used.includes(name.toLowerCase())) {
      const identity = generateIdentity([...outside, ...result.map(member => member.name)], `${id}:${index}`, gender);
      name = identity.name; gender = identity.gender;
    }
    const soul = keep('soul') ? base!.soul : plan.soul ?? base?.soul;
    const access = keep('access') ? base!.access : plan.access ?? base?.access;
    const scope = keep('scope') ? base!.scope : plan.scope ?? base?.scope;
    const forbidden = keep('forbidden') ? base!.forbidden : plan.forbidden ?? base?.forbidden;
    result.push({
      id, name, ...(gender ? { gender } : {}), role: (keep('role') ? base!.role : plan.role).trim() || plan.role,
      ...(task?.trim() ? { task: task.trim() } : {}), models,
      ...(soul?.trim() ? { soul: soul.trim() } : {}), ...(access ? { access } : {}),
      ...(scope?.length ? { scope: [...scope] } : {}), ...(forbidden?.length ? { forbidden: [...forbidden] } : {}),
      ...(edited.length ? { edited: [...edited] } : {}),
    });
  });
  return result;
}

/**
 * Why a team cannot be saved yet, or `undefined` when it can. `modelsOptional`
 * (Hermes Agent, which runs every subagent on one model) saves a team without ticked models.
 */
export function teamProblem(team: { enabled: boolean; allowedModels: readonly string[]; members: readonly TeamMember[] }, modelsOptional = false): 'models' | 'members' | 'names' | 'roles' | undefined {
  if (!team.enabled && !team.members.length) return undefined;
  if (!team.allowedModels.length && !modelsOptional) return 'models';
  if (team.enabled && !team.members.length) return 'members';
  if (team.members.some(member => !member.name.trim())) return 'names';
  const names = team.members.map(member => member.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) return 'names';
  if (team.members.some(member => !member.role.trim())) return 'roles';
  return undefined;
}

/** The team the host receives: trimmed, edit marks dropped, models limited to the allowed ones. */
export function teamForSave(draft: { enabled: boolean; allowedModels: readonly string[]; members: readonly DraftMember[]; goal: string; rules?: readonly string[] | undefined }): AgentTeam {
  const allowedModels = [...new Set(draft.allowedModels)].slice(0, TEAM_MAX_ALLOWED_MODELS);
  const goal = draft.goal.trim();
  return {
    enabled: draft.enabled, allowedModels,
    members: draft.members.slice(0, TEAM_MAX_MEMBERS).map((member, index) => {
      const write = member.access === 'write';
      return {
        id: member.id, name: member.name.trim(), ...(member.gender ? { gender: member.gender } : {}), role: member.role.trim(),
        ...(member.task?.trim() ? { task: member.task.trim() } : {}),
        models: restrictModels(member.models, allowedModels, index, member.role),
        ...(member.soul?.trim() ? { soul: member.soul.trim().slice(0, TEAM_MAX_SOUL) } : {}),
        ...(member.access ? { access: member.access } : {}),
        // A read member edits nothing, so its scope would mean nothing; forbidden paths always apply.
        ...(write && member.scope?.length ? { scope: [...member.scope] } : {}),
        ...(member.forbidden?.length ? { forbidden: [...member.forbidden] } : {}),
      };
    }),
    ...(goal ? { goal } : {}),
    ...(draft.rules?.length ? { rules: [...draft.rules] } : {}),
  };
}

/* ── v0.0.30 ui: member paths and teams written into a prompt ── */

/** Adds a workspace-relative path (or glob) chip; absolute paths, `~` and `..` are refused. */
export function addMemberPath(paths: readonly string[] | undefined, raw: string): { paths: string[] } | { error: 'invalid' | 'duplicate' | 'full' } {
  let path: string;
  try { path = normalizeMemberPath(raw); } catch { return { error: 'invalid' }; }
  const list = paths ?? [];
  if (list.includes(path)) return { error: 'duplicate' };
  if (list.length >= TEAM_MAX_PATHS) return { error: 'full' };
  return { paths: [...list, path] };
}

export interface TeamSpecPreview {
  spec: TeamSpec;
  /** Members' names as written (empty ones get a generated full name when applied). */
  names: string[];
  /** The prompt asks for live Discord reporting, which is not supported yet. */
  discord: boolean;
}

/** What the dock shows for a prompt that defines subagents, or `undefined` when it defines none. */
export function teamSpecPreview(text: string): TeamSpecPreview | undefined {
  let spec: TeamSpec | undefined;
  try { spec = parseTeamSpec(text); } catch { return undefined; }
  if (!spec?.members.length) return undefined;
  return { spec, names: spec.members.map(member => member.name.trim()), discord: /\bdiscord\b/i.test(text) };
}

/**
 * The team a prompt's spec gives a session (members merged by name into
 * `current`, names generated office-wide unique), or the reason it cannot.
 */
export function teamFromSpec(spec: TeamSpec, current: AgentTeam | undefined, taken: Iterable<string>, seed: string, newId?: () => string): { team: AgentTeam } | { error: string } {
  try { return { team: applyTeamSpec(current, spec, { taken, seed, ...(newId ? { newId } : {}) }) }; }
  catch (failure) { return { error: failure instanceof Error ? failure.message : String(failure) }; }
}

/* ── v0.0.32 ui: plans without a goal or ticked models ── */

/**
 * The allowed models and members after a plan. With models ticked they stay
 * as they are; with none ticked the plan chose them, so its models (the
 * `allowedModels` it returned, else the order its members use them) become the
 * ticked list, in the plan's priority order.
 */
export function applyPlan(current: readonly DraftMember[], allowed: readonly string[], plan: Pick<TeamPlan, 'members' | 'allowedModels'>, taken: Iterable<string> = []): { allowed: string[]; members: DraftMember[] } {
  const next = allowed.length ? [...allowed] : [...new Set(plan.allowedModels?.length ? plan.allowedModels : planModelOrder(plan.members))].filter(isModelId).slice(0, TEAM_MAX_ALLOWED_MODELS);
  return { allowed: next, members: mergePlan(current, plan.members, next, taken) };
}

/**
 * v0.0.39: why the plan gave each member its models, keyed by the merged
 * member's id (plans and merged members line up by position). Members whose
 * models the user edited get none: the reason no longer applies.
 */
export function planReasons(plan: Pick<TeamPlan, 'members' | 'modelReasons'>, merged: readonly DraftMember[]): Record<string, string> {
  const reasons: Record<string, string> = {};
  plan.members.forEach((planned, index) => {
    const reason = plan.modelReasons?.[planned.id]?.trim();
    const member = merged[index];
    if (reason && member && !member.edited?.includes('models')) reasons[member.id] = reason;
  });
  return reasons;
}

/** Members for a plan request (no edit marks). */
export function plainMembers(members: readonly DraftMember[]): TeamMember[] {
  return members.map(({ edited: _edited, ...member }) => ({ ...member, models: [...member.models] }));
}

/** The allowed models a new team starts with: the default model first, then up to two more of the listed ones. */
export function defaultAllowedModels(defaultModel: string | undefined, models: readonly string[]): string[] {
  return [...new Set([...(defaultModel ? [defaultModel] : []), ...models])].filter(isModelId).slice(0, 3);
}

export function clampCount(value: number): number {
  return Number.isFinite(value) ? Math.max(TEAM_MIN_MEMBERS, Math.min(TEAM_MAX_MEMBERS, Math.round(value))) : TEAM_MIN_MEMBERS;
}
