/** Only these user-facing Knowledge actions may cross a workspace-scoped bridge. */
export const WORKSPACE_KNOWLEDGE_METHODS = [
  'knowledgeStatus', 'syncKnowledge', 'knowledgeNode', 'knowledgeLinks', 'knowledgeBacklinks', 'searchKnowledge', 'knowledgeGraph', 'knowledgeOverview',
  'readKnowledgeNote', 'writeKnowledgeNote', 'knowledgeHistory', 'rollbackKnowledgeNote', 'importMemoryNotes', 'knowledgeSettings', 'setKnowledgeVaultRoot',
] as const;
export type WorkspaceKnowledgeMethod = (typeof WORKSPACE_KNOWLEDGE_METHODS)[number];

export function normalizeWorkspaceKnowledgeRequest(workspaceId: unknown, method: unknown, args: unknown): {
  workspaceId: string; method: WorkspaceKnowledgeMethod; args: unknown[];
} {
  if (typeof workspaceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(workspaceId)
    || typeof method !== 'string' || !(WORKSPACE_KNOWLEDGE_METHODS as readonly string[]).includes(method)
    || !Array.isArray(args) || args.length > 3) throw new Error('Choose a workspace and a supported Knowledge action.');
  return { workspaceId, method: method as WorkspaceKnowledgeMethod, args };
}
