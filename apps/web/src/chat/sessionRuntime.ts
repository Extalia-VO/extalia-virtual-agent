import type { RuntimeId, Workspace } from '@extalia/core';
import type { HostState, SessionSummary } from '@extalia/platform';

/** Existing sessions own their runtime; only a new conversation follows workspace defaults. */
export function sessionRuntime(workspace: Pick<Workspace, 'runtimeId'> | undefined, session?: Pick<SessionSummary, 'runtime'>): RuntimeId {
  return session ? session.runtime?.id ?? 'extalia-native' : workspace?.runtimeId ?? 'extalia-native';
}

export function workspaceTargetChanged(workspace: Workspace, session?: SessionSummary): boolean {
  if (!session || session.control !== 'managed' || session.workspaceId !== workspace.id) return false;
  if (sessionRuntime(workspace, session) !== sessionRuntime(workspace)) return true;
  return session.runtime?.id === 'hermes'
    ? session.runtime.profile !== (workspace.runtimeProfileId ?? 'default')
    : session.connectionId !== workspace.providerProfileId;
}

/** Invalidates suggestions after an in-place settings change without discarding the typed prompt. */
export function modelChoicesKey(state: Pick<HostState, 'profile' | 'connections'>, workspace?: Workspace, session?: SessionSummary): string {
  const runtime = sessionRuntime(workspace, session);
  const connectionId = session ? session.connectionId : workspace?.providerProfileId;
  const connection = runtime === 'extalia-native' ? state.connections.find(item => item.id === connectionId) : undefined;
  const profile = runtime === 'hermes' ? session?.runtime?.profile ?? workspace?.runtimeProfileId ?? 'default' : undefined;
  const workspaceModel = runtime === 'hermes' && workspace?.runtimeId === 'hermes' && (workspace.runtimeProfileId ?? 'default') === profile ? workspace.runtimeModel : undefined;
  return JSON.stringify([state.profile.id, workspace?.id, session?.id, runtime,
    profile, workspaceModel, session?.options?.model,
    connectionId, connection?.updatedAt, connection?.api, connection?.model]);
}
