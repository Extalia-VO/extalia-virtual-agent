import { randomUUID } from 'node:crypto';
import type { Workspace } from '@extalia/core';
import type { StoredVaultProfiles } from './vaultProfiles.js';

export interface WorkspaceVaultProfileState {
  profiles?: StoredVaultProfiles;
  workspaces: Workspace[];
  defaultProfile: { id: string; name: string };
}

export interface WorkspaceVaultProfileResult {
  profiles: StoredVaultProfiles;
  workspaces: Workspace[];
  profileId: string;
  created: boolean;
}

/**
 * Bind an isolated workspace to its own stable, managed vault profile.
 * Call inside the host's workspace mutation lane and persist both returned values together.
 * Existing dedicated bindings survive edits; shared/default bindings get a new profile.
 */
export function assignWorkspaceVaultProfile(state: WorkspaceVaultProfileState, workspaceId: string,
  makeId: () => string = () => `vp-${randomUUID()}`): WorkspaceVaultProfileResult {
  const target = state.workspaces.find(workspace => workspace.id === workspaceId);
  if (!target) throw new Error('That workspace no longer exists.');
  const profiles: StoredVaultProfiles = structuredClone(state.profiles ?? { profiles: [] });
  const workspaces = structuredClone(state.workspaces);
  const current = profiles.profiles.find(profile => profile.id === target.profileId);
  const members = workspaces.filter(workspace => workspace.profileId === target.profileId);
  const alreadyDedicated = target.profileId !== state.defaultProfile.id && current !== undefined
    && /^vp-[a-f0-9-]{36}$/.test(current.id) && members.length === 1;
  if (alreadyDedicated) return { profiles, workspaces, profileId: target.profileId, created: false };

  if (profiles.profiles.length >= 63) throw new Error('At most 64 vault profiles are supported.');
  const id = makeId();
  if (!/^vp-[a-f0-9-]{36}$/.test(id) || id === state.defaultProfile.id || profiles.profiles.some(profile => profile.id === id))
    throw new Error('A unique workspace vault profile id could not be created.');
  const baseName = `${(target.name.trim() || 'Workspace').slice(0, 105)} vault`;
  const names = new Set([state.defaultProfile.name, ...profiles.profiles.map(profile => profile.name)].map(name => name.toLocaleLowerCase()));
  let name = baseName;
  for (let suffix = 2; names.has(name.toLocaleLowerCase()); suffix++) name = `${baseName} ${suffix}`;
  const stamp = new Date().toISOString();
  const profile: StoredVaultProfiles['profiles'][number] = {
    id, name, vaultRoot: null, minutesEnabled: true,
    automaticLearning: { enabled: true, skills: true, notes: true },
  };
  profiles.profiles.push(profile);
  const updated = workspaces.find(workspace => workspace.id === workspaceId)!;
  updated.profileId = id;
  updated.updatedAt = stamp;
  return { profiles, workspaces, profileId: id, created: true };
}
