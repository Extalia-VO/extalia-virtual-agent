import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@extalia/platform';
import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { MESSAGES } from '../src/i18n';
import { projectOfficePresence, subagentLingerMs, type OfficeAgent } from '../src/office/presence';
import { popoverSummary } from '../src/office/overlay/popoverModel';
import { agentStatusLabel, statusTone } from '../src/office/overlay/status';
import { presenceCategory } from '../src/office/semanticBubble';

// v0.0.38: statuses of observed agents (hooks and transcripts) and their labels. Synthesized events only.
const BASE = Date.parse('2026-10-16T12:00:00.000Z');
const observed: SessionSummary = {
  id: 'cc', workspaceId: '', connectionId: '', title: 'Outside', control: 'observed', running: false,
  createdAt: '2026-10-16T11:00:00.000Z', lastActiveAt: '2026-10-16T11:00:00.000Z',
  observation: { sourceId: 'claude-code', nativeSessionId: 'native', watching: true, status: 'watching', channel: 'hook' },
};
let counter = 0;
/** A hook event: no `seq`, timestamped on arrival, like the host's hook channel. */
const hook = (seconds: number, body: EventBody, agentId = 'primary'): ExtaliaEvent =>
  createEvent({ id: `h${++counter}`, at: new Date(BASE + seconds * 1000).toISOString(), sessionId: 'cc', agentId, source: { runtime: 'claude', channel: 'hook' }, body });
const project = (events: ExtaliaEvent[], seconds: number, sessions: SessionSummary[] = [observed]) => projectOfficePresence(sessions, events, BASE + seconds * 1000);
const byAgent = (agents: OfficeAgent[], agentId: string) => agents.find(agent => agent.agentId === agentId)!;
const en = MESSAGES.en, id = MESSAGES.id;

describe('observed Claude Code: lead ends its turn while background subagents work (the "always Ready" bug)', () => {
  // The lead launches a background Agent task and stops; the subagent's hooks carry its agent_id.
  const leadTurn = [
    hook(0, { type: 'prompt.submitted', text: 'Fix it', via: 'native' }),
    hook(0, { type: 'agent.state', state: 'thinking' }),
    hook(1, { type: 'agent.state', state: 'delegating', activity: 'delegate', summary: 'Delegating via Agent' }),
    hook(1, { type: 'tool.started', tool: 'Agent', kind: 'delegate', label: 'Delegating via Agent' }),
    hook(2, { type: 'subagent.spawned', subagentId: 'bg1', role: 'general-purpose', label: 'general-purpose' }),
    hook(2, { type: 'tool.completed', tool: 'Agent', kind: 'delegate', label: 'Delegating via Agent', ok: true }),
    hook(3, { type: 'turn.completed' }),
    hook(3, { type: 'agent.state', state: 'idle' }),
  ];
  const subagentWork = [
    hook(10, { type: 'agent.state', state: 'working', activity: 'edit', summary: 'Editing via Edit: a.ts', target: 'a.ts' }, 'bg1'),
    hook(10, { type: 'tool.started', tool: 'Edit', kind: 'edit', label: 'Editing via Edit: a.ts', target: 'a.ts' }, 'bg1'),
  ];

  it('shows the subagent from its own events and the lead coordinating it, both live', () => {
    const agents = project([...leadTurn, ...subagentWork], 20);
    expect(byAgent(agents, 'bg1')).toMatchObject({ status: 'working', activity: 'edit', running: true, live: true, parentId: 'cc:primary' });
    expect(byAgent(agents, 'primary')).toMatchObject({ status: 'delegating', activity: 'delegate', running: true });
    expect(agentStatusLabel(en, byAgent(agents, 'bg1'))).toBe('Editing');
    expect(agentStatusLabel(en, byAgent(agents, 'primary'))).toBe('Delegating to a subagent');
  });

  it('nests a subagent under the lead when its events arrive without an announcement (missed SubagentStart, trimmed window)', () => {
    const agents = project(subagentWork, 20);
    expect(byAgent(agents, 'bg1')).toMatchObject({ status: 'working', parentId: 'cc:primary' });
  });

  it('a finished subagent is ready, then leaves; the lead is ready again', () => {
    // v0.0.44: a stop (SubagentStop) ends its work, not its stay: it lingers as Ready, nested under its lead.
    const linger = subagentLingerMs('cc:bg1') / 1000;
    const done = [...leadTurn, ...subagentWork, hook(30, { type: 'subagent.state', subagentId: 'bg1', state: 'offline' }, 'primary')];
    expect(byAgent(project(done, 40), 'bg1')).toMatchObject({ status: 'idle', running: false, parentId: 'cc:primary' });
    expect(byAgent(project(done, 40), 'bg1').earlier).toBeUndefined();
    expect(byAgent(project(done, 40), 'primary').status).toBe('idle');
    expect(byAgent(project(done, 30 + linger - 1), 'bg1').status).toBe('idle');
    expect(byAgent(project(done, 30 + linger + 1), 'bg1')).toMatchObject({ status: 'offline', earlier: true });
    const quiet = [...leadTurn, ...subagentWork, hook(30, { type: 'agent.state', state: 'idle' }, 'bg1')];
    expect(byAgent(project(quiet, 40), 'bg1').status).toBe('idle');
    expect(byAgent(project(quiet, 30 + linger - 1), 'bg1').status).toBe('idle');
    expect(byAgent(project(quiet, 30 + linger + 1), 'bg1').status).toBe('offline');
  });
});

