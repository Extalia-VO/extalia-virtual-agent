import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { semanticBubble } from '../src/office/semanticBubble';
import { activityFromEvent, activityText, latestByCharacter, newActivities } from '../src/office/activityFeed';

let n = 0;
const event = (body: EventBody, options: { agentId?: string; channel?: 'stream' | 'import' } = {}): ExtaliaEvent =>
  createEvent({ id: `e${++n}`, sessionId: 's1', agentId: options.agentId ?? 'primary', source: { runtime: 'test', channel: options.channel ?? 'stream' }, body },
    () => new Date(Date.UTC(2026, 9, 9, 10, 0, n)));

describe('office activity feed', () => {
  it('turns reported events into short activities for the right character', () => {
    expect(activityFromEvent(event({ type: 'prompt.submitted', text: 'Fix **the** login\n\nplease', via: 'extalia' }))).toMatchObject({ characterId: 's1:primary', kind: 'prompt', text: 'Fix the login please' });
    expect(activityFromEvent(event({ type: 'tool.started', tool: 'write_file', kind: 'edit', label: 'Editing', target: 'src/a.ts' }))).toMatchObject({ kind: 'tool', text: 'Editing src/a.ts', activity: 'edit' });
    expect(activityFromEvent(event({ type: 'subagent.spawned', subagentId: 'w1', label: 'Review tests' }))).toMatchObject({ characterId: 's1:w1', kind: 'delegated', text: 'Review tests' });
    expect(activityFromEvent(event({ type: 'model.completed', text: 'Done.' }, { agentId: 'w1' }))).toMatchObject({ characterId: 's1:w1', kind: 'reply' });
    expect(activityFromEvent(event({ type: 'approval.requested', approvalId: 'a', action: 'Run npm test' }))).toMatchObject({ kind: 'approval', text: 'Run npm test' });
    expect(activityFromEvent(event({ type: 'turn.failed', error: 'Rate limited' }))).toMatchObject({ kind: 'failed', text: 'Rate limited' });
  });

  it('ignores bookkeeping, empty replies and conversations carried over from another agent', () => {
    expect(activityFromEvent(event({ type: 'agent.state', state: 'working' }))).toBeUndefined();
    expect(activityFromEvent(event({ type: 'model.completed', text: '  ' }))).toBeUndefined();
    expect(activityFromEvent(event({ type: 'prompt.submitted', text: 'old', via: 'native' }, { channel: 'import' }))).toBeUndefined();
  });

  it('shortens long text at a word and keeps the latest line per character', () => {
    const long = activityText('word '.repeat(60), 40);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith('…')).toBe(true);
    expect(activityText('a ```code\nblock``` b')).toBe('a b');
    const events = [event({ type: 'prompt.submitted', text: 'one', via: 'extalia' }), event({ type: 'model.completed', text: 'two' }), event({ type: 'model.completed', text: 'three' }, { agentId: 'w1' })];
    const fresh = newActivities(events, new Set([events[0]!.id]));
    expect(fresh.map(item => item.text)).toEqual(['two', 'three']);
    expect([...latestByCharacter(newActivities(events, new Set())).values()].map(item => item.text)).toEqual(['two', 'three']);
  });
});


it('displays real meeting contributions and outcomes with localized, world-safe labels', () => {
  const start = activityFromEvent(event({ type: 'meeting.started', meetingId: 'sync', participants: ['primary'], topic: 'Design review' }))!;
  const contribution = activityFromEvent(event({ type: 'meeting.contribution', meetingId: 'sync', round: 2, text: 'Use **the** shared interface.' }, { agentId: 'member' }))!;
  expect(start).toMatchObject({ kind: 'meeting-started', text: 'Design review' });
  expect(contribution).toMatchObject({ characterId: 's1:member', kind: 'meeting-contribution', round: 2, text: 'Use the shared interface.' });
  for (const language of ['en', 'id'] as const) {
    expect(semanticBubble(contribution, MESSAGES[language])).toBe(MESSAGES[language].officeUx.semantic.meeting);
    expect(MESSAGES[language].officeUx.toast[contribution.kind]).toBeTruthy();
  }
  for (const outcome of ['completed', 'cancelled', 'failed'] as const) {
    const completed = activityFromEvent(event({ type: 'meeting.completed', meetingId: 'sync', outcome, decisions: ['Use shared interfaces'], notePath: 'notes/meeting.md' }))!;
    expect(completed.kind).toBe(`meeting-${outcome}`);
    expect(completed.text).toBe('Use shared interfaces');
    expect(JSON.stringify(completed)).not.toContain('notes/meeting.md');
  }
});
