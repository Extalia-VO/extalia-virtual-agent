import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import type { OfficeAgent } from '../src/office/presence';
import { characterTranscript } from '../src/office/characterHistory';
import { describe, expect, it } from 'vitest';

function event(id: string, sessionId: string, body: EventBody, agentId = 'primary'): ExtaliaEvent {
  return createEvent({ id, sessionId, agentId, source: { runtime: 'test', channel: 'stream' }, body });
}

function presence(sessionId: string, agentId = 'primary', control: OfficeAgent['control'] = 'managed'): OfficeAgent {
  return {
    id: `${sessionId}:${agentId}`, sessionId, agentId, displayName: agentId,
    control, status: 'idle', running: false,
  };
}

describe('character transcript routing', () => {
  it('isolates sessions, even when their event content is identical', () => {
    const events = [
      event('a1', 'session-a', { type: 'prompt.submitted', text: 'Same prompt', via: 'extalia' }),
      event('a2', 'session-a', { type: 'model.completed', text: 'Session A' }),
      event('b1', 'session-b', { type: 'prompt.submitted', text: 'Same prompt', via: 'extalia' }),
      event('b2', 'session-b', { type: 'model.completed', text: 'Session B' }),
    ];
    expect(characterTranscript(events, presence('session-a')).map(item => item.kind === 'assistant' ? item.text : item.kind === 'user' ? item.text : item.kind))
      .toEqual(['Same prompt', 'Session A']);
  });

  it('shows a worker card from its own linked events without parent prompts or approvals', () => {
    const events = [
      event('prompt', 's1', { type: 'prompt.submitted', text: 'Parent instruction', via: 'extalia' }),
      event('spawn', 's1', { type: 'subagent.spawned', subagentId: 'worker-1', label: 'Review worker' }),
      event('approval', 's1', { type: 'approval.requested', approvalId: 'a1', action: 'Run command' }),
      event('worker-tool', 's1', { type: 'tool.started', toolCallId: 'c1', tool: 'read_file', kind: 'read', label: 'Inspect source' }, 'worker-1'),
      event('other-worker', 's1', { type: 'subagent.state', subagentId: 'worker-2', state: 'idle', summary: 'Other worker.' }, 'worker-2'),
    ];
    expect(characterTranscript(events, presence('s1', 'worker-1'))).toMatchObject([
      { kind: 'worker', subagentId: 'worker-1', activity: 'Inspect source', toolCalls: 1 },
    ]);
  });

  it('keeps primary approvals actionable and removes approval controls from observed history', () => {
    const events = [
      event('prompt', 's1', { type: 'prompt.submitted', text: 'Edit files', via: 'extalia' }),
      event('approval', 's1', { type: 'approval.requested', approvalId: 'a1', action: 'Edit file' }),
    ];
    expect(characterTranscript(events, presence('s1')).map(item => item.kind)).toEqual(['user', 'approval']);
    expect(characterTranscript(events, presence('s1', 'primary', 'observed')).map(item => item.kind)).toEqual(['user']);
  });
});
