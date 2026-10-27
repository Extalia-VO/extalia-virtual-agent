import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@extalia/platform';
import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { MESSAGES } from '../src/i18n';
import {
  OBSERVED_GONE_MS, OBSERVED_RECENT_MS, STALL_LONG_TOOL_MS, STALL_THINKING_MS, STALL_TOOL_MS,
  projectOfficePresence, subagentLingerMs, type OfficeAgent,
} from '../src/office/presence';
import { activityBucket, officeKpis } from '../src/office/overlay/kpis';
import { splitBoard, withTeamMembers } from '../src/office/overlay/boardTree';
import { buildSearchSource } from '../src/office/overlay/searchSource';
import { popoverState, popoverSummary } from '../src/office/overlay/popoverModel';
import { agentStatusLabel, statusTone } from '../src/office/overlay/status';
import { quietCharacters } from '../src/office/scene/bubbles';

// v0.0.40: stalled observed agents, stop reasons, and the board's "Earlier" group. Synthesized events only.
const BASE = Date.parse('2026-10-16T12:00:00.000Z');
const MIN = 60_000;
const observed = (id = 'cc', extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id, workspaceId: '', connectionId: '', title: 'Outside', control: 'observed', running: false,
  createdAt: '2026-10-16T11:00:00.000Z', lastActiveAt: '2026-10-16T12:00:00.000Z',
  observation: { sourceId: 'claude-code', nativeSessionId: `native-${id}`, watching: true, status: 'watching', channel: 'hook' },
  ...extra,
});
let counter = 0;
const hook = (ms: number, body: EventBody, agentId = 'primary', sessionId = 'cc'): ExtaliaEvent =>
  createEvent({ id: `s${++counter}`, at: new Date(BASE + ms).toISOString(), sessionId, agentId, source: { runtime: 'claude', channel: 'hook' }, body });
const project = (events: ExtaliaEvent[], ms: number, sessions: SessionSummary[] = [observed()]) => projectOfficePresence(sessions, events, BASE + ms);
const byAgent = (agents: OfficeAgent[], agentId: string, sessionId = 'cc') => agents.find(agent => agent.agentId === agentId && agent.sessionId === sessionId)!;
const lead = (events: ExtaliaEvent[], ms: number) => byAgent(project(events, ms), 'primary');
const en = MESSAGES.en, id = MESSAGES.id;

