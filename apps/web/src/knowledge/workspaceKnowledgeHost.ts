import { WORKSPACE_KNOWLEDGE_METHODS, type AgentHostApi } from '@extalia/platform';

/** Presentation adapter only; authority and workspace-to-profile resolution stay in the host. */
export function workspaceKnowledgeHost(agents: AgentHostApi, workspaceId: string | undefined): AgentHostApi {
  if (!workspaceId || !agents.workspaceKnowledge) return agents;
  const scoped = Object.fromEntries(WORKSPACE_KNOWLEDGE_METHODS.map(method => [method, (...args: unknown[]) => {
    while (args.length && args.at(-1) === undefined) args.pop();
    return agents.workspaceKnowledge!(workspaceId, method, args);
  }]));
  return { ...agents, ...scoped } as AgentHostApi;
}
