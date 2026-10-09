import type { HostState, SessionSummary } from '@extalia/platform';
import type { Workspace } from '@extalia/core';

/** `sessionId: null` is a new, not yet created session; undefined opens the latest one. */
export interface ChatSelection { workspaceId?: string; sessionId?: string | null }

/** The workspace, its sessions (latest first) and the open session for a selection. */
export function resolveChat(state: HostState, selection: ChatSelection): { workspace?: Workspace; sessions: SessionSummary[]; session?: SessionSummary } {
  const workspace = state.workspaces.find(item => item.id === selection.workspaceId) ?? state.workspaces[0];
  const sessions = state.sessions.filter(item => item.workspaceId === workspace?.id).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  const session = selection.sessionId === null ? undefined : sessions.find(item => item.id === selection.sessionId) ?? sessions[0];
  return { ...(workspace ? { workspace } : {}), sessions, ...(session ? { session } : {}) };
}