describe('stall thresholds', () => {
  it('thinking, planning and compacting stall after 3 minutes without an event', () => {
    for (const body of [
      { type: 'agent.state', state: 'thinking' },
      { type: 'agent.state', state: 'working', activity: 'think', phase: 'planning' },
      { type: 'agent.state', state: 'thinking', phase: 'compacting' },
      { type: 'tool.completed', tool: 'Read', kind: 'read', label: 'Read', ok: true },
    ] as EventBody[]) {
      const events = [hook(0, body)];
      expect(lead(events, STALL_THINKING_MS - 1000).stalled).toBeUndefined();
      expect(lead(events, STALL_THINKING_MS + 1000)).toMatchObject({ stalled: true, running: false, live: false });
    }
  });

  it('a tool call in progress stalls after 10 minutes; a command or test run after 15', () => {
    const edit = [hook(0, { type: 'agent.state', state: 'working', activity: 'edit' }), hook(0, { type: 'tool.started', tool: 'Edit', kind: 'edit', label: 'Edit' })];
    expect(lead(edit, STALL_TOOL_MS - 1000).stalled).toBeUndefined();
    expect(lead(edit, STALL_TOOL_MS + 1000).stalled).toBe(true);
    for (const kind of ['command', 'test'] as const) {
      const run = [hook(0, { type: 'tool.started', tool: 'Bash', kind, label: 'Run' })];
      expect(lead(run, STALL_LONG_TOOL_MS - 1000).stalled).toBeUndefined();
      expect(lead(run, STALL_LONG_TOOL_MS + 1000)).toMatchObject({ status: 'working', stalled: true });
    }
  });

  it('waiting for approval or for the user never stalls', () => {
    for (const body of [
      { type: 'agent.state', state: 'waiting', phase: 'approval' },
      { type: 'agent.state', state: 'waiting', phase: 'input' },
      { type: 'agent.state', state: 'idle', phase: 'input' },
    ] as EventBody[]) {
      const agent = lead([hook(0, body)], OBSERVED_GONE_MS - 1000);
      expect(agent.stalled).toBeUndefined();
    }
    expect(lead([hook(0, { type: 'agent.state', state: 'waiting', phase: 'approval' })], OBSERVED_GONE_MS - 1000).status).toBe('waiting');
  });

  it('any new event clears the stall at once', () => {
    const events = [hook(0, { type: 'agent.state', state: 'thinking' })];
    expect(lead(events, 5 * MIN).stalled).toBe(true);
    const resumed = [...events, hook(5 * MIN, { type: 'tool.started', tool: 'Read', kind: 'read', label: 'Read' })];
    expect(lead(resumed, 5 * MIN + 1000)).toMatchObject({ status: 'working', running: true });
    expect(lead(resumed, 5 * MIN + 1000).stalled).toBeUndefined();
  });

  it('after 30 minutes without events a stalled lead is ready and a stalled subagent has left', () => {
    const events = [
      hook(0, { type: 'agent.state', state: 'thinking' }),
      hook(0, { type: 'subagent.spawned', subagentId: 'sub', label: 'Helper' }),
      hook(0, { type: 'agent.state', state: 'working', activity: 'edit' }, 'sub'),
    ];
    const stalled = project(events, 20 * MIN);
    expect(byAgent(stalled, 'sub')).toMatchObject({ status: 'working', stalled: true });
    const gone = project(events, OBSERVED_GONE_MS + 1000);
    expect(byAgent(gone, 'primary')).toMatchObject({ status: 'idle' });
    expect(byAgent(gone, 'primary').stalled).toBeUndefined();
    expect(byAgent(gone, 'sub')).toMatchObject({ status: 'offline', earlier: true });
  });

  it('a delegating agent does not stall while a child works; it does once the child stalls too', () => {
    const events = [
      hook(0, { type: 'agent.state', state: 'delegating', activity: 'delegate' }),
      hook(0, { type: 'tool.started', tool: 'Agent', kind: 'delegate', label: 'Delegating via Agent' }),
      hook(0, { type: 'subagent.spawned', subagentId: 'sub', label: 'Helper' }),
    ];
    const busy = [...events, hook(11 * MIN, { type: 'tool.started', tool: 'Bash', kind: 'test', label: 'Run tests' }, 'sub')];
    expect(byAgent(project(busy, 12 * MIN), 'primary').stalled).toBeUndefined();
    // The child's test run outlasts 15 minutes: both have stopped responding.
    const agents = project(busy, 11 * MIN + STALL_LONG_TOOL_MS + 1000);
    expect(byAgent(agents, 'sub').stalled).toBe(true);
    expect(byAgent(agents, 'primary').stalled).toBe(true);
  });

  it('labels, tone, bucket, popover and bubbles of a stalled agent', () => {
    const agent = lead([hook(0, { type: 'agent.state', state: 'working', summary: 'Working on it' })], 5 * MIN);
    expect(agentStatusLabel(en, agent, 'en-GB')).toMatch(/^No response · since \d{2}:\d{2}$/);
    expect(agentStatusLabel(id, agent, 'id-ID')).toMatch(/^Tidak merespons · sejak \d{2}[.:]\d{2}$/);
    expect(agentStatusLabel(en, { ...agent, lastActivityAt: undefined })).toBe('No response');
    expect(statusTone(agent)).toBe('warn');
    expect(activityBucket(agent)).toBe('errors');
    expect(popoverState(agent)).toBe('waiting');
    expect(popoverSummary(en, agent)).toBe(en.characterPopover.summary.noResponse);
    expect(quietCharacters([agent]).has(agent.id)).toBe(true);
  });
});

