import type { AgentTeam, TeamMember } from '@extalia/core';
import type { EventBody } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { ProviderError, createDelegationTool, createManageTeamTool, runTurn, type AnyTool, type ModelProvider, type ModelRequest } from '../src/index.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const context = (signal = new AbortController().signal) => ({ signal, toolCallId: 'call', emit: () => undefined });
const members: TeamMember[] = [
  { id: 'm-a', name: 'First Reader', role: 'Researcher', connectionId: 'first', models: [] },
  { id: 'm-b', name: 'Second Reader', role: 'Reviewer', connectionId: 'second', models: ['second-model'] },
];
const read: AnyTool = { name: 'read_file', description: 'Read', access: 'read', kind: 'read', parameters: { type: 'object', properties: {} }, describe: () => ({ label: 'Read' }), run: async () => ({ ok: true, output: 'source evidence' }) };

describe('member connection delegation', () => {
  it.each([{ models: ['preferred', 'fallback'] }, { models: [] }])('reports preferred and fallback models on the same member identity (%j)', async ({ models }) => {
    const member = { ...members[0]!, models };
    const events: EventBody[] = [], created: string[] = [], metadataAtCreation: number[] = [], started: string[] = [], settled: string[] = [];
    const tool = createDelegationTool({
      providerFor: () => { throw new Error('unexpected tier'); }, workerTools: [], maxDelegations: 1,
      workspace: { name: 'Example', root: '/projects/example' }, emit: body => {
        events.push(body);
        if (body.type === 'subagent.spawned' && body.model) metadataAtCreation.push(created.length);
      },
      onWorkerStarted: id => { started.push(id); }, onWorkerSettled: id => { settled.push(id); },
      team: {
        members: [member], leadModels: ['lead-model'], modelsForMember: () => ['preferred', 'fallback'],
        providerForModel: (model, selected) => {
          expect(selected).toBe(member);
          created.push(model);
          return { api: 'openai-chat', listModels: async () => { throw new Error('unexpected catalog request'); }, complete: async () => {
            if (model === 'preferred') throw new ProviderError('rate limited', 429, true);
            return { text: 'Fallback findings', toolCalls: [], stop: 'end' };
          } };
        },
      },
    });
    expect(await tool.run({ task: 'Inspect', member: member.id }, context())).toEqual({ ok: true, output: 'Fallback findings' });
    expect(created).toEqual(['preferred', 'fallback']);
    expect(metadataAtCreation).toEqual([0, 1]);
    const metadata = events.filter(event => event.type === 'subagent.spawned' && event.model);
    expect(metadata).toEqual([
      { type: 'subagent.spawned', subagentId: member.id, role: member.role, label: member.name, model: 'preferred' },
      { type: 'subagent.spawned', subagentId: member.id, role: member.role, label: member.name, model: 'fallback' },
    ]);
    expect(events[events.indexOf(metadata[1]!) + 1]).toMatchObject({ type: 'subagent.state', subagentId: member.id, state: 'working', summary: 'Switched to fallback (preferred hit a limit)' });
    expect(started).toHaveLength(1);
    expect(settled).toEqual(started);
  });

  it('runs distinct connections in parallel, executes their tools and forwards findings to the lead', async () => {
    const bothEntered = deferred(), release = deferred();
    const routes: string[] = [], catalogs: string[][] = [], events: { body: EventBody; agentId?: string }[] = [], observations: TeamMember[] = [];
    const tool = createDelegationTool({
      providerFor: () => { throw new Error('unexpected tier'); }, workerTools: [], maxDelegations: 2,
      workspace: { name: 'Example', root: '/projects/example' }, emit: (body, agentId) => events.push({ body, agentId }),
      onWorkerStarted: (_id, _name, member) => { observations.push(member!); },
      team: {
        members, leadModels: ['lead'], modelsForMember: member => member.connectionId === 'first' ? ['first-model'] : ['second-model'],
        workerToolsForMember: () => [read],
        providerForModel: (model, member) => ({ api: 'openai-chat', listModels: async () => [], complete: async request => {
          if (request.messages.at(-1)?.role === 'user') {
            routes.push(`${member!.connectionId}:${model}`);
            catalogs.push(request.tools.map(tool => tool.name));
            if (routes.length === 2) bothEntered.resolve();
            await release.promise;
            return { text: '', toolCalls: [{ id: `read-${member!.id}`, name: 'read_file', input: {} }], stop: 'tool_use' };
          }
          expect(request.messages.at(-1)).toMatchObject({ role: 'tool', results: [{ content: 'source evidence' }] });
          return { text: `${member!.name} verified`, toolCalls: [], stop: 'end' };
        } }),
      },
    });
    const leadRequests: ModelRequest[] = [];
    const lead: ModelProvider = { api: 'openai-chat', listModels: async () => [], complete: async request => {
      leadRequests.push(request);
      return request.messages.at(-1)?.role === 'user'
        ? { text: '', toolCalls: members.map(member => ({ id: member.id, name: 'delegate_task', input: { task: 'Inspect', member: member.id } })), stop: 'tool_use' }
        : { text: 'Combined verified findings', toolCalls: [], stop: 'end' };
    } };
    const turn = runTurn({ provider: lead, system: '', history: [], prompt: 'Inspect', tools: [tool], permissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: new Set(), emit: () => undefined, requestApproval: async () => 'reject', signal: context().signal });
    await bothEntered.promise;
    expect(routes).toEqual(['first:first-model', 'second:second-model']);
    release.resolve();
    expect((await turn).outcome).toBe('completed');
    expect(catalogs).toEqual([['read_file'], ['read_file']]);
    expect(observations).toEqual(members);
    const results = leadRequests.at(-1)!.messages.flatMap(message => message.role === 'tool' ? message.results : []);
    expect(results).toMatchObject([{ content: 'First Reader verified' }, { content: 'Second Reader verified' }]);
    expect(events.filter(({ body }) => body.type === 'tool.completed').map(({ agentId }) => agentId)).toEqual(['m-a', 'm-b']);
  });

  it('serializes one named reader and aborts queued calls without interleaving its Office state or leaking locks', async () => {
    const entered = deferred(), release = deferred();
    const events: EventBody[] = [], started: string[] = [], settled: string[] = [];
    let calls = 0;
    const provider: ModelProvider = { api: 'openai-chat', listModels: async () => [], complete: async () => { if (++calls === 1) { entered.resolve(); await release.promise; } return { text: 'Done', toolCalls: [], stop: 'end' }; } };
    const tool = createDelegationTool({ providerFor: () => provider, workerTools: [], maxDelegations: 5, workspace: { name: 'Example', root: '/projects/example' }, emit: body => events.push(body),
      team: { members, leadModels: ['lead'], providerForModel: () => provider }, onWorkerStarted: id => { started.push(id); }, onWorkerSettled: id => { settled.push(id); } });
    const first = tool.run({ task: 'First', member: 'm-a' }, context());
    await entered.promise;
    const beforeQueue = events.length;
    const abort = new AbortController();
    const cancelled = tool.run({ task: 'Cancelled', member: 'First Reader' }, context(abort.signal));
    const third = tool.run({ task: 'Third', member: 'm-a' }, context());
    expect(events).toHaveLength(beforeQueue);
    abort.abort();
    expect(await cancelled).toMatchObject({ ok: false });
    expect(calls).toBe(1);
    expect(started).toHaveLength(1);
    expect(settled).toHaveLength(0);
    release.resolve();
    expect((await Promise.all([first, third])).map(result => result.ok)).toEqual([true, true]);
    expect(calls).toBe(2);
    expect(settled).toEqual(started);
    expect(await tool.run({ task: 'After', member: 'm-a' }, context())).toMatchObject({ ok: true });
    expect(calls).toBe(3);
  });

  it('keeps the global writer queue fenced after a queued writer aborts, then releases after failure', async () => {
    const entered = deferred(), release = deferred();
    const calls: string[] = [], started: string[] = [], settled: string[] = [];
    const writers = members.map(member => ({ ...member, access: 'write' as const }));
    const write: AnyTool = { ...read, name: 'write_file', access: 'write', kind: 'edit' };
    const tool = createDelegationTool({ providerFor: () => { throw new Error('unexpected tier'); }, workerTools: [], maxDelegations: 5,
      workspace: { name: 'Example', root: '/projects/example' }, emit: () => undefined,
      onWorkerStarted: id => { started.push(id); }, onWorkerSettled: id => { settled.push(id); },
      team: { members: writers, leadModels: ['lead'], writeTools: [write], providerForModel: (_model, member) => ({
        api: 'openai-chat', listModels: async () => [], complete: async () => {
          calls.push(member!.id);
          if (calls.length === 1) { entered.resolve(); await release.promise; throw new Error('request failed'); }
          return { text: 'Done', toolCalls: [], stop: 'end' };
        },
      }) },
    });
    const first = tool.run({ task: 'First', member: 'm-a' }, context());
    await entered.promise;
    const abort = new AbortController();
    const cancelled = tool.run({ task: 'Cancelled', member: 'm-b' }, context(abort.signal));
    abort.abort();
    expect(await cancelled).toMatchObject({ ok: false });
    const third = tool.run({ task: 'Third', member: 'm-b' }, context());
    await Promise.resolve();
    expect(calls).toEqual(['m-a']);
    release.resolve();
    expect((await Promise.all([first, third])).map(result => result.ok)).toEqual([false, true]);
    expect(calls).toEqual(['m-a', 'm-b']);
    expect(settled).toEqual(started);
  });
});

