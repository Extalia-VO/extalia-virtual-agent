import { normalizeKnowledgeVaultRoot } from './knowledgeVault.js';

/** A stale-view guard, never authority to select a vault. The host still resolves the workspace. */
export interface WorkspaceKnowledgeBinding { profileId: string; root: string }

/** Only these user-facing Knowledge actions may cross a workspace-scoped bridge. */
export const WORKSPACE_KNOWLEDGE_METHODS = [
  'knowledgeStatus', 'syncKnowledge', 'knowledgeNode', 'knowledgeLinks', 'knowledgeBacklinks', 'searchKnowledge', 'knowledgeGraph', 'knowledgeOverview',
  'readKnowledgeNote', 'writeKnowledgeNote', 'knowledgeHistory', 'rollbackKnowledgeNote', 'importMemoryNotes', 'knowledgeSettings', 'setKnowledgeVaultRoot',
] as const;
export type WorkspaceKnowledgeMethod = (typeof WORKSPACE_KNOWLEDGE_METHODS)[number];

export function normalizeWorkspaceKnowledgeRequest(workspaceId: unknown, method: unknown, args: unknown, expectedBinding?: unknown): {
  workspaceId: string; method: WorkspaceKnowledgeMethod; args: unknown[]; expectedBinding?: WorkspaceKnowledgeBinding;
} {
  if (typeof workspaceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(workspaceId)
    || typeof method !== 'string' || !(WORKSPACE_KNOWLEDGE_METHODS as readonly string[]).includes(method)
    || !Array.isArray(args) || args.length > 3) throw new Error('Choose a workspace and a supported Knowledge action.');
  if (expectedBinding === undefined) return { workspaceId, method: method as WorkspaceKnowledgeMethod, args };
  if (!expectedBinding || typeof expectedBinding !== 'object' || Array.isArray(expectedBinding)) throw new Error('Refresh the workspace vault before continuing.');
  const binding = expectedBinding as Record<string, unknown>;
  if (Object.keys(binding).some(key => key !== 'profileId' && key !== 'root')
    || typeof binding.profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(binding.profileId)) throw new Error('Refresh the workspace vault before continuing.');
  const root = normalizeKnowledgeVaultRoot(binding.root);
  if (!root) throw new Error('Refresh the workspace vault before continuing.');
  return { workspaceId, method: method as WorkspaceKnowledgeMethod, args, expectedBinding: { profileId: binding.profileId, root } };
}
