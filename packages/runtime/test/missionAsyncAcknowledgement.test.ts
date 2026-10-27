import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, OrchestrationPlan } from '@extalia/protocol';
import { runNativeMission, type AnyTool, type NativeMissionAccounting, type NativeMissionOptions, type NativeMissionTaskResult } from '../src/index.js';
import type { ModelProvider, ModelRequest, ModelResult } from '../src/model.js';
import { expectAuditedTransitions } from './transitionAudit.js';

// Every emitted state change must be listed in the shared protocol transition tables.
vi.mock('../src/index.js', async importOriginal => (await import('./transitionAudit.js')).auditTransitions(await importOriginal()));
expectAuditedTransitions();

// ADR 0014 amendment (2026-10-21): the asynchronous acknowledgement port mirrors
// the synchronous cases in missionDurability.test.ts.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const version = { schemaVersion: 1 as const };
const at = '2026-10-18T00:00:00.000Z';
type AsyncSink = NonNullable<NativeMissionOptions['commitEventAsync']>;

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
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** Hand-driven sink: each acknowledgement is released explicitly, or automatically after `auto()`. */
function manualSink() {
  interface Commit { event: AgentEvent; acked: boolean; ack(sequence?: number): void }
  const arrivals: ReturnType<typeof deferred<Commit>>[] = [], all: Commit[] = [];
  const arrival = (index: number) => (arrivals[index] ??= deferred<Commit>());
  let taken = 0, sequence = 0, inFlight = 0, maxInFlight = 0, automatic = false;
  const sink: AsyncSink = event => {
    const answer = deferred<number>();
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    const commit: Commit = {
      event, acked: false,
      ack: value => { if (commit.acked) return; commit.acked = true; inFlight--; answer.resolve(value ?? ++sequence); },
    };
    arrival(all.length).resolve(commit);
    all.push(commit);
    if (automatic) commit.ack();
    return answer.promise;
  };
  return {
    sink,
    next: () => arrival(taken++).promise,
    auto: () => { automatic = true; for (const commit of all) commit.ack(); },
    get maxInFlight() { return maxInFlight; },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('native mission asynchronous event acknowledgement (ADR 0014 amendment)', () => {
  it('rejects both sinks together and an out-of-range acknowledgement deadline', async () => {
    const both = fixture(1);
    both.commitEvent = () => 1;
    both.commitEventAsync = async () => 1;
    await expect(runNativeMission(both)).rejects.toThrow('Invalid native mission input');
    for (const commitDeadlineMs of [0, 60_001, 1.5]) {
      const options = fixture(1);
      options.commitEventAsync = async () => 1;
      options.commitDeadlineMs = commitDeadlineMs;
      await expect(runNativeMission(options)).rejects.toThrow('Invalid native mission input');
    }
  });

  it('matches the synchronous path on success: events, sequences, results and accounting snapshots', async () => {
    const run = async (mode: 'sync' | 'async') => {
      let providerCalls = 0, sequence = 0;
      const options = fixture(1, async () => ++providerCalls === 1
        ? { ...toolReply, usage: { inputTokens: 3, outputTokens: 2 } }
        : { text: 'done', toolCalls: [], stop: 'end', model: 'model', usage: { inputTokens: 4, outputTokens: 1 } });
      options.tasks[0]!.tools = [readTool(async () => ({ ok: true, output: 'read result' }))];
      const commits: { type: string; result?: NativeMissionTaskResult; accounting?: NativeMissionAccounting }[] = [];
      const record = (event: AgentEvent, result?: NativeMissionTaskResult, accounting?: NativeMissionAccounting) => {
        commits.push({ type: event.body.type, ...(result ? { result } : {}), ...(accounting ? { accounting } : {}) });
        return ++sequence;
      };
      if (mode === 'sync') options.commitEvent = record;
      else options.commitEventAsync = async (event, result, accounting) => { await Promise.resolve(); return record(event, result, accounting); };
      const observed: AgentEvent[] = [];
      options.onEvent = event => { observed.push(event); };
      const result = await runNativeMission(options);
      const shape = (event: AgentEvent) => ({ sequence: event.sequence, taskId: event.taskId, agentId: event.agentId, body: event.body });
      return { result: { ...result, events: result.events.map(shape) }, observed: observed.map(shape), commits };
    };
    const sync = await run('sync'), async = await run('async');
    expect(async.result.state).toBe('completed');
    expect(async.result.persistenceFailed).toBe(false);
    expect(async.result.events.map(event => event.sequence)).toEqual(async.result.events.map((_, index) => index + 1));
    expect(async).toEqual(sync);
  });

  it('runs no provider call or observer delivery before the preceding acknowledgement resolves', async () => {
    const sink = manualSink(), providerEntered = deferred();
    let providerCalls = 0;
    const options = fixture(1, async () => { providerCalls++; providerEntered.resolve(); return { text: 'done', toolCalls: [], stop: 'end', model: 'model' }; });
    options.commitEventAsync = sink.sink;
    const observed: AgentEvent[] = [];
    options.onEvent = event => { observed.push(event); };
    const pending = runNativeMission(options);
    for (const [type, state] of [['mission.state', 'running'], ['task.assigned', undefined], ['task.state', 'running'], ['agent.state', 'thinking']] as const) {
      const commit = await sink.next();
      expect(is(commit.event, type, state)).toBe(true);
      // Unacknowledged: neither the effect nor the observer may see it yet.
      await new Promise(resolve => setImmediate(resolve));
      expect(providerCalls).toBe(0);
      expect(observed.some(event => event.id === commit.event.id)).toBe(false);
      commit.ack();
    }
    await providerEntered.promise;
    expect(providerCalls).toBe(1);
    sink.auto();
    const result = await pending;
    expect(result.state).toBe('completed');
    expect(observed.map(event => event.sequence)).toEqual(result.events.map((_, index) => index + 1));
    expect(sink.maxInFlight).toBe(1);
  });

  it('runs no read tool or precheck before tool.started is acknowledged', async () => {
    const sink = manualSink();
    let providerCalls = 0, toolCalls = 0, prechecks = 0;
    const options = fixture(1, async () => ++providerCalls === 1 ? toolReply : { text: 'done', toolCalls: [], stop: 'end', model: 'model' });
    options.tasks[0]!.tools = [readTool(async () => { toolCalls++; return { ok: true, output: 'read result' }; })];
    options.tasks[0]!.tools[0]!.precheck = () => { prechecks++; return undefined; };
    options.commitEventAsync = sink.sink;
    const pending = runNativeMission(options);
    let commit = await sink.next();
    while (!is(commit.event, 'tool.started')) { commit.ack(); commit = await sink.next(); }
    await new Promise(resolve => setImmediate(resolve));
    expect(providerCalls).toBe(1);
    expect(toolCalls).toBe(0);
    expect(prechecks).toBe(0);
    commit.ack();
    commit = await sink.next();
    expect(is(commit.event, 'tool.completed')).toBe(true);
    expect([toolCalls, prechecks]).toEqual([1, 1]);
    sink.auto();
    expect((await pending).state).toBe('completed');
  });

  it.each(['task.assigned', 'running', 'thinking'] as const)('fails closed before provider when the acknowledgement of %s rejects, replaying nothing', async failedAt => {
    let calls = 0, sequence = 0, targetRejected = false;
    const received: AgentEvent[] = [];
    const options = fixture(1, async () => { calls++; return { text: 'should not run', toolCalls: [], stop: 'end', model: 'model' }; });
    options.commitEventAsync = async event => {
      received.push(event);
      await Promise.resolve();
      if (event.body.type === 'task.assigned' && failedAt === 'task.assigned'
        || event.body.type === 'task.state' && event.body.state === 'running' && failedAt === 'running'
        || event.body.type === 'agent.state' && event.body.state === 'thinking' && failedAt === 'thinking') { targetRejected = true; throw new Error('private daemon failure'); }
      return ++sequence;
    };
    const result = await runNativeMission(options);
    expect(calls).toBe(0);
    expect(result.state).toBe('recovering');
    expect(result.persistenceFailed).toBe(true);
    expect(targetRejected).toBe(true);
    expect(result.tasks[0]).toMatchObject(failedAt === 'thinking' ? { state: 'unknown', reason: 'persistence-failed' } : { state: 'blocked', reason: 'persistence-failed' });
    // The rejected event was the last one dispatched: queued events are dropped, never replayed.
    expect(received.at(-1)?.body.type).toBe(failedAt === 'task.assigned' ? 'task.assigned' : failedAt === 'running' ? 'task.state' : 'agent.state');
    expect(result.events.map(event => event.id)).toEqual(received.slice(0, -1).map(event => event.id));
    expect(JSON.stringify(result)).not.toContain('private daemon failure');
  });

  it.each(['rejects', 'throws', 'malformed', 'fractional', 'non-monotonic', 'late'] as const)('latches the mission before any provider call when an early acknowledgement %s', async fault => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let calls = 0, sinkCalls = 0;
    const reached = deferred(), late = deferred<number>();
    const options = fixture(1, async () => { calls++; return { text: 'no', toolCalls: [], stop: 'end', model: 'model' }; });
    options.commitDeadlineMs = 100;
    options.commitEventAsync = (event => {
      sinkCalls++;
      // Non-monotonic: the second acknowledgement repeats the first sequence.
      const target = fault === 'non-monotonic' ? is(event, 'task.assigned') : is(event, 'mission.state', 'running');
      if (!target) return Promise.resolve(7);
      reached.resolve();
      if (fault === 'throws') throw new Error('private daemon error');
      if (fault === 'rejects') return Promise.reject(new Error('private daemon error'));
      if (fault === 'malformed') return Promise.resolve('1');
      if (fault === 'fractional') return Promise.resolve(1.5);
      if (fault === 'non-monotonic') return Promise.resolve(7);
      return late.promise;
    }) as AsyncSink;
    const pending = runNativeMission(options);
    await reached.promise;
    if (fault === 'late') await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(calls).toBe(0);
    expect(result.persistenceFailed).toBe(true);
    expect(result.state).toBe('recovering');
    expect(result.tasks[0]).toMatchObject({ state: 'blocked', reason: 'persistence-failed' });
    expect(sinkCalls).toBe(fault === 'non-monotonic' ? 2 : 1);
    expect(JSON.stringify(result)).not.toMatch(/private daemon error/);
    // A late acknowledgement cannot revive the mission or append events.
    const snapshot = JSON.stringify(result.events);
    late.resolve(1);
    await Promise.resolve();
    expect(JSON.stringify(result.events)).toBe(snapshot);
  });

  it.each(['rejected', 'late', 'non-monotonic'] as const)('aborts siblings and blocks queued admission after a %s tool acknowledgement, preserving ignored abort as unknown', async fault => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const providerEntered = [deferred(), deferred(), deferred()];
    const ignoredProvider = deferred<ModelResult>();
    const providerSettled = deferred();
    const toolEnteredSignal = deferred(), releaseTool = deferred(), toolCompletedSent = deferred();
    let toolCalls = 0, providerCalls = 0, sequence = 0, sinkCallsAfterFailure = 0, failed = false;
    const options = fixture(3, async (_request, index) => {
      providerCalls++;
      if (index === 1) { providerEntered[1]!.resolve(); const value = await ignoredProvider.promise; providerSettled.resolve(); return value; }
      if (index === 0) { providerEntered[0]!.resolve(); return toolReply; }
      providerEntered[2]!.resolve();
      return { text: 'task three should not start', toolCalls: [], stop: 'end', model: 'model' };
    });
    options.maxConcurrency = 2;
    options.abortGraceMs = 5;
    options.commitDeadlineMs = 100;
    options.tasks[0]!.tools = [readTool(async (_input, context) => {
      toolCalls++; toolEnteredSignal.resolve();
      await releaseTool.promise;
      if (context.signal.aborted) return { ok: false, output: 'cancelled' };
      return { ok: true, output: 'done' };
    })];
    options.commitEventAsync = async event => {
      if (failed) sinkCallsAfterFailure++;
      await Promise.resolve();
      if (event.body.type !== 'tool.completed') return ++sequence;
      failed = true; toolCompletedSent.resolve();
      if (fault === 'rejected') throw new Error('secret daemon failure');
      if (fault === 'non-monotonic') return sequence;
      return new Promise<number>(() => {});
    };
    const observed: AgentEvent[] = [];
    options.onEvent = event => { observed.push(structuredClone(event)); };
    const pending = runNativeMission(options);
    await Promise.all([providerEntered[0]!.promise, providerEntered[1]!.promise, toolEnteredSignal.promise]);
    releaseTool.resolve();
    await toolCompletedSent.promise;
    // Deadline for the late case, then the bounded abort window.
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;
    expect(result.persistenceFailed).toBe(true);
    expect(result.state).toBe('recovering');
    expect(result.requiresReconciliation).toBe(true);
    expect(result.tasks[0]?.state).toBe('unknown');
    expect(result.tasks[1]).toMatchObject({ state: 'unknown', reason: 'persistence-failed' });
    expect(result.tasks[2]).toMatchObject({ state: 'blocked', reason: 'persistence-failed' });
    expect(toolCalls).toBe(1);
    expect(providerCalls).toBe(2);
    expect(sinkCallsAfterFailure).toBe(0);
    expect(observed.some(event => event.taskId === id(22))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret daemon failure');
    const snapshot = JSON.stringify(result.events);
    // The provider ignores abort. Its late resolution must not append or deliver events.
    ignoredProvider.resolve({ text: 'late result', toolCalls: [], stop: 'end', model: 'model' });
    await providerSettled.promise;
    await Promise.resolve();
    expect(JSON.stringify(result.events)).toBe(snapshot);
    expect(observed.some(event => event.taskId === id(21) && is(event, 'turn.completed'))).toBe(false);
  });

  it('keeps one commit in flight per mission and acknowledges concurrent tasks in emission order', async () => {
    let sequence = 0, inFlight = 0, maxInFlight = 0;
    const received: string[] = [];
    const options = fixture(3);
    options.commitEventAsync = async event => {
      received.push(event.id);
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setImmediate(resolve));
      inFlight--;
      return ++sequence;
    };
    const result = await runNativeMission(options);
    expect(result.state).toBe('completed');
    expect(maxInFlight).toBe(1);
    expect(result.events.map(event => event.id)).toEqual(received);
    expect(result.events.map(event => event.sequence)).toEqual(received.map((_, index) => index + 1));
  });

  it('keeps observational callback failures best-effort without failing durable execution', async () => {
    const options = fixture(1);
    let sequence = 0;
    options.commitEventAsync = async () => ++sequence;
    options.onEvent = () => { throw new Error('private observer failure'); };
    const result = await runNativeMission(options);
    expect(result.state).toBe('completed');
    expect(result.persistenceFailed).toBe(false);
    expect(result.eventDeliveryFailed).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private observer failure');
  });
});
