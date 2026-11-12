import type { TeamMember } from '@extalia/core';
import type { EventBody } from '@extalia/protocol';
import type { AnyTool, ModelRequest, ModelResult, NativeMeetingMinutes } from '@extalia/runtime';
import { describe, expect, it, vi } from 'vitest';
import { runNativeKnowledgeMeeting, type NativeKnowledgeMeetingOptions } from '../src/nativeKnowledgeMeeting.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const reply = (text: string): ModelResult => ({ text, toolCalls: [], stop: 'end' });
const readTool = (name: string, access: AnyTool['access']): AnyTool => ({ name, access, kind: 'read', description: name,
  parameters: { type: 'object', properties: {} }, describe: () => ({ label: name }), run: async () => ({ ok: true, output: 'project evidence' }) });

function harness(script?: (request: ModelRequest, member: TeamMember) => Promise<ModelResult>, count = 2) {
  const controller = new AbortController();
  const requests: ModelRequest[] = [];
  const events: EventBody[] = [];
  const saved: NativeMeetingMinutes[] = [];
  const workers = new Set<string>();
  const members: TeamMember[] = Array.from({ length: count }, (_, index) => ({ id: `member-${index}`, name: `Reviewer ${index}`, role: 'Reviewer', models: ['approved-model'], access: 'write' }));
  const options: NativeKnowledgeMeetingOptions = {
    workspace: { id: 'workspace-one', name: 'Example project', root: '/projects/example' }, sessionId: 'session-one', runId: 'run-one',
    sourceContext: 'The task verified the existing project configuration.', signal: controller.signal, assertCurrent: vi.fn(),
    team: {
      members, leadModels: ['approved-model'],
      providerForModel: (_model, member) => ({ api: 'openai-chat', listModels: async () => [], complete: async request => {
        requests.push(request);
        expect(events.some(event => event.type === 'meeting.started')).toBe(true);
        return script ? script(request, member!) : reply(`${member!.id} verified finding ${requests.length}`);
      } }),
      workerToolsForMember: () => [readTool('read_file', 'read'), readTool('memory_read', 'memory'), readTool('write_file', 'write'), readTool('run_command', 'execute')],
    },
    emit: async body => { events.push(body); },
    onWorkerStarted: id => { workers.add(id); }, onWorkerSettled: id => { workers.delete(id); },
    onMinutes: async minutes => { saved.push(structuredClone(minutes)); return 'Meetings/workspace-one/example.md'; },
  };
  return { options, controller, requests, events, saved, workers };
}

