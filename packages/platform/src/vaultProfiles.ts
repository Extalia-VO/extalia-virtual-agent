/** Opt-in curation after useful completed work; candidate skills never activate automatically. */
export interface AutomaticLearningPolicy { enabled: boolean; skills: boolean; notes: boolean; observed?: boolean }

export function normalizeAutomaticLearningPolicy(value: unknown): AutomaticLearningPolicy {
  if (value === undefined) return { enabled: false, skills: false, notes: false };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose an automatic learning policy.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['enabled', 'skills', 'notes', 'observed'].includes(key))
    || ['enabled', 'skills', 'notes'].some(key => typeof input[key] !== 'boolean')
    || Object.hasOwn(input, 'observed') && typeof input.observed !== 'boolean') throw new Error('Invalid automatic learning policy.');
  return { enabled: input.enabled as boolean, skills: input.skills as boolean, notes: input.notes as boolean, ...(Object.hasOwn(input, 'observed') ? { observed: input.observed as boolean } : {}) };
}

/** Workspace grouping selects its Knowledge/managed-notes vault without moving sessions or credentials. */
export interface VaultProfile {
  id: string;
  name: string;
  kind: 'indexed' | 'managed' | 'custom';
  root: string;
  minutesEnabled: boolean;
  automaticLearning: AutomaticLearningPolicy;
  workspaceIds: string[];
}
export interface VaultProfilesCatalog {
  revision: string;
  defaultProfileId: string;
  profiles: VaultProfile[];
  workspaces: { id: string; name: string; profileId: string }[];
}
export interface SaveVaultProfileInput {
  id?: string;
  name: string;
  /** null: managed folder; the default profile always follows the indexed vault setting. */
  vaultRoot: string | null;
  workspaceIds: string[];
  expectedRevision: string;
  minutesEnabled: boolean;
  /** Omission preserves existing policy and note-folder consent; new profiles default to off. */
  automaticLearning?: AutomaticLearningPolicy;
}
export const VAULT_PROFILE_HOST_METHODS = ['listVaultProfiles', 'saveVaultProfile'] as const;

export function normalizeSaveVaultProfile(value: unknown): SaveVaultProfileInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a vault profile.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['id', 'name', 'vaultRoot', 'workspaceIds', 'expectedRevision', 'minutesEnabled', 'automaticLearning'].includes(key))) throw new Error('Invalid vault profile fields.');
  const text = (item: unknown, limit: number): item is string => typeof item === 'string' && !!item.trim() && item.length <= limit && !/\p{Cc}/u.test(item);
  if (input.id !== undefined && !text(input.id, 160)) throw new Error('Invalid vault profile id.');
  if (!text(input.name, 120)) throw new Error('Enter a profile name of 1–120 characters.');
  if (input.vaultRoot !== null && !text(input.vaultRoot, 4096)) throw new Error('Choose a vault folder or use the managed folder.');
  if (!Array.isArray(input.workspaceIds) || input.workspaceIds.length > 1000 || input.workspaceIds.some(id => !text(id, 160))) throw new Error('Choose registered workspaces.');
  if (new Set(input.workspaceIds).size !== input.workspaceIds.length) throw new Error('Choose each workspace only once.');
  if (!text(input.expectedRevision, 128)) throw new Error('Refresh the vault profiles before saving.');
  if (typeof input.minutesEnabled !== 'boolean') throw new Error('Choose whether meeting minutes may be saved in this vault.');
  return { ...(input.id !== undefined ? { id: input.id as string } : {}), name: (input.name as string).trim(), vaultRoot: typeof input.vaultRoot === 'string' ? input.vaultRoot.trim() : null,
    workspaceIds: input.workspaceIds as string[], expectedRevision: input.expectedRevision as string, minutesEnabled: input.minutesEnabled,
    ...(input.automaticLearning !== undefined ? { automaticLearning: normalizeAutomaticLearningPolicy(input.automaticLearning) } : {}) };
}
