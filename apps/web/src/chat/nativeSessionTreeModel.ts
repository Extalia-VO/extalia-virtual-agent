import type { Workspace } from '@extalia/core';
import type { SessionSummary } from '@extalia/platform';

export const NATIVE_SESSION_DRAG_TYPE = 'application/x-extalia-native-session';
export type NativeSessionDrag = { sessionId: string; workspaceId: string };
export const nativeSession = (session: SessionSummary): boolean => session.control === 'managed' && !session.runtime;
export const registeredSessionFolders = (workspace: Workspace): string[] =>
  [...new Set([workspace.projectLocation, ...(workspace.additionalProjectLocations ?? [])].filter((path): path is string => Boolean(path)))];

/** The drag payload identifies a row; current host state owns every decision. */
export function nativeSessionDrop(sessions: readonly SessionSummary[], workspaces: readonly Workspace[], drag: NativeSessionDrag | undefined, workspaceId: string, projectLocation: string): SessionSummary | undefined {
  if (!drag || drag.workspaceId !== workspaceId) return undefined;
  const workspace = workspaces.find(item => item.id === workspaceId && item.mode !== 'observe');
  const session = sessions.find(item => item.id === drag.sessionId);
  if (!workspace || !session || session.workspaceId !== workspaceId || !nativeSession(session) || session.transient || session.running || session.pendingApprovalId) return undefined;
  if (!registeredSessionFolders(workspace).includes(projectLocation)) return undefined;
  if ((session.projectLocation ?? workspace.projectLocation) === projectLocation) return undefined;
  return session;
}

export function parseNativeSessionDrag(value: string): NativeSessionDrag | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const { sessionId, workspaceId } = parsed as Partial<NativeSessionDrag>;
    return typeof sessionId === 'string' && typeof workspaceId === 'string' ? { sessionId, workspaceId } : undefined;
  } catch { return undefined; }
}
