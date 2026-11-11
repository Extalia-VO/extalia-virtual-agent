import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { mergeEvents, projectActivity, projectTranscript, type ToolItem, type UsageItem, type WorkerItem } from '../src/chat/transcript';
import { TranscriptView } from '../src/chat/TranscriptView';
import { MESSAGES, type Language } from '../src/i18n';

function session() {
  let n = 0;
  const event = (body: EventBody, agentId = 'primary'): ExtaliaEvent =>
    createEvent({ id: `e${++n}`, sessionId: 's1', agentId, source: { runtime: 'test', channel: 'stream' }, body }, () => new Date(Date.UTC(2026, 0, 31, 9, 0, n)));
  return event;
}

describe('rendered turn usage', () => {
  for (const language of ['en', 'id'] as const) it(`explains a local context refusal in ${language} without exposing the internal code`, () => {
    const html = renderToStaticMarkup(createElement(TranscriptView, {
      t: MESSAGES[language], language, items: [{ kind: 'notice', id: 'held', reason: 'failed', text: 'native_context_limit' }], onDecide: async () => undefined,
    }));
    expect(html).toContain(MESSAGES[language].context.requestHeld);
    expect(html).not.toContain('native_context_limit');
  });
  const renderUsage = (item: Omit<UsageItem, 'kind' | 'id'>, language: Language = 'en') => renderToStaticMarkup(createElement(TranscriptView, {
    t: MESSAGES[language], language, items: [{ kind: 'usage', id: 'usage', ...item }], onDecide: async () => undefined,
  }));

  it('shows reported cache counts, including zero, without changing input or deriving a percentage', () => {
    for (const cachedInputTokens of [0, 800]) {
      const html = renderUsage({ usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens } });
      expect(html).toContain(`100 in · 20 out · ${cachedInputTokens} cached input (reported)`);
      expect(html).not.toContain('%');
      expect(html).not.toContain('900 in');
    }
  });

  it('keeps genuinely reported input and output zeros', () => {
    expect(renderUsage({ usage: { inputTokens: 0, outputTokens: 0 } })).toContain('0 in · 0 out');
  });

  it('marks missing input or output explicitly instead of fabricating zero', () => {
    const inputOnly = renderUsage({ usage: { inputTokens: 50 } });
    expect(inputOnly).toContain('50 in · Output not reported');
    expect(inputOnly).not.toContain('0 out');
    const outputOnly = renderUsage({ usage: { outputTokens: 25 } });
    expect(outputOnly).toContain('Input not reported · 25 out');
    expect(outputOnly).not.toContain('0 in');
    const cacheOnly = renderUsage({ usage: { cachedInputTokens: 0 } });
    expect(cacheOnly).toContain('Input not reported · Output not reported · 0 cached input (reported)');
  });

  it('keeps cache-less historical records unchanged and leaves unreported cache absent', () => {
    const html = renderUsage({ usage: { inputTokens: 100, outputTokens: 20 }, model: 'example-model', costUsd: 0.02 });
    expect(html).toContain('100 in · 20 out · $0.0200 · example-model');
    expect(html).not.toContain('cache');
  });

  it('does not add unknown-token clutter when all usage is absent', () => {
    for (const usage of [undefined, {}]) {
      const html = renderUsage({ usage, model: 'example-model' });
      expect(html).toContain('>example-model</p>');
      expect(html).not.toContain('not reported');
      expect(html).not.toContain('0 in');
      expect(html).not.toContain('cache');
    }
  });

  it('renders partial and cached reports in Indonesian with locale formatting', () => {
    const html = renderUsage({ usage: { outputTokens: 2000, cachedInputTokens: 1000 } }, 'id');
    expect(html).toContain('Input tidak dilaporkan · 2.000 keluar · 1.000 input cache (dilaporkan)');
    expect(html).not.toContain('0 masuk');
  });

  it('renders historical provider totals exactly as stored through the event projection', () => {
    const event = session();
    const items = projectTranscript([
      event({ type: 'prompt.submitted', text: 'Hello', via: 'extalia' }),
      event({ type: 'model.completed', text: 'Done', usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 100 } }),
      event({ type: 'turn.completed' }),
    ]);
    const html = renderToStaticMarkup(createElement(TranscriptView, { t: MESSAGES.en, language: 'en', items, onDecide: async () => undefined }));
    expect(html).toContain('10 in · 2 out · 100 cached input (reported)');
    expect(html).not.toContain('110 in');
    expect(html).not.toContain('%');
  });
});

