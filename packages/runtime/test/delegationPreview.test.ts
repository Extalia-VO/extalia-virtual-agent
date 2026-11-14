import type { TeamMember } from '@extalia/core';
import type { EventBody } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import {
  createDelegationTool, ProviderError, runTurn,
  type AnyTool, type DelegationOptions, type ModelProvider, type ModelRequest, type ModelResult,
} from '../src/index.js';

type ScopedEvent = { body: EventBody; agentId?: string };
const member: TeamMember = { id: 'member-reviewer', name: 'Reviewer', role: 'reviewer', models: ['model-a', 'model-b'] };
const completed = (text: string): ModelResult => ({ text, toolCalls: [], stop: 'end' });
const provider = (complete: (request: ModelRequest) => Promise<ModelResult> | ModelResult): ModelProvider => ({
  api: 'openai-chat', listModels: async () => [], complete: async request => complete(request),
});
const context = (signal = new AbortController().signal) => ({ signal, toolCallId: 'delegate-call', emit: () => undefined });

function harness(worker: ModelProvider, extra: Partial<DelegationOptions> = {}) {
  const events: ScopedEvent[] = [];
  const tool = createDelegationTool({
    providerFor: () => worker, workerTools: [], maxDelegations: 3,
    workspace: { name: 'Example', root: '/projects/example' }, newId: () => 'worker-preview',
    ...extra, emit: (body, agentId) => events.push({ body, ...(agentId ? { agentId } : {}) }),
  });
  return { tool, events };
}

