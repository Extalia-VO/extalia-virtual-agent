import type { TaskTier } from '@extalia/core';
import type { EventBody } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { createDelegationTool, runTurn, type AnyTool, type ModelProvider, type ModelRequest, type ModelResult } from '../src/index.js';

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
