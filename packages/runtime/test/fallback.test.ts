import type { TeamMember } from '@extalia/core';
import type { EventBody } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import {
  ProviderError, buildSystemPrompt, createDelegationTool, createFallbackProvider, createOpenAIChatProvider, isQuotaMessage, modelChain,
  type AnyTool, type ModelProvider, type ModelResult,
} from '../src/index.js';

/** A provider that fails with `failure` (when given) and records which model answered. */
function fake(model: string, calls: string[], failure?: ProviderError | Error, reply?: (last: string) => ModelResult): ModelProvider {
  return {
    api: 'openai-chat',
    listModels: async () => [model],
    async complete(request) {
      calls.push(model);
      if (failure) throw failure;
      const last = request.messages.at(-1);
      return reply?.(last?.role === 'user' ? last.text : '') ?? { text: `${model} answered`, toolCalls: [], stop: 'end', model };
    },
  };
}

const request = { system: '', messages: [{ role: 'user' as const, text: 'hi' }], tools: [] };

describe('createFallbackProvider', () => {
  it('advances to the next model on a quota/429 error, reports the switch and stays there', async () => {
    const calls: string[] = [];
    const switches: string[] = [];
    const chain = createFallbackProvider([
      { model: 'a', provider: () => fake('a', calls, new ProviderError('The endpoint returned 429: insufficient_quota', 429, true)) },
      { model: 'b', provider: () => fake('b', calls) },
      { model: 'c', provider: () => { throw new Error('never created'); } },
    ], { onSwitch: change => switches.push(`${change.from}->${change.to}`) });
    expect((await chain.complete(request)).text).toBe('b answered');
    expect((await chain.complete(request)).text).toBe('b answered');
    expect(calls).toEqual(['a', 'b', 'b']);
    expect(switches).toEqual(['a->b']);
    expect(chain.current).toBe('b');
  });

  it('does not fall back on a non-retryable error or a cancelled request', async () => {
    const calls: string[] = [];
    const denied = createFallbackProvider(modelChain(['a', 'b'], model => fake(model, calls, new ProviderError('The endpoint rejected the credentials.', 401, false))));
    await expect(denied.complete(request)).rejects.toThrow(/credentials/);
    expect(calls).toEqual(['a']);
    const controller = new AbortController();
    controller.abort();
    const aborted = createFallbackProvider(modelChain(['a', 'b'], model => fake(model, calls, new ProviderError('busy', 503, true))));
    await expect(aborted.complete({ ...request, signal: controller.signal })).rejects.toThrow('busy');
  });

  it('names every model when the whole order is exhausted', async () => {
    const calls: string[] = [];
    const chain = createFallbackProvider(modelChain(['a', 'b', 'a'], model => fake(model, calls, new ProviderError('Your credit balance is too low.', 400, true))));
    await expect(chain.complete(request)).rejects.toThrow(/Every model in the order was tried \(a, b\)/);
    expect(calls).toEqual(['a', 'b']);
  });
});

describe('quota classification', () => {
  it('treats quota, credit and rate-limit messages as retryable, but not context-length errors', async () => {
    expect(isQuotaMessage('You exceeded your current quota, please check your plan and billing details.')).toBe(true);
    expect(isQuotaMessage('Your credit balance is too low to access the Anthropic API.')).toBe(true);
    expect(isQuotaMessage('This model\'s maximum context length is 8192 tokens; limit exceeded')).toBe(false);
    const respond = (status: number, message: string) => async () => Response.json({ error: { message, code: 'insufficient_quota' } }, { status });
    const quota = createOpenAIChatProvider({ baseUrl: 'http://mock.test/v1', model: 'm', fetch: respond(403, 'Monthly usage limit reached') });
    await expect(quota.complete(request)).rejects.toMatchObject({ status: 403, retryable: true });
    const credit = createOpenAIChatProvider({ baseUrl: 'http://mock.test/v1', model: 'm', fetch: respond(402, 'Payment required') });
    await expect(credit.complete(request)).rejects.toMatchObject({ status: 402, retryable: true });
    const bad = createOpenAIChatProvider({ baseUrl: 'http://mock.test/v1', model: 'm', fetch: respond(400, 'Unknown parameter') });
    await expect(bad.complete(request)).rejects.toMatchObject({ status: 400, retryable: false });
    const auth = createOpenAIChatProvider({ baseUrl: 'http://mock.test/v1', model: 'm', fetch: respond(401, 'Invalid API key; quota unknown') });
    await expect(auth.complete(request)).rejects.toMatchObject({ status: 401, retryable: false });
  });
});

