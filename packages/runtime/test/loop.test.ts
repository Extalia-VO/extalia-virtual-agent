import type { WorkspacePermissions } from '@extalia/core';
import type { EventBody } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt, decide, runTurn, validateArguments, type AnyTool, type ApprovalOutcome, type ModelProvider, type ModelRequest, type ModelResult, type ToolAccess,
} from '../src/index.js';

function scripted(steps: (ModelResult | ((request: ModelRequest) => Promise<ModelResult>))[]): ModelProvider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    api: 'openai-chat',
    requests,
    listModels: async () => [],
    async complete(request) {
      requests.push({ ...request, messages: [...request.messages] });
      const step = steps.shift();
      if (!step) throw new Error('no more steps');
      if (typeof step === 'function') return step(request);
      if (step.text) request.onText?.(step.text);
      return step;
    },
  };
}

const writeTool = (log: string[]): AnyTool => ({
  name: 'write_file', description: 'Write', access: 'write', kind: 'edit',
  parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  describe: input => ({ label: `Writing ${String(input.path)}`, target: String(input.path) }),
  run: async input => { log.push(String(input.path)); return { ok: true, output: 'written', files: [{ path: String(input.path), change: 'add' }] }; },
});

const toolCallStep = (args: Record<string, unknown> = { path: 'a.txt', content: 'x' }): ModelResult => ({ text: 'Writing the file.', toolCalls: [{ id: 'c1', name: 'write_file', input: args }], stop: 'tool_use' });
const finalStep: ModelResult = { text: 'Done.', toolCalls: [], stop: 'end', usage: { inputTokens: 3, outputTokens: 2 } };

function harness(steps: Parameters<typeof scripted>[0], approval: ApprovalOutcome = 'once', permissions: WorkspacePermissions = { fileWrite: 'ask', commands: 'ask' }) {
  const provider = scripted(steps);
  const events: EventBody[] = [];
  const written: string[] = [];
  const grants = new Set<ToolAccess>();
  const controller = new AbortController();
  let n = 0;
  const run = (prompt = 'make a file', history: Parameters<typeof runTurn>[0]['history'] = []) => runTurn({
    provider, system: 'sys', history, prompt, tools: [writeTool(written)], permissions, sessionGrants: grants,
    emit: body => events.push(body), requestApproval: async () => approval, signal: controller.signal, newId: () => `id${n++}`,
  });
  return { provider, events, written, grants, controller, run };
}

