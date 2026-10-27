import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { characterTimeline, formatDuration, shortcutFor, teamRoster } from '../src/office/console/timeline';

let n = 0;
const event = (body: EventBody, agentId = 'primary', second = ++n): ExtaliaEvent =>
  createEvent({ id: `e${n}`, sessionId: 's1', agentId, source: { runtime: 'test', channel: 'stream' }, body }, () => new Date(Date.UTC(2026, 9, 9, 10, 0, second)));
const lead = { sessionId: 's1', agentId: 'primary', control: 'managed' as const };

describe('character console timeline', () => {
  const events = [
    event({ type: 'prompt.submitted', text: 'Add tests', via: 'extalia' }),
    event({ type: 'tool.started', toolCallId: 'c1', tool: 'read_file', kind: 'read', label: 'Reading', target: 'a.ts' }),
    event({ type: 'tool.completed', toolCallId: 'c1', tool: 'read_file', kind: 'read', label: 'Reading', ok: true }),
    event({ type: 'subagent.spawned', subagentId: 'w1', label: 'Review tests' }),
    event({ type: 'tool.started', toolCallId: 'w-c1', tool: 'search', kind: 'search', label: 'Searching' }, 'w1'),
    event({ type: 'subagent.state', subagentId: 'w1', state: 'idle' }),
    event({ type: 'approval.requested', approvalId: 'a1', action: 'Write file', detail: 'test/a.test.ts' }),
    event({ type: 'approval.resolved', approvalId: 'a1', decision: 'granted', by: 'user' }),
    event({ type: 'tool.started', toolCallId: 'c2', tool: 'run_command', kind: 'command', label: 'Running', target: 'npm test' }),
    event({ type: 'turn.completed', usage: { inputTokens: 1200, outputTokens: 300 } }),
  ];

  it('pairs steps with their results and keeps worker steps out of the lead’s timeline', () => {
    const entries = characterTimeline(events, lead);
    expect(entries.map(entry => entry.kind)).toEqual(['prompt', 'tool', 'delegated', 'approval', 'tool', 'turn']);
    expect(entries[1]).toMatchObject({ label: 'Reading a.ts', status: 'ok', durationMs: 1000 });
    expect(entries[2]).toMatchObject({ label: 'Review tests', workerId: 's1:w1' });
    expect(entries[3]).toMatchObject({ action: 'Write file: test/a.test.ts', decision: 'granted' });
    // A step still running when the turn ends is shown as stopped.
    expect(entries[4]).toMatchObject({ label: 'Running npm test', status: 'stopped' });
    expect(entries[5]).toMatchObject({ ok: true, usage: { inputTokens: 1200, outputTokens: 300 }, durationMs: 9000 });
  });

  it('shows a worker only its own steps and lists the lead’s team', () => {
    expect(characterTimeline(events, { ...lead, agentId: 'w1' }).map(entry => entry.kind === 'tool' ? entry.label : entry.kind)).toEqual(['Searching']);
    expect(teamRoster(events, 's1')).toEqual([{ characterId: 's1:w1', label: 'Review tests', state: 'idle' }]);
  });

  it('formats durations and maps shortcuts only when not typing', () => {
    expect([formatDuration(850), formatDuration(12_400), formatDuration(185_000), formatDuration(120_000)]).toEqual(['850 ms', '12 s', '3 min 5 s', '2 min']);
    const none = { alt: false, ctrl: false, meta: false };
    expect(shortcutFor('M', none, false)).toBe('message');
    expect(shortcutFor('l', none, false)).toBe('locate');
    expect(shortcutFor('F', none, false)).toBe('follow');
    expect(shortcutFor('a', none, true)).toBeUndefined();
    expect(shortcutFor('e', { ...none, meta: true }, false)).toBeUndefined();
    expect(shortcutFor('x', none, false)).toBeUndefined();
  });
});
