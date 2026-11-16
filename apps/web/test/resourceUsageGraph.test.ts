import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { createResourceUsageProjection, projectResourceUsage, type ResourceUsageOptions } from '../src/chat/resourceUsageGraph';
const options: ResourceUsageOptions = { scopeKey: 'profile/workspace', sessionId: 'session', primaryLabel: 'Lead', teamLabel: 'Saved team',
  team: { enabled: true, allowedModels: [], members: [{ id: 'one', name: 'Researcher', role: 'Research', models: [] }] } };
let serial = 0;
const e = (body: EventBody, agentId = 'primary', id = `event-${++serial}`, sessionId = 'session'): ExtaliaEvent => createEvent({
  id, at: new Date(Date.UTC(2026, 0, 1, 0, 0, serial)).toISOString(), sessionId, agentId, source: { runtime: 'extalia-native', channel: 'stream' }, body });
const prompt = () => e({ type: 'prompt.submitted', text: 'Review the project', via: 'extalia' });
const loaded = (owner = 'primary', name = 'project-review') => e({ type: 'skills.loaded', skills: [{ name, source: 'registry', reason: 'current-context', status: 'loaded', characters: 200 }], characters: 250, budgetCharacters: 1000 }, owner);
const start = (id: string, owner = 'primary', tool = 'skill_read', target: string | null = 'project-review') => e({ type: 'tool.started', toolCallId: id, tool, kind: 'knowledge', label: 'Recorded resource access', ...(target ? { target } : {}) }, owner);
const end = (id: string, owner = 'primary', ok = true, tool = 'skill_read', target: string | null = 'project-review') => e({ type: 'tool.completed', toolCallId: id, tool, kind: 'knowledge', label: 'Recorded access result', ok, ...(target ? { target } : {}) }, owner);
const graph = (events: ExtaliaEvent[], extra: Partial<ResourceUsageOptions> = {}) => projectResourceUsage(events, { ...options, ...extra });

