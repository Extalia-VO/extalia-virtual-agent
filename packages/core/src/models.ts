import { assertNoCredentialFields } from './privacy.js';
import { decodeAgentTeam, type AgentTeam } from './teams.js';
import { decode, entityId, object, oneOf, optionalText, text, timestamp, type DecodeResult } from './validation.js';

/**
 * A Profile is the top-level user context (for example "Work" or "Personal").
 * Names, rosters and environments are user data; core never special-cases them.
 */
export interface Profile {
  id: string;
  name: string;
  defaults?: {
    runtimeId?: string;
    providerProfileId?: string;
    model?: string;
  };
  /** Office environment template id, when the profile maps to its own building. */
  environment?: string;
  createdAt: string;
  updatedAt: string;
}

export type PermissionMode = 'ask' | 'allow';

/** What agents may do in a workspace without asking. Reads inside the workspace are always allowed. */
export interface WorkspacePermissions {
  fileWrite: PermissionMode;
  commands: PermissionMode;
}

export const DEFAULT_PERMISSIONS: WorkspacePermissions = { fileWrite: 'ask', commands: 'ask' };

/**
 * A session's permission mode (v0.0.49), chosen in the prompt box. `workspace` follows the workspace
 * policy; `ask` asks before every edit and command; `accept-edits` allows edits inside the workspace
 * and still asks for commands; `plan` is read-only (no edit or command tools are offered).
 */
export const SESSION_PERMISSION_MODES = ['workspace', 'ask', 'accept-edits', 'plan'] as const;
export type SessionPermissionMode = (typeof SESSION_PERMISSION_MODES)[number];

/**
 * Agent loop a workspace's sessions use. `extalia-native` (the default) needs a
 * model connection; `hermes` drives the locally installed Hermes Agent, which
 * brings its own models, tools and memory.
 */
export type RuntimeId = 'extalia-native' | 'hermes';
export const RUNTIME_IDS: readonly RuntimeId[] = ['extalia-native', 'hermes'];
/** Hermes profile names: `default` or a profile directory name. */
export const RUNTIME_PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Model ids passed to a runtime: one token that cannot be read as a command-line option. */
export const RUNTIME_MODEL_PATTERN = /^[^\s-][^\s]{0,199}$/;

export const workspaceRuntime = (workspace: Pick<Workspace, 'runtimeId'>): RuntimeId => workspace.runtimeId ?? 'extalia-native';

/**
 * ADR 0028: the check that must pass in a disposable integration worktree before a write-capable
 * worker's changes can be merged. Chosen by the user in Settings, never by a model. There is no
 * ungated mode: without a gate a proposal is `gate_missing` and cannot be applied.
 */
export interface WorkspaceIntegrationGate {
  command: string;
  /** 1–1800 s; the host uses 600 s when absent. */
  timeoutSeconds?: number;
}
export const INTEGRATION_GATE_LIMITS = { maxCommand: 4_000, minTimeoutSeconds: 1, maxTimeoutSeconds: 1_800, defaultTimeoutSeconds: 600 } as const;

/** A stored gate, or an error naming the field. The command is trimmed and must not contain NUL. */
export function decodeIntegrationGate(raw: unknown): WorkspaceIntegrationGate {
  const value = object(raw, 'integrationGate');
  const { maxCommand, minTimeoutSeconds, maxTimeoutSeconds } = INTEGRATION_GATE_LIMITS;
  if (typeof value.command !== 'string' || !value.command.trim() || value.command.length > maxCommand || value.command.includes('\0')) throw new Error('integrationGate.command: enter a command of up to 4,000 characters.');
  const timeout = value.timeoutSeconds;
  if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < minTimeoutSeconds || timeout > maxTimeoutSeconds)) throw new Error('integrationGate.timeoutSeconds: use 1–1800 seconds.');
  return { command: value.command.trim(), ...(timeout !== undefined ? { timeoutSeconds: timeout as number } : {}) };
}

/** A Workspace is a project context. Its sessions are separate from its project location. */
export interface Workspace {
  id: string;
  profileId: string;
  name: string;
  /** Host path or remote location chosen by the user; never inferred by scanning. */
  projectLocation?: string;
  /** Absent means Extalia Native. */
  runtimeId?: RuntimeId;
  /** Runtime profile, for Hermes the profile name (`default` unless chosen). */
  runtimeProfileId?: string;
  /** Model override passed to the runtime; the runtime profile's default otherwise. */
  runtimeModel?: string;
  /** Connection (provider profile) used by new sessions in this workspace. */
  providerProfileId?: string;
  /** Additional saved connections explicitly permitted for native missions in this workspace. */
  missionConnectionIds?: string[];
  defaultAgentId?: string;
  permissions?: WorkspacePermissions;
  /**
   * v0.0.47: default subagent team (Extalia Native and Hermes Agent). Every new
   * managed session in the workspace starts with its own copy unless it is given another.
   */
  team?: AgentTeam;
  /** ADR 0028: the test gate integration proposals use when the request names none. Absent = not configured. */
  integrationGate?: WorkspaceIntegrationGate;
  createdAt: string;
  updatedAt: string;
}

