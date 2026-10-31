import { describe, expect, it, vi } from 'vitest';
import type { OrchestrationPlan } from '@extalia/protocol';
import { runNativeMission, type AnyTool, type ModelResult, type NativeLocalOperationsDrained, type NativeMissionOptions } from '../src/index.js';
import { LocalOperationTracker } from '../src/localOperations.js';
import * as turnLoop from '../src/loop.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const coverage = 'extalia-native-local-v1' as const;
const version = { schemaVersion: 1 as const };
const at = '2026-10-18T00:00:00.000Z';
const answer: ModelResult = { text: 'Answer', toolCalls: [], stop: 'end', model: 'model' };
const toolReply: ModelResult = { text: '', toolCalls: [{ id: 'call-1', name: 'read_only', input: {} }], stop: 'tool_use', model: 'model' };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(count = 1, complete: NativeMissionOptions['bindings'][number]['provider']['complete'] = async () => answer): NativeMissionOptions {
  const capabilities = { ...version, observe: true, readMessages: true, readTools: true, pause: false, resume: false, control: true, delegate: false };
  const plan: OrchestrationPlan = {
    ...version,
    mission: { ...version, id: id(2), workspaceId: id(1), leadAgentId: id(3), budgetId: id(4), state: 'queued', createdAt: at, updatedAt: at, version: 1 },
    budget: { ...version, id: id(4), workspaceId: id(1), maxTokens: 1000, spentTokens: 0, maxCostUsd: 1, spentCostUsd: 0, maxDurationMs: 10_000, maxActiveAgents: count, maxDelegationDepth: 1 },
    registry: { ...version, workspaceId: id(1), agents: [
      { ...version, id: id(3), origin: 'native', workspaceId: id(1), role: 'lead', engineId: 'extalia-native', capabilities: { ...capabilities, delegate: true } },
      ...Array.from({ length: count }, (_, index) => ({ ...version, id: id(10 + index), origin: 'native' as const, workspaceId: id(1), supervisorId: id(3), role: 'worker', engineId: 'extalia-native', modelProfileId: id(5), capabilities })),
    ] },
    providers: [{ ...version, id: id(6), adapterId: 'openai-chat', maxConcurrency: count }],
    models: [{ ...version, id: id(5), providerId: id(6), model: 'model', toolCalling: true, streaming: true, vision: false }],
    graph: { ...version, missionId: id(2), tasks: Array.from({ length: count }, (_, index) => ({ ...version, id: id(20 + index), missionId: id(2), assignedAgentId: id(10 + index), state: 'queued' as const, attempt: 0, dependsOn: [], requirements: ['Read only'], evidenceIds: [] })) },
  };
  return { plan, sessionId: id(7), tasks: plan.graph.tasks.map(task => ({ taskId: task.id, instructions: 'Inspect files', timeoutMs: 5_000, localSettlementCoverage: coverage })),
    bindings: [{ modelProfileId: id(5), providerId: id(6), model: 'model', localSettlementCoverage: coverage, provider: { api: 'openai-chat', listModels: async () => [], complete } }] };
}

function readTool(run: AnyTool['run'], name = 'read_only'): AnyTool {
  return { name, description: 'Read fixture', parameters: { type: 'object', properties: {} }, access: 'read', kind: 'read', describe: () => ({ label: 'Read fixture' }), run };
}

const receipt = (providerOperations: number, toolOperations: number): NativeLocalOperationsDrained => ({
  missionId: id(2), taskId: id(20), agentId: id(10), attempt: 1, kind: 'local-operations-drained', coverage, providerOperations, toolOperations,
});

