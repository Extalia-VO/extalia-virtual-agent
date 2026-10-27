import type { ExtaliaEvent } from '@extalia/protocol';
import { projectTranscript } from '../chat/transcript';
import type { TranscriptItem } from '../chat/transcript';
import type { OfficeAgent } from './presence';

/**
 * Project only the selected presence's actual session history and controls. A lead shows its own
 * conversation with its workers as cards; a managed worker shows its card; an observed subagent
 * shows its own messages and tools (its task, replies and calls), never the lead's.
 */
export function characterTranscript(events: readonly ExtaliaEvent[], agent: OfficeAgent): TranscriptItem[] {
  const sessionEvents = events.filter(event => event.sessionId === agent.sessionId);
  const selectedEvents = agent.agentId === 'primary'
    ? sessionEvents
    : agent.control === 'observed'
      ? sessionEvents.filter(event => event.agentId === agent.agentId && event.body.type !== 'subagent.spawned' && event.body.type !== 'subagent.state')
      : sessionEvents.filter(event => event.agentId === agent.agentId
        || ('subagentId' in event.body && event.body.subagentId === agent.agentId));
  const items = projectTranscript(selectedEvents);
  return agent.control === 'observed' || agent.agentId !== 'primary'
    ? items.filter(item => item.kind !== 'approval')
    : items;
}
