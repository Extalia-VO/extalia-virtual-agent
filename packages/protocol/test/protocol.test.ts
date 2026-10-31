import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, PROTOCOL_VERSION, createEvent, isUtcTimestamp, parseEvent, parseEventLines } from '../src/index.js';

const base = {
  v: PROTOCOL_VERSION,
  id: 'evt-1',
  at: '2026-01-31T12:00:00.000Z',
  sessionId: 'session-1',
  source: { runtime: 'demo', channel: 'stream' },
};

describe('parseEvent', () => {
  it('accepts optional bounded approval choice metadata and legacy events', () => {
    const body = { type: 'approval.resolved', approvalId: 'a1', decision: 'granted', by: 'user' };
    expect(parseEvent({ ...base, body }).ok).toBe(true);
    for (const choice of ['once', 'session', 'reject']) expect(parseEvent({ ...base, body: { ...body, choice } }).ok).toBe(true);
    expect(parseEvent({ ...base, body: { ...body, choice: 'always' } }).ok).toBe(false);
  });
  it('accepts a minimal valid event', () => {
    const result = parseEvent({ ...base, body: { type: 'model.delta', text: 'Hello' } });
    expect(result.ok).toBe(true);
  });

  it('accepts agent events with the agent in the envelope', () => {
    const result = parseEvent({ ...base, agentId: 'primary', body: { type: 'agent.state', state: 'working', activity: 'edit', progress: 0.5 } });
    expect(result).toMatchObject({ ok: true });
  });

  it('requires envelope ids that the event type depends on', () => {
    const agent = parseEvent({ ...base, body: { type: 'agent.state', state: 'idle' } });
    const task = parseEvent({ ...base, body: { type: 'task.progress', progress: 0.2 } });
    expect(agent).toMatchObject({ ok: false, code: 'invalid' });
    expect(task).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('rejects other protocol versions separately from invalid events', () => {
    expect(parseEvent({ ...base, v: 'extalia.v1', body: { type: 'model.thinking' } })).toMatchObject({ ok: false, code: 'unsupported-version' });
  });

  it('reports unknown event types so consumers can skip them', () => {
    expect(parseEvent({ ...base, body: { type: 'office.dance' } })).toMatchObject({ ok: false, code: 'unknown-type' });
  });

  it('rejects runtime-specific fields in the envelope, source and body', () => {
    const envelope = parseEvent({ ...base, nativePayload: {}, body: { type: 'model.thinking' } });
    const source = parseEvent({ ...base, source: { ...base.source, apiKey: 'x' }, body: { type: 'model.thinking' } });
    const body = parseEvent({ ...base, body: { type: 'model.delta', text: 'x', raw: {} } });
    for (const result of [envelope, source, body]) expect(result.ok).toBe(false);
  });

  it('validates field types, enums and ranges', () => {
    const cases = [
      { type: 'agent.state', state: 'dancing' },
      { type: 'task.progress', progress: 2 },
      { type: 'command.completed', exitCode: 1.5 },
      { type: 'meeting.started', meetingId: 'm1', participants: 'everyone' },
      { type: 'model.completed', text: 'x', usage: { inputTokens: -1 } },
    ];
    for (const body of cases) {
      const result = parseEvent({ ...base, agentId: 'a', taskId: 't', body });
      expect(result.ok, body.type).toBe(false);
    }
  });

  it('records whether Extalia controls or only observes a session', () => {
    const observed = parseEvent({ ...base, source: { runtime: 'codex', channel: 'transcript' }, body: { type: 'session.started', control: 'observed' } });
    const missing = parseEvent({ ...base, body: { type: 'session.started' } });
    expect(observed.ok).toBe(true);
    expect(missing.ok).toBe(false);
  });

  it('rejects malformed source identifiers and timestamps', () => {
    expect(parseEvent({ ...base, source: { runtime: 'My Runtime', channel: 'stream' }, body: { type: 'model.thinking' } }).ok).toBe(false);
    expect(parseEvent({ ...base, at: '2026-02-30T00:00:00Z', body: { type: 'model.thinking' } }).ok).toBe(false);
  });
});

describe('isUtcTimestamp', () => {
  it('accepts UTC instants up to millisecond precision', () => {
    expect(isUtcTimestamp('2026-01-31T12:00:00Z')).toBe(true);
    expect(isUtcTimestamp('2026-01-31T12:00:00.5Z')).toBe(true);
    expect(isUtcTimestamp('2026-01-31T12:00:00.000+07:00')).toBe(false);
    expect(isUtcTimestamp('2026-13-01T00:00:00Z')).toBe(false);
  });
});

describe('createEvent', () => {
  it('fills the envelope and validates the result', () => {
    const event = createEvent(
      { sessionId: 's', agentId: 'primary', source: { runtime: 'demo', channel: 'system' }, body: { type: 'agent.created', name: 'Primary' } },
      () => new Date('2026-01-31T12:00:00.000Z'),
    );
    expect(event).toMatchObject({ v: PROTOCOL_VERSION, at: '2026-01-31T12:00:00.000Z' });
    expect(event.id).toBeTruthy();
  });

  it('throws for an invalid event', () => {
    expect(() => createEvent({ sessionId: 's', source: { runtime: 'demo', channel: 'system' }, body: { type: 'agent.created', name: 'No agent id' } })).toThrow(/agentId/);
  });

  it('carries an optional model on subagent.spawned', () => {
    const base = { sessionId: 's', agentId: 'primary', source: { runtime: 'demo', channel: 'transcript' as const } };
    expect(createEvent({ ...base, body: { type: 'subagent.spawned', subagentId: 'a1', label: 'Explore the repo', role: 'explorer', model: 'gpt-5.5' } }).body).toMatchObject({ model: 'gpt-5.5' });
    expect(() => createEvent({ ...base, body: { type: 'subagent.spawned', subagentId: 'a1', model: 42 as unknown as string } })).toThrow();
  });
});

describe('parseEventLines', () => {
  it('reports each JSON line independently and skips blank lines', () => {
    const input = [JSON.stringify({ ...base, body: { type: 'model.thinking' } }), '', '{not json', JSON.stringify({ ...base, body: { type: 'nope' } })].join('\n');
    const results = parseEventLines(input);
    expect(results.map(entry => [entry.line, entry.result.ok])).toEqual([[1, true], [3, false], [4, false]]);
  });
});

it('every event type has validation rules', () => {
  expect(EVENT_TYPES.length).toBeGreaterThanOrEqual(30);
});

describe('classifyTool', () => {
  it('maps native tool names to activity kinds', async () => {
    const { classifyTool } = await import('../src/index.js');
    expect(['Bash', 'exec_command', 'Read', 'Grep', 'apply_patch', 'WebFetch', 'web_search', 'Task', 'update_plan', 'skill_manage', 'skill_view'].map(name => classifyTool(name).kind))
      .toEqual(['command', 'command', 'read', 'search', 'edit', 'web', 'web', 'delegate', 'tool', 'knowledge', 'knowledge']);
  });
});
