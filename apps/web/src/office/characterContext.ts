import type { SessionSummary } from '@extalia/platform';
import type { Messages } from '../i18n';
import type { OfficeAgent } from './presence';
import { promptTargetFor } from './promptTarget';

/** Explicit character selection follows its source session without narrowing the Office roster. */
export function officeCharacterContext(t: Messages, agent: OfficeAgent | undefined, sessions: readonly SessionSummary[], presences: readonly OfficeAgent[]) {
  if (!agent) return undefined;
  const session = sessions.find(item => item.id === agent.sessionId);
  if (!session) return undefined;
  const c = t.officeUx.composer;
  const target = promptTargetFor(agent, sessions);
  const lead = target && presences.find(item => item.sessionId === target.sessionId && item.agentId === 'primary');
  const dock: { sessionId?: string; note?: string } = target
    ? { sessionId: target.sessionId, ...(target.viaWorker ? { note: c.viaSubagent(target.viaWorker, lead?.displayName ?? c.untitled) } : {}) }
    : { note: c.observedTarget(agent.displayName) };
  return { workspaceId: session.workspaceId || undefined, sessionId: session.id, dock };
}