describe('Native worker transcript previews', () => {
  it('forwards public streamed text and tool output without exposing request context or changing the lead turn', async () => {
    const requests: ModelRequest[] = [];
    const read: AnyTool = {
      name: 'read_example', description: 'Read', access: 'read', kind: 'read',
      parameters: { type: 'object', properties: {} }, describe: () => ({ label: 'Reading example' }),
      run: async (_input, ctx) => {
        ctx.emit({ type: 'tool.output', toolCallId: ctx.toolCallId, text: 'Public tool progress' });
        return { ok: true, output: 'Public tool result' };
      },
    };
    const worker = provider(request => {
      requests.push(request);
      if (request.messages.at(-1)?.role === 'user') {
        request.onText?.('Checking the file.');
        return { text: 'Checking the file.', toolCalls: [{ id: 'worker-read', name: read.name, input: {} }], stop: 'tool_use',
          native: { api: 'openai-chat', content: { reasoning: 'PRIVATE_NATIVE_REASONING' } } };
      }
      request.onText?.('Worker ');
      request.onText?.('findings');
      return { ...completed('Worker findings'), model: 'worker-model', usage: { inputTokens: 10, outputTokens: 2 } };
    });
    const h = harness(worker, { workerTools: [read] });
    const leadEvents: EventBody[] = [];
    const lead = provider(request => request.messages.at(-1)?.role === 'tool'
      ? completed('Lead summary')
      : { text: '', toolCalls: [{ id: 'lead-delegate', name: h.tool.name, input: { task: 'Inspect example', context: 'PRIVATE_WORKER_CONTEXT' } }], stop: 'tool_use' });
    const result = await runTurn({
      provider: lead, system: '', history: [], prompt: 'Review the project', tools: [h.tool],
      permissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: new Set(),
      signal: new AbortController().signal, requestApproval: async () => 'reject', emit: body => leadEvents.push(body),
    });

    expect(result.outcome).toBe('completed');
    expect(result.history.at(-2)).toMatchObject({ role: 'tool', results: [{ content: 'Worker findings', isError: false }] });
    expect(leadEvents.filter(event => event.type === 'model.completed')).toEqual([{ type: 'model.completed', text: 'Lead summary' }]);
    expect(leadEvents.filter(event => event.type === 'turn.completed')).toHaveLength(1);
    expect(h.events.filter(event => event.body.type === 'model.delta').map(event => event.body)).toEqual([
      { type: 'model.delta', text: 'Checking the file.' }, { type: 'model.delta', text: 'Worker ' }, { type: 'model.delta', text: 'findings' },
    ]);
    expect(h.events).toContainEqual({ agentId: 'worker-preview', body: { type: 'model.completed', text: 'Worker findings', model: 'worker-model', usage: { inputTokens: 10, outputTokens: 2 } } });
    expect(h.events).toContainEqual({ agentId: 'worker-preview', body: { type: 'tool.output', toolCallId: 'worker-read', text: 'Public tool progress' } });
    expect(h.events).toContainEqual({ agentId: 'worker-preview', body: expect.objectContaining({ type: 'tool.completed', toolCallId: 'worker-read', ok: true, output: 'Public tool result' }) });
    expect(h.events.filter(event => !event.body.type.startsWith('subagent.')).every(event => event.agentId === 'worker-preview')).toBe(true);
    expect(h.events.some(event => ['turn.completed', 'turn.failed', 'prompt.submitted', 'model.thinking'].includes(event.body.type))).toBe(false);
    expect(requests[0]?.messages[0]).toMatchObject({ role: 'user', text: expect.stringContaining('PRIVATE_WORKER_CONTEXT') });
    expect(JSON.stringify(h.events)).not.toMatch(/PRIVATE_WORKER_CONTEXT|PRIVATE_NATIVE_REASONING/);
  });

  it.each([
    ['provider failure', provider(() => { throw new ProviderError('Endpoint unavailable'); }), 'Endpoint unavailable', ''],
    ['partial answer', provider(() => ({ ...completed('Partial findings'), stop: 'max_tokens' })), 'output limit', 'Partial findings'],
    ['refusal', provider(() => ({ ...completed('Cannot proceed'), stop: 'refusal', refusal: 'Request declined' })), 'Request declined', 'Cannot proceed'],
  ])('scopes the actual %s error and preserves its delegation result', async (_name, worker, error, partial) => {
    const results: unknown[] = [];
    const h = harness(worker, { onWorkerResult: (...result) => results.push(result) });
    const result = await h.tool.run({ task: 'Inspect example' }, context());
    expect(result).toMatchObject({ ok: false, output: expect.stringContaining(error) });
    if (partial) expect(result.output).toContain(`Partial findings:\n${partial}`);
    expect(h.events.filter(event => event.body.type === 'agent.error')).toEqual([
      { agentId: 'worker-preview', body: { type: 'agent.error', message: expect.stringContaining(error) } },
    ]);
    expect(h.events.some(event => event.body.type === 'turn.failed' || event.body.type === 'turn.completed')).toBe(false);
    expect(results).toEqual([['worker-preview', expect.any(String), partial]]);
  });

  it('reports startup failures under the worker identity', async () => {
    const h = harness(provider(() => completed('Unused')), { providerFor: () => { throw new Error('No worker model configured'); } });
    const result = await h.tool.run({ task: 'Inspect example' }, context());
    expect(result).toEqual({ ok: false, output: 'The standard worker could not start: No worker model configured' });
    expect(h.events).toContainEqual({ agentId: 'worker-preview', body: { type: 'agent.error', message: result.output } });
    expect(h.events.at(-1)?.body).toMatchObject({ type: 'subagent.state', state: 'blocked' });
  });

  it('forwards a failed tool result and preserves an existing scoped worker error', async () => {
    const read: AnyTool = {
      name: 'read_example', description: 'Read', access: 'read', kind: 'read',
      parameters: { type: 'object', properties: {} }, describe: () => ({ label: 'Reading example' }),
      run: async (_input, ctx) => {
        ctx.emit({ type: 'agent.error', message: 'The file could not be read', recoverable: true });
        return { ok: false, output: 'File unavailable' };
      },
    };
    const h = harness(provider(request => {
      if (request.messages.at(-1)?.role === 'user') return { text: '', toolCalls: [{ id: 'worker-read', name: read.name, input: {} }], stop: 'tool_use' };
      expect(request.messages.at(-1)).toMatchObject({ role: 'tool', results: [{ toolCallId: 'worker-read', content: 'File unavailable', isError: true }] });
      throw new ProviderError('Could not continue');
    }), { workerTools: [read] });
    expect(await h.tool.run({ task: 'Inspect example' }, context())).toMatchObject({ ok: false, output: expect.stringContaining('Could not continue') });
    expect(h.events).toContainEqual({ agentId: 'worker-preview', body: expect.objectContaining({ type: 'tool.completed', ok: false, output: 'File unavailable' }) });
    expect(h.events.filter(event => event.body.type === 'agent.error')).toEqual([
      { agentId: 'worker-preview', body: { type: 'agent.error', message: 'The file could not be read', recoverable: true } },
    ]);
  });

  it('reports cancellation without publishing late answer text', async () => {
    const controller = new AbortController();
    const h = harness(provider(request => {
      request.onText?.('Started inspection');
      controller.abort();
      request.onText?.('Late stream');
      return completed('Late answer');
    }));
    expect(await h.tool.run({ task: 'Inspect example' }, context(controller.signal))).toMatchObject({ ok: false, output: expect.stringContaining('Stopped by the user.') });
    expect(h.events).toContainEqual({ agentId: 'worker-preview', body: { type: 'agent.error', message: 'Stopped by the user.' } });
    expect(JSON.stringify(h.events)).not.toMatch(/Late stream|Late answer/);
  });

  it('keeps a member identity across model fallback and later invocations', async () => {
    const routes: string[] = [];
    const h = harness(provider(() => completed('Unused')), {
      team: { members: [member], leadModels: ['lead-model'], providerForModel: model => provider(request => {
        routes.push(model);
        if (model === 'model-a') throw new ProviderError('Rate limited', 429, true);
        request.onText?.('Fallback findings');
        return { ...completed('Fallback findings'), model };
      }) },
    });
    for (const task of ['First inspection', 'Second inspection']) {
      expect(await h.tool.run({ task, member: member.id }, context())).toEqual({ ok: true, output: 'Fallback findings' });
    }
    expect(routes).toEqual(['model-a', 'model-b', 'model-a', 'model-b']);
    expect(h.events.filter(event => ['model.delta', 'model.completed'].includes(event.body.type)).map(event => event.agentId)).toEqual(Array(4).fill(member.id));
    expect(h.events.filter(event => event.body.type === 'subagent.spawned').every(event => event.body.type === 'subagent.spawned' && event.body.subagentId === member.id)).toBe(true);
    expect(h.events.some(event => event.body.type === 'agent.error')).toBe(false);
  });

  it('retains member approval attribution and rejected actions', async () => {
    const approvals: string[] = [];
    let writes = 0;
    const write: AnyTool = {
      name: 'write_example', description: 'Write', access: 'write', kind: 'edit',
      parameters: { type: 'object', properties: { path: { type: 'string' } } }, describe: () => ({ label: 'Writing example' }),
      run: async () => { writes++; return { ok: true, output: 'Written' }; },
    };
    const worker = provider(request => request.messages.at(-1)?.role === 'user'
      ? { text: '', toolCalls: [{ id: 'worker-write', name: write.name, input: { path: 'src/example.ts' } }], stop: 'tool_use' }
      : completed('Write was declined'));
    const h = harness(worker, {
      team: { members: [{ ...member, access: 'write', scope: ['src'] }], leadModels: ['model-a'], providerForModel: () => worker, writeTools: [write] },
      requestApproval: async (_request, agentId) => { approvals.push(agentId); return 'reject'; },
    });
    expect(await h.tool.run({ task: 'Update example', member: member.id }, context())).toEqual({ ok: true, output: 'Write was declined' });
    expect(approvals).toEqual([member.id]);
    expect(writes).toBe(0);
    expect(h.events.filter(event => event.body.type.startsWith('approval.')).map(event => event.agentId)).toEqual([member.id, member.id]);
    expect(h.events).toContainEqual({ agentId: member.id, body: { type: 'model.completed', text: 'Write was declined' } });
  });
});
