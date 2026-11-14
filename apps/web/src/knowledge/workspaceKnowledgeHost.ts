import { WORKSPACE_KNOWLEDGE_METHODS, type AgentHostApi, type WorkspaceKnowledgeBinding } from '@extalia/platform';
import { MESSAGES } from '../i18n';

/** Only the host/mock's explicit binding refusal is redundant beside the scope-change banner. */
export function isWorkspaceKnowledgeBindingError(message: string | undefined): boolean {
  return typeof message === 'string' && /^The workspace Knowledge vault changed\. Refresh it before continuing(?:; no operation was applied to the new vault)?\.$/.test(message);
}

/** Presentation adapter only; authority and workspace-to-profile resolution stay in the host. */
export function workspaceKnowledgeHost(agents: AgentHostApi, workspaceId: string | undefined, binding?: WorkspaceKnowledgeBinding,
  unsupportedMessage = MESSAGES.en.knowledgeContext.unsupported): AgentHostApi {
  if (!workspaceId) return agents;
  const pinned = binding ? { profileId: binding.profileId, root: binding.root } : undefined;
  const scoped = Object.fromEntries(WORKSPACE_KNOWLEDGE_METHODS.map(method => [method, (...args: unknown[]) => {
    if (!agents.workspaceKnowledge) return Promise.reject(new Error(unsupportedMessage));
    while (args.length && args.at(-1) === undefined) args.pop();
    return pinned ? agents.workspaceKnowledge(workspaceId, method, args, { ...pinned }) : agents.workspaceKnowledge(workspaceId, method, args);
  }]));
  return { ...agents, ...scoped } as AgentHostApi;
}
