import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, OrchestrationPlan } from '@extalia/protocol';
import { runNativeMission, type AnyTool, type NativeMissionOptions, type NativeMissionTaskResult } from '../src/index.js';
import type { ModelProvider, ModelRequest, ModelResult } from '../src/model.js';
import { expectAuditedTransitions } from './transitionAudit.js';

// Every emitted state change must be listed in the shared protocol transition tables.
vi.mock('../src/index.js', async importOriginal => (await import('./transitionAudit.js')).auditTransitions(await importOriginal()));
expectAuditedTransitions();

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const version = { schemaVersion: 1 as const };
const at = '2026-10-18T00:00:00.000Z';

function fixture(count = 3, providerOverride?: (request: ModelRequest, taskIndex: number) => Promise<ModelResult>): NativeMissionOptions {
  const capability = { ...version, observe: true, readMessages: true, readTools: true, pause: false, resume: false, control: true, delegate: false };
  const plan: OrchestrationPlan = {
    ...version,
    mission: { ...version, id: id(2), workspaceId: id(1), leadAgentId: id(3), budgetId: id(4), state: 'queued', createdAt: at, updatedAt: at, version: 1 },
    budget: { ...version, id: id(4), workspaceId: id(1), maxTokens: 1000, spentTokens: 0, maxCostUsd: 1, spentCostUsd: 0, maxDurationMs: 10_000, maxActiveAgents: count, maxDelegationDepth: 1 },
    registry: { ...version, workspaceId: id(1), agents: [
      { ...version, id: id(3), origin: 'native', workspaceId: id(1), role: 'lead', engineId: 'extalia-native', capabilities: { ...capability, delegate: true } },
      ...Array.from({ length: count }, (_, index) => ({ ...version, id: id(10 + index), origin: 'native' as const, workspaceId: id(1), supervisorId: id(3), role: 'worker', engineId: 'extalia-native', modelProfileId: id(5), capabilities: capability })),
    ] },
    providers: [{ ...version, id: id(6), adapterId: 'openai-chat', maxConcurrency: count }],
    models: [{ ...version, id: id(5), providerId: id(6), model: 'model', toolCalling: true, streaming: true, vision: false }],
    graph: { ...version, missionId: id(2), tasks: Array.from({ length: count }, (_, index) => ({ ...version, id: id(20 + index), missionId: id(2), assignedAgentId: id(10 + index), state: 'queued' as const, attempt: 0, dependsOn: [], requirements: ['Read only'], evidenceIds: [] })) },
  };
  const provider: ModelProvider = {
    api: 'openai-chat',
    listModels: async () => ['model'],
    complete: async request => {
      const firstMessage = request.messages[0];
      const match = String(firstMessage && 'text' in firstMessage ? firstMessage.text : '').match(/Inspect task-(\d+)/);
      const index = Number(match?.[1] ?? 0);
      return providerOverride ? providerOverride(request, index) : { text: 'Answer', toolCalls: [], stop: 'end', model: 'model' };
    },
  };
  return { plan, sessionId: id(7), tasks: plan.graph.tasks.map((task, index) => ({ taskId: task.id, instructions: `Inspect task-${index}`, timeoutMs: 5_000 })), bindings: [{ modelProfileId: id(5), providerId: id(6), model: 'model', provider }] };
}

function is(event: AgentEvent, type: string, state?: string): boolean {
  const body = event.body as { type?: string; state?: string };
  return body.type === type && (state === undefined || body.state === state);
}
const toolReply: ModelResult = { text: '', toolCalls: [{ id: 'call-1', name: 'read_only', input: {} }], stop: 'tool_use', model: 'model' };
function readTool(run: AnyTool['run']): AnyTool {
  return { name: 'read_only', description: 'A bounded read-only fixture', parameters: { type: 'object', properties: {} }, access: 'read', kind: 'read', describe: () => ({ label: 'read-only fixture' }), run };
}

