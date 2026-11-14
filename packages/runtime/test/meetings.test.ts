import type { TeamMember } from '@extalia/core';
import type { EventBody } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { createConductTeamMeetingTool, type AnyTool, type ModelProvider, type ModelRequest, type ModelResult, type NativeMeetingMinutes } from '../src/index.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const reply = (text: string): ModelResult => ({ text, toolCalls: [], stop: 'end' });
const member = (index: number): TeamMember => ({ id: `member-${index}`, name: `Member ${index}`, role: 'Reviewer', models: [`model-${index}`], access: 'write' });
const tool = (name: string, access: AnyTool['access']): AnyTool => ({ name, access, kind: 'read', description: name,
  parameters: { type: 'object', properties: {} }, describe: () => ({ label: name }), run: async () => ({ ok: true, output: 'data' }) });

function harness(script?: (id: string, request: ModelRequest) => Promise<ModelResult> | ModelResult, count = 2) {
  const members = Array.from({ length: count }, (_, index) => member(index));
  const requests: { id: string; request: ModelRequest }[] = [];
  const events: { body: EventBody; agentId?: string }[] = [];
  const minutes: NativeMeetingMinutes[] = [];
  const workers = new Set<string>();
  const routes: { model: string; memberId?: string }[] = [];
  const calls = new Map<string, number>();
  const controller = new AbortController();
  const options: Parameters<typeof createConductTeamMeetingTool>[0] = {
    team: {
      members, leadModels: ['lead-model'],
      providerForModel: (model, selected) => {
        routes.push({ model, memberId: selected?.id });
        const id = selected!.id;
        const provider: ModelProvider = { api: 'openai-chat', listModels: async () => [], complete: async request => {
          requests.push({ id, request });
          calls.set(id, (calls.get(id) ?? 0) + 1);
          return script ? script(id, request) : reply(`${id} real round ${calls.get(id)} findings`);
        } };
        return provider;
      },
      workerToolsForMember: () => [tool('read_file', 'read'), tool('write_file', 'write'), tool('run_command', 'execute'),
        tool('memory_read', 'memory'), tool('memory_write', 'memory'), tool('manage_team', 'meta')],
    },
    workspace: { name: 'Project', root: '/projects/example' },
    emit: async (body, agentId) => { events.push({ body, agentId }); },
    emitWorkerEvent: () => undefined,
    onWorkerStarted: id => { workers.add(id); }, onWorkerSettled: id => { workers.delete(id); },
    onMinutes: async record => { minutes.push(record); return 'meetings/example.md'; },
    newId: () => 'meeting-test',
  };
  const context = { signal: controller.signal, toolCallId: 'meeting-call', emit: () => undefined };
  return { options, context, members, requests, events, minutes, workers, routes, controller };
}