describe('evidence-backed resource activity', () => {
  it('keeps preparation separate from actual read activity, counts reuse and preserves node position/identity', () => {
    const events = [prompt(), loaded()], prepared = graph(events), first = prepared.nodes[0]!;
    expect(first).toMatchObject({ label: 'project-review', status: 'loaded', count: 1, agentId: 'primary' });
    events.push(start('read')); const active = graph(events).nodes[0]!;
    expect(active.id).toBe(first.id); expect(active.status).toBe('active'); expect(active.count).toBe(2);
    events.push(end('read'), start('second'), end('second'));
    const completed = graph(events).nodes[0]!;
    expect(completed).toMatchObject({ id: first.id, status: 'completed', count: 3 });
    expect(completed.evidenceIds).toHaveLength(5);
    const before = JSON.stringify(events); graph(events); expect(JSON.stringify(events)).toBe(before);
  });

  it('does not duplicate reloaded events, repeated hook call ids, or worker receipt projections', () => {
    const p = prompt(), receipt = loaded(), s = start('call');
    const events = [p, receipt, receipt, s, { ...s, id: 'retry-start' }, end('call'), end('call')];
    expect(graph(events).nodes).toHaveLength(1);
    expect(graph(events).nodes[0]).toMatchObject({ count: 2, status: 'completed' });
    const enriched = { ...receipt, body: { ...receipt.body, skills: [{ name: 'different', source: 'builtin', reason: 'current-context', status: 'loaded', characters: 100 }], characters: 100, budgetCharacters: 1000 } } as ExtaliaEvent;
    expect(graph([p, receipt, enriched]).nodes[0]!.label).toBe('different');
  });

  it('attributes parallel owners, real nested parents and saved team membership without conflating identical skills', () => {
    const events = [prompt(), e({ type: 'subagent.spawned', subagentId: 'one', label: 'Researcher' }),
      e({ type: 'subagent.spawned', subagentId: 'two', label: 'Nested checker' }, 'one'), loaded(), loaded('one'), loaded('two'), start('same-call', 'one'), start('same-call', 'two'), end('same-call', 'one')];
    const projected = graph(events);
    expect(projected.nodes.map(node => [node.agentId, node.status])).toEqual([['primary', 'loaded'], ['one', 'completed'], ['two', 'active']]);
    expect(new Set(projected.nodes.map(node => node.id)).size).toBe(3);
    expect(new Set(projected.nodes.map(node => node.resourceKey)).size).toBe(1);
    expect(projected.agents.find(agent => agent.id === 'one')).toMatchObject({ parentId: 'primary', label: 'Researcher', teamId: 'session-team' });
    expect(projected.agents.find(agent => agent.id === 'two')).toMatchObject({ parentId: 'one' });
    expect(projected.teams).toEqual([{ id: 'session-team', label: 'Saved team' }]);
    expect(projected.agents).toHaveLength(3);
  });

  it('keeps a resource active until every concurrent access settles and shows truthful failures', () => {
    const events = [prompt(), start('one', 'primary', 'knowledge_read', 'notes/review.md'), start('two', 'primary', 'knowledge_read', 'notes/review.md'), end('one', 'primary', true, 'knowledge_read', 'notes/review.md')];
    expect(graph(events).nodes[0]).toMatchObject({ kind: 'knowledge', status: 'active', count: 2 });
    events.push(end('two', 'primary', false, 'knowledge_read', 'notes/review.md'));
    expect(graph(events).nodes[0]!.status).toBe('failed');
  });

  it('does not infer note identity from generic tool text, output JSON, query labels, or discovery metadata', () => {
    const events = [prompt(), start('discovery', 'primary', 'skill_list', null), end('discovery', 'primary', true, 'skill_list', null),
      e({ type: 'tool.completed', tool: 'knowledge_search', kind: 'knowledge', label: 'Searching knowledge', ok: true, output: '{"path":"secret.md"}' }),
      e({ type: 'model.completed', text: 'I used a different secret skill.' })];
    const projected = graph(events);
    expect(projected.nodes.every(node => node.kind === 'knowledge')).toBe(true);
    expect(projected.nodes.every(node => node.resourceKey === undefined)).toBe(true);
    expect(JSON.stringify(projected)).not.toContain('secret');
  });

  it('supports completion-only Observe evidence and canonical MCP resource names without invented starts', () => {
    const result = graph([end('observed', 'member', true, 'mcp__workspace__skill_read')]);
    expect(result.nodes[0]).toMatchObject({ kind: 'skill', status: 'completed', agentId: 'member', count: 1 });
    expect(graph([start('mcp', 'member', 'mcp__workspace__knowledge_read', 'notes/a.md')]).nodes[0]).toMatchObject({ kind: 'knowledge', status: 'active' });
  });

  it('retains the active run on steer and worker prompts, resets on a new primary turn, and closes meeting-only runs', () => {
    const events = [prompt(), loaded(), e({ type: 'subagent.spawned', subagentId: 'one' }), e({ type: 'prompt.submitted', text: 'Worker task', via: 'extalia' }, 'one'), prompt()];
    const initial = graph(events); expect(initial.nodes).toHaveLength(1);
    events.push(e({ type: 'turn.completed' }), prompt(), loaded('primary', 'new-review'));
    expect(graph(events).scopeKey).not.toBe(initial.scopeKey);
    expect(graph(events).nodes.map(node => node.label)).toEqual(['new-review']);
    const meeting = [e({ type: 'meeting.started', meetingId: 'meeting', participants: [] }), loaded(), e({ type: 'meeting.completed', meetingId: 'meeting' }), prompt(), loaded('primary', 'after-meeting')];
    expect(graph(meeting).nodes.map(node => node.label)).toEqual(['after-meeting']);
  });

  it('does not mark an unacknowledged access successful on terminal events, and keeps owner approvals independent', () => {
    const events = [prompt(), start('pending'), e({ type: 'approval.requested', approvalId: 'one', action: 'Write elsewhere' }), e({ type: 'approval.requested', approvalId: 'two', action: 'Write another file' }), e({ type: 'approval.resolved', approvalId: 'one', decision: 'granted', by: 'user' })];
    expect(graph(events).agents[0]!.status).toBe('waiting');
    expect(graph(events).nodes[0]!.status).toBe('active');
    events.push(e({ type: 'approval.resolved', approvalId: 'two', decision: 'granted', by: 'user' }));
    expect(graph(events).agents[0]!.status).toBe('active');
    events.push(e({ type: 'turn.failed', error: 'Interrupted', reason: 'interrupted' }));
    expect(graph(events).nodes[0]!.status).toBe('unknown');
  });

  it('retains known agent metadata across turns without inventing saved inactive roster activity', () => {
    const events = [e({ type: 'agent.created', name: 'Known lead' }), e({ type: 'subagent.spawned', subagentId: 'known', label: 'Known worker' }), prompt(), loaded('known')];
    expect(graph(events).agents).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'known', label: 'Known worker', parentId: 'primary' })]));
    expect(graph(events).agents.some(agent => agent.id === 'one')).toBe(false);
    expect(graph(events).agents).toContainEqual(expect.objectContaining({ id: 'primary', label: 'Known lead' }));
  });

  it('does not merge exact resource accessors across prepared registry revisions', () => {
    const one = loaded('one'), two = loaded('two');
    if (one.body.type === 'skills.loaded') one.body.skills[0]!.revisionId = 'skr_' + 'a'.repeat(64);
    if (two.body.type === 'skills.loaded') two.body.skills[0]!.revisionId = 'skr_' + 'b'.repeat(64);
    const result = graph([prompt(), one, two]);
    expect(new Set(result.nodes.map(node => node.resourceKey)).size).toBe(2);
  });

  it('bounds resources, owners, evidence history and input horizon while preserving event/session isolation', () => {
    const events = [prompt(), ...Array.from({ length: 300 }, (_, index) => start(`read-${index}`, 'primary', 'knowledge_read', `notes/${index}.md`))];
    const result = graph(events); expect(result.nodes).toHaveLength(256); expect(result.truncated).toBe(true);
    expect(graph([loaded('primary', 'other')], { sessionId: 'other' }).nodes).toEqual([]);
    expect(graph([prompt(), loaded()], { scopeKey: 'different-profile' }).scopeKey).not.toBe(graph([prompt(), loaded()]).scopeKey);
    const history = Array.from({ length: 20_010 }, (_, index) => e({ type: 'model.delta', text: 'Token' }, 'primary', `token-${index}`));
    expect(graph(history).truncated).toBe(true);
  });
});