describe('projectTranscript', () => {
  it('marks a conversation carried over from another agent and does not treat it as running', () => {
    const event = session();
    const carried = (body: EventBody, n: number): ExtaliaEvent =>
      createEvent({ id: `c${n}`, sessionId: 's1', agentId: 'codex', source: { runtime: 'codex', channel: 'import', adapter: 'continuation' }, body });
    const events = [
      event({ type: 'session.started', control: 'managed', title: 'Fix login' }),
      carried({ type: 'prompt.submitted', text: 'Fix login', via: 'native' }, 1),
      carried({ type: 'model.completed', text: 'Patched auth.ts' }, 2),
      carried({ type: 'prompt.submitted', text: 'Add a test', via: 'native' }, 3),
    ];
    expect(projectTranscript(events).map(item => item.kind === 'handoff' ? `${item.kind}:${item.edge}:${item.runtime}` : item.kind))
      .toEqual(['handoff:start:codex', 'user', 'assistant', 'user', 'handoff:end:codex']);
    expect(projectActivity(events).running).toBe(false);

    const continued = [...events, event({ type: 'prompt.submitted', text: 'Continue', via: 'extalia' }), event({ type: 'model.completed', text: 'Done' })];
    expect(projectTranscript(continued).map(item => item.kind)).toEqual(['handoff', 'user', 'assistant', 'user', 'handoff', 'user', 'assistant']);
    expect(projectActivity(continued).running).toBe(true);
  });

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

  it('attaches a late file report to its completed tool instead of another running tool', () => {
    const event = session();
    const result = projectTranscript([
      event({ type: 'tool.started', toolCallId: 'edit-1', tool: 'Edit', kind: 'edit', label: 'Edit a.ts' }),
      event({ type: 'tool.completed', toolCallId: 'edit-1', tool: 'Edit', kind: 'edit', label: 'Edit a.ts', ok: true }),
      event({ type: 'tool.started', toolCallId: 'edit-2', tool: 'Edit', kind: 'edit', label: 'Edit b.ts' }),
      event({ type: 'file.written', path: 'src/a.ts', change: 'update', toolCallId: 'edit-1' }),
    ]).filter((item): item is ToolItem => item.kind === 'tool');
    expect(result[0]?.files).toEqual([{ path: 'src/a.ts', change: 'update' }]);
    expect(result[1]?.files).toEqual([]);
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

  it('keeps approvals, tools and workers live when a user steers the current run', () => {
    const event = session();
    const events = [
      event({ type: 'prompt.submitted', text: 'Review the change', via: 'extalia' }),
      event({ type: 'tool.started', toolCallId: 'delegate', tool: 'delegate_task', kind: 'delegate', label: 'Review together' }),
      event({ type: 'subagent.spawned', subagentId: 'worker', role: 'reviewer', label: 'Review member' }),
      event({ type: 'approval.requested', approvalId: 'approval', action: 'Edit example.ts', risk: 'medium' }),
      event({ type: 'user.intervention', action: 'steer', text: 'Also preserve the existing API' }),
    ];
    const items = projectTranscript(events);
    expect(items.filter(item => item.kind === 'user').map(item => item.text)).toEqual(['Review the change', 'Also preserve the existing API']);
    expect(items.find(item => item.kind === 'approval')).toMatchObject({ status: 'pending' });
    expect(items.find(item => item.kind === 'tool')).toMatchObject({ status: 'running' });
    expect(items.find(item => item.kind === 'worker')).toMatchObject({ status: 'running' });
    expect(projectActivity(events)).toMatchObject({ running: true, state: 'waiting', stopping: false, pendingApprovalId: 'approval' });
    const completed = projectTranscript([...events,
      event({ type: 'approval.resolved', approvalId: 'approval', decision: 'granted', by: 'user' }),
      event({ type: 'tool.completed', toolCallId: 'delegate', tool: 'delegate_task', kind: 'delegate', label: 'Review together', ok: true }),
      event({ type: 'turn.completed' }),
    ]);
    expect(completed.find(item => item.kind === 'approval')).toMatchObject({ status: 'granted' });
    expect(completed.find(item => item.kind === 'tool')).toMatchObject({ status: 'ok' });
    expect(completed.find(item => item.kind === 'worker')).toMatchObject({ status: 'ok' });
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

  it('places a late transcript reply before newer hook events, like reloaded history', () => {
    const at = (second: number) => `2026-11-10T00:00:${String(second).padStart(2, '0')}.000Z`;
    const make = (id: string, second: number, body: EventBody) => createEvent({ id, at: at(second), sessionId: 's', source: { runtime: 'antigravity', channel: 'hook' }, body });
    const tool = make('tool', 5, { type: 'tool.started', toolCallId: 'c1', tool: 'run_command', kind: 'command', label: 'Run command' });
    const reply = make('reply', 3, { type: 'model.completed', text: 'Checking models' });
    expect(mergeEvents([tool], [reply]).map(item => item.id)).toEqual(['reply', 'tool']);
  });
});
