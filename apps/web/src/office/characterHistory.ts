import type { ExtaliaEvent } from '@extalia/protocol';
import { projectTranscript } from '../chat/transcript';
import type { TranscriptItem } from '../chat/transcript';
import type { OfficeAgent } from './presence';

/** Project only the selected presence's actual session history and controls. */
export function characterTranscript(events: readonly ExtaliaEvent[], agent: OfficeAgent): TranscriptItem[] {
  const sessionEvents = events.filter(event => event.sessionId === agent.sessionId);
  const selectedEvents = agent.control === 'observed' || agent.agentId === 'primary'
    ? sessionEvents
    : sessionEvents.filter(event => event.agentId === agent.agentId
      || ('subagentId' in event.body && event.body.subagentId === agent.agentId));
  const items = projectTranscript(selectedEvents);
  return agent.control === 'observed' || agent.agentId !== 'primary'
    ? items.filter(item => item.kind !== 'approval')
    : items;
}
