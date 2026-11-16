import type { TaskTier } from '@extalia/core';
import type { EventBody } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { checkRequestBudget, createDelegationTool, runTurn, type AnyTool, type ModelProvider, type ModelRequest, type ModelResult } from '../src/index.js';

function provider(name: string, script: (request: ModelRequest) => Promise<ModelResult> | ModelResult, seen: { name: string; tools: string[] }[] = []): ModelProvider {
  return {
    api: 'openai-chat',
    listModels: async () => [],
    async complete(request) {
      seen.push({ name, tools: request.tools.map(tool => tool.name) });
      return script(request);
    },
  };
}

const readTool: AnyTool = {
  name: 'read_file', description: 'Read', access: 'read', kind: 'read',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  describe: input => ({ label: `Reading ${String(input.path)}` }),
  run: async input => ({ ok: true, output: `contents of ${String(input.path)}` }),
};

function harness(maxDelegations = 2, workerDelayMs = 0) {
  const seen: { name: string; tools: string[] }[] = [];
  const events: { body: EventBody; agentId?: string }[] = [];
  const timeline: string[] = [];
  const workers = (tier: TaskTier) => provider(`worker-${tier}`, async request => {
    const last = request.messages.at(-1);
    if (last?.role === 'user') return { text: '', toolCalls: [{ id: `r-${tier}`, name: 'read_file', input: { path: 'a.ts' } }], stop: 'tool_use' };
    timeline.push(`start-${tier}`);
    await new Promise(resolve => setTimeout(resolve, workerDelayMs));
    timeline.push(`end-${tier}`);
    return { text: `${tier} findings: a.ts:1`, toolCalls: [], stop: 'end' };
  }, seen);
  const tool = createDelegationTool({
    providerFor: workers,
    workerTools: [readTool],
    maxDelegations,
    workspace: { name: 'Site', root: '/projects/site' },
    emit: (body, agentId) => events.push({ body, ...(agentId ? { agentId } : {}) }),
  });
  return { tool, seen, events, timeline };
}

const context = { signal: new AbortController().signal, toolCallId: 'c', emit: () => undefined };