describe('stop reasons', () => {
  it('labels a quota failure from a stated reason, from older event text, and for subagents', () => {
    const stated = lead([hook(0, { type: 'turn.failed', error: 'Out of tokens or quota', reason: 'quota' }), hook(0, { type: 'agent.state', state: 'idle', phase: 'error', reason: 'quota' })], 60_000);
    expect(stated).toMatchObject({ status: 'idle', phase: 'error', reason: 'quota' });
    expect(agentStatusLabel(en, stated)).toBe('Out of tokens or quota');
    expect(agentStatusLabel(id, stated)).toBe('Kehabisan token atau kuota');
    expect(statusTone(stated)).toBe('error');
    expect(activityBucket(stated)).toBe('errors');
    expect(popoverSummary(en, stated)).toBe(en.characterPopover.summary.reason.quota);
    // Events written before `reason` existed: read from the error text.
    const legacy = lead([hook(0, { type: 'agent.state', state: 'idle', phase: 'error', summary: "You've hit your usage limit. Upgrade to Pro or try again later." })], 60_000);
    expect(legacy.reason).toBe('quota');
    expect(agentStatusLabel(en, lead([hook(0, { type: 'turn.failed', error: 'Credit balance is too low' })], 60_000))).toBe('Out of tokens or quota');
    expect(agentStatusLabel(en, lead([hook(0, { type: 'turn.failed', error: 'Please run /login' })], 60_000))).toBe('Sign-in needed');
    expect(agentStatusLabel(en, lead([hook(0, { type: 'turn.failed', error: 'Request interrupted by user' })], 60_000))).toBe('Interrupted');
    expect(agentStatusLabel(en, lead([hook(0, { type: 'turn.failed', error: 'boom' })], 60_000))).toBe('Error');
    const sub = byAgent(project([
      hook(0, { type: 'subagent.spawned', subagentId: 'sub', label: 'Helper' }),
      hook(1000, { type: 'subagent.state', subagentId: 'sub', state: 'idle', phase: 'error', reason: 'rate-limit' }),
    ], 60_000), 'sub');
    expect(sub).toMatchObject({ phase: 'error', reason: 'rate-limit' });
    expect(agentStatusLabel(en, sub)).toBe('Rate limited');
  });

  it('keeps a failure on the lead for 30 minutes, then it is ready', () => {
    const events = [hook(0, { type: 'agent.state', state: 'idle', phase: 'error', reason: 'quota' })];
    expect(lead(events, 25 * MIN)).toMatchObject({ phase: 'error', reason: 'quota' });
    const later = lead(events, OBSERVED_GONE_MS + 1000);
    expect(later.phase).toBeUndefined();
    expect(later.reason).toBeUndefined();
  });

  it('labels a managed lead whose last turn ran out of quota', () => {
    const managed = observed('m', { control: 'managed', observation: undefined });
    const event = (n: number, body: EventBody) => createEvent({ id: `m${n}`, seq: n, at: new Date(BASE + n * 1000).toISOString(), sessionId: 'm', agentId: 'primary', source: { runtime: 'test', channel: 'stream' }, body });
    const [failed] = projectOfficePresence([managed], [event(1, { type: 'prompt.submitted', text: 'go', via: 'extalia' }), event(2, { type: 'turn.failed', error: 'insufficient_quota: You exceeded your current quota' })], BASE + 5000);
    expect(failed).toMatchObject({ status: 'idle', phase: 'error', reason: 'quota' });
  });
});