describe('observed status nuances', () => {
  const label = (body: EventBody, extra: ExtaliaEvent[] = []) => {
    const agent = byAgent(project([...extra, hook(0, body)], 5), 'primary');
    return { agent, en: agentStatusLabel(en, agent), id: agentStatusLabel(id, agent), tone: statusTone(agent) };
  };

  it('labels approval, questions, idle prompts, planning, compacting, interruption, errors and the end', () => {
    expect(label({ type: 'agent.state', state: 'waiting', phase: 'approval', summary: 'Waiting for approval: Running rm' })).toMatchObject({ en: 'Waiting for approval', id: 'Menunggu persetujuan', tone: 'wait' });
    expect(label({ type: 'agent.state', state: 'idle', phase: 'input' })).toMatchObject({ en: 'Waiting for you', id: 'Menunggu Anda', tone: 'idle' });
    expect(label({ type: 'agent.state', state: 'working', activity: 'think', phase: 'planning' })).toMatchObject({ en: 'Planning', tone: 'work' });
    expect(label({ type: 'agent.state', state: 'thinking', phase: 'compacting' })).toMatchObject({ en: 'Compacting context', id: 'Meringkas konteks', tone: 'work' });
    expect(label({ type: 'agent.state', state: 'idle', phase: 'interrupted' })).toMatchObject({ en: 'Interrupted', tone: 'idle' });
    expect(label({ type: 'agent.state', state: 'idle', phase: 'error' })).toMatchObject({ en: 'Error', tone: 'error' });
    expect(label({ type: 'agent.state', state: 'offline' })).toMatchObject({ agent: { status: 'idle', phase: 'ended' }, en: 'Ended', id: 'Selesai' });
    expect(label({ type: 'agent.state', state: 'thinking' })).toMatchObject({ en: 'Thinking', tone: 'work' });
    expect(label({ type: 'agent.state', state: 'idle' })).toMatchObject({ en: 'Ready', id: 'Siap' });
  });

  it('labels activity kinds and named MCP tools', () => {
    const tool = (kind: 'read' | 'edit' | 'command' | 'test' | 'search' | 'web' | 'tool', name = 'Tool') =>
      label({ type: 'tool.started', tool: name, kind, label: `Calling ${name}` });
    expect(tool('read').en).toBe('Reading');
    expect(tool('edit').en).toBe('Editing');
    expect(tool('command').en).toBe('Running a command');
    expect(tool('test').en).toBe('Running tests');
    expect(tool('search').en).toBe('Searching');
    expect(tool('web').en).toBe('Browsing');
    expect(tool('tool').en).toBe('Using a tool');
    expect(tool('tool', 'mcp__github__create_issue')).toMatchObject({ agent: { toolName: 'github · create_issue' }, en: 'Using github · create_issue', id: 'Memakai github · create_issue' });
  });

  it('keeps a question to the user (tool call + waiting state) as waiting for you, and never calls it an approval in the world', () => {
    const state = hook(0, { type: 'agent.state', state: 'waiting', phase: 'input', activity: 'tool', summary: 'Asking the user' });
    const { agent, en: text } = label({ type: 'tool.started', tool: 'AskUserQuestion', kind: 'tool', label: 'Asking the user' }, [state]);
    expect(agent).toMatchObject({ status: 'waiting', phase: 'input' });
    expect(text).toBe('Waiting for you');
    expect(presenceCategory(agent)).toBe('question');
    expect(popoverSummary(en, agent)).toBe('Waiting for your answer or next prompt');
  });

  it('a failed turn reads as an error, an interrupted one as interrupted', () => {
    expect(label({ type: 'turn.failed', error: 'boom' }).en).toBe('Error');
    // v0.0.40: a failure that says why is labelled with the reason (older events without `reason` are read from the text).
    expect(label({ type: 'turn.failed', error: 'API Error: overloaded' })).toMatchObject({
      agent: { status: 'idle', phase: 'error', reason: 'overloaded', running: false }, en: 'Service overloaded', tone: 'error',
    });
    expect(label({ type: 'turn.failed', error: 'API Error: overloaded', reason: 'quota' })).toMatchObject({
      agent: { reason: 'quota' }, en: en.chat.detail.reason.quota, id: id.chat.detail.reason.quota, tone: 'error',
    });
    expect(label({ type: 'turn.failed', error: 'Interrupted' }).en).toBe('Interrupted');
  });

  it('a managed lead keeps how its last turn ended once it stops', () => {
    const managed: SessionSummary = { ...observed, id: 'm', control: 'managed', observation: undefined, running: false };
    const event = (n: number, body: EventBody) => createEvent({ id: `m${n}`, seq: n, at: new Date(BASE + n * 1000).toISOString(), sessionId: 'm', agentId: 'primary', source: { runtime: 'test', channel: 'stream' }, body });
    const [failed] = projectOfficePresence([managed], [event(1, { type: 'prompt.submitted', text: 'go', via: 'extalia' }), event(2, { type: 'turn.failed', error: 'boom' })], BASE + 5000);
    expect(failed).toMatchObject({ status: 'idle', phase: 'error' });
    const [again] = projectOfficePresence([managed], [event(1, { type: 'turn.failed', error: 'boom' }), event(2, { type: 'prompt.submitted', text: 'retry', via: 'extalia' }), event(3, { type: 'turn.completed' })], BASE + 5000);
    expect(again?.phase).toBeUndefined();
  });
});
