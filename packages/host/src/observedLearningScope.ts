import type { Workspace } from '@extalia/core';
import { GLOBAL_OBSERVE_WORKSPACE_ID, type SessionSummary } from '@extalia/platform';

/** Consume a fresh physical workspace projection. Invalid/ambiguous links never become global. */
export function observedLearningWorkspace(source: SessionSummary, workspaces: readonly Workspace[], defaultProfileId: string) {
  if (source.observation?.workspaceLinkState === 'invalid' || source.observation?.workspaceLinkState === 'ambiguous') return undefined;
  if (source.workspaceId) {
    const workspace = workspaces.find(item => item.id === source.workspaceId);
    return workspace ? { workspaceId: workspace.id, profileId: workspace.profileId, workspace } : undefined;
  }
  if (source.observation?.workspaceLinkState !== 'unbound') return undefined;
  return { workspaceId: GLOBAL_OBSERVE_WORKSPACE_ID, profileId: defaultProfileId, workspace: undefined };
}

/** Prefer the sole approved default-profile route, or the sole saved eligible connection. */
export function globalObservedConnection(workspaces: readonly Workspace[], defaultProfileId: string, eligibleConnectionIds: readonly string[]): string | undefined {
  const allowed = new Set(eligibleConnectionIds);
  const defaults = new Set(workspaces.filter(item => item.profileId === defaultProfileId)
    .map(item => item.providerProfileId).filter((id): id is string => Boolean(id && allowed.has(id))));
  if (defaults.size) return defaults.size === 1 ? [...defaults][0] : undefined;
  return allowed.size === 1 ? [...allowed][0] : undefined;
}