describe('board visibility (Earlier)', () => {
  const recent = [hook(0, { type: 'agent.state', state: 'idle' })];
  it('lists live or recent observed leads and present subagents; ended, quiet ones and subagents that left go under Earlier', () => {
    const sessions = [observed('cc'), observed('old', { lastActiveAt: '2026-10-16T08:00:00.000Z' }), observed('ended'), observed('quiet', { lastActiveAt: '2026-10-16T07:00:00.000Z' })];
    const events = [
      ...recent,
      // v0.0.44: it left after its Ready linger (at most 20 minutes after its stop).
      hook(-30 * MIN, { type: 'subagent.spawned', subagentId: 'done', label: 'Done' }),
      hook(-25 * MIN, { type: 'subagent.state', subagentId: 'done', state: 'offline' }),
      hook(0, { type: 'subagent.spawned', subagentId: 'busy', label: 'Busy' }),
      hook(60_000, { type: 'agent.state', state: 'working', activity: 'edit' }, 'busy'),
      hook(-OBSERVED_RECENT_MS - MIN, { type: 'agent.state', state: 'idle' }, 'primary', 'old'),
      hook(0, { type: 'agent.state', state: 'offline' }, 'primary', 'ended'),
    ];
    const agents = project(events, 2 * MIN, sessions);
    expect(byAgent(agents, 'primary').earlier).toBeUndefined();
    expect(byAgent(agents, 'busy').earlier).toBeUndefined();
    expect(byAgent(agents, 'done')).toMatchObject({ status: 'offline', earlier: true });
    expect(byAgent(agents, 'primary', 'old')).toMatchObject({ status: 'idle', earlier: true });
    expect(byAgent(agents, 'primary', 'ended')).toMatchObject({ phase: 'ended', earlier: true });
    // No events loaded: the host's last-active time decides.
    expect(byAgent(agents, 'primary', 'quiet')).toMatchObject({ status: 'observing', earlier: true });

    const board = splitBoard(agents, new Set(), agent => agent.lastActivityAt ? Date.parse(agent.lastActivityAt) : undefined);
    expect(board.present.map(row => row.agent.id)).toEqual(['cc:primary', 'cc:busy']);
    expect(board.earlierCount).toBe(4);
    // One group per session; the subagent that left is listed under its lead's name, which is still in the office.
    expect(board.earlier.map(group => group.sessionId).sort()).toEqual(['cc', 'ended', 'old', 'quiet']);
    expect(board.earlier.find(group => group.sessionId === 'cc')?.presentLead?.id).toBe('cc:primary');
    expect(board.earlier.find(group => group.sessionId === 'old')?.presentLead).toBeUndefined();
    // Earlier agents are never counted: the lead coordinates its working subagent, and that is all.
    expect(officeKpis(agents)).toMatchObject({ working: 2, idle: 0, errors: 0, waiting: 0, observed: 2 });
  });

  it('v0.0.44: a subagent that just finished stays Ready under its lead and counts as ready until its linger ends', () => {
    const events = [
      ...recent,
      hook(0, { type: 'subagent.spawned', subagentId: 'done', label: 'Done' }),
      hook(MIN, { type: 'agent.state', state: 'working', activity: 'edit' }, 'done'),
      hook(2 * MIN, { type: 'subagent.state', subagentId: 'done', state: 'offline' }),
    ];
    const agents = project(events, 3 * MIN);
    expect(byAgent(agents, 'done')).toMatchObject({ status: 'idle', running: false, parentId: 'cc:primary' });
    expect(byAgent(agents, 'done').earlier).toBeUndefined();
    expect(byAgent(agents, 'done').phase).toBeUndefined();
    expect(splitBoard(agents, new Set()).present.map(row => [row.agent.agentId, row.depth])).toEqual([['primary', 0], ['done', 1]]);
    expect(officeKpis(agents)).toMatchObject({ idle: 2, working: 0 });
    const linger = subagentLingerMs('cc:done');
    expect(linger).toBeGreaterThanOrEqual(7 * MIN);
    expect(linger).toBeLessThanOrEqual(20 * MIN);
    expect(byAgent(project(events, 2 * MIN + linger + 1000), 'done')).toMatchObject({ status: 'offline', earlier: true });
    // The 30-minute silence rule still applies to a subagent last seen at work: it leaves without a linger.
    const silent = [...recent, hook(0, { type: 'subagent.spawned', subagentId: 'gone', label: 'Gone' }), hook(MIN, { type: 'agent.state', state: 'working', activity: 'edit' }, 'gone')];
    expect(byAgent(project(silent, MIN + OBSERVED_GONE_MS + 1000), 'gone')).toMatchObject({ status: 'offline', earlier: true });
  });

  it('v0.0.44: a managed subagent that stopped lingers as Ready, then leaves', () => {
    const managed = observed('m', { control: 'managed', observation: undefined, running: true });
    const event = (n: number, at: number, body: EventBody, agentId = 'primary') => createEvent({ id: `ml${n}`, seq: n, at: new Date(BASE + at).toISOString(), sessionId: 'm', agentId, source: { runtime: 'test', channel: 'stream' }, body });
    const events = [
      event(1, 0, { type: 'subagent.spawned', subagentId: 'w', label: 'Worker' }),
      event(2, 1000, { type: 'subagent.state', subagentId: 'w', state: 'working' }),
      event(3, MIN, { type: 'subagent.state', subagentId: 'w', state: 'offline' }),
    ];
    const linger = subagentLingerMs('m:w');
    expect(byAgent(projectOfficePresence([managed], events, BASE + 2 * MIN), 'w', 'm')).toMatchObject({ status: 'idle', parentId: 'm:primary' });
    expect(byAgent(projectOfficePresence([managed], events, BASE + 2 * MIN), 'w', 'm').earlier).toBeUndefined();
    expect(byAgent(projectOfficePresence([managed], events, BASE + MIN + linger + 1000), 'w', 'm')).toMatchObject({ status: 'offline', earlier: true });
  });

  it('keeps managed leads and team members on the board, uncounted, and moves other managed subagents that left to Earlier', () => {
    const managed = observed('m', { control: 'managed', observation: undefined, running: false });
    const event = (n: number, body: EventBody, agentId = 'primary') => createEvent({ id: `mm${n}`, seq: n, at: new Date(BASE - 5 * 60 * MIN + n * 1000).toISOString(), sessionId: 'm', agentId, source: { runtime: 'test', channel: 'stream' }, body });
    const teams = new Map([['m', [{ id: 'member', name: 'Elena Mark' }, { id: 'idle-member', name: 'Kaelen Vael' }]]]);
    const agents = projectOfficePresence([managed], [
      event(1, { type: 'agent.created', name: 'Elena Mark' }, 'member'), event(2, { type: 'agent.stopped' }, 'member'),
      event(3, { type: 'agent.created', name: 'Scratch' }, 'scratch'), event(4, { type: 'agent.stopped' }, 'scratch'),
    ], BASE, teams);
    expect(byAgent(agents, 'primary', 'm').earlier).toBeUndefined();
    expect(byAgent(agents, 'member', 'm')).toMatchObject({ status: 'offline' });
    expect(byAgent(agents, 'member', 'm').earlier).toBeUndefined();
    expect(byAgent(agents, 'scratch', 'm')).toMatchObject({ status: 'offline', earlier: true });
    const board = splitBoard(withTeamMembers(agents, teams));
    expect(board.present.map(row => row.agent.agentId).sort()).toEqual(['idle-member', 'member', 'primary']);
    expect(board.earlierCount).toBe(1);
    expect(officeKpis(withTeamMembers(agents, teams))).toMatchObject({ idle: 1, working: 0, errors: 0 });
  });

  it('history replayed on load never brings old subagents back', () => {
    // A busy session from three hours ago: the lead and its subagents were working when the history ends.
    const old = -3 * 60 * MIN;
    const events = [
      hook(old, { type: 'prompt.submitted', text: 'go', via: 'native' }),
      hook(old, { type: 'agent.state', state: 'delegating', activity: 'delegate' }),
      ...['a', 'b', 'c'].flatMap(sub => [
        hook(old, { type: 'subagent.spawned', subagentId: sub, label: sub }),
        hook(old + 1000, { type: 'tool.started', tool: 'Edit', kind: 'edit', label: 'Edit' }, sub),
      ]),
    ];
    const agents = project(events, 0, [observed('cc', { lastActiveAt: new Date(BASE + old).toISOString() })]);
    for (const sub of ['a', 'b', 'c']) expect(byAgent(agents, sub)).toMatchObject({ status: 'offline', running: false, earlier: true });
    expect(byAgent(agents, 'primary')).toMatchObject({ status: 'idle', running: false, earlier: true });
    expect(agents.some(agent => agent.stalled)).toBe(false);
    expect(officeKpis(agents)).toMatchObject({ running: 0, working: 0, waiting: 0, errors: 0, idle: 0, observed: 0 });
  });

  it('search still finds agents under Earlier', () => {
    const agents = project([
      hook(-30 * MIN, { type: 'subagent.spawned', subagentId: 'done', label: 'Done' }),
      hook(-25 * MIN, { type: 'subagent.state', subagentId: 'done', state: 'offline' }),
      ...recent,
    ], 2 * MIN);
    const source = buildSearchSource(en, { presences: agents, projects: new Map(), rooms: [], board: [], names: new Map() });
    const earlier = source.agents.find(item => item.id === 'cc:done');
    expect(earlier?.status).toBe('Offline · Earlier');
  });
});