describe('resource projection lifetime and ambiguous sources', () => {
  it('settles only a failed Native worker after idle/error while other parallel resource accesses continue', () => {
    const events = [prompt(), e({ type: 'subagent.spawned', subagentId: 'one', label: 'Researcher' }),
      e({ type: 'subagent.spawned', subagentId: 'two', label: 'Reviewer' }),
      start('lead', 'primary', 'skill_read', 'planning'),
      start('notes', 'one', 'knowledge_read', 'notes/research.md'),
      start('reference', 'one', 'skill_read', 'research'),
      start('review', 'two', 'skill_read', 'verification')];
    const project = createResourceUsageProjection(options), initial = project([...events]);
    expect(initial.nodes.filter(node => node.status === 'active')).toHaveLength(4);
    events.push(e({ type: 'subagent.state', subagentId: 'one', state: 'idle' }));
    expect(project([...events]).nodes.filter(node => node.agentId === 'one' && node.status === 'active')).toHaveLength(2);
    const failure = e({ type: 'agent.error', message: 'Worker provider failed' }, 'one'); events.push(failure);
    const failed = project([...events]);
    expect(failed).not.toBe(initial);
    expect(failed.agents.find(agent => agent.id === 'one')!.status).toBe('failed');
    expect(failed.nodes.filter(node => node.agentId === 'one').map(node => node.status)).toEqual(['failed', 'failed']);
    expect(failed.nodes.filter(node => node.agentId === 'one').every(node => node.evidenceIds.includes(failure.id))).toBe(true);
    expect(failed.nodes.filter(node => node.status === 'active').map(node => node.agentId)).toEqual(['primary', 'two']);
    events.push(end('review', 'two', true, 'skill_read', 'verification'));
    expect(project([...events]).nodes.filter(node => node.status === 'active').map(node => node.agentId)).toEqual(['primary']);
    events.push(end('lead', 'primary', true, 'skill_read', 'planning'));
    expect(project([...events]).nodes.some(node => node.status === 'active')).toBe(false);
    expect(project([...events]).nodes.map(node => node.id)).toEqual(initial.nodes.map(node => node.id));
  });
  it('preserves independent calls on recoverable errors and generic roster updates', () => {
    const events = [prompt(), start('read', 'one')];
    for (const body of [{ type: 'agent.error', message: 'Retrying', recoverable: true },
      { type: 'subagent.state', subagentId: 'one', state: 'idle' },
      { type: 'subagent.state', subagentId: 'one', state: 'blocked' }] satisfies EventBody[]) {
      events.push(e(body, 'one'));
      expect(graph(events).nodes[0]!.status).toBe('active');
    }
    events.push(end('read', 'one'));
    expect(graph(events).nodes[0]!.status).toBe('completed');
  });
  it.each(['error', 'interrupted', 'ended', 'offline'] as const)('closes explicit %s lifecycle only for the reported worker', phase => {
    const event = e({ type: 'subagent.state', subagentId: 'one', state: phase === 'offline' ? 'offline' : 'idle', ...(phase === 'offline' ? {} : { phase }) });
    const result = graph([prompt(), start('one', 'one'), start('two', 'two'), event]);
    expect(result.nodes.find(node => node.agentId === 'one')!.status).toBe(phase === 'error' ? 'failed' : 'unknown');
    expect(result.nodes.find(node => node.agentId === 'two')!.status).toBe('active');
  });
  it('does not rewrite an already completed resource when its owner fails later', () => {
    const result = graph([prompt(), start('done', 'one'), end('done', 'one'), e({ type: 'agent.error', message: 'Later provider failure' }, 'one'),
      e({ type: 'subagent.state', subagentId: 'one', state: 'idle' })]);
    expect(result.nodes[0]!.status).toBe('completed');
    expect(result.agents[0]!.status).toBe('failed');
  });
  it('does not reopen a failed invocation on late replay, but accepts a fresh worker access', () => {
    const events = [prompt(), start('old', 'one'), e({ type: 'agent.error', message: 'Worker stopped' }, 'one'), start('old', 'one'), end('old', 'one')];
    const stopped = graph(events);
    expect(stopped.nodes[0]).toMatchObject({ status: 'failed', count: 1 });
    events.push(e({ type: 'subagent.spawned', subagentId: 'one', label: 'Researcher' }), start('new', 'one'));
    expect(graph(events).nodes[0]).toMatchObject({ status: 'active', count: 2 });
    events.push(end('new', 'one'));
    expect(graph(events).nodes[0]!.status).toBe('completed');
  });
  it('keeps independently running children live after the lead finishes, until their own terminal or session shutdown', () => {
    const events = [prompt(), start('lead'), start('child', 'one'), e({ type: 'turn.completed' })];
    let result = graph(events);
    expect(result.nodes.find(node => node.agentId === 'primary')!.status).toBe('unknown');
    expect(result.nodes.find(node => node.agentId === 'one')!.status).toBe('active');
    events.push(e({ type: 'session.ended' })); result = graph(events);
    expect(result.nodes.some(node => node.status === 'active')).toBe(false);
  });
  it('starts a new resource scope after a nonrecoverable lead error, but not a recoverable warning', () => {
    const events = [prompt(), loaded(), e({ type: 'agent.error', message: 'Temporary warning', recoverable: true }), prompt()];
    const previous = graph(events); expect(previous.nodes).toHaveLength(1);
    events.push(e({ type: 'agent.error', message: 'Lead stopped' }), prompt(), loaded('primary', 'new-run'));
    expect(graph(events).scopeKey).not.toBe(previous.scopeKey);
    expect(graph(events).nodes.map(node => node.label)).toEqual(['new-run']);
  });
  it('uses explicit lead shutdown as a run boundary without confusing lead-wrapped worker shutdown', () => {
    const events = [prompt(), loaded(), e({ type: 'subagent.state', subagentId: 'one', state: 'idle', phase: 'error' }), prompt()];
    const before = graph(events); expect(before.nodes).toHaveLength(1);
    events.push(e({ type: 'agent.state', state: 'idle', phase: 'error' }), prompt(), loaded('primary', 'after-error'));
    expect(graph(events).scopeKey).not.toBe(before.scopeKey);
    expect(graph(events).nodes.map(node => node.label)).toEqual(['after-error']);
  });
  it('stops a known skill access when its completion omits optional target metadata', () => {
    const complete = end('read');
    if (complete.body.type === 'tool.completed') delete complete.body.target;
    const result = graph([prompt(), loaded(), start('read'), complete]);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.status).toBe('completed');
    const idlessStart = start('read'), idlessEnd = end('read');
    if (idlessStart.body.type === 'tool.started') delete idlessStart.body.toolCallId;
    if (idlessEnd.body.type === 'tool.completed') { delete idlessEnd.body.toolCallId; delete idlessEnd.body.target; }
    expect(graph([prompt(), idlessStart, idlessEnd]).nodes[0]!.status).toBe('completed');
  });
  it('matches id-less parallel calls by exact target and does not retain false pulses when targets are missing', () => {
    const a = start('a', 'primary', 'knowledge_read', 'a.md'), b = start('b', 'primary', 'knowledge_read', 'b.md');
    if (a.body.type === 'tool.started') delete a.body.toolCallId;
    if (b.body.type === 'tool.started') delete b.body.toolCallId;
    const complete = end('missing', 'primary', true, 'knowledge_read', 'a.md');
    if (complete.body.type === 'tool.completed') delete complete.body.toolCallId;
    expect(graph([prompt(), a, b, complete]).nodes.map(node => [node.label, node.status])).toEqual([['a.md', 'completed'], ['b.md', 'active']]);
    if (complete.body.type === 'tool.completed') delete complete.body.target;
    expect(graph([prompt(), a, b, complete]).nodes.filter(node => node.status === 'active')).toEqual([]);
  });
  it('respects failed/cancelled meeting outcomes without claiming successful work', () => {
    for (const outcome of ['failed', 'cancelled'] as const) {
      const result = graph([e({ type: 'meeting.started', meetingId: 'meeting', participants: [] }), loaded(), e({ type: 'meeting.completed', meetingId: 'meeting', outcome })]);
      expect(result.agents[0]!.status).toBe(outcome === 'failed' ? 'failed' : 'unknown');
    }
  });
  it('reuses graph identity on text tokens but replaces it after real evidence changes or authoritative redaction', () => {
    const project = createResourceUsageProjection(options), events = [prompt(), loaded()];
    const initial = project(events), textOnly = [...events, e({ type: 'model.delta', text: 'Another token' })];
    expect(project(textOnly)).toBe(initial);
    const changed = [...textOnly, start('read')]; expect(project(changed)).not.toBe(initial);
    expect(project([]).nodes).toEqual([]);
  });
});