describe('manage_team connection policy', () => {
  it('lists approved choices, preserves grants, rejects expansion and clears a connection explicitly', async () => {
    let team: AgentTeam = { enabled: true, allowedModels: ['lead'], connections: [{ connectionId: 'first', allowedModels: ['approved'] }], members: [{ ...members[0]!, models: ['approved'] }] };
    const original = structuredClone(team.connections);
    const tool = createManageTeamTool({ getTeam: () => team, saveTeam: async next => { team = next; return next; }, takenNames: () => [], seed: 'example', emit: () => undefined });
    const run = (input: Record<string, unknown>) => tool.run(input as never, context());
    expect((await run({ action: 'list' })).output).toContain('Approved connection first: approved');
    expect(await run({ action: 'update', member: 'm-a', models: ['unapproved'] })).toMatchObject({ ok: false });
    expect(await run({ action: 'update', member: 'm-a', connectionId: 'unknown', models: [] })).toMatchObject({ ok: false });
    expect(await run({ action: 'add', name: 'New Reader', role: 'Reader', connectionId: 'first', models: [] })).toMatchObject({ ok: true });
    expect(team.connections).toEqual(original);
    expect(await run({ action: 'update', member: 'm-a', connectionId: '' })).toMatchObject({ ok: false });
    expect(await run({ action: 'update', member: 'm-a', connectionId: '', models: [] })).toMatchObject({ ok: true });
    expect(team.members[0]!.connectionId).toBeUndefined();
    expect(team.connections).toEqual(original);
    expect(team.allowedModels).toEqual(['lead']);
  });
});