describe('runTurn', () => {
  it('runs tools after approval and returns the full history', async () => {
    const h = harness([toolCallStep(), finalStep]);
    const result = await h.run();
    expect(result.outcome).toBe('completed');
    expect(h.written).toEqual(['a.txt']);
    expect(h.events.map(event => event.type)).toEqual([
      'agent.state', 'model.delta', 'model.completed', 'agent.state', 'approval.requested', 'approval.resolved', 'agent.state', 'tool.started',
      'file.written', 'tool.completed', 'agent.state', 'model.delta', 'model.completed', 'turn.completed', 'agent.state',
    ]);
    expect(result.history.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(h.provider.requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool', results: [{ toolCallId: 'c1', isError: false }] });
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });

  it('tells the model when the user declines, and remembers session grants', async () => {
    const declined = harness([toolCallStep(), finalStep], 'reject');
    const result = await declined.run();
    expect(declined.written).toEqual([]);
    expect(result.history[2]).toMatchObject({ role: 'tool', results: [{ isError: true, content: expect.stringContaining('declined') }] });

    const granted = harness([toolCallStep(), finalStep, toolCallStep(), finalStep], 'session');
    await granted.run();
    expect(granted.grants.has('write')).toBe(true);
    granted.events.length = 0;
    await granted.run('again');
    expect(granted.events.some(event => event.type === 'approval.requested')).toBe(false);
  });

  it('skips approval when the workspace allows the action', async () => {
    const h = harness([toolCallStep(), finalStep], 'reject', { fileWrite: 'allow', commands: 'ask' });
    await h.run();
    expect(h.written).toEqual(['a.txt']);
  });

  it('returns errors to the model for unknown tools and invalid arguments', async () => {
    const h = harness([
      { text: '', toolCalls: [{ id: 'u', name: 'launch', input: {} }, { id: 'v', name: 'write_file', input: { path: 3 } }], stop: 'tool_use' },
      finalStep,
    ]);
    const result = await h.run();
    const tool = result.history[2];
    expect(tool).toMatchObject({ role: 'tool', results: [{ isError: true, content: expect.stringContaining('Unknown tool') }, { isError: true, content: expect.stringContaining('Invalid arguments') }] });
    expect(h.written).toEqual([]);
  });

  it('stops when cancelled and still answers every pending tool call', async () => {
    const h = harness([]);
    h.provider.complete = async () => ({ text: '', toolCalls: [{ id: 'c1', name: 'write_file', input: { path: 'a', content: '' } }, { id: 'c2', name: 'write_file', input: { path: 'b', content: '' } }], stop: 'tool_use' });
    const run = runTurn({
      provider: h.provider, system: '', history: [], prompt: 'x', tools: [writeTool(h.written)], permissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: h.grants,
      emit: body => h.events.push(body), signal: h.controller.signal,
      requestApproval: async () => { h.controller.abort(); return 'reject'; },
    });
    const result = await run;
    expect(result.outcome).toBe('cancelled');
    expect(result.history.at(-1)).toMatchObject({ role: 'tool', results: [{ toolCallId: 'c1' }, { toolCallId: 'c2', isError: true }] });
    expect(h.events.at(-2)).toMatchObject({ type: 'turn.failed' });
  });

  it('reports provider failures, refusals and truncated tool calls without running tools', async () => {
    const failing = harness([async () => { throw new Error('connection refused'); }]);
    expect(await failing.run()).toMatchObject({ outcome: 'failed', error: expect.stringContaining('connection refused') });

    const refused = harness([{ text: '', toolCalls: [{ id: 'c', name: 'write_file', input: { path: 'a', content: '' } }], stop: 'refusal', refusal: 'Declined.' }]);
    expect(await refused.run()).toMatchObject({ outcome: 'refused', error: 'Declined.' });
    expect(refused.written).toEqual([]);

    const truncated = harness([{ ...toolCallStep(), stop: 'max_tokens' }]);
    expect(await truncated.run()).toMatchObject({ outcome: 'failed' });
    expect(truncated.written).toEqual([]);
  });

  it('stops at the step limit', async () => {
    const provider = scripted(Array.from({ length: 3 }, () => ({ text: '', toolCalls: [{ id: 'c', name: 'write_file', input: { path: 'a', content: '' } }], stop: 'tool_use' as const })));
    const result = await runTurn({
      provider, system: '', history: [], prompt: 'loop', tools: [writeTool([])], permissions: { fileWrite: 'allow', commands: 'allow' }, sessionGrants: new Set(),
      emit: () => undefined, requestApproval: async () => 'once', signal: new AbortController().signal, maxSteps: 2,
    });
    expect(result.outcome).toBe('step-limit');
  });
});

describe('policy, validation and prompt', () => {
  it('allows reads, asks for writes and commands unless allowed', () => {
    const ask = { fileWrite: 'ask' as const, commands: 'ask' as const };
    expect(decide('read', ask)).toBe('allow');
    expect(decide('write', ask)).toBe('ask');
    expect(decide('execute', { ...ask, commands: 'allow' })).toBe('allow');
    expect(decide('write', ask, new Set(['write']))).toBe('allow');
  });

  it('validates tool arguments', () => {
    const schema = { type: 'object' as const, properties: { path: { type: 'string' as const }, limit: { type: 'integer' as const, maximum: 10 } }, required: ['path'], additionalProperties: false as const };
    expect(validateArguments(schema, { path: 'a' })).toEqual([]);
    expect(validateArguments(schema, { limit: 11, extra: 1 })).toHaveLength(3);
    expect(validateArguments(schema, [])).toHaveLength(1);
  });

  it('includes memory and skills only when enabled', () => {
    const base = { workspace: { name: 'Site', root: '/projects/site' }, platform: { os: 'macOS', shell: 'zsh' } };
    const plain = buildSystemPrompt(base);
    expect(plain).not.toContain('memory_write');
    expect(plain).not.toContain('skill_read');
    const full = buildSystemPrompt({ ...base, memory: [{ name: 'stack', summary: 'Vue + Laravel' }], skills: [{ name: 'code-review', description: 'Review changes' }], projectInstructions: [{ file: 'AGENTS.md', text: 'Use pnpm.' }] });
    expect(full).toContain('stack: Vue + Laravel');
    expect(full).toContain('code-review: Review changes');
    expect(full).toContain('Use pnpm.');
  });
});