it('uses explicit Observe skill-file read metadata without guessing from shell commands or chat text', () => {
  const events = [prompt(), e({ type: 'file.read', path: '/example/skills/review/SKILL.md' }, 'reader'),
    e({ type: 'tool.started', toolCallId: 'read-file', tool: 'read_file', kind: 'read', label: 'Read instruction file', target: '/example/skills/check/SKILL.md' }, 'reader'),
    e({ type: 'command.started', command: 'cat /example/skills/guess/SKILL.md' })];
  const result = graph(events);
  expect(result.nodes.map(node => [node.label, node.status])).toEqual([['review/SKILL.md', 'completed'], ['check/SKILL.md', 'active']]);
  expect(JSON.stringify(result)).not.toContain('guess');
});


it('uses canonical lead identity and stored Office name, never promotes an unannounced worker prompt', () => {
  const result = graph([e({ type: 'agent.created', name: 'Generic lead' }), prompt(), loaded(), e({ type: 'prompt.submitted', text: 'Worker-only prompt', via: 'native' }, 'unannounced'), loaded('unannounced')], { primaryName: 'Stored lead name' });
  expect(result.agents.find(agent => agent.id === 'primary')).toMatchObject({ label: 'Stored lead name', role: 'primary' });
  expect(result.agents.find(agent => agent.id === 'unannounced')).toMatchObject({ role: 'unknown' });
  expect(result.nodes).toHaveLength(2);
  const workerOnly = graph([e({ type: 'prompt.submitted', text: 'Worker-only prompt', via: 'native' }, 'unknown-worker'), loaded('unknown-worker')]);
  expect(workerOnly.agents.some(agent => agent.role === 'primary')).toBe(false);
});
