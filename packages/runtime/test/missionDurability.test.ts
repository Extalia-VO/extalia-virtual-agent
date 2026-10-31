import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, OrchestrationPlan } from '@extalia/protocol';
import { runNativeMission, type AnyTool, type NativeMissionOptions, type NativeMissionTaskResult, type NativeTurnSettlement } from '../src/index.js';
import * as turnLoop from '../src/loop.js';
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
  it('reports only captured, cloned turn identities once per genuinely settled turn', async () => {
    const options = fixture(2);
    const observations: NativeTurnSettlement[] = [];
    const replacement = vi.fn();
    options.onTurnSettled = observation => {
      observations.push({ ...observation });
      observation.taskId = 'observer mutation';
    };
    options.onEvent = () => { options.onTurnSettled = replacement; };
    const result = await runNativeMission(options);
    expect(result.state).toBe('completed');
    expect(observations).toEqual([0, 1].map(index => ({ missionId: id(2), taskId: id(20 + index), agentId: id(10 + index), attempt: 1, kind: 'turn-promise-settled' })));
    expect(replacement).not.toHaveBeenCalled();
    expect(result.tasks.map(task => task.taskId)).toEqual([id(20), id(21)]);
    expect(observations.every(observation => Object.keys(observation).sort().join(',') === 'agentId,attempt,kind,missionId,taskId')).toBe(true);
  });

  it('does not mistake abort or grace expiry for settlement and reports a genuine late provider return without new effects', async () => {
    const user = new AbortController();
    const entered = deferred();
    const reply = deferred<ModelResult>();
    const delivered = deferred();
    const observations: NativeTurnSettlement[] = [];
    const provider = vi.fn(async () => { entered.resolve(); return reply.promise; });
    const options = fixture(2, provider);
    const runTool = vi.fn(async () => ({ ok: true, output: 'must not run' }));
    options.tasks[0]!.tools = [readTool(runTool)];
    const pending = runNativeMission({ ...options, maxConcurrency: 1, signal: user.signal, abortGraceMs: 0,
      onTurnSettled: observation => { observations.push(observation); delivered.resolve(); },
    });
    await entered.promise;
    user.abort();
    const result = await pending;
    expect(result.state).toBe('recovering');
    expect(observations).toEqual([]);
    const snapshot = JSON.stringify(result);
    reply.resolve(toolReply);
    await delivered.promise;
    await Promise.resolve();
    expect(observations).toEqual([{ missionId: id(2), taskId: id(20), agentId: id(10), attempt: 1, kind: 'turn-promise-settled' }]);
    expect(provider).toHaveBeenCalledOnce();
    expect(runTool).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toBe(snapshot);
  });

  it('reports an abort-ignoring provider only when its late promise rejects, never at the task timeout', async () => {
    const entered = deferred();
    const reply = deferred<ModelResult>();
    const delivered = deferred();
    const observed = vi.fn(() => delivered.resolve());
    const options = fixture(1, async () => { entered.resolve(); return reply.promise; });
    options.tasks[0]!.timeoutMs = 10;
    const pending = runNativeMission({ ...options, abortGraceMs: 0, onTurnSettled: observed });
    await entered.promise;
    const result = await pending;
    expect(result.state).toBe('recovering');
    expect(observed).not.toHaveBeenCalled();
    const snapshot = JSON.stringify(result);
    reply.reject(new Error('private late provider rejection'));
    await delivered.promise;
    expect(observed).toHaveBeenCalledExactlyOnceWith({ missionId: id(2), taskId: id(20), agentId: id(10), attempt: 1, kind: 'turn-promise-settled' });
    expect(JSON.stringify(result)).toBe(snapshot);
  });

  it('does not notify for queued work, failed admission or a runner that never produced a promise', async () => {
    const observation = vi.fn();
    const preaborted = new AbortController();
    preaborted.abort();
    await runNativeMission({ ...fixture(2), authoritySignal: preaborted.signal, onTurnSettled: observation });
    await runNativeMission({ ...fixture(1), commitEvent: () => { throw new Error('admission failed'); }, onTurnSettled: observation });
    const realRun = turnLoop.runTurn;
    const spy = vi.spyOn(turnLoop, 'runTurn').mockImplementationOnce(() => { throw new Error('runner failed synchronously'); }).mockImplementation(realRun);
    try {
      const result = await runNativeMission({ ...fixture(1), onTurnSettled: observation });
      expect(result.state).toBe('failed');
      expect(observation).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('contains both synchronous and accidental async observer failures without changing mission authority', async () => {
    for (const observer of [() => { throw new Error('private synchronous observer failure'); }, async () => { throw new Error('private asynchronous observer failure'); }]) {
      const result = await runNativeMission({ ...fixture(1), onTurnSettled: observer });
      await Promise.resolve();
      expect(result).toMatchObject({ state: 'completed', persistenceFailed: false, eventDeliveryFailed: false, requiresReconciliation: false });
      expect(JSON.stringify(result)).not.toContain('private');
    }
  });

  it('labels aggregate turn rejection as a weak observation while a parallel tool sibling remains pending', async () => {
    const release = deferred();
    const toolReturned = deferred();
    let toolStillRunning = true;
    const held = readTool(async () => {
      await release.promise;
      toolStillRunning = false;
      toolReturned.resolve();
      return { ok: true, output: 'late tool output' };
    });
    const other = { ...readTool(async () => ({ ok: true, output: 'other tool' })), name: 'other_read' };
    const options = fixture(1, async () => ({ ...toolReply, toolCalls: [toolReply.toolCalls[0]!, { id: 'call-2', name: 'other_read', input: {} }] }));
    options.tasks[0]!.tools = [held, other];
    const observation = vi.fn();
    const realRun = turnLoop.runTurn;
    // Exercise an aggregate failure with a held parallel sibling. Native wrappers
    // normally run sequentially; the observation must not claim drain in either case.
    const spy = vi.spyOn(turnLoop, 'runTurn').mockImplementationOnce(turn => realRun({ ...turn,
      tools: turn.tools.map(tool => ({ ...tool, parallel: true })),
      emit: body => {
        if (body.type === 'tool.started' && body.tool === 'other_read') throw new Error('synthetic sibling delivery failure');
        turn.emit(body);
      },
    })).mockImplementation(realRun);
    try {
      const result = await runNativeMission({ ...options, onTurnSettled: observation });
      expect(result.state).toBe('recovering');
      expect(toolStillRunning).toBe(true);
      expect(observation).toHaveBeenCalledExactlyOnceWith({ missionId: id(2), taskId: id(20), agentId: id(10), attempt: 1, kind: 'turn-promise-settled' });
      const snapshot = JSON.stringify(result);
      release.resolve();
      await toolReturned.promise;
      await Promise.resolve();
      expect(JSON.stringify(result)).toBe(snapshot);
      expect(observation).toHaveBeenCalledOnce();
    } finally { release.resolve(); spy.mockRestore(); }
  });

  it('does not admit providers, tools or commits when execution authority was already lost', async () => {
    const authority = new AbortController();
    authority.abort(new Error('private authority failure'));
    const provider = vi.fn(async () => toolReply);
    const options = fixture(2, provider);
    const runTool = vi.fn(async () => ({ ok: true, output: 'read result' }));
    options.tasks[0]!.tools = [readTool(runTool)];
    const commit = vi.fn(() => 1);
    const result = await runNativeMission({ ...options, authoritySignal: authority.signal, commitEvent: commit });
    expect(result).toMatchObject({ state: 'recovering', persistenceFailed: true, requiresReconciliation: true, events: [] });
    expect(result.tasks.every(task => task.state === 'blocked' && task.reason === 'persistence-failed')).toBe(true);
    expect(provider).not.toHaveBeenCalled();
    expect(runTool).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private authority failure');
  });

  it('latches authority lost during synchronous startup acknowledgement before any observer or worker effect', async () => {
    const authority = new AbortController();
    const provider = vi.fn(async () => toolReply);
    const observer = vi.fn();
    const commit = vi.fn(() => { authority.abort(); return 1; });
    const result = await runNativeMission({ ...fixture(1, provider), authoritySignal: authority.signal, commitEvent: commit, onEvent: observer });
    expect(result).toMatchObject({ state: 'recovering', persistenceFailed: true, requiresReconciliation: true, events: [] });
    expect(result.tasks[0]).toMatchObject({ state: 'blocked', reason: 'persistence-failed' });
    expect(provider).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('interrupts a pending startup acknowledgement immediately and never replays its late success', async () => {
    const authority = new AbortController();
    const entered = deferred();
    const acknowledgement = deferred<number>();
    const provider = vi.fn(async () => toolReply);
    const observer = vi.fn();
    const commit = vi.fn(() => { entered.resolve(); return acknowledgement.promise; });
    const remove = vi.spyOn(authority.signal, 'removeEventListener');
    const pending = runNativeMission({ ...fixture(1, provider), authoritySignal: authority.signal, commitEventAsync: commit, commitDeadlineMs: 60_000, onEvent: observer });
    await entered.promise;
    authority.abort();
    const result = await pending;
    expect(result).toMatchObject({ state: 'recovering', persistenceFailed: true, requiresReconciliation: true, events: [] });
    expect(provider).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    acknowledgement.resolve(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(result.events).toEqual([]);
    expect(observer).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('stops event-silent provider and tool siblings, blocks queued admission and ignores late completion', async () => {
    const authority = new AbortController();
    const toolEntered = deferred();
    const providerEntered = deferred();
    const ignoredProvider = deferred<ModelResult>();
    const ignoredTool = deferred();
    const providerReturned = deferred();
    const toolReturned = deferred();
    const activeSignals: AbortSignal[] = [];
    let calls = 0;
    const options = fixture(3, async (request, index) => {
      calls++;
      activeSignals.push(request.signal!);
      if (index === 0) return toolReply;
      if (index === 1) {
        providerEntered.resolve();
        const reply = await ignoredProvider.promise;
        providerReturned.resolve();
        return reply;
      }
      return { text: 'queued task', toolCalls: [], stop: 'end', model: 'model' };
    });
    const tool = vi.fn<AnyTool['run']>(async (_input, context) => {
      activeSignals.push(context.signal);
      toolEntered.resolve();
      await ignoredTool.promise;
      toolReturned.resolve();
      return { ok: true, output: 'late tool output' };
    });
    options.tasks[0]!.tools = [readTool(tool)];
    options.maxConcurrency = 2;
    options.abortGraceMs = 0;
    const observed: AgentEvent[] = [];
    let sequence = 0;
    const pending = runNativeMission({ ...options, authoritySignal: authority.signal, commitEvent: () => ++sequence, onEvent: event => observed.push(event) });
    await Promise.all([toolEntered.promise, providerEntered.promise]);
    authority.abort();
    const result = await pending;
    expect(result).toMatchObject({ state: 'recovering', persistenceFailed: true, requiresReconciliation: true });
    expect(result.tasks.slice(0, 2).every(task => task.state === 'unknown' && task.reason === 'persistence-failed')).toBe(true);
    expect(result.tasks[2]).toMatchObject({ state: 'blocked', reason: 'persistence-failed' });
    expect(activeSignals.every(signal => signal.aborted)).toBe(true);
    expect(calls).toBe(2);
    expect(tool).toHaveBeenCalledOnce();
    const events = JSON.stringify(result.events);
    const observedCount = observed.length;
    ignoredProvider.resolve({ text: 'late provider answer', toolCalls: [], stop: 'end', model: 'model' });
    ignoredTool.resolve();
    await Promise.all([providerReturned.promise, toolReturned.promise]);
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.stringify(result.events)).toBe(events);
    expect(observed).toHaveLength(observedCount);
    expect(calls).toBe(2);
    expect(result.events.some(event => event.taskId === id(22))).toBe(false);
  });

  it('does not dispatch queued acknowledgements or provider admissions after authority loss', async () => {
    const authority = new AbortController();
    const assignmentEntered = deferred();
    const assignmentAcknowledgement = deferred<number>();
    const provider = vi.fn(async () => toolReply);
    let sequence = 0;
    const commit = vi.fn(async (event: AgentEvent) => {
      if (event.body.type === 'task.assigned') { assignmentEntered.resolve(); return assignmentAcknowledgement.promise; }
      return ++sequence;
    });
    const pending = runNativeMission({ ...fixture(2, provider), maxConcurrency: 1, authoritySignal: authority.signal, commitEventAsync: commit, commitDeadlineMs: 60_000 });
    await assignmentEntered.promise;
    authority.abort();
    const result = await pending;
    expect(result).toMatchObject({ state: 'recovering', persistenceFailed: true, requiresReconciliation: true });
    expect(result.tasks.every(task => task.state === 'blocked' && task.reason === 'persistence-failed')).toBe(true);
    expect(provider).not.toHaveBeenCalled();
    expect(commit.mock.calls.map(([event]) => event.body.type)).toEqual(['mission.state', 'task.assigned']);
    assignmentAcknowledgement.resolve(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(result.events.map(event => event.body.type)).toEqual(['mission.state']);
  });

  it('keeps ordinary cooperative user cancellation distinct from authority loss', async () => {
    const user = new AbortController();
    const authority = new AbortController();
    const entered = deferred();
    const options = fixture(1, request => new Promise((_resolve, reject) => {
      request.signal!.addEventListener('abort', () => reject(new Error('cooperative cancellation')), { once: true });
      entered.resolve();
    }));
    const pending = runNativeMission({ ...options, signal: user.signal, authoritySignal: authority.signal });
    await entered.promise;
    user.abort();
    const result = await pending;
    expect(result).toMatchObject({ state: 'cancelled', persistenceFailed: false, requiresReconciliation: false });
    expect(result.tasks[0]).toMatchObject({ state: 'cancelled', reason: 'cancelled' });
  });

  it('cannot report success if authority is lost while the final completion acknowledgement is pending', async () => {
    const authority = new AbortController();
    const completionEntered = deferred();
    const completionAcknowledgement = deferred<number>();
    let sequence = 0;
    const pending = runNativeMission({ ...fixture(1), authoritySignal: authority.signal, commitDeadlineMs: 60_000,
      commitEventAsync: async event => {
        if (is(event, 'mission.state', 'completed')) {
          completionEntered.resolve();
          return completionAcknowledgement.promise;
        }
        return ++sequence;
      },
    });
    await completionEntered.promise;
    authority.abort();
    const result = await pending;
    expect(result).toMatchObject({ state: 'recovering', persistenceFailed: true, requiresReconciliation: true });
    expect(result.events.some(event => is(event, 'mission.state', 'completed'))).toBe(false);
    const snapshot = JSON.stringify(result);
    completionAcknowledgement.resolve(sequence + 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.stringify(result)).toBe(snapshot);
  });

  it('validates input before subscribing and removes the listener after successful completion', async () => {
    const invalidAuthority = new AbortController();
    const invalidSubscribe = vi.spyOn(invalidAuthority.signal, 'addEventListener');
    await expect(runNativeMission({ ...fixture(1), sessionId: 'invalid-session', authoritySignal: invalidAuthority.signal })).rejects.toThrow('Invalid native mission input');
    expect(invalidSubscribe).not.toHaveBeenCalled();

    const authority = new AbortController();
    const subscribe = vi.spyOn(authority.signal, 'addEventListener');
    const unsubscribe = vi.spyOn(authority.signal, 'removeEventListener');
    const observer = vi.fn();
    const result = await runNativeMission({ ...fixture(1), authoritySignal: authority.signal, onEvent: observer });
    expect(result).toMatchObject({ state: 'completed', persistenceFailed: false, requiresReconciliation: false });
    expect(subscribe).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledWith('abort', subscribe.mock.calls[0]![1]);
    const snapshot = JSON.stringify(result);
    const delivered = observer.mock.calls.length;
    authority.abort();
    await Promise.resolve();
    expect(JSON.stringify(result)).toBe(snapshot);
    expect(observer).toHaveBeenCalledTimes(delivered);
  });

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
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
