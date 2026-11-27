import type { HostState, SessionSummary } from '@extalia/platform';
import type { Workspace } from '@extalia/core';

/** `sessionId: null` is a new, not yet created session; `workspaceId: null` is explicit unassigned context. */
export interface ChatSelection { workspaceId?: string | null; sessionId?: string | null }

/** The workspace (if assigned), whether the view is unassigned, its sessions (latest first) and the open session. */
export function resolveChat(state: HostState, selection: ChatSelection): { workspace?: Workspace; unassigned: boolean; sessions: SessionSummary[]; session?: SessionSummary } {
  const workspaces = state.workspaces.filter(item => item.mode !== 'observe');
  const explicitUnassigned = selection.workspaceId === null;
  const workspace = explicitUnassigned ? undefined : workspaces.find(item => item.id === selection.workspaceId) ?? workspaces[0];
  const unassigned = !workspace;
  const targetWorkspaceId = workspace?.id ?? null;
  const sessions = state.sessions.filter(item => item.workspaceId === targetWorkspaceId).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  const session = selection.sessionId === null ? undefined : sessions.find(item => item.id === selection.sessionId) ?? sessions[0];
  return { ...(workspace ? { workspace } : {}), unassigned, sessions, ...(session ? { session } : {}) };
}