describe('delegate_task', () => {
  it('owns compaction and archive reads per worker, without inheriting the lead or another worker archive', async () => {
    const owners: string[] = [], archived: string[] = [], fetched: string[] = [], denied: string[] = [];
    let identity = 0;
    const ownReferences = new Map<string, string>();
    const source: AnyTool = { ...readTool, run: async () => ({ ok: true, output: `Source start. ${'bounded evidence '.repeat(1500)} Source end.` }) };
    const leadArchive: AnyTool = { ...readTool, name: 'context_archive_read', access: 'memory', run: async () => { throw new Error('Lead archive must never be called by a worker.'); } };
    const tool = createDelegationTool({
      maxDelegations: 3, workerTools: [source, leadArchive], newId: () => `worker-${++identity}`,
      workspace: { name: 'Fixture', root: '/projects/fixture' }, emit: () => undefined,
      contextForWorker: (_member, agentId) => {
        owners.push(agentId);
        if (agentId === 'worker-3') return undefined;
        const reference = (agentId === 'worker-1' ? 'a' : 'b').repeat(64);
        ownReferences.set(agentId, reference);
        const read: AnyTool = { ...leadArchive, parameters: { type: 'object', properties: { reference: { type: 'string' } }, required: ['reference'] },
          run: async input => {
            if (input.reference !== reference) { denied.push(agentId); return { ok: false, output: 'Archive belongs to another worker.' }; }
            fetched.push(agentId); return { ok: true, output: `Owned evidence for ${agentId}.` };
          } };
        return { tools: [read], maxInputTokens: 2500, compaction: { triggerTokens: 2000, archive: async request => {
          expect(request.messages.some(message => message.role === 'tool' && message.results[0]!.content.includes('bounded evidence '.repeat(100)))).toBe(true);
          archived.push(agentId); return { reference };
        } } };
      },
      providerFor: tier => {
        const owner = tier === 'quick' ? 'worker-1' : tier === 'standard' ? 'worker-2' : 'worker-3';
        let step = 0;
        return provider(owner, request => {
          expect(checkRequestBudget(request, 2500).reason).toBeUndefined();
          if (owner === 'worker-3') {
            expect(request.tools.some(tool => tool.name === 'context_archive_read')).toBe(false);
            return { text: 'Memory disabled for this worker.', toolCalls: [], stop: 'end' };
          }
          if (step++ === 0) return { text: '', toolCalls: [{ id: 'source', name: 'read_file', input: { path: 'source.txt' } }], stop: 'tool_use' };
          if (step === 2) {
            const original = request.messages.find(message => message.role === 'tool');
            expect(original?.role === 'tool' && original.results[0]!.content).toContain(ownReferences.get(owner));
            return { text: '', toolCalls: [{ id: 'own', name: 'context_archive_read', input: { reference: ownReferences.get(owner) } }], stop: 'tool_use' };
          }
          if (step === 3) {
            expect(request.messages.at(-1)).toMatchObject({ role: 'tool', results: [{ content: `Owned evidence for ${owner}.`, isError: false }] });
            return { text: '', toolCalls: [{ id: 'other', name: 'context_archive_read', input: { reference: (owner === 'worker-1' ? 'b' : 'a').repeat(64) } }], stop: 'tool_use' };
          }
          expect(request.messages.at(-1)).toMatchObject({ role: 'tool', results: [{ isError: true, content: 'Archive belongs to another worker.' }] });
          return { text: `Verified archive ownership for ${owner}.`, toolCalls: [], stop: 'end' };
        });
      },
    });
    expect((await tool.run({ task: 'Inspect A.', tier: 'quick' }, context)).ok).toBe(true);
    expect((await tool.run({ task: 'Inspect B.', tier: 'standard' }, context)).ok).toBe(true);
    expect((await tool.run({ task: 'Inspect C.', tier: 'complex' }, context)).ok).toBe(true);
    expect(owners).toEqual(['worker-1', 'worker-2', 'worker-3']);
    expect(archived).toEqual(['worker-1', 'worker-2']);
    expect(fetched).toEqual(['worker-1', 'worker-2']); expect(denied).toEqual(['worker-1', 'worker-2']);
  });

  it('runs a read-only worker on the tier model and returns its findings', async () => {
    const h = harness();
    const outcome = await h.tool.run({ task: 'Find where config loads', tier: 'quick' }, context);
    expect(outcome).toEqual({ ok: true, output: 'quick findings: a.ts:1' });
    expect(h.seen.every(entry => entry.name === 'worker-quick')).toBe(true);
    expect(h.seen[0]?.tools).toEqual(['read_file']);
    expect(h.events[0]?.body).toMatchObject({ type: 'subagent.spawned', role: 'quick', label: 'Find where config loads' });
    expect(h.events.some(event => event.body.type === 'tool.started' && event.agentId?.startsWith('worker-'))).toBe(true);
    expect(h.events.at(-1)?.body).toMatchObject({ type: 'subagent.state', state: 'idle' });
  });

  it('enforces the delegation limit per turn', async () => {
    const h = harness(1);
    expect((await h.tool.run({ task: 'one' }, context)).ok).toBe(true);
    expect(await h.tool.run({ task: 'two' }, context)).toMatchObject({ ok: false, output: expect.stringContaining('limit') });
  });

  it('runs several delegations from one response concurrently', async () => {
    const h = harness(3, 80);
    const primary = provider('primary', request => request.messages.at(-1)?.role === 'tool'
      ? { text: 'Merged the findings.', toolCalls: [], stop: 'end' }
      : { text: '', toolCalls: [{ id: 'd1', name: 'delegate_task', input: { task: 'A', tier: 'quick' } }, { id: 'd2', name: 'delegate_task', input: { task: 'B', tier: 'complex' } }], stop: 'tool_use' });
    const result = await runTurn({
      provider: primary, system: '', history: [], prompt: 'investigate', tools: [h.tool], permissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: new Set(),
      emit: () => undefined, requestApproval: async () => 'reject', signal: new AbortController().signal,
    });
    expect(result.outcome).toBe('completed');
    expect(h.timeline.slice(0, 2).sort()).toEqual(['start-complex', 'start-quick']);
    expect(result.history[2]).toMatchObject({ role: 'tool', results: [{ toolCallId: 'd1', content: 'quick findings: a.ts:1' }, { toolCallId: 'd2', content: 'complex findings: a.ts:1' }] });
  });
});
