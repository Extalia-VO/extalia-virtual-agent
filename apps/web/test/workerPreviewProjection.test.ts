import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { projectActivity, projectTranscript, type WorkerItem } from '../src/chat/transcript';

function fixture() {
  let n = 0;
  return (body: EventBody, agentId = 'primary'): ExtaliaEvent => createEvent({
    id: `preview-${++n}`, sessionId: 'example-session', agentId,
    source: { runtime: 'native', channel: 'stream' }, body,
  });
}
const workers = (events: ExtaliaEvent[]) => projectTranscript(events).filter((item): item is WorkerItem => item.kind === 'worker');

describe('worker transcript previews', () => {
  it('keeps interleaved tools, streamed findings and commands inside the assigned worker', () => {
    const e = fixture();
    const events = [e({ type: 'prompt.submitted', text: 'Review the project', via: 'extalia' }),
      e({ type: 'subagent.spawned', subagentId: 'reviewer', label: 'Reviewer' }),
      e({ type: 'subagent.state', subagentId: 'reviewer', state: 'working', summary: 'Inspect the tests' }),
      e({ type: 'model.delta', text: 'Lead continues' }),
      e({ type: 'model.delta', text: 'Checking coverage' }, 'reviewer'),
      e({ type: 'tool.started', toolCallId: 'read', tool: 'read_file', kind: 'read', label: 'Read tests' }, 'reviewer'),
      e({ type: 'tool.output', toolCallId: 'read', text: 'Partial result' }, 'reviewer'),
      e({ type: 'tool.completed', toolCallId: 'read', tool: 'read_file', kind: 'read', label: 'Read tests', ok: true, output: 'Actual file' }, 'reviewer'),
      e({ type: 'command.started', commandId: 'test', command: 'pnpm test' }, 'reviewer'),
      e({ type: 'command.output', commandId: 'test', stream: 'stdout', text: 'Passed' }, 'reviewer'),
      e({ type: 'command.completed', commandId: 'test', exitCode: 0 }, 'reviewer'),
      e({ type: 'model.completed', text: 'Coverage is complete', model: 'worker-model' }, 'reviewer'),
      e({ type: 'subagent.state', subagentId: 'reviewer', state: 'idle', summary: 'Done' })];
    const before = JSON.stringify(events);
    const lead = projectTranscript(events);
    expect(lead.filter(item => item.kind === 'assistant')).toMatchObject([{ text: 'Lead continues' }]);
    const [worker] = workers(events);
    expect(worker).toMatchObject({ task: 'Inspect the tests', summary: 'Done', toolCalls: 1 });
    expect(worker!.preview).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', output: 'Actual file', status: 'ok' }),
      expect.objectContaining({ kind: 'tool', command: expect.objectContaining({ command: 'pnpm test', exitCode: 0, output: [{ stream: 'stdout', text: 'Passed' }] }) }),
      expect.objectContaining({ kind: 'assistant', text: 'Coverage is complete', streaming: false }),
    ]));
    expect(JSON.stringify(events)).toBe(before);
  });

  it('preserves an active invocation across model announcements and fallback without duplicate cards', () => {
    const e = fixture();
    const events = [e({ type: 'subagent.spawned', subagentId: 'member', label: 'Reviewer' }),
      e({ type: 'subagent.state', subagentId: 'member', state: 'working', summary: 'Review implementation' }),
      e({ type: 'subagent.spawned', subagentId: 'member', label: 'Reviewer', model: 'first-model' }),
      e({ type: 'model.completed', text: 'First finding' }, 'member'),
      e({ type: 'subagent.spawned', subagentId: 'member', label: 'Reviewer', model: 'backup-model' }),
      e({ type: 'subagent.state', subagentId: 'member', state: 'working', summary: 'Using backup model' })];
    expect(workers(events)).toHaveLength(1);
    expect(workers(events)[0]).toMatchObject({ id: events[0]!.id, task: 'Review implementation', preview: [expect.objectContaining({ text: 'First finding' })] });
  });

  it('isolates repeated tasks for a stable member and deduplicates replayed events', () => {
    const e = fixture();
    const old = e({ type: 'model.completed', text: 'Previous result' }, 'member');
    const recent = e({ type: 'model.delta', text: 'New result' }, 'member');
    const events = [e({ type: 'subagent.spawned', subagentId: 'member' }), old, old,
      e({ type: 'subagent.state', subagentId: 'member', state: 'idle' }),
      e({ type: 'subagent.spawned', subagentId: 'member' }), recent, recent];
    const [first, second] = workers(events);
    expect(first!.preview).toMatchObject([{ text: 'Previous result', streaming: false }]);
    expect(second!.preview).toMatchObject([{ text: 'New result', streaming: true }]);
  });

  it('never mixes sibling activity or changes the lead activity/approval state', () => {
    const e = fixture();
    const lead = [e({ type: 'prompt.submitted', text: 'Delegate', via: 'extalia' }), e({ type: 'agent.state', state: 'working', activity: 'delegate' })];
    const events = [...lead, e({ type: 'subagent.spawned', subagentId: 'one' }), e({ type: 'subagent.spawned', subagentId: 'two' }),
      e({ type: 'model.completed', text: 'One' }, 'one'), e({ type: 'model.completed', text: 'Two' }, 'two'),
      e({ type: 'approval.requested', approvalId: 'worker-approval', action: 'Edit file' }, 'one')];
    expect(projectActivity(events)).toEqual(projectActivity(lead));
    const [one, two] = workers(events);
    expect(one!.preview).toMatchObject([{ text: 'One' }, { kind: 'approval', approvalId: 'worker-approval' }]);
    expect(two!.preview).toMatchObject([{ text: 'Two' }]);
    expect(projectTranscript(events).some(item => item.kind === 'approval')).toBe(false);
  });

  it('settles unfinished preview activity when the actual lead turn stops', () => {
    const e = fixture();
    const events = [e({ type: 'subagent.spawned', subagentId: 'member' }),
      e({ type: 'model.delta', text: 'Partial' }, 'member'),
      e({ type: 'tool.started', toolCallId: 'read', tool: 'read_file', kind: 'read', label: 'Read' }, 'member'),
      e({ type: 'turn.failed', error: 'Cancelled' })];
    expect(workers(events)[0]).toMatchObject({ status: 'stopped', preview: [
      expect.objectContaining({ kind: 'assistant', streaming: false }), expect.objectContaining({ kind: 'tool', status: 'stopped' }),
    ] });
  });

  it('shows actual worker errors without marking the lead failed or a failed worker successful', () => {
    const e = fixture();
    const lead = [e({ type: 'prompt.submitted', text: 'Review', via: 'extalia' })];
    const events = [...lead, e({ type: 'subagent.spawned', subagentId: 'member' }),
      e({ type: 'agent.error', message: 'The worker request failed' }, 'member'),
      e({ type: 'subagent.state', subagentId: 'member', state: 'idle' })];
    expect(workers(events)[0]).toMatchObject({ status: 'failed', preview: [expect.objectContaining({ kind: 'notice', text: 'The worker request failed' })] });
    expect(projectActivity(events)).toEqual(projectActivity(lead));
    expect(projectTranscript(events).some(item => item.kind === 'notice')).toBe(false);
  });

  it('keeps a recovered worker successful while preserving its earlier error in the preview', () => {
    const e = fixture();
    const events = [e({ type: 'subagent.spawned', subagentId: 'member' }),
      e({ type: 'agent.error', message: 'Retrying a read', recoverable: true }, 'member'),
      e({ type: 'model.completed', text: 'The retry succeeded' }, 'member'),
      e({ type: 'subagent.state', subagentId: 'member', state: 'idle' })];
    expect(workers(events)[0]).toMatchObject({ status: 'ok', preview: [
      expect.objectContaining({ kind: 'notice', text: 'Retrying a read' }), expect.objectContaining({ text: 'The retry succeeded' }),
    ] });
  });

  it('retains historical file boundaries within the worker preview after project moves', () => {
    const e = fixture();
    const source = e({ type: 'model.completed', text: '[Source](src/example.ts)' }, 'member');
    const events = [e({ type: 'subagent.spawned', subagentId: 'member' }), source];
    const scope = { workspaceId: 'old-workspace', projectLocation: '/example/old-project' };
    const items = projectTranscript(events, new Map([[source.id, scope]]));
    expect((items[0] as WorkerItem).preview![0]).toMatchObject({ fileScope: scope });
  });
});
