import type { EventBody, OrchestrationPlan } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import {
  checkedVerdict, runNativeMission, runTurn, type AnyTool, type ModelProvider, type ModelResult, type NativeMissionOptions, type PermissionRequest, type PermissionVerdict, type ToolAccess,
} from '../src/index.js';

// ADR 0026: an external policy decision point (the Rust core's `permission.check`) replaces
// `decide()` at the single tool execution boundary; an unavailable one denies, never falls back.
const readTool = (log: string[], access: ToolAccess = 'read'): AnyTool => ({
  name: 'read_only', description: 'Read', access, kind: 'read', parameters: { type: 'object', properties: {} },
  describe: () => ({ label: 'read-only fixture' }), run: async () => { log.push('ran'); return { ok: true, output: 'contents' }; },
});
const toolStep: ModelResult = { text: '', toolCalls: [{ id: 'c1', name: 'read_only', input: {} }], stop: 'tool_use', model: 'model' };
const finalStep: ModelResult = { text: 'Done.', toolCalls: [], stop: 'end', model: 'model' };
function provider(steps: ModelResult[]): ModelProvider {
  return { api: 'openai-chat', listModels: async () => [], complete: async () => { const step = steps.shift(); if (!step) throw new Error('no more steps'); return step; } };
}

describe('external permission decision point in runTurn', () => {
  async function turn(checkPermission: (request: PermissionRequest) => Promise<PermissionVerdict>, access: ToolAccess = 'read') {
    const ran: string[] = [], events: EventBody[] = [], requests: PermissionRequest[] = [];
    const result = await runTurn({
      provider: provider([toolStep, finalStep]), system: 'sys', history: [], prompt: 'read', tools: [readTool(ran, access)],
      permissions: { fileWrite: 'allow', commands: 'ask' }, sessionGrants: new Set(['execute']), permissionMode: 'accept-edits',
      emit: body => events.push(body), requestApproval: async () => 'once', signal: new AbortController().signal,
      checkPermission: async request => { requests.push(request); return checkPermission(request); },
    });
    const output = events.find(event => event.type === 'tool.completed');
    return { result, ran, requests, output: output?.type === 'tool.completed' ? output : undefined };
  }

  it('asks it with the decision inputs instead of decide()', async () => {
    const allowed = await turn(async () => ({ decision: 'allow' }));
    expect(allowed.ran).toEqual(['ran']);
    expect(allowed.requests).toEqual([{ access: 'read', mode: 'accept-edits', permissions: { fileWrite: 'allow', commands: 'ask' }, sessionGrants: ['execute'] }]);
    // decide() would allow a read; the decision point's answer wins.
    const denied = await turn(async () => ({ decision: 'deny' }));
    expect(denied.ran).toEqual([]);
    expect(denied.output).toMatchObject({ ok: false, output: expect.stringContaining('Plan mode') });
  });

  it.each([
    ['a rejection', async () => { throw new Error('daemon gone'); }],
    ['policy_unavailable', async () => ({ decision: 'deny', reason: 'policy_unavailable' }) as PermissionVerdict],
    ['a malformed verdict', async () => ({ decision: 'yes' }) as unknown as PermissionVerdict],
    ['an unknown reason', async () => ({ decision: 'allow', reason: 'override' }) as unknown as PermissionVerdict],
  ])('denies every call, reads included, on %s', async (_name, check) => {
    const { ran, output, result } = await turn(check);
    expect(ran).toEqual([]);
    expect(output).toMatchObject({ ok: false, output: 'The permission service is unavailable, so this tool call was denied.' });
    expect(result.outcome).toBe('completed');
  });

  it('accepts only exact verdicts', () => {
    expect(checkedVerdict({ decision: 'ask' })).toEqual({ decision: 'ask' });
    for (const raw of [undefined, null, 'allow', { decision: 'allow', extra: 1, reason: 'x' }, { reason: 'policy_unavailable', decision: 'allow' }]) {
      expect(checkedVerdict(raw)).toEqual({ decision: 'deny', reason: 'policy_unavailable' });
    }
  });
});