describe('native mission durable event acknowledgement', () => {
  it('keeps the original commit boundary when a caller mutates its options during delivery', async () => {
    const options = fixture(1);
    let sequence = 0, calls = 0;
    options.commitEvent = () => { calls++; return ++sequence; };
    options.onEvent = () => { delete options.commitEvent; };
    const result = await runNativeMission(options);
    expect(result.state).toBe('completed');
    expect(calls).toBe(result.events.length);
    expect(calls).toBeGreaterThan(1);
  });

  it('commits strictly increasing store sequence before observer and provider/tool effects', async () => {
    const order: string[] = [], committed: AgentEvent[] = [], observed: AgentEvent[] = [];
    const terminalResults = new Map<string, NativeMissionTaskResult | undefined>();
    let sequence = 0;
    const options = fixture(1);
    options.tasks[0]!.tools = [readTool(async () => { order.push('tool'); return { ok: true, output: 'read result' }; })];
    let providerCalls = 0;
    options.bindings[0]!.provider = {
      api: 'openai-chat', listModels: async () => ['model'],
      complete: async () => {
        order.push('provider');
        expect(committed.some(event => is(event, 'agent.state', 'thinking'))).toBe(true);
        return ++providerCalls === 1 ? toolReply : { text: 'done', toolCalls: [], stop: 'end', model: 'model' };
      },
    };
    options.commitEvent = (event, taskResult) => {
      order.push(`commit:${event.body.type}${event.body.type === 'task.state' ? `:${event.body.state}` : ''}`);
      committed.push(structuredClone(event));
      if (event.body.type === 'task.state' && event.body.state === 'completed') terminalResults.set(event.taskId!, taskResult);
      return ++sequence;
    };
    options.onEvent = event => { expect(committed.at(-1)?.id).toBe(event.id); observed.push(structuredClone(event)); };
    const result = await runNativeMission(options);
    expect(result.state).toBe('completed');
    expect(result.persistenceFailed).toBe(false);
    expect(result.events.map(event => event.sequence)).toEqual(result.events.map((_, index) => index + 1));
    expect(committed.map(event => event.id)).toEqual(result.events.map(event => event.id));
    expect(observed.map(event => event.id)).toEqual(result.events.map(event => event.id));
    expect(terminalResults.get(id(20))).toMatchObject({ state: 'completed', answer: 'done', verification: 'unverified', evidenceIds: [] });
    const assigned = order.indexOf('commit:task.assigned');
    const running = order.indexOf('commit:task.state:running');
    const thinking = order.indexOf('commit:agent.state');
    expect(assigned).toBeGreaterThanOrEqual(0);
    expect(running).toBeGreaterThan(assigned);
    expect(thinking).toBeGreaterThan(running);
    expect(order.indexOf('provider')).toBeGreaterThan(thinking);
    expect(order.indexOf('tool')).toBeGreaterThan(order.findIndex(item => item === 'commit:tool.started'));
  });

  it.each(['task.assigned', 'running', 'thinking'] as const)('fails closed before provider when persistence rejects %s', async failedAt => {
    let calls = 0, sequence = 0, targetRejected = false;
    const options = fixture(1, async () => { calls++; return { text: 'should not run', toolCalls: [], stop: 'end', model: 'model' }; });
    options.commitEvent = event => {
      if (event.body.type === 'task.assigned' && failedAt === 'task.assigned'
        || event.body.type === 'task.state' && event.body.state === 'running' && failedAt === 'running'
        || event.body.type === 'agent.state' && event.body.state === 'thinking' && failedAt === 'thinking') { targetRejected = true; throw new Error('private sqlite failure'); }
      return ++sequence;
    };
    const result = await runNativeMission(options);
    expect(calls).toBe(0);
    expect(result.state).toBe('recovering');
    expect(result.persistenceFailed).toBe(true);
    expect(targetRejected).toBe(true);
    expect(result.tasks[0]).toMatchObject(failedAt === 'thinking' ? { state: 'unknown', reason: 'persistence-failed' } : { state: 'blocked', reason: 'persistence-failed' });
    expect(JSON.stringify(result)).not.toContain('private sqlite failure');
  });

  it.each(['throws', 'bad-ack', 'resolved-async-ack', 'rejected-async-ack'] as const)('rejects a commit callback that %s before scheduling work', async fault => {
    let calls = 0;
    const options = fixture(1, async () => { calls++; return { text: 'no', toolCalls: [], stop: 'end', model: 'model' }; });
    options.commitEvent = ((event: AgentEvent) => {
      if (is(event, 'mission.state', 'running')) {
        if (fault === 'throws') throw new Error('private db error');
        if (fault === 'bad-ack') return 0;
        return fault === 'resolved-async-ack' ? Promise.resolve(1) : Promise.reject(new Error('private rejected promise'));
      }
      return 1;
    }) as NativeMissionOptions['commitEvent'];
    const result = await runNativeMission(options);
    expect(calls).toBe(0);
    expect(result.persistenceFailed).toBe(true);
    expect(result.state).toBe('recovering');
    expect(JSON.stringify(result)).not.toMatch(/private db error|private rejected promise|Promise/);
  });

  it('does not invoke a read tool when committing tool.started fails', async () => {
    let calls = 0, toolCalls = 0, prechecks = 0, sequence = 0, toolStartRejected = false;
    const options = fixture(1, async () => { calls++; return toolReply; });
    options.tasks[0]!.tools = [readTool(async () => { toolCalls++; return { ok: true, output: 'private data' }; })];
    options.tasks[0]!.tools[0]!.precheck = () => { prechecks++; return undefined; };
    options.commitEvent = event => { if (is(event, 'tool.started')) { toolStartRejected = true; throw new Error('private commit error'); } return ++sequence; };
    const result = await runNativeMission(options);
    expect(calls).toBe(1);
    expect(toolStartRejected).toBe(true);
    expect(toolCalls).toBe(0);
    expect(prechecks).toBe(0);
    expect(result.persistenceFailed).toBe(true);
    expect(result.state).toBe('recovering');
    expect(JSON.stringify(result)).not.toMatch(/private commit error|private data/);
  });

  it('aborts siblings and blocks queued admission after an ambiguous tool commit, preserving ignored abort as unknown', async () => {
    const providerEntered = [deferred(), deferred(), deferred()];
    const ignoredProvider = deferred<ModelResult>();
    const providerSettled = deferred<void>();
    const toolEnteredSignal = deferred<void>();
    const releaseTool = deferred<void>();
    let toolEntered = false, toolCalls = 0, providerCalls = 0, sequence = 0;
    const options = fixture(3, async (_request, index) => {
      providerCalls++;
      if (index === 1) { providerEntered[1]!.resolve(); const late = await ignoredProvider.promise; providerSettled.resolve(); return late; }
      if (index === 0) { providerEntered[0]!.resolve(); return toolReply; }
      providerEntered[2]!.resolve();
      return { text: 'task three should not start', toolCalls: [], stop: 'end', model: 'model' };
    });
    options.maxConcurrency = 2;
    options.abortGraceMs = 5;
    options.tasks[0]!.tools = [readTool(async (_input, context) => {
      toolCalls++; toolEntered = true; toolEnteredSignal.resolve();
      await releaseTool.promise;
      if (context.signal.aborted) return { ok: false, output: 'cancelled' };
      return { ok: true, output: 'done' };
    })];
    options.commitEvent = event => {
      if (event.body.type === 'tool.completed') throw new Error('secret db failure');
      return ++sequence;
    };
    const observed: AgentEvent[] = [];
    options.onEvent = event => { observed.push(structuredClone(event)); };
    const pending = runNativeMission(options);
    await Promise.all([providerEntered[0]!.promise, providerEntered[1]!.promise]);
    await toolEnteredSignal.promise;
    expect(toolEntered).toBe(true);
    releaseTool.resolve();
    const result = await pending;
    expect(result.persistenceFailed).toBe(true);
    expect(result.state).toBe('recovering');
    expect(result.requiresReconciliation).toBe(true);
    expect(result.tasks[0]?.state).toBe('unknown');
    expect(result.tasks[1]).toMatchObject({ state: 'unknown', reason: 'persistence-failed' });
    expect(result.tasks[2]).toMatchObject({ state: 'blocked', reason: 'persistence-failed' });
    expect(toolCalls).toBe(1);
    expect(providerCalls).toBe(2);
    expect(observed.some(event => event.taskId === id(22))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret db failure');
    const snapshot = JSON.stringify(result.events);
    // The provider ignores abort. Its late resolution must not append or deliver events.
    ignoredProvider.resolve({ text: 'late result', toolCalls: [], stop: 'end', model: 'model' });
    await providerSettled.promise;
    await Promise.resolve();
    expect(JSON.stringify(result.events)).toBe(snapshot);
    expect(observed.some(event => event.taskId === id(21) && is(event, 'turn.completed'))).toBe(false);
  });

  it('keeps observational callback failures best-effort without failing durable execution', async () => {
    const options = fixture(1);
    let sequence = 0;
    options.commitEvent = () => ++sequence;
    options.onEvent = () => { throw new Error('private observer failure'); };
    const result = await runNativeMission(options);
    expect(result.state).toBe('completed');
    expect(result.persistenceFailed).toBe(false);
    expect(result.eventDeliveryFailed).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private observer failure');
  });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