describe('conduct_team_meeting', () => {
  it('reserves bounded synthesis so an evidence-heavy participant can finish both manual rounds', async () => {
    const h = harness((_id, request) => request.tools.length
      ? { text: '', toolCalls: [{ id: `read-${request.messages.length}`, name: 'read_file', input: {} }], stop: 'tool_use' }
      : reply('Attributed findings; remaining questions need more evidence.'), 1);
    const result = await createConductTeamMeetingTool(h.options).run({ topic: 'Review evidence', members: ['member-0'] }, h.context);
    expect(result.ok).toBe(true);
    expect(h.requests).toHaveLength(12);
    expect(h.requests.filter(({ request }) => !request.tools.length)).toHaveLength(2);
    expect(h.requests[5]!.request.system).toContain('final bounded response');
    expect(h.requests[0]!.request.messages[0]).toMatchObject({ role: 'user', text: expect.stringContaining('5 evidence steps') });
    expect(h.minutes[0]).toMatchObject({ outcome: 'completed', contributions: [{ round: 1 }, { round: 2 }] });
  });

  it('does not execute tools or fabricate success when a participant ignores bounded synthesis', async () => {
    let reads = 0;
    const h = harness(() => ({ text: '', toolCalls: [{ id: `call-${reads}`, name: 'read_file', input: {} }], stop: 'tool_use' }), 1);
    h.options.team.workerToolsForMember = () => [{ ...tool('read_file', 'read'), run: async () => { reads++; return { ok: true, output: 'evidence' }; } }];
    const result = await createConductTeamMeetingTool(h.options).run({ topic: 'Review evidence', members: ['member-0'] }, h.context);
    expect(result.ok).toBe(false);
    expect(reads).toBe(5);
    expect(h.requests).toHaveLength(6);
    expect(h.minutes[0]?.outcome).toBe('failed');
  });

  it('reserves the last host-selected step and describes its actual one-round budget', async () => {
    const h = harness((_id, request) => request.tools.length
      ? { text: '', toolCalls: [{ id: `read-${request.messages.length}`, name: 'read_file', input: {} }], stop: 'tool_use' }
      : reply('A bounded source-attributed finding.'), 1);
    h.options.limits = { rounds: 1, maxWorkerSteps: 3 };
    const result = await createConductTeamMeetingTool(h.options).run({ topic: 'Review supplied evidence', members: ['member-0'] }, h.context);
    expect(result.ok).toBe(true);
    expect(h.requests).toHaveLength(3);
    expect(h.requests[0]!.request.messages[0]).toMatchObject({ role: 'user', text: expect.stringContaining('2 evidence steps') });
    expect(h.requests[2]!.request.tools).toEqual([]);
    expect(h.minutes[0]).toMatchObject({ outcome: 'completed', contributions: [{ round: 1 }] });
  });

  it('supports a host-selected one-round review without changing manual meeting defaults', async () => {
    const h = harness();
    h.options.limits = { rounds: 1, maxWorkerSteps: 3 };
    const meeting = createConductTeamMeetingTool(h.options);
    expect(meeting.description).toContain('One read-only round');
    expect((await meeting.run({ topic: 'Review supplied evidence', members: ['member-0', 'member-1'] }, h.context)).ok).toBe(true);
    expect(h.requests).toHaveLength(2);
    expect(h.minutes[0]?.contributions).toHaveLength(2);
    expect(h.minutes[0]?.contributions.every(item => item.round === 1)).toBe(true);
    expect(h.requests.every(({ request }) => request.messages[0]?.role === 'user' && request.messages[0].text.includes('Round 1 of 1'))).toBe(true);
  });

  it('caps review worker steps using host options that model arguments cannot widen', async () => {
    let calls = 0;
    const h = harness(() => ({ text: '', stop: 'tool_use', toolCalls: [{ id: `read-${++calls}`, name: 'read_file', input: {} }] }), 1);
    h.options.limits = { rounds: 1, maxWorkerSteps: 3 };
    const meeting = createConductTeamMeetingTool(h.options);
    expect(meeting.parameters.properties).not.toHaveProperty('limits');
    expect((await meeting.run({ topic: 'Review', members: ['member-0'] }, h.context)).ok).toBe(false);
    expect(h.requests).toHaveLength(3);
    expect(h.minutes[0]?.outcome).toBe('failed');
    expect(h.workers.size).toBe(0);
  });

  it.each([0, 7, Number.NaN, 1.5])('refuses invalid host worker step limit %s', maxWorkerSteps => {
    const h = harness();
    expect(() => createConductTeamMeetingTool({ ...h.options, limits: { maxWorkerSteps } })).toThrow('worker steps');
    expect(h.requests).toEqual([]);
  });

  it('prepares each participant independently in both rounds without widening discussion tools', async () => {
    const h = harness(), prepared: string[] = [];
    h.options.prepareWorkerRequest = (selected, agentId) => async request => {
      prepared.push(agentId);
      expect(selected?.id).toBe(agentId);
      expect(request.tools.some(tool => ['write_file', 'run_command', 'memory_write', 'manage_team'].includes(tool.name))).toBe(false);
      return `${request.system}\nprepared-for:${agentId}`;
    };
    expect((await createConductTeamMeetingTool(h.options).run({ topic: 'Review', members: ['member-0', 'member-1'] }, h.context)).ok).toBe(true);
    expect(prepared.sort()).toEqual(['member-0', 'member-0', 'member-1', 'member-1']);
    for (const request of h.requests) expect(request.request.system).toContain(`prepared-for:${request.id}`);
  });
  it('runs two real rounds with shared first-round evidence and only read tools even for writers', async () => {
    const h = harness();
    const meeting = createConductTeamMeetingTool(h.options);
    const result = await meeting.run({ topic: 'Choose an implementation plan', members: ['Member 0', 'member-1'], roomId: 'meeting-a' }, h.context);
    expect(result.ok).toBe(true);
    expect(meeting.parallel).toBeUndefined();
    expect(h.events.slice(0, 2).map(event => event.body)).toEqual([
      { type: 'subagent.spawned', subagentId: 'member-0', role: 'Reviewer', label: 'Member 0' },
      { type: 'subagent.spawned', subagentId: 'member-1', role: 'Reviewer', label: 'Member 1' },
    ]);
    expect(h.events[2]?.body).toEqual({ type: 'meeting.started', meetingId: 'meeting-test', topic: 'Choose an implementation plan', roomId: 'meeting-a', participants: ['primary', 'member-0', 'member-1'] });
    expect(h.requests).toHaveLength(4);
    for (const { request } of h.requests) {
      expect(request.tools.map(offered => offered.name)).toEqual(['read_file', 'memory_read']);
      expect(request.system).toContain('You cannot edit files or run commands');
    }
    for (const { request } of h.requests.slice(2)) {
      const prompt = request.messages.find(message => message.role === 'user');
      expect(prompt).toMatchObject({ role: 'user', text: expect.stringContaining('member-0 real round 1 findings') });
      expect(prompt).toMatchObject({ text: expect.stringContaining('member-1 real round 1 findings') });
    }
    expect(h.events.filter(event => event.body.type === 'meeting.contribution')).toEqual([
      { agentId: 'member-0', body: { type: 'meeting.contribution', meetingId: 'meeting-test', round: 1, text: 'member-0 real round 1 findings' } },
      { agentId: 'member-1', body: { type: 'meeting.contribution', meetingId: 'meeting-test', round: 1, text: 'member-1 real round 1 findings' } },
      { agentId: 'member-0', body: { type: 'meeting.contribution', meetingId: 'meeting-test', round: 2, text: 'member-0 real round 2 findings' } },
      { agentId: 'member-1', body: { type: 'meeting.contribution', meetingId: 'meeting-test', round: 2, text: 'member-1 real round 2 findings' } },
    ]);
    expect(h.events.at(-1)?.body).toEqual({ type: 'meeting.completed', meetingId: 'meeting-test', outcome: 'completed', notePath: 'meetings/example.md' });
    expect(h.routes).toEqual([{ model: 'model-0', memberId: 'member-0' }, { model: 'model-1', memberId: 'member-1' }]);
    expect(h.minutes[0]?.contributions).toHaveLength(4);
    expect(h.workers.size).toBe(0);
    expect(result.output).toContain('member-1 real round 2 findings');
    expect(await meeting.run({ topic: 'Another decision', members: ['member-0'] }, h.context)).toMatchObject({ ok: false, output: expect.stringContaining('limit') });
    expect(h.requests).toHaveLength(4);
  });

  it('refuses unknown, repeated, empty and over-capacity participants without fabricating a meeting', async () => {
    const h = harness(undefined, 13);
    const meeting = createConductTeamMeetingTool(h.options);
    for (const input of [
      { topic: 'Plan', members: ['unknown'] }, { topic: 'Plan', members: ['member-0', 'Member 0'] },
      { topic: 'Plan', members: [] }, { topic: '', members: ['member-0'] },
      { topic: 'Plan', members: h.members.slice(0, 10).map(item => item.id), roomId: 'meeting-a' as const },
      { topic: 'Plan', members: [...h.members.map(item => item.id), 'extra-member'] },
    ]) expect((await meeting.run(input, h.context)).ok).toBe(false);
    expect(h.events).toEqual([]);
    expect(h.requests).toEqual([]);
  });

  it('leaves available-room allocation to the Office while retaining the 14-seat and eight-worker ceilings', async () => {
    const h = harness(id => reply(`${id}: ${'e'.repeat(2500)}`), 13);
    let peak = 0;
    h.options.onWorkerStarted = id => { h.workers.add(id); peak = Math.max(peak, h.workers.size); };
    const result = await createConductTeamMeetingTool(h.options).run({ topic: 'Compare options across the team', members: h.members.map(item => item.id) }, h.context);
    expect(result.ok).toBe(true);
    expect(h.events.find(event => event.body.type === 'meeting.started')?.body).toMatchObject({ participants: ['primary', ...h.members.map(item => item.id)] });
    expect(h.events.find(event => event.body.type === 'meeting.started')?.body).not.toHaveProperty('roomId');
    expect(peak).toBe(8);
    expect(h.requests).toHaveLength(26);
    expect(h.events.filter(event => event.body.type === 'meeting.contribution')).toHaveLength(26);
    expect(h.workers.size).toBe(0);
    expect(result.output.length).toBeLessThan(30_000);
    expect(result.output).toContain('Round 2 · Member 12');
  });

  it('acknowledges the start before providers, and snapshots model/member authority for both rounds', async () => {
    const h = harness();
    const admitted = deferred<void>();
    const entered = deferred<void>();
    h.options.emit = async body => {
      h.events.push({ body });
      if (body.type === 'meeting.started') { entered.resolve(); await admitted.promise; }
    };
    const running = createConductTeamMeetingTool(h.options).run({ topic: 'Plan', members: ['member-0'] }, h.context);
    await entered.promise;
    expect(h.requests).toEqual([]);
    h.members[0]!.models = ['unapproved'];
    h.members.splice(0);
    admitted.resolve();
    expect((await running).ok).toBe(true);
    expect(h.requests).toHaveLength(2);
    expect(h.routes).toEqual([{ model: 'model-0', memberId: 'member-0' }]);
  });

  it('does not start providers or emit a terminal meeting when durable start fails', async () => {
    const h = harness();
    h.options.emit = async body => { if (body.type === 'meeting.started') throw new Error('storage unavailable'); h.events.push({ body }); };
    expect(await createConductTeamMeetingTool(h.options).run({ topic: 'Plan', members: ['member-0'] }, h.context)).toMatchObject({ ok: false, output: expect.stringContaining('storage unavailable') });
    expect(h.requests).toEqual([]);
    expect(h.minutes).toEqual([]);
    expect(h.events.map(event => event.body.type)).toEqual(['subagent.spawned']);
    expect(h.workers.size).toBe(0);
  });

  it('waits for an abort-ignoring entered provider before terminal cancellation and starts no second round', async () => {
    const entered = deferred<void>();
    const settlement = deferred<ModelResult>();
    const h = harness(async () => { entered.resolve(); return settlement.promise; }, 1);
    const running = createConductTeamMeetingTool(h.options).run({ topic: 'Plan', members: ['member-0'] }, h.context);
    await entered.promise;
    h.controller.abort();
    await Promise.resolve();
    expect(h.events.some(event => event.body.type === 'meeting.completed')).toBe(false);
    expect(h.workers.size).toBe(1);
    settlement.resolve(reply('Late output'));
    expect((await running).ok).toBe(false);
    expect(h.events.at(-1)?.body).toMatchObject({ type: 'meeting.completed', outcome: 'cancelled' });
    expect(h.events.some(event => event.body.type === 'meeting.contribution')).toBe(false);
    expect(h.requests).toHaveLength(1);
    expect(h.workers.size).toBe(0);
  });

  it('retains actual successful contributions but closes failed when another provider fails', async () => {
    const h = harness(id => { if (id === 'member-0') throw new Error('provider unavailable'); return reply('Observed evidence'); });
    const outcome = await createConductTeamMeetingTool(h.options).run({ topic: 'Plan', members: ['member-0', 'member-1'] }, h.context);
    expect(outcome.ok).toBe(false);
    expect(h.events.filter(event => event.body.type === 'meeting.contribution')).toEqual([
      { agentId: 'member-1', body: { type: 'meeting.contribution', meetingId: 'meeting-test', round: 1, text: 'Observed evidence' } },
    ]);
    expect(h.events.at(-1)?.body).toMatchObject({ type: 'meeting.completed', outcome: 'failed' });
    expect(h.requests).toHaveLength(2);
    expect(h.workers.size).toBe(0);
  });

  it('does not present empty worker completion wrappers as real contributions', async () => {
    const h = harness(() => reply(''));
    expect((await createConductTeamMeetingTool(h.options).run({ topic: 'Plan', members: ['member-0'] }, h.context)).ok).toBe(false);
    expect(h.events.some(event => event.body.type === 'meeting.contribution')).toBe(false);
    expect(h.events.at(-1)?.body).toMatchObject({ type: 'meeting.completed', outcome: 'failed' });
  });

  it('reports minutes export failure without changing the actual discussion outcome or fabricating a note', async () => {
    const h = harness();
    h.options.onMinutes = async () => { throw new Error('vault unavailable'); };
    const result = await createConductTeamMeetingTool(h.options).run({ topic: 'Plan', members: ['member-0'] }, h.context);
    expect(result).toMatchObject({ ok: true, output: expect.stringContaining('Minutes were not saved') });
    expect(h.events.at(-1)?.body).toEqual({ type: 'meeting.completed', meetingId: 'meeting-test', outcome: 'completed' });
  });
});
