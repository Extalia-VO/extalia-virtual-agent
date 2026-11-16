import { createEvent, type EventBody, type EventChannel, type ExtaliaEvent } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { projectActivity, projectTranscript, type TranscriptItem, type WorkerItem } from '../src/chat/transcript';

// Sanitized protocol fixtures exercise the shared normalized contract. They do
// not assert that a source parser can recover data its native format omits.
function fixture(runtime = 'codex', channel: EventChannel = 'transcript') {
  let n = 0;
  return (body: EventBody, agentId = 'primary'): ExtaliaEvent => createEvent({
    id: `observed-preview-${++n}`, at: '2026-11-15T00:00:00.000Z',
    sessionId: 'observed-example', agentId, source: { runtime, channel }, body,
  });
}
const children = (items: TranscriptItem[]): WorkerItem[] => items.filter((item): item is WorkerItem => item.kind === 'worker');

describe('observed worker previews', () => {
  it.each(['codex', 'claude-code', 'gemini-cli', 'hermes', 'antigravity'])('projects actual normalized %s child messages and scoped completion', runtime => {
    const e = fixture(runtime);
    const lead = [e({ type: 'session.started', control: 'observed' }),
      e({ type: 'prompt.submitted', text: 'Review the project', via: 'native' }),
      e({ type: 'agent.state', state: 'working', activity: 'delegate', summary: 'Reviewing' })];
    const events = [...lead,
      e({ type: 'subagent.spawned', subagentId: 'reviewer', label: 'Reviewer' }),
      e({ type: 'prompt.submitted', text: 'Inspect the recorded tests', via: 'native' }, 'reviewer'),
      e({ type: 'agent.state', state: 'thinking' }, 'reviewer'),
      e({ type: 'agent.state', state: 'working', activity: 'read', summary: 'Reading the tests' }, 'reviewer'),
      e({ type: 'model.delta', text: 'Checking' }, 'reviewer'),
      e({ type: 'model.completed', text: 'The tests cover both paths', model: 'example-model' }, 'reviewer'),
      e({ type: 'turn.completed', model: 'example-model', usage: { inputTokens: 40, outputTokens: 12 } }, 'reviewer'),
      e({ type: 'agent.state', state: 'idle' }, 'reviewer')];
    const before = JSON.stringify(events);
    const items = projectTranscript([...events, ...events]);
    expect(items.map(item => item.kind)).toEqual(['user', 'worker']);
    expect(children(items)[0]).toMatchObject({ task: 'Inspect the recorded tests', status: 'ok', state: 'idle', activity: 'Reading the tests', preview: [
      { kind: 'user', text: 'Inspect the recorded tests' },
      { kind: 'assistant', text: 'The tests cover both paths', streaming: false },
      { kind: 'usage', usage: { inputTokens: 40, outputTokens: 12 }, model: 'example-model' },
    ] });
    expect(projectActivity(events)).toEqual(projectActivity(lead));
    expect(JSON.stringify(events)).toBe(before);
  });

  it('keeps sibling tools, commands, approvals, errors and file scopes separate even with shared call ids', () => {
    const e = fixture('claude-code', 'hook');
    const read = (agent: string, text: string) => [
      e({ type: 'tool.started', toolCallId: 'same-call', tool: 'read_file', kind: 'read', label: `Read ${agent}` }, agent),
      e({ type: 'tool.output', toolCallId: 'same-call', text }, agent),
      e({ type: 'tool.completed', toolCallId: 'same-call', tool: 'read_file', kind: 'read', label: `Read ${agent}`, ok: true, output: `${text} complete` }, agent),
    ];
    const scoped = e({ type: 'model.completed', text: '[Source](src/example.ts)' }, 'one');
    const scope = { workspaceId: 'previous-workspace', projectLocation: '/example/previous-project' };
    const events = [e({ type: 'prompt.submitted', text: 'Inspect', via: 'native' }),
      e({ type: 'subagent.spawned', subagentId: 'one' }), e({ type: 'subagent.spawned', subagentId: 'two' }),
      ...read('primary', 'Lead output'), ...read('one', 'First output'), ...read('two', 'Second output'),
      e({ type: 'command.started', commandId: 'check', command: 'pnpm test' }, 'one'),
      e({ type: 'command.output', commandId: 'check', stream: 'stdout', text: 'Started\n' }, 'one'),
      e({ type: 'command.output', commandId: 'check', stream: 'stderr', text: 'Recorded warning\n' }, 'one'),
      e({ type: 'command.completed', commandId: 'check', exitCode: 1, durationMs: 20 }, 'one'),
      e({ type: 'approval.requested', approvalId: 'child-approval', action: 'Inspect a protected file' }, 'one'),
      e({ type: 'agent.error', message: 'Recorded child error' }, 'one'), scoped,
      e({ type: 'turn.failed', error: 'Child failed' }, 'one'),
      e({ type: 'agent.state', state: 'idle', phase: 'error' }, 'one'),
      e({ type: 'model.delta', text: 'Second is still checking' }, 'two')];
    const items = projectTranscript(events, new Map([[scoped.id, scope]]));
    const [one, two] = children(items);
    expect(one).toMatchObject({ status: 'failed', preview: expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', output: 'First output complete' }),
      expect.objectContaining({ kind: 'tool', status: 'failed', command: { command: 'pnpm test', exitCode: 1, durationMs: 20, output: [{ stream: 'stdout', text: 'Started\n' }, { stream: 'stderr', text: 'Recorded warning\n' }] } }),
      expect.objectContaining({ kind: 'approval', approvalId: 'child-approval', status: 'expired' }),
      expect.objectContaining({ kind: 'notice', text: 'Recorded child error' }),
      expect.objectContaining({ kind: 'notice', text: 'Child failed' }),
      expect.objectContaining({ kind: 'assistant', fileScope: scope }),
    ]) });
    expect(two).toMatchObject({ status: 'running', preview: [
      { kind: 'tool', output: 'Second output complete' }, { kind: 'assistant', text: 'Second is still checking', streaming: true },
    ] });
    expect(items.filter(item => item.kind === 'tool')).toMatchObject([{ output: 'Lead output complete' }]);
    expect(items.some(item => item.kind === 'notice' || item.kind === 'approval')).toBe(false);
    expect(projectActivity(events).running).toBe(true);
    expect(projectActivity(events).pendingApprovalId).toBeUndefined();
  });

  it('keeps nested descendants in their parent preview with actual child lifecycle wrappers', () => {
    const e = fixture();
    const events = [e({ type: 'prompt.submitted', text: 'Delegate', via: 'native' }),
      e({ type: 'subagent.spawned', subagentId: 'parent' }),
      e({ type: 'subagent.spawned', subagentId: 'sibling' }),
      e({ type: 'prompt.submitted', text: 'Review the source', via: 'native' }, 'parent'),
      e({ type: 'subagent.spawned', subagentId: 'grandchild', label: 'Nested review' }, 'parent'),
      e({ type: 'subagent.state', subagentId: 'grandchild', state: 'working', summary: 'Inspect nested scope' }, 'parent'),
      e({ type: 'model.completed', text: 'Nested finding' }, 'grandchild'),
      e({ type: 'turn.completed' }, 'grandchild'),
      e({ type: 'subagent.state', subagentId: 'grandchild', state: 'idle', summary: 'Nested done' }, 'parent'),
      e({ type: 'model.completed', text: 'Sibling finding' }, 'sibling'),
      e({ type: 'model.completed', text: 'Parent finding' }, 'parent')];
    const items = projectTranscript(events);
    const [parent, sibling] = children(items);
    expect(children(items)).toHaveLength(2);
    expect(parent!.preview).toMatchObject([{ kind: 'user', text: 'Review the source' },
      { kind: 'worker', subagentId: 'grandchild', task: 'Inspect nested scope', status: 'ok', summary: 'Nested done', preview: [{ kind: 'assistant', text: 'Nested finding' }] },
      { kind: 'assistant', text: 'Parent finding' }]);
    expect(sibling!.preview).toMatchObject([{ text: 'Sibling finding' }]);
    expect(projectActivity(events)).toMatchObject({ running: true });
  });

  it('retains nested historical file boundaries and image metadata without moving child content to the lead', () => {
    const e = fixture();
    const file = e({ type: 'file.written', path: 'src/example.ts', change: 'update' }, 'grandchild');
    const reply = e({ type: 'model.completed', text: '[Source](src/example.ts)' }, 'grandchild');
    const image = { name: 'result.png', kind: 'image' as const, size: 100, ref: 'a'.repeat(64) };
    const events = [e({ type: 'subagent.spawned', subagentId: 'parent' }),
      e({ type: 'subagent.spawned', subagentId: 'grandchild' }, 'parent'), file, reply,
      e({ type: 'tool.completed', tool: 'view_image', kind: 'read', label: 'View result', ok: true, attachments: [image, image] }, 'grandchild')];
    const scope = { workspaceId: 'previous-workspace', projectLocation: '/example/previous-project' };
    const items = projectTranscript(events, new Map([[file.id, scope], [reply.id, null]]));
    const parent = children(items)[0]!;
    const grandchild = children(parent.preview!)[0]!;
    expect(grandchild.attachments).toEqual([image]);
    expect(grandchild.preview).toMatchObject([
      { kind: 'files', files: [{ path: '/example/previous-project/src/example.ts', change: 'update' }], fileScope: scope },
      { kind: 'assistant', fileScope: null }, { kind: 'tool', attachments: [image, image] },
    ]);
    expect(parent.attachments).toBeUndefined();
    expect(items.map(item => item.kind)).toEqual(['worker']);
  });

  it('preserves model announcements but starts a fresh preview for a settled stable-id invocation', () => {
    const e = fixture();
    const events = [e({ type: 'subagent.spawned', subagentId: 'member', model: 'first-model' }),
      e({ type: 'prompt.submitted', text: 'First assignment', via: 'native' }, 'member'),
      e({ type: 'subagent.spawned', subagentId: 'member', model: 'backup-model', label: 'Reviewer' }),
      e({ type: 'model.completed', text: 'First result' }, 'member'), e({ type: 'turn.completed' }, 'member'),
      e({ type: 'subagent.spawned', subagentId: 'member' }),
      e({ type: 'prompt.submitted', text: 'Second assignment', via: 'native' }, 'member'),
      e({ type: 'model.delta', text: 'Second result' }, 'member')];
    const [first, second] = children(projectTranscript(events));
    expect(first).toMatchObject({ id: events[0]!.id, task: 'First assignment', label: 'Reviewer', status: 'ok', preview: [{ text: 'First assignment' }, { text: 'First result' }] });
    expect(second).toMatchObject({ id: events[5]!.id, task: 'Second assignment', status: 'running', preview: [{ text: 'Second assignment' }, { text: 'Second result', streaming: true }] });
  });

  it('keeps repeated nested Native invocations separate when both stable member ids are reused', () => {
    const e = fixture('native', 'stream');
    const events = [e({ type: 'subagent.spawned', subagentId: 'parent' }),
      e({ type: 'subagent.spawned', subagentId: 'nested' }, 'parent'),
      e({ type: 'model.completed', text: 'First nested result' }, 'nested'),
      e({ type: 'subagent.state', subagentId: 'nested', state: 'idle' }, 'parent'),
      e({ type: 'subagent.state', subagentId: 'parent', state: 'idle' }),
      e({ type: 'subagent.spawned', subagentId: 'parent' }),
      e({ type: 'subagent.spawned', subagentId: 'nested' }, 'parent'),
      e({ type: 'model.delta', text: 'Second nested result' }, 'nested')];
    const [first, second] = children(projectTranscript(events));
    expect(children(first!.preview!)[0]).toMatchObject({ status: 'ok', preview: [{ text: 'First nested result' }] });
    expect(children(second!.preview!)[0]).toMatchObject({ status: 'running', preview: [{ text: 'Second nested result' }] });
  });

  it('does not cancel independent observed children on lead idle, completion or a new lead prompt', () => {
    const e = fixture();
    const events = [e({ type: 'session.started', control: 'observed' }),
      e({ type: 'prompt.submitted', text: 'Delegate', via: 'native' }), e({ type: 'subagent.spawned', subagentId: 'member' }),
      e({ type: 'subagent.spawned', subagentId: 'nested' }, 'member'),
      e({ type: 'model.delta', text: 'Still checking' }, 'nested'),
      e({ type: 'agent.state', state: 'idle' }), e({ type: 'turn.completed' }),
      e({ type: 'prompt.submitted', text: 'Follow-up', via: 'native' })];
    const member = children(projectTranscript(events))[0]!;
    expect(member.status).toBe('running');
    expect(children(member.preview!)[0]).toMatchObject({ status: 'running', preview: [{ text: 'Still checking', streaming: true }] });
    const ended = children(projectTranscript([...events, e({ type: 'session.ended' })]))[0]!;
    expect(ended.status).toBe('stopped');
    expect(children(ended.preview!)[0]).toMatchObject({ status: 'stopped', preview: [{ text: 'Still checking', streaming: false }] });
  });

  it('ends active descendants at session closure even after their immediate parent finished', () => {
    const e = fixture();
    const events = [e({ type: 'subagent.spawned', subagentId: 'parent' }),
      e({ type: 'subagent.spawned', subagentId: 'grandchild' }, 'parent'),
      e({ type: 'model.delta', text: 'Nested work continues' }, 'grandchild'),
      e({ type: 'turn.completed' }, 'parent'), e({ type: 'turn.completed' })];
    const live = children(projectTranscript(events))[0]!;
    expect(live.status).toBe('ok');
    expect(children(live.preview!)[0]!.status).toBe('running');
    const ended = children(projectTranscript([...events, e({ type: 'session.ended' })]))[0]!;
    expect(ended.status).toBe('ok');
    expect(children(ended.preview!)[0]).toMatchObject({ status: 'stopped', preview: [{ streaming: false }] });
  });

  it('reopens an observed child thread on its own later prompt while retaining its recorded history', () => {
    const e = fixture();
    const items = projectTranscript([e({ type: 'subagent.spawned', subagentId: 'member' }),
      e({ type: 'agent.state', state: 'working', summary: 'Generic activity' }, 'member'),
      e({ type: 'prompt.submitted', text: 'First actual assignment', via: 'native' }, 'member'),
      e({ type: 'model.completed', text: 'First result' }, 'member'), e({ type: 'turn.completed' }, 'member'),
      e({ type: 'prompt.submitted', text: 'Follow-up assignment', via: 'native' }, 'member'),
      e({ type: 'model.delta', text: 'Follow-up result' }, 'member')]);
    expect(children(items)).toHaveLength(1);
    expect(children(items)[0]).toMatchObject({ task: 'First actual assignment', status: 'running', state: 'thinking', preview: [
      { text: 'First actual assignment' }, { text: 'First result', streaming: false },
      { text: 'Follow-up assignment' }, { text: 'Follow-up result', streaming: true },
    ] });
  });

  it('keeps observed children active when the spawning delegate merely returns their id', () => {
    const e = fixture();
    const items = projectTranscript([e({ type: 'tool.started', toolCallId: 'spawn', tool: 'spawn_agent', kind: 'delegate', label: 'Spawn reviewer' }),
      e({ type: 'subagent.spawned', subagentId: 'member' }),
      e({ type: 'tool.completed', toolCallId: 'spawn', tool: 'spawn_agent', kind: 'delegate', label: 'Spawn reviewer', ok: true, output: 'member' }),
      e({ type: 'model.delta', text: 'Still reviewing' }, 'member')]);
    expect(children(items)[0]).toMatchObject({ status: 'running', preview: [{ text: 'Still reviewing', streaming: true }] });
  });

  it.each([
    [{ type: 'turn.failed', error: 'Cancelled', reason: 'interrupted' }, 'stopped', 'idle'],
    [{ type: 'agent.state', state: 'idle', phase: 'interrupted' }, 'stopped', 'idle'],
    [{ type: 'agent.state', state: 'idle', phase: 'error' }, 'failed', 'idle'],
    [{ type: 'session.ended' }, 'ok', 'offline'],
    [{ type: 'agent.stopped' }, 'stopped', 'offline'],
  ] as const)('settles only the child for %j', (body, status, state) => {
    const e = fixture();
    const events = [e({ type: 'prompt.submitted', text: 'Delegate', via: 'native' }),
      e({ type: 'subagent.spawned', subagentId: 'member' }), e({ type: 'subagent.spawned', subagentId: 'sibling' }),
      e({ type: 'model.delta', text: 'Partial result' }, 'member'), e(body, 'member')];
    const [member, sibling] = children(projectTranscript(events));
    expect(member).toMatchObject({ status, state, preview: expect.arrayContaining([expect.objectContaining({ text: 'Partial result', streaming: false })]) });
    expect(sibling!.status).toBe('running');
    expect(projectActivity(events)).toMatchObject({ running: true });
  });

  it('ignores malformed self and ancestor spawns and routes a deep hierarchy without recursive replay', () => {
    const e = fixture();
    const events = [e({ type: 'prompt.submitted', text: 'Delegate', via: 'native' }, 'lead'),
      e({ type: 'subagent.spawned', subagentId: 'member' }, 'lead'),
      e({ type: 'subagent.spawned', subagentId: 'member' }, 'member'),
      e({ type: 'subagent.spawned', subagentId: 'lead' }, 'member')];
    const depth = 2_000;
    for (let n = 0; n < depth; n++) events.push(e({ type: 'subagent.spawned', subagentId: `nested-${n}` }, n ? `nested-${n - 1}` : 'member'));
    events.push(e({ type: 'subagent.spawned', subagentId: 'member' }, `nested-${depth - 1}`),
      e({ type: 'model.completed', text: 'Deep finding' }, `nested-${depth - 1}`),
      e({ type: 'model.completed', text: 'Lead finding' }, 'lead'));
    const items = projectTranscript(events);
    expect(items.map(item => item.kind)).toEqual(['user', 'worker', 'assistant']);
    let nested = children(items)[0]!;
    for (let n = 0; n < depth; n++) {
      expect(children(nested.preview!)).toHaveLength(1);
      nested = children(nested.preview!)[0]!;
    }
    expect(nested.preview).toMatchObject([{ text: 'Deep finding' }]);
    expect(projectActivity(events)).toMatchObject({ running: true });
  });
});
