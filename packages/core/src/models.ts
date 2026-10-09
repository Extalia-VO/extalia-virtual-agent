import { assertNoCredentialFields } from './privacy.js';
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

/** A Workspace is a project context. Its sessions are separate from its project location. */
export interface Workspace {
  id: string;
  profileId: string;
  name: string;
  /** Host path or remote location chosen by the user; never inferred by scanning. */
  projectLocation?: string;
  runtimeProfileId?: string;
  /** Connection (provider profile) used by new sessions in this workspace. */
  providerProfileId?: string;
  defaultAgentId?: string;
  permissions?: WorkspacePermissions;
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
    for (const key of ['projectLocation', 'runtimeProfileId', 'providerProfileId', 'defaultAgentId'] as const) {
      const field = optionalText(value[key], key, { singleLine: true, max: key === 'projectLocation' ? 4096 : 200 });
      if (field) workspace[key] = field;
    }
    if (value.permissions !== undefined) {
      const permissions = object(value.permissions, 'permissions');
      workspace.permissions = {
        fileWrite: oneOf(permissions.fileWrite, ['ask', 'allow'] as const, 'permissions.fileWrite'),
        commands: oneOf(permissions.commands, ['ask', 'allow'] as const, 'permissions.commands'),
      };
    }
    return workspace;
  });
}