const readTool: AnyTool = {
  name: 'read_file', description: 'Read', access: 'read', kind: 'read',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  describe: input => ({ label: `Reading ${String(input.path)}` }),
  run: async input => ({ ok: true, output: `contents of ${String(input.path)}` }),
};

describe('delegate_task with team members', () => {
  const members: TeamMember[] = [
    { id: 'm-ava', name: 'Ava', role: 'Researcher', task: 'Find call sites', models: ['fast', 'big'] },
    { id: 'm-milo', name: 'Milo', role: 'Reviewer', models: [] },
  ];

  function harness(failing: string[] = []) {
    const calls: string[] = [];
    const systems: string[] = [];
    const events: { body: EventBody; agentId?: string }[] = [];
    const tool = createDelegationTool({
      providerFor: () => { throw new Error('tier workers are not used here'); },
      workerTools: [readTool],
      maxDelegations: 3,
      workspace: { name: 'Site', root: '/projects/site' },
      emit: (body, agentId) => events.push({ body, ...(agentId ? { agentId } : {}) }),
      team: {
        members,
        leadModels: ['lead', 'big'],
        providerForModel: model => {
          const base = fake(model, calls, failing.includes(model) ? new ProviderError('The endpoint returned 429: Rate limit reached', 429, true) : undefined);
          return { ...base, complete: async req => { systems.push(req.system); return base.complete(req); } };
        },
      },
    });
    return { tool, calls, systems, events };
  }
  const context = { signal: new AbortController().signal, toolCallId: 'c', emit: () => undefined };

  it('runs the member on its own first model, as a subagent named after the member', async () => {
    const h = harness();
    const outcome = await h.tool.run({ task: 'List the auth call sites', member: 'ava' }, context);
    expect(outcome).toEqual({ ok: true, output: 'fast answered' });
    expect(h.calls).toEqual(['fast']);
    expect(h.systems[0]).toContain('You are Ava, the team\'s Researcher. Your standing responsibility: Find call sites');
    expect(h.events[0]?.body).toEqual({ type: 'subagent.spawned', subagentId: 'm-ava', role: 'Researcher', label: 'Ava' });
    expect(h.tool.describe({ task: 'x', member: 'm-ava' }).label).toBe('Delegating to Ava: x');
    expect(JSON.stringify(h.tool.parameters)).toContain('Team member name or id: Ava, Milo');
  });

  it('falls back to the member\'s next model on a 429 and emits a switch note', async () => {
    const h = harness(['fast']);
    expect(await h.tool.run({ task: 'Look', member: 'm-ava' }, context)).toEqual({ ok: true, output: 'big answered' });
    expect(h.calls).toEqual(['fast', 'big']);
    expect(h.events.some(event => event.body.type === 'subagent.state' && event.body.subagentId === 'm-ava' && event.body.summary === 'Switched to big (fast hit a limit)')).toBe(true);
  });

  it('uses the lead chain for a member without models and refuses unknown members', async () => {
    const h = harness(['lead']);
    expect((await h.tool.run({ task: 'Review', member: 'Milo' }, context)).output).toBe('big answered');
    expect(h.calls).toEqual(['lead', 'big']);
    expect(await h.tool.run({ task: 'x', member: 'Nobody' }, context)).toMatchObject({ ok: false, output: expect.stringContaining('Members: Ava (Researcher), Milo (Reviewer)') });
  });
});

describe('team instructions in the system prompt', () => {
  it('tells the lead to delegate to the members whose role a request concerns, and only then', () => {
    const prompt = buildSystemPrompt({
      workspace: { name: 'Site', root: '/projects/site' }, platform: { os: 'macOS', shell: 'zsh' }, orchestration: { maxDelegations: 3 },
      team: { members: [{ name: 'Ava', role: 'Researcher', task: 'Find\ncall sites' }] },
    });
    expect(prompt).toContain('You lead a team of subagents');
    expect(prompt).toContain('Delegate only when a request actually concerns a member\'s role, task or scope');
    expect(prompt).toContain('without waiting for the user to name them');
    expect(prompt).toContain('pick several members when the work spans their roles');
    expect(prompt).toContain('Do not delegate on every request: handle small, quick or unrelated requests');
    expect(prompt).not.toContain('For every request');
    expect(prompt).toContain('- Ava (Researcher): Find call sites');
    expect(buildSystemPrompt({ workspace: { name: 'Site', root: '/' }, platform: { os: 'macOS', shell: 'zsh' } })).not.toContain('team of subagents');
  });
});