describe('native local operation settlement', () => {
  it('reports captured bounded counts once, after the weak observation and complete tool pipeline', async () => {
    const order: string[] = [], observations: NativeLocalOperationsDrained[] = [];
    let calls = 0;
    const options = fixture(1, async () => ++calls === 1 ? toolReply : answer);
    options.tasks[0]!.tools = [readTool(async () => ({ ok: true, output: 'file' }))];
    const replacement = vi.fn();
    options.onTurnSettled = () => { order.push('turn'); expect(observations).toEqual([]); };
    options.onLocalOperationsDrained = value => { order.push('drain'); observations.push({ ...value }); value.taskId = 'observer mutation'; };
    options.onEvent = () => { options.onLocalOperationsDrained = replacement; options.tasks[0]!.localSettlementCoverage = undefined; options.bindings[0]!.localSettlementCoverage = undefined; };
    const result = await runNativeMission(options);
    expect(result.state).toBe('completed');
    expect(order).toEqual(['turn', 'drain']);
    expect(observations).toEqual([receipt(2, 1)]);
    expect(replacement).not.toHaveBeenCalled();
  });

  it.each(['task', 'binding', 'both'] as const)('does not prove default/custom unknown %s coverage', async missing => {
    const options = fixture();
    if (missing !== 'binding') options.tasks[0]!.localSettlementCoverage = undefined;
    if (missing !== 'task') options.bindings[0]!.localSettlementCoverage = undefined;
    const observed = vi.fn();
    expect((await runNativeMission({ ...options, onLocalOperationsDrained: observed })).state).toBe('completed');
    expect(observed).not.toHaveBeenCalled();
  });

  it.each(['task', 'binding', 'callback'] as const)('rejects invalid %s coverage input before effects', async invalid => {
    const complete = vi.fn(async () => answer), options = fixture(1, complete);
    if (invalid === 'task') Object.assign(options.tasks[0]!, { localSettlementCoverage: 'custom' });
    if (invalid === 'binding') Object.assign(options.bindings[0]!, { localSettlementCoverage: 'custom' });
    if (invalid === 'callback') Object.assign(options, { onLocalOperationsDrained: true });
    await expect(runNativeMission(options)).rejects.toThrow('Invalid native mission input');
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'timeout', 'deadline', 'authority', 'persistence'] as const)('never treats %s or grace expiry as drain of an abort-ignoring provider', async stop => {
    const entered = deferred(), reply = deferred<ModelResult>(), delivered = deferred();
    const user = new AbortController(), authority = new AbortController();
    const observed = vi.fn(() => delivered.resolve()), weak = vi.fn();
    const complete = vi.fn(async () => { entered.resolve(); return reply.promise; });
    const options = fixture(2, complete);
    let commitSequence = 0;
    if (stop === 'timeout') options.tasks[0]!.timeoutMs = 5;
    const pending = runNativeMission({ ...options, maxConcurrency: 1, abortGraceMs: 0, signal: user.signal, authoritySignal: authority.signal,
      ...(stop === 'deadline' ? { budget: { maxDurationMs: 5 } } : {}),
      ...(stop === 'persistence' ? { commitEvent: event => { if (event.body.type === 'task.state' && event.body.state === 'unknown') throw new Error('commit failed'); return ++commitSequence; } } : {}),
      onTurnSettled: weak, onLocalOperationsDrained: observed,
    });
    await entered.promise;
    if (stop === 'cancel' || stop === 'persistence') user.abort();
    if (stop === 'authority') authority.abort();
    const result = await pending;
    expect(result.state).toBe('recovering');
    if (stop === 'persistence') expect(result.persistenceFailed).toBe(true);
    expect(observed).not.toHaveBeenCalled();
    expect(weak).not.toHaveBeenCalled();
    const snapshot = JSON.stringify(result);
    if (stop === 'timeout') reply.reject(new Error('late provider failure'));
    else reply.resolve(toolReply);
    await delivered.promise;
    expect(observed).toHaveBeenCalledExactlyOnceWith(receipt(1, 0));
    expect(weak).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).toBe(snapshot);
  });

  it('waits for a late rejection of an abort-ignoring raw tool', async () => {
    const entered = deferred(), reply = deferred<{ ok: boolean; output: string }>(), delivered = deferred();
    const options = fixture(1, async () => toolReply);
    options.tasks[0]!.tools = [readTool(async () => { entered.resolve(); return reply.promise; })];
    options.tasks[0]!.timeoutMs = 5;
    const observed = vi.fn(() => delivered.resolve());
    const pending = runNativeMission({ ...options, abortGraceMs: 0, onLocalOperationsDrained: observed });
    await entered.promise;
    const result = await pending;
    expect(result.state).toBe('recovering');
    expect(observed).not.toHaveBeenCalled();
    reply.reject(new Error('late tool failure'));
    await delivered.promise;
    expect(observed).toHaveBeenCalledExactlyOnceWith(receipt(1, 1));
  });

  it.each(['raw-tool', 'permission'] as const)('quarantines a settled aggregate while its parallel %s sibling remains pending', async held => {
    const release = deferred(), delivered = deferred();
    const raw = vi.fn(async () => { await release.promise; return { ok: true, output: 'late' }; });
    const blockedRaw = vi.fn(async () => ({ ok: true, output: 'never' }));
    const complete = vi.fn(async () => ({ ...toolReply, toolCalls: [...toolReply.toolCalls, { id: 'call-2', name: 'other_read', input: {} }] }));
    const options = fixture(2, complete);
    options.tasks[0]!.tools = [readTool(raw), readTool(blockedRaw, 'other_read')];
    const weak = vi.fn(), observed = vi.fn(() => delivered.resolve());
    const realRun = turnLoop.runTurn;
    const spy = vi.spyOn(turnLoop, 'runTurn').mockImplementationOnce(turn => {
      let checks = 0;
      return realRun({ ...turn, tools: turn.tools.map(tool => ({ ...tool, parallel: true })),
        ...(held === 'permission' ? { checkPermission: async () => {
          if (++checks === 1) { await release.promise; return { decision: 'allow' as const }; }
          throw new Error('permission failed');
        } } : {}),
        emit: body => { if (body.type === 'tool.started' && body.tool === 'other_read') throw new Error('parallel delivery failed'); turn.emit(body); },
      });
    }).mockImplementation(realRun);
    try {
      const result = await runNativeMission({ ...options, maxConcurrency: 1, onTurnSettled: weak, onLocalOperationsDrained: observed });
      expect(result.state).toBe('recovering');
      expect(result.tasks[0]).toMatchObject({ state: 'unknown', reason: 'execution-unknown' });
      expect(result.tasks[1]).toMatchObject({ state: 'blocked', reason: 'capacity-unknown' });
      expect(weak).toHaveBeenCalledOnce();
      expect(observed).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledOnce();
      release.resolve();
      await delivered.promise;
      expect(observed).toHaveBeenCalledExactlyOnceWith(receipt(1, held === 'raw-tool' ? 1 : 0));
      expect(blockedRaw).not.toHaveBeenCalled();
      if (held === 'permission') expect(raw).not.toHaveBeenCalled();
    } finally { release.resolve(); spy.mockRestore(); }
  });

  it.each(['provider', 'tool'] as const)('counts a synchronously throwing raw %s invocation without false early proof', async kind => {
    const observed = vi.fn();
    const options = fixture(1, kind === 'provider' ? () => { throw new Error('sync provider'); } : async () => toolReply);
    if (kind === 'tool') options.tasks[0]!.tools = [readTool(() => { expect(observed).not.toHaveBeenCalled(); throw new Error('sync tool'); })];
    options.tasks[0]!.maxSteps = 1;
    await runNativeMission({ ...options, onLocalOperationsDrained: observed });
    expect(observed).toHaveBeenCalledExactlyOnceWith(receipt(1, kind === 'tool' ? 1 : 0));
  });

  it('tracks the complete tool acknowledgement wait and prevents precheck/code effects after a sibling seals admission', async () => {
    const waiting = deferred(), release = deferred(), settled = deferred(), drained = deferred();
    const raw = vi.fn(async () => ({ ok: true, output: 'never' })), precheck = vi.fn(() => undefined);
    const options = fixture(1, async () => ({ ...toolReply, toolCalls: [...toolReply.toolCalls, { id: 'call-2', name: 'other_read', input: {} }] }));
    options.tasks[0]!.tools = [{ ...readTool(raw), precheck }, readTool(raw, 'other_read')];
    const realRun = turnLoop.runTurn;
    const spy = vi.spyOn(turnLoop, 'runTurn').mockImplementationOnce(turn => realRun({ ...turn,
      tools: turn.tools.map(tool => ({ ...tool, parallel: true })),
      emit: body => { if (body.type === 'tool.started' && body.tool === 'other_read') throw new Error('sibling failed'); turn.emit(body); },
    })).mockImplementation(realRun);
    const observed = vi.fn(() => drained.resolve());
    let sequence = 0;
    try {
      const pending = runNativeMission({ ...options, onTurnSettled: () => settled.resolve(), onLocalOperationsDrained: observed,
        commitEventAsync: async event => {
          const next = ++sequence;
          if (event.body.type === 'tool.started') { waiting.resolve(); await release.promise; }
          return next;
        },
      });
      await waiting.promise;
      await settled.promise;
      expect(observed).not.toHaveBeenCalled();
      expect(raw).not.toHaveBeenCalled();
      expect(precheck).not.toHaveBeenCalled();
      release.resolve();
      await drained.promise;
      const result = await pending;
      expect(result.state).toBe('recovering');
      expect(observed).toHaveBeenCalledExactlyOnceWith(receipt(1, 0));
      expect(raw).not.toHaveBeenCalled();
      expect(precheck).not.toHaveBeenCalled();
    } finally { release.resolve(); spy.mockRestore(); }
  });

  it('contains synchronous and accidental async drain observer failures', async () => {
    for (const observer of [() => { throw new Error('observer'); }, async () => { throw new Error('observer'); }]) {
      const result = await runNativeMission({ ...fixture(), onLocalOperationsDrained: observer });
      await Promise.resolve();
      expect(result).toMatchObject({ state: 'completed', persistenceFailed: false, eventDeliveryFailed: false });
    }
  });

  it('does not prove queued or failed admissions, including a synchronous runner throw', async () => {
    const observed = vi.fn(), authority = new AbortController();
    authority.abort();
    await runNativeMission({ ...fixture(), authoritySignal: authority.signal, onLocalOperationsDrained: observed });
    const spy = vi.spyOn(turnLoop, 'runTurn').mockImplementationOnce(() => { throw new Error('runner'); });
    try { await runNativeMission({ ...fixture(), onLocalOperationsDrained: observed }); }
    finally { spy.mockRestore(); }
    expect(observed).not.toHaveBeenCalled();
  });

  it('counts only actual raw implementation calls, excluding permission and precheck refusals', async () => {
    for (const refused of ['permission', 'precheck'] as const) {
      const raw = vi.fn(async () => ({ ok: true, output: 'never' })), observed = vi.fn();
      const options = fixture(1, async () => toolReply);
      options.tasks[0]!.maxSteps = 1;
      options.tasks[0]!.tools = [{ ...readTool(raw), ...(refused === 'precheck' ? { precheck: () => 'refused' } : {}) }];
      await runNativeMission({ ...options, ...(refused === 'permission' ? { checkPermission: async () => ({ decision: 'deny' as const }) } : {}), onLocalOperationsDrained: observed });
      expect(raw).not.toHaveBeenCalled();
      expect(observed).toHaveBeenCalledExactlyOnceWith(receipt(1, 0));
    }
  });

  it('bounds receipts to twenty raw provider and eighty raw tool operations', async () => {
    const observed = vi.fn(), tracker = new LocalOperationTracker(observed);
    tracker.markStarted();
    for (let index = 0; index < 20; index++) await tracker.invoke('provider', async () => undefined);
    for (let index = 0; index < 80; index++) await tracker.invoke('tool', async () => undefined);
    const forbidden = vi.fn(async () => undefined);
    await expect(tracker.invoke('provider', forbidden)).rejects.toThrow('limit exceeded');
    await expect(tracker.invoke('tool', forbidden)).rejects.toThrow('limit exceeded');
    expect(forbidden).not.toHaveBeenCalled();
    expect(observed).not.toHaveBeenCalled();
    tracker.markSettled();
    expect(observed).toHaveBeenCalledExactlyOnceWith({ providerOperations: 20, toolOperations: 80 });
  });

  it('registers before raw invocation and reserves all sibling pipelines before synchronous failures', async () => {
    const observed = vi.fn(), tracker = new LocalOperationTracker(observed);
    tracker.markStarted();
    const first = tracker.reserveToolPipeline(), second = tracker.reserveToolPipeline();
    const failure = first.run(() => tracker.invoke('tool', () => { expect(tracker.pending).toBe(3); throw new Error('sync'); }));
    await expect(failure).rejects.toThrow('sync');
    tracker.markSettled();
    expect(tracker.pending).toBe(1);
    expect(observed).not.toHaveBeenCalled();
    const never = vi.fn(async () => 'must not run');
    await expect(second.run(never)).rejects.toThrow('admission is closed');
    expect(never).not.toHaveBeenCalled();
    expect(observed).toHaveBeenCalledExactlyOnceWith({ providerOperations: 0, toolOperations: 1 });
  });
});