describe('external permission decision point in native missions', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const version = { schemaVersion: 1 as const };
  const at = '2026-10-22T00:00:00.000Z';
  function fixture(steps: ModelResult[], log: string[], count = 1): NativeMissionOptions {
    const capability = { ...version, observe: true, readMessages: true, readTools: true, pause: false, resume: false, control: true, delegate: false };
    const plan: OrchestrationPlan = {
      ...version,
      mission: { ...version, id: id(2), workspaceId: id(1), leadAgentId: id(3), budgetId: id(4), state: 'queued', createdAt: at, updatedAt: at, version: 1 },
      budget: { ...version, id: id(4), workspaceId: id(1), maxTokens: 1000, spentTokens: 0, maxCostUsd: 1, spentCostUsd: 0, maxDurationMs: 10_000, maxActiveAgents: 1, maxDelegationDepth: 1 },
      registry: { ...version, workspaceId: id(1), agents: [
        { ...version, id: id(3), origin: 'native', workspaceId: id(1), role: 'lead', engineId: 'extalia-native', capabilities: { ...capability, delegate: true } },
        ...Array.from({ length: count }, (_, index) => ({ ...version, id: id(10 + index), origin: 'native' as const, workspaceId: id(1), supervisorId: id(3), role: 'worker', engineId: 'extalia-native', modelProfileId: id(5), capabilities: capability })),
      ] },
      providers: [{ ...version, id: id(6), adapterId: 'openai-chat', maxConcurrency: 1 }],
      models: [{ ...version, id: id(5), providerId: id(6), model: 'model', toolCalling: true, streaming: true, vision: false }],
      graph: { ...version, missionId: id(2), tasks: Array.from({ length: count }, (_, index) => ({ ...version, id: id(20 + index), missionId: id(2), assignedAgentId: id(10 + index), state: 'queued' as const, attempt: 0, dependsOn: [], requirements: ['Read only'], evidenceIds: [] })) },
    };
    return {
      plan, sessionId: id(7), maxConcurrency: 1,
      tasks: plan.graph.tasks.map((task, index) => ({ taskId: task.id, instructions: `Inspect task-${index}`, timeoutMs: 5_000, tools: [readTool(log)] })),
      bindings: [{ modelProfileId: id(5), providerId: id(6), model: 'model', provider: provider(steps) }],
    };
  }
  let sequence = 0;
  const sink: NativeMissionOptions['commitEventAsync'] = async () => ++sequence;

  it('runs worker tools the decision point allows, with the mission worker inputs', async () => {
    const log: string[] = [], requests: PermissionRequest[] = [];
    const result = await runNativeMission({ ...fixture([toolStep, finalStep], log), commitEventAsync: sink, checkPermission: async request => { requests.push(request); return { decision: 'allow' }; } });
    expect(result.state).toBe('completed');
    expect(log).toEqual(['ran']);
    expect(requests).toEqual([{ access: 'read', mode: 'workspace', permissions: { fileWrite: 'ask', commands: 'ask' }, sessionGrants: [] }]);
  });

  it('denies and latches the mission like a failed commit when the decision point is unavailable', async () => {
    const log: string[] = [];
    const options = fixture([toolStep, finalStep, finalStep], log, 2);
    const result = await runNativeMission({ ...options, commitEventAsync: sink, checkPermission: async () => { throw new Error('daemon gone'); } });
    expect(log).toEqual([]);
    expect(result).toMatchObject({ state: 'recovering', persistenceFailed: true, requiresReconciliation: true });
    expect(result.tasks.map(task => [task.state, task.reason])).toEqual([['unknown', 'persistence-failed'], ['blocked', 'persistence-failed']]);
    expect(result.events.some(event => event.body.type === 'tool.started')).toBe(false);
  });

  it('rejects a decision point that is not a function', async () => {
    await expect(runNativeMission({ ...fixture([finalStep], []), checkPermission: 'allow' as never })).rejects.toThrow(/Invalid native mission input/);
  });
});
