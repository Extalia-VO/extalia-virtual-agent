import type { Workspace } from '@extalia/core';
import type { AgentHostApi, HostState, SessionSummary } from '@extalia/platform';
import { connectionModels, eligibleSessions, missionEligibility } from './missionModel';

export type MissionSetupIssue = 'noWorkspace' | 'hermes' | 'folder' | 'connection' | 'credential' | 'model';

/** A proxy exposes current methods even when an older peer rejects their RPC. */
export function missionMethodUnavailable(message: string | undefined): boolean {
  return message === 'This host does not support this action.' || message === 'Unknown method.' || message === 'Unknown host method.'
    || message === 'Extalia Bridge answered 501.' || Boolean(message?.startsWith('No handler registered for'));
}

/** Prerequisites for creating a Native mission session; the host remains authoritative. */
export function missionSetupIssue(state: HostState, workspace: Workspace | undefined): MissionSetupIssue | undefined {
  if (!workspace) return 'noWorkspace';
  if (workspace.runtimeId === 'hermes') return 'hermes';
  if (!workspace.projectLocation) return 'folder';
  const connection = state.connections.find(item => item.id === workspace.providerProfileId);
  if (!connection) return 'connection';
  if (connection.credentialStatus === 'missing') return 'credential';
  if (!connectionModels(connection).length) return 'model';
  return undefined;
}

/** An exact status link never substitutes a different session when its target disappears. */
export function missionSelection(state: HostState, choice: { workspaceId?: string | undefined; sessionId?: string | undefined; exact?: boolean }) {
  const requested = state.sessions.find(item => item.id === choice.sessionId);
  const workspace = state.workspaces.find(item => item.id === choice.workspaceId)
    ?? state.workspaces.find(item => item.id === requested?.workspaceId)
    ?? (choice.exact ? undefined : state.workspaces.find(item => !missionSetupIssue(state, item)) ?? state.workspaces[0]);
  const sessions = eligibleSessions(state).filter(item => item.workspaceId === workspace?.id);
  const session = choice.exact
    ? sessions.find(item => item.id === choice.sessionId)
    : sessions.find(item => item.id === choice.sessionId) ?? sessions.find(item => !item.running) ?? sessions[0];
  return { workspace, sessions, session };
}

export class MissionSetupChanged extends Error {}

/** Create a blank session only; planning and inference require a later explicit action. */
export async function createMissionSession(options: {
  agents: Pick<AgentHostApi, 'getState' | 'createSession'>;
  workspaceId: string;
  current(): boolean;
  onState(state: HostState): void;
  onCreated(session: SessionSummary): void;
}): Promise<void> {
  const { agents, workspaceId, current } = options;
  if (!current()) return;
  const before = await agents.getState();
  if (!current()) return;
  if (missionSetupIssue(before, before.workspaces.find(item => item.id === workspaceId))) throw new MissionSetupChanged();
  const created = await agents.createSession(workspaceId);
  if (!current()) return;
  const next = await agents.getState();
  if (!current()) return;
  const session = next.sessions.find(item => item.id === created.id && item.workspaceId === workspaceId);
  if (!session || missionEligibility(next, session) !== 'eligible') {
    options.onState(next);
    throw new MissionSetupChanged();
  }
  // No await between the ownership check and these commits.
  options.onState(next);
  options.onCreated(session);
}