function checkOrder(createdAt: string, updatedAt: string): void {
  if (Date.parse(createdAt) > Date.parse(updatedAt)) throw new Error('updatedAt: must not be earlier than createdAt.');
}

export function decodeProfile(raw: unknown): DecodeResult<Profile> {
  return decode(() => {
    assertNoCredentialFields(raw);
    const value = object(raw, 'profile');
    const createdAt = timestamp(value.createdAt, 'createdAt'), updatedAt = timestamp(value.updatedAt, 'updatedAt');
    checkOrder(createdAt, updatedAt);
    const profile: Profile = { id: entityId(value.id, 'id'), name: text(value.name, 'name', { singleLine: true, max: 120 }).trim(), createdAt, updatedAt };
    if (value.defaults !== undefined) {
      const defaults = object(value.defaults, 'defaults');
      profile.defaults = {};
      const runtimeId = optionalText(defaults.runtimeId, 'defaults.runtimeId', { singleLine: true, max: 64 });
      const providerProfileId = optionalText(defaults.providerProfileId, 'defaults.providerProfileId', { singleLine: true, max: 200 });
      const model = optionalText(defaults.model, 'defaults.model', { singleLine: true, max: 200 });
      if (runtimeId) profile.defaults.runtimeId = runtimeId;
      if (providerProfileId) profile.defaults.providerProfileId = providerProfileId;
      if (model) profile.defaults.model = model;
    }
    const environment = optionalText(value.environment, 'environment', { singleLine: true, max: 64 });
    if (environment) profile.environment = environment;
    return profile;
  });
}

export function decodeWorkspace(raw: unknown): DecodeResult<Workspace> {
  return decode(() => {
    assertNoCredentialFields(raw);
    const value = object(raw, 'workspace');
    const createdAt = timestamp(value.createdAt, 'createdAt'), updatedAt = timestamp(value.updatedAt, 'updatedAt');
    checkOrder(createdAt, updatedAt);
    const workspace: Workspace = {
      id: entityId(value.id, 'id'),
      profileId: entityId(value.profileId, 'profileId'),
      name: text(value.name, 'name', { singleLine: true, max: 120 }).trim(),
      createdAt,
      updatedAt,
    };
    for (const key of ['projectLocation', 'runtimeProfileId', 'runtimeModel', 'providerProfileId', 'defaultAgentId'] as const) {
      const field = optionalText(value[key], key, { singleLine: true, max: key === 'projectLocation' ? 4096 : 200 });
      if (field) workspace[key] = field;
    }
    if (value.missionConnectionIds !== undefined) {
      if (!Array.isArray(value.missionConnectionIds) || value.missionConnectionIds.length > 8) throw new Error('missionConnectionIds: expected up to 8 connection ids.');
      const ids = value.missionConnectionIds.map(id => entityId(id, 'missionConnectionIds'));
      if (new Set(ids).size !== ids.length) throw new Error('missionConnectionIds: duplicate connection ids.');
      workspace.missionConnectionIds = ids;
    }
    if (value.runtimeId !== undefined && oneOf(value.runtimeId, RUNTIME_IDS, 'runtimeId') === 'hermes') {
      workspace.runtimeId = 'hermes';
      workspace.runtimeProfileId ??= 'default';
      if (!RUNTIME_PROFILE_PATTERN.test(workspace.runtimeProfileId)) throw new Error('runtimeProfileId: use a Hermes profile name (lowercase letters, numbers, - and _).');
      if (workspace.runtimeModel && !RUNTIME_MODEL_PATTERN.test(workspace.runtimeModel)) throw new Error('runtimeModel: use a model id without spaces.');
    }
    if (value.permissions !== undefined) {
      const permissions = object(value.permissions, 'permissions');
      workspace.permissions = {
        fileWrite: oneOf(permissions.fileWrite, ['ask', 'allow'] as const, 'permissions.fileWrite'),
        commands: oneOf(permissions.commands, ['ask', 'allow'] as const, 'permissions.commands'),
      };
    }
    // A damaged default team is dropped, never the whole workspace (hosts keep only valid workspaces).
    if (value.team !== undefined && value.team !== null) {
      const team = decodeAgentTeam(value.team);
      if (team.ok) workspace.team = team.value;
    }
    // Likewise a damaged gate is dropped: proposals then stay `gate_missing` (never ungated).
    if (value.integrationGate !== undefined && value.integrationGate !== null) {
      try { workspace.integrationGate = decodeIntegrationGate(value.integrationGate); } catch { /* not configured */ }
    }
    return workspace;
  });
}
