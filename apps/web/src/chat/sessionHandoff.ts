import type { AgentHostApi, AgentTeam, HostState } from '@extalia/platform';
import type { ComposerSend } from './Composer';
import type { ChatSelection } from './selection';

/** Resolve async creation/state first; commit UI ownership only while the send still owns its context. */
export async function createComposerSession({ agents, workspaceId, connectionId, choice, team, clientRequestId, bindSession, onState, onSelect, interrupted }: {
  agents: Pick<AgentHostApi, 'createSession' | 'getState'>;
  workspaceId: string | null;
  connectionId?: string | undefined;
  choice: ComposerSend['choice'];
  /** An explicit reviewed snapshot; undefined preserves the host's default inheritance. */
  team?: AgentTeam | null;
  clientRequestId?: string | undefined;
  bindSession: ComposerSend['bindSession'];
  onState: (state: HostState) => void;
  onSelect: (selection: ChatSelection) => void;
  interrupted: string;
}): Promise<string> {
  const options = {
    ...choice,
    ...(workspaceId === null && connectionId ? { connectionId } : {}),
    ...(clientRequestId ? { clientRequestId } : {}),
    ...(team === undefined ? {} : { team }),
  };
  const created = await agents.createSession(workspaceId, options);
  const state = await agents.getState();
  if (bindSession && !bindSession(created.id)) throw new Error(interrupted);
  // No await may separate the ownership guard from these UI commits.
  onState(state);
  onSelect({ workspaceId: created.workspaceId, sessionId: created.id });
  return created.id;
}
