import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { mergeEvents, projectActivity, projectTranscript, type ToolItem, type WorkerItem } from '../src/chat/transcript';

function session() {
  let n = 0;
  const event = (body: EventBody, agentId = 'primary'): ExtaliaEvent =>
    createEvent({ id: `e${++n}`, sessionId: 's1', agentId, source: { runtime: 'test', channel: 'stream' }, body }, () => new Date(Date.UTC(2026, 0, 31, 9, 0, n)));
  return event;
}

describe('projectTranscript', () => {
  it('streams deltas and replaces them with the completed text', () => {
    const event = session();
    const streaming = [
      event({ type: 'prompt.submitted', text: 'Hi', via: 'extalia' }),
      event({ type: 'agent.state', state: 'thinking' }),
      event({ type: 'model.delta', text: 'Hel' }),
      event({ type: 'model.delta', text: 'lo wor' }),
    ];
    expect(projectTranscript(streaming)).toMatchObject([
      { kind: 'user', text: 'Hi' },
      { kind: 'assistant', text: 'Hello wor', streaming: true },
    ]);
    const done = [...streaming, event({ type: 'model.completed', text: 'Hello world.', model: 'm1' })];
    const items = projectTranscript(done);
    expect(items[1]).toMatchObject({ kind: 'assistant', text: 'Hello world.', streaming: false, model: 'm1' });
    expect(items).toHaveLength(2);
  });

  it('drops a streamed message whose completed text is empty and never mutates its input', () => {
    const event = session();
    const events = [event({ type: 'prompt.submitted', text: 'x', via: 'extalia' }), event({ type: 'model.delta', text: ' ' }), event({ type: 'model.completed', text: '' })];
    const before = JSON.stringify(events);
    expect(projectTranscript(events).map(item => item.kind)).toEqual(['user']);
    expect(JSON.stringify(events)).toBe(before);
  });

  it('builds tool cards with live command output and changed files', () => {
    const event = session();
    const events = [
      event({ type: 'prompt.submitted', text: 'Run tests', via: 'extalia' }),
      event({ type: 'tool.started', toolCallId: 'c1', tool: 'edit_file', kind: 'edit', label: 'Edit a.ts', target: 'a.ts' }),
      event({ type: 'file.written', path: 'a.ts', change: 'update' }),
      event({ type: 'tool.completed', toolCallId: 'c1', tool: 'edit_file', kind: 'edit', label: 'Edit a.ts', ok: true, output: 'Updated.' }),
      event({ type: 'tool.started', toolCallId: 'c2', tool: 'run_command', kind: 'command', label: 'Run npm test' }),
      event({ type: 'command.started', commandId: 'c2', command: 'npm test' }),
      event({ type: 'command.output', commandId: 'c2', stream: 'stdout', text: 'line 1\n' }),
      event({ type: 'command.output', commandId: 'c2', stream: 'stdout', text: 'line 2\n' }),
      event({ type: 'command.output', commandId: 'c2', stream: 'stderr', text: 'warn\n' }),
    ];
    const running = projectTranscript(events).filter((item): item is ToolItem => item.kind === 'tool');
    expect(running[0]).toMatchObject({ status: 'ok', output: 'Updated.', files: [{ path: 'a.ts', change: 'update' }] });
    expect(running[1]).toMatchObject({ status: 'running', command: { command: 'npm test', output: [{ stream: 'stdout', text: 'line 1\nline 2\n' }, { stream: 'stderr', text: 'warn\n' }] } });

    const finished = projectTranscript([
      ...events,
      event({ type: 'command.completed', commandId: 'c2', exitCode: 1, durationMs: 900 }),
      event({ type: 'tool.completed', toolCallId: 'c2', tool: 'run_command', kind: 'command', label: 'Run npm test', ok: false }),
    ]).filter((item): item is ToolItem => item.kind === 'tool');
    expect(finished[1]).toMatchObject({ status: 'failed', command: { exitCode: 1, durationMs: 900 } });
  });

  it('tracks approvals and expires unanswered ones when the turn ends', () => {
    const event = session();
    const asked = [
      event({ type: 'prompt.submitted', text: 'Edit', via: 'extalia' }),
      event({ type: 'approval.requested', approvalId: 'a1', action: 'Edit a.ts', detail: 'Add a line', risk: 'medium' }),
    ];
    expect(projectTranscript(asked)[1]).toMatchObject({ kind: 'approval', status: 'pending', risk: 'medium' });
    expect(projectActivity(asked)).toMatchObject({ running: true, state: 'waiting', pendingApprovalId: 'a1' });

    const granted = [...asked, event({ type: 'approval.resolved', approvalId: 'a1', decision: 'granted', by: 'user' })];
    expect(projectTranscript(granted)[1]).toMatchObject({ status: 'granted', by: 'user' });
    expect(projectActivity(granted).pendingApprovalId).toBeUndefined();

    const abandoned = [...asked, event({ type: 'turn.failed', error: 'Lost connection.' })];
    expect(projectTranscript(abandoned).slice(1)).toMatchObject([{ kind: 'approval', status: 'expired' }, { kind: 'notice', reason: 'failed', text: 'Lost connection.' }]);
  });

  it('shows a cancellation once and stops running tools', () => {
    const event = session();
    const items = projectTranscript([
      event({ type: 'prompt.submitted', text: 'Go', via: 'extalia' }),
      event({ type: 'tool.started', toolCallId: 'c1', tool: 'run_command', kind: 'command', label: 'Run build' }),
      event({ type: 'user.intervention', action: 'cancel' }),
      event({ type: 'turn.failed', error: 'Cancelled.' }),
      event({ type: 'agent.state', state: 'idle' }),
    ]);
    expect(items.map(item => item.kind)).toEqual(['user', 'tool', 'notice']);
    expect(items[1]).toMatchObject({ status: 'stopped' });
    expect(items[2]).toMatchObject({ reason: 'cancelled' });
  });

  it('separates turns, adds usage per turn and ignores duplicate events', () => {
    const event = session();
    const first = [
      event({ type: 'prompt.submitted', text: 'One', via: 'extalia' }),
      event({ type: 'model.completed', text: 'A', usage: { inputTokens: 10, outputTokens: 2 } }),
      event({ type: 'model.completed', text: 'B', usage: { inputTokens: 5, outputTokens: 1 } }),
      event({ type: 'turn.completed', model: 'm1' }),
    ];
    const second = [
      event({ type: 'prompt.submitted', text: 'Two', via: 'extalia' }),
      event({ type: 'model.delta', text: 'C' }),
      event({ type: 'model.completed', text: 'C!' }),
      event({ type: 'turn.completed', usage: { inputTokens: 7, outputTokens: 3 } }),
    ];
    const items = projectTranscript([...first, ...first, ...second, ...second.slice(1)]);
    expect(items.map(item => item.kind)).toEqual(['user', 'assistant', 'assistant', 'usage', 'user', 'assistant', 'usage']);
    expect(items[3]).toMatchObject({ usage: { inputTokens: 15, outputTokens: 3 }, model: 'm1' });
    expect(items[6]).toMatchObject({ usage: { inputTokens: 7, outputTokens: 3 } });
    expect(projectActivity([...first, ...second])).toMatchObject({ running: false, state: 'idle' });
  });

  it('folds worker agents into one card each, settled by their delegate call', () => {
    const event = session();
    const events = [
      event({ type: 'prompt.submitted', text: 'Review', via: 'extalia' }),
      event({ type: 'tool.started', toolCallId: 'd1', tool: 'delegate_task', kind: 'delegate', label: 'Delegate review' }),
      event({ type: 'subagent.spawned', subagentId: 'w1', role: 'quick', label: 'Review tests' }),
      event({ type: 'subagent.state', subagentId: 'w1', state: 'working' }),
      event({ type: 'agent.state', state: 'working', activity: 'read', target: 'a.ts' }, 'w1'),
      event({ type: 'tool.started', toolCallId: 'w1-c1', tool: 'read_file', kind: 'read', label: 'Read a.ts' }, 'w1'),
      event({ type: 'tool.completed', toolCallId: 'w1-c1', tool: 'read_file', kind: 'read', label: 'Read a.ts', ok: true }, 'w1'),
      event({ type: 'tool.started', toolCallId: 'w1-c2', tool: 'search_files', kind: 'search', label: 'Search "coverage"' }, 'w1'),
    ];
    const running = projectTranscript(events);
    expect(running.map(item => item.kind)).toEqual(['user', 'tool', 'worker']);
    expect(running[2]).toMatchObject({ tier: 'quick', label: 'Review tests', status: 'running', toolCalls: 2, activity: 'Search "coverage"', callId: 'd1' });
    // The status line keeps following the primary agent, not the worker.
    expect(projectActivity(events).activity).toBeUndefined();

    const done = projectTranscript([
      ...events,
      event({ type: 'subagent.state', subagentId: 'w1', state: 'idle', summary: 'No issues.' }),
      event({ type: 'tool.completed', toolCallId: 'd1', tool: 'delegate_task', kind: 'delegate', label: 'Delegate review', ok: true }),
    ]);
    expect(done[1]).toMatchObject({ kind: 'tool', status: 'ok' });
    expect(done[2] as WorkerItem).toMatchObject({ status: 'ok', summary: 'No issues.' });

    const failed = projectTranscript([...events, event({ type: 'tool.completed', toolCallId: 'd1', tool: 'delegate_task', kind: 'delegate', label: 'Delegate review', ok: false })]);
    expect(failed[2]).toMatchObject({ status: 'failed' });
  });
});

describe('mergeEvents', () => {
  it('appends only unknown events and keeps the original array when nothing is new', () => {
    const event = session();
    const a = event({ type: 'model.delta', text: 'a' }), b = event({ type: 'model.delta', text: 'b' });
    const merged = mergeEvents([a], [a, b, b]);
    expect(merged.map(item => item.id)).toEqual([a.id, b.id]);
    expect(mergeEvents(merged, [a, b])).toBe(merged);
  });
});