describe('native knowledge meeting execution', () => {
  it('redacts externally supplied context before clipping provider, activity and minutes text', async () => {
    const h = harness(undefined, 1);
    const credential = 'synthetic-credential-'.repeat(80);
    h.options.sourceContext = `Authorization: Bearer ${credential}\nDecision: reject invalid input before saving.`;
    expect(await runNativeKnowledgeMeeting(h.options)).toMatchObject({ outcome: 'completed', knowledge: 'saved' });
    for (const projection of [h.requests, h.events, h.saved]) {
      const text = JSON.stringify(projection);
      expect(text).not.toContain('synthetic-credential-');
      expect(text).toContain('[redacted]');
      expect(text).toContain('Decision: reject invalid input before saving.');
    }
  });

  it('runs two actual read-only rounds and reports saved knowledge only after the minutes writer acknowledges', async () => {
    const h = harness();
    h.options.sourceContext = 'Older task evidence. '.repeat(200) + 'Latest verified finding: the project configuration is valid.';
    const writing = deferred<void>();
    const persisted = deferred<string>();
    h.options.onMinutes = async minutes => { h.saved.push(minutes); writing.resolve(); return persisted.promise; };
    let returned = false;
    const running = runNativeKnowledgeMeeting(h.options).then(result => { returned = true; return result; });
    await writing.promise;
    expect(returned).toBe(false);
    expect(h.events.some(event => event.type === 'meeting.completed')).toBe(false);
    expect(h.requests).toHaveLength(4);
    expect(h.saved[0]?.contributions).toHaveLength(4);
    expect(h.saved[0]?.topic.length).toBeLessThanOrEqual(2_000);
    expect(h.saved[0]?.topic).toContain('Source session: session-one; completed run: run-one.');
    expect(h.saved[0]?.topic).toContain('Latest verified finding: the project configuration is valid.');
    for (const request of h.requests) expect(request.tools.map(tool => tool.name)).toEqual(['read_file', 'memory_read']);
    for (const request of h.requests.slice(2)) {
      expect(request.messages[0]).toMatchObject({ role: 'user', text: expect.stringContaining('member-0 verified finding 1') });
      expect(request.messages[0]).toMatchObject({ text: expect.stringContaining('member-1 verified finding 2') });
    }
    persisted.resolve('Meetings/workspace-one/acknowledged.md');
    expect(await running).toEqual({ outcome: 'completed', knowledge: 'saved', meetingId: h.saved[0]!.meetingId, notePath: 'Meetings/workspace-one/acknowledged.md' });
    expect(h.workers.size).toBe(0);
    expect(h.events.at(-1)).toMatchObject({ type: 'meeting.completed', outcome: 'completed', notePath: 'Meetings/workspace-one/acknowledged.md' });
  });

  it('forwards fresh participant skill preparation to both real rounds without widening read-only tools', async () => {
    const h = harness();
    const prepared: string[] = [];
    const preparedSystems: string[] = [];
    h.options.prepareWorkerRequest = (selected, agentId) => {
      expect(selected?.id).toBe(agentId);
      return async request => {
        prepared.push(agentId);
        expect(request.tools.map(tool => tool.name)).toEqual(['read_file', 'memory_read']);
        const system = `${request.system}\nFresh skill context for ${agentId}; preparation ${prepared.length}.`;
        preparedSystems.push(system);
        return system;
      };
    };
    expect(await runNativeKnowledgeMeeting(h.options)).toMatchObject({ outcome: 'completed', knowledge: 'saved' });
    expect(prepared).toEqual(['member-0', 'member-1', 'member-0', 'member-1']);
    expect(h.requests.map(request => request.system)).toEqual(preparedSystems);
    expect(h.requests).toHaveLength(4);
    expect(h.workers.size).toBe(0);
  });

  it.each(['missing', 'unavailable', 'failed'] as const)('does not claim knowledge saved when the exporter is %s', async mode => {
    const h = harness(undefined, 1);
    h.options.onMinutes = mode === 'missing' ? undefined : async () => {
      if (mode === 'failed') throw new Error('private exporter details');
      return undefined;
    };
    const result = await runNativeKnowledgeMeeting(h.options);
    expect(result).toMatchObject({ outcome: 'completed', knowledge: mode === 'failed' ? 'failed' : 'unavailable' });
    expect(result.notePath).toBeUndefined();
    expect(result.problem).not.toContain('private exporter details');
    expect(h.requests).toHaveLength(2);
    expect(h.events.at(-1)).toMatchObject({ type: 'meeting.completed', outcome: 'completed' });
    expect(h.events.at(-1)).not.toHaveProperty('notePath');
  });

  it('retains ownership until an abort-ignoring provider physically settles, and exports only actual partial minutes', async () => {
    const entered = deferred<void>();
    const settled = deferred<ModelResult>();
    const h = harness(async () => { entered.resolve(); return settled.promise; }, 1);
    let returned = false;
    const running = runNativeKnowledgeMeeting(h.options).then(result => { returned = true; return result; });
    await entered.promise;
    h.controller.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(returned).toBe(false);
    expect(h.workers.size).toBe(1);
    expect(h.saved).toEqual([]);
    expect(h.events.some(event => event.type === 'meeting.completed')).toBe(false);
    settled.resolve(reply('Late ignored response'));
    expect(await running).toMatchObject({ outcome: 'cancelled', knowledge: 'saved', notePath: 'Meetings/workspace-one/example.md' });
    expect(h.requests).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({ outcome: 'cancelled', contributions: [] });
    expect(h.workers.size).toBe(0);
  });

  it('refuses stale authority before provider entry and rechecks it before writing minutes', async () => {
    const blocked = harness();
    blocked.options.assertCurrent = () => { throw new Error('private profile details'); };
    expect(await runNativeKnowledgeMeeting(blocked.options)).toMatchObject({ outcome: 'failed', knowledge: 'unavailable' });
    expect(blocked.requests).toEqual([]);
    expect(blocked.events).toEqual([]);

    let current = true;
    let calls = 0;
    const h = harness(async () => { if (++calls === 2) current = false; return reply('Actual finding'); }, 1);
    h.options.assertCurrent = () => { if (!current) throw new Error('Profile changed'); };
    expect(await runNativeKnowledgeMeeting(h.options)).toMatchObject({ outcome: 'completed', knowledge: 'failed' });
    expect(h.requests).toHaveLength(2);
    expect(h.saved).toEqual([]);
  });

  it('rechecks authority before the second round instead of reusing source-run permissions', async () => {
    let current = true;
    const h = harness(async () => { current = false; return reply('First-round finding'); }, 1);
    h.options.assertCurrent = () => { if (!current) throw new Error('Profile changed'); };
    expect(await runNativeKnowledgeMeeting(h.options)).toMatchObject({ outcome: 'cancelled', knowledge: 'failed' });
    expect(h.requests).toHaveLength(1);
    expect(h.saved).toEqual([]);
    expect(h.workers.size).toBe(0);
  });

  it('waits for strict start persistence and refuses a rejected start before any provider request', async () => {
    const h = harness();
    const start = deferred<void>();
    const persisted = deferred<void>();
    h.options.emit = async body => {
      if (body.type === 'meeting.started') { start.resolve(); await persisted.promise; throw new Error('private persistence details'); }
      h.events.push(body);
    };
    const running = runNativeKnowledgeMeeting(h.options);
    await start.promise;
    expect(h.requests).toEqual([]);
    persisted.resolve();
    expect(await running).toMatchObject({ outcome: 'failed', knowledge: 'unavailable', problem: 'Meeting activity could not be recorded.' });
    expect(h.requests).toEqual([]);
    expect(h.saved).toEqual([]);
  });

  it('keeps an acknowledged note receipt when the later terminal activity write fails', async () => {
    const h = harness(undefined, 1);
    h.options.emit = async body => { if (body.type === 'meeting.completed') throw new Error('terminal write failed'); h.events.push(body); };
    expect(await runNativeKnowledgeMeeting(h.options)).toMatchObject({
      outcome: 'completed', knowledge: 'saved', notePath: 'Meetings/workspace-one/example.md', problem: 'Meeting activity could not be recorded.',
    });
    expect(h.workers.size).toBe(0);
  });
});
