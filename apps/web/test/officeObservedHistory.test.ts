import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@extalia/platform';
import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { activityFromEvent } from '../src/office/activityFeed';
import { officeHistoryIds } from '../src/office/historyIds';
import { projectOfficePresence, subagentLingerMs } from '../src/office/presence';

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id, workspaceId: 'ws', connectionId: 'c', title: id, control: 'managed', createdAt: '2026-10-09T00:00:00.000Z', lastActiveAt: '2026-10-09T00:00:00.000Z', running: false, ...overrides };
}
const observed = (id: string, minute: number, status: 'watching' | 'paused' | 'unavailable' = 'watching', watching = status === 'watching'): SessionSummary =>
  summary(id, { control: 'observed', workspaceId: '', lastActiveAt: `2026-10-09T00:${String(minute).padStart(2, '0')}:00.000Z`, observation: { sourceId: 'codex', nativeSessionId: id, watching, status } });

describe('officeHistoryIds', () => {
  it('loads running or selected managed sessions and watched observed sessions', () => {
    const ids = officeHistoryIds([
      summary('running', { running: true }), summary('idle'), summary('picked'),
      observed('watched', 5), observed('paused', 6, 'paused'), observed('gone', 7, 'unavailable', true),
    ], 'picked');
    expect(ids.sort()).toEqual(['picked', 'running', 'watched']);
  });

  it('limits observed sessions to the most recent ones', () => {
    const sessions = Array.from({ length: 30 }, (_, index) => observed(`o${index}`, index));
    const ids = officeHistoryIds(sessions);
    expect(ids).toHaveLength(24);
    expect(ids).toContain('o29');
    expect(ids).not.toContain('o5');
    expect(officeHistoryIds(sessions, undefined, 3)).toEqual(['o29', 'o28', 'o27']);
  });
});

describe('observed events in the activity feed and Office presence (hook E2E flow)', () => {
  const make = (channel: 'transcript' | 'hook' | 'import') => createEvent({
    id: `e-${channel}`, sessionId: 'obs', agentId: 'primary', source: { runtime: 'codex', channel },
    body: { type: 'tool.started', tool: 'shell', kind: 'test', label: 'Run tests', target: 'pnpm test' },
  });

  it('turns transcript and hook events into activities but not imported history', () => {
    expect(activityFromEvent(make('transcript'))).toMatchObject({ kind: 'tool', characterId: 'obs:primary', activity: 'test' });
    expect(activityFromEvent(make('hook'))).toMatchObject({ kind: 'tool' });
    expect(activityFromEvent(make('import'))).toBeUndefined();
  });

  it('drives character presence, tool activity, waiting approvals, and MCP subagent handoffs from live hook events', () => {
    const baseMs = Date.parse('2026-10-15T02:00:00.000Z');
    const hookSession = summary('hook-codex', {
      control: 'observed',
      title: 'Codex · live-1',
      observation: { sourceId: 'codex', nativeSessionId: 'live-1', watching: true, status: 'watching', hook: true },
    });
    const emitHook = (seq: number, offsetSec: number, body: EventBody, agentId = 'primary'): ExtaliaEvent =>
      createEvent({
        id: `hook-${seq}`,
        at: new Date(baseMs + offsetSec * 1000).toISOString(),
        seq,
        sessionId: 'hook-codex',
        agentId,
        source: { runtime: 'codex', channel: 'hook', adapter: 'codex-hooks' },
        body,
      });

    // 1. PreToolUse arrives -> character works on target and produces activity toast/feed item
    const stepEvents = [
      emitHook(1, 0, { type: 'session.started', control: 'observed', title: 'Codex · live-1' }),
      emitHook(2, 1, { type: 'prompt.submitted', via: 'native', text: 'Run test suite' }),
      emitHook(3, 1, { type: 'agent.state', state: 'working', activity: 'test', summary: 'Running pnpm test', target: 'pnpm test' }),
      emitHook(4, 1, { type: 'tool.started', toolCallId: 't1', tool: 'Bash', kind: 'test', label: 'Running pnpm test', target: 'pnpm test' }),
    ];
    const [workingPresence] = projectOfficePresence([hookSession], stepEvents, baseMs + 2000);
    expect(workingPresence).toMatchObject({
      id: 'hook-codex:primary',
      control: 'observed',
      status: 'working',
      running: true,
      live: true,
      activity: 'test',
      target: 'pnpm test',
      summary: 'Running pnpm test',
    });
    expect(activityFromEvent(stepEvents[3]!)).toMatchObject({
      kind: 'tool',
      characterId: 'hook-codex:primary',
      activity: 'test',
      text: 'Running pnpm test',
    });

    // 2. PermissionRequest hook -> character enters waiting state
    const waitingEvents = [
      ...stepEvents,
      emitHook(5, 2, { type: 'agent.state', state: 'waiting', activity: 'command', summary: 'Waiting for approval: Running rm -rf dist', target: 'rm -rf dist' }),
    ];
    const [waitingPresence] = projectOfficePresence([hookSession], waitingEvents, baseMs + 3000);
    expect(waitingPresence).toMatchObject({
      status: 'waiting',
      running: false,
      live: true,
      summary: 'Waiting for approval: Running rm -rf dist',
    });

    // 3. SubagentStart / MCP report_handoff -> spawns worker character linked to primary
    const handoffEvents = [
      ...waitingEvents,
      emitHook(6, 3, { type: 'subagent.spawned', subagentId: 'reviewer-1', role: 'CodeReviewer', label: 'Audit diff' }),
      emitHook(7, 3, { type: 'subagent.state', subagentId: 'reviewer-1', state: 'working', summary: 'Audit diff' }),
    ];
    const presences = projectOfficePresence([hookSession], handoffEvents, baseMs + 4000);
    expect(presences.map(p => [p.id, p.status, p.parentId])).toEqual([
      ['hook-codex:primary', 'waiting', undefined],
      ['hook-codex:reviewer-1', 'working', 'hook-codex:primary'],
    ]);

    // 4. Stop hook -> primary returns to idle and stopped subagent goes offline
    const doneEvents = [
      ...handoffEvents,
      emitHook(8, 4, { type: 'subagent.state', subagentId: 'reviewer-1', state: 'offline' }),
      emitHook(9, 5, { type: 'turn.completed' }),
      emitHook(10, 5, { type: 'agent.state', state: 'idle' }),
    ];
    const afterStop = projectOfficePresence([hookSession], doneEvents, baseMs + 6000);
    expect(afterStop.find(p => p.id === 'hook-codex:primary')).toMatchObject({
      status: 'idle',
      running: false,
      live: true,
    });
    // v0.0.44: the stop ends its work; it stays Ready under its lead for its linger before it leaves.
    expect(afterStop.find(p => p.id === 'hook-codex:reviewer-1')).toMatchObject({
      status: 'idle',
      parentId: 'hook-codex:primary',
    });
    const afterLinger = projectOfficePresence([hookSession], doneEvents, baseMs + 9000 + subagentLingerMs('hook-codex:reviewer-1'));
    expect(afterLinger.find(p => p.id === 'hook-codex:reviewer-1')).toMatchObject({ status: 'offline', earlier: true, parentId: 'hook-codex:primary' });
  });
});
