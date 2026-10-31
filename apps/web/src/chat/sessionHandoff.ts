import type { AgentHostApi, HostState } from '@extalia/platform';
import type { ComposerSend } from './Composer';
import type { ChatSelection } from './selection';

/** Resolve async creation/state first; commit UI ownership only while the send still owns its context. */
export async function createComposerSession({ agents, workspaceId, choice, bindSession, onState, onSelect, interrupted }: {
  agents: Pick<AgentHostApi, 'createSession' | 'getState'>;
  workspaceId: string;
  choice: ComposerSend['choice'];
  bindSession: ComposerSend['bindSession'];
  onState: (state: HostState) => void;
  onSelect: (selection: ChatSelection) => void;
  interrupted: string;
}): Promise<string> {
  const created = await agents.createSession(workspaceId, choice);
  const state = await agents.getState();
  if (bindSession && !bindSession(created.id)) throw new Error(interrupted);
  // No await may separate the ownership guard from these UI commits.
  onState(state);
  onSelect({ workspaceId, sessionId: created.id });
  return created.id;
}
