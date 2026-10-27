import { describe, expect, it, vi } from 'vitest';
import type { OrchestrationPlan } from '@extalia/protocol';
import { createProvider, runNativeMission, type AnyTool, type FetchLike, type NativeMissionOptions, type PermissionRequest } from '../src/index.js';

// Write-capable mission workers (ADR 0028): additive and opt-in per task; read-only tasks are unchanged.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const version = { schemaVersion: 1 as const }, at = '2026-01-01T00:00:00.000Z';
const answer = () => Response.json({ model: 'model-a', choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] });
const writeCall = (path = 'src/a.txt') => Response.json({ model: 'model-a', choices: [{ message: { content: '', tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path, content: 'SECRET-CONTENT' }) } }] }, finish_reason: 'tool_calls' }] });

function fixture(fetch: FetchLike): NativeMissionOptions {
  const capabilities = { ...version, observe: true, readMessages: true, readTools: true, pause: false, resume: false, control: true, delegate: false };
  const plan: OrchestrationPlan = {
    ...version,
    mission: { ...version, id: id(2), workspaceId: id(1), leadAgentId: id(3), budgetId: id(4), state: 'queued', createdAt: at, updatedAt: at, version: 1 },
    budget: { ...version, id: id(4), workspaceId: id(1), maxTokens: 0, spentTokens: 0, maxCostUsd: 0, spentCostUsd: 0, maxDurationMs: 0, maxActiveAgents: 1, maxDelegationDepth: 1 },
    registry: { ...version, workspaceId: id(1), agents: [
      { ...version, id: id(3), origin: 'native', role: 'lead', workspaceId: id(1), engineId: 'extalia-native', capabilities: { ...capabilities, delegate: true } },
      { ...version, id: id(30), origin: 'native', role: 'write-worker', workspaceId: id(1), supervisorId: id(3), engineId: 'extalia-native', modelProfileId: id(6), capabilities },
    ] },
    providers: [{ ...version, id: id(8), adapterId: 'openai-chat', maxConcurrency: 1 }],
    models: [{ ...version, id: id(6), providerId: id(8), model: 'model-a', toolCalling: true, streaming: true, vision: false }],
    graph: { ...version, missionId: id(2), tasks: [{ ...version, id: id(20), missionId: id(2), assignedAgentId: id(30), state: 'queued', attempt: 0, dependsOn: [], requirements: ['Write'], evidenceIds: [], access: 'write' }] },
  };
  const provider = createProvider({ preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'model-a', features: { memory: 'extalia', skills: 'extalia' } }, 'synthetic-key', fetch);
  return { plan, sessionId: id(5), tasks: [{ taskId: id(20), instructions: 'Write a.txt', timeoutMs: 1000 }], bindings: [{ modelProfileId: id(6), providerId: id(8), model: 'model-a', provider }] };
}
const tool = (access: AnyTool['access'], kind: AnyTool['kind'], run: AnyTool['run'] = vi.fn(async () => ({ ok: true, output: 'Created a.txt' }))): AnyTool => ({
  name: 'write_file', description: 'Write', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } }, access, kind, describe: () => ({ label: 'private label' }), run,
});

describe('write-capable native mission workers', () => {
  it('runs worktree-rooted write tools without a per-call approval and journals bounded edits', async () => {
    let calls = 0;
    const run = vi.fn(async () => ({ ok: true, output: 'Created a.txt', files: [{ path: 'a.txt', change: 'add' as const }] }));
    const options = fixture(async (_url, init) => {
      if (++calls === 1) return writeCall();
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] };
      expect(body.messages.find(message => message.role === 'tool')?.content).toBe('Created a.txt');
      return answer();
    });
    options.tasks[0]!.tools = [tool('write', 'edit', run)];
    options.tasks[0]!.writeCapable = true;
    const requests: PermissionRequest[] = [];
    options.checkPermission = async request => { requests.push(request); return { decision: 'allow' }; };
    const result = await runNativeMission(options);
    expect(result.state).toBe('completed');
    expect(run).toHaveBeenCalledOnce();
    // The external decision point sees a workspace that allows edits: the tool root is the worker's worktree.
    expect(requests).toEqual([{ access: 'write', mode: 'workspace', permissions: { fileWrite: 'allow', commands: 'ask' }, sessionGrants: [] }]);
    const bodies = result.events.map(event => event.body);
    // ADR 0028: the tool name and the worktree-relative path, never content, labels or output.
    expect(bodies).toContainEqual({ type: 'agent.state', state: 'working', activity: 'edit' });
    expect(bodies).toContainEqual({ type: 'tool.started', tool: 'write_file', kind: 'edit', label: 'write_file', target: 'src/a.txt' });
    expect(bodies).toContainEqual({ type: 'tool.completed', tool: 'write_file', kind: 'edit', label: 'write_file', ok: true, target: 'src/a.txt' });
    const journal = JSON.stringify(result.events);
    for (const secret of ['private label', 'SECRET-CONTENT', 'Created a.txt']) expect(journal).not.toContain(secret);
  });

  it('journals an edit without a target when the model path is not a bounded relative path', async () => {
    for (const path of ['../outside.txt', '/etc/passwd', 'caf\u00e9.txt']) {
      let calls = 0;
      const options = fixture(async () => (++calls === 1 ? writeCall(path) : answer()));
      options.tasks[0]!.tools = [tool('write', 'edit', vi.fn(async () => ({ ok: false, output: 'Refused' })))];
      options.tasks[0]!.writeCapable = true;
      const result = await runNativeMission(options);
      const started = result.events.map(event => event.body).filter(body => body.type === 'tool.started');
      expect(started, path).toEqual([{ type: 'tool.started', tool: 'write_file', kind: 'edit', label: 'write_file' }]);
      expect(JSON.stringify(result.events)).not.toContain(path.slice(1, 6));
    }
  });

  it('requires the plan to mark exactly the write-capable tasks, and only the worktree file tools', async () => {
    const fetch = vi.fn<FetchLike>(async () => answer());
    const mismatched = fixture(fetch);
    mismatched.tasks[0]!.tools = [tool('write', 'edit')];
    mismatched.tasks[0]!.writeCapable = true;
    delete mismatched.plan.graph.tasks[0]!.access;
    await expect(runNativeMission(mismatched)).rejects.toThrow('Invalid native mission input');
    const readOnly = fixture(fetch);
    await expect(runNativeMission(readOnly)).rejects.toThrow('Invalid native mission input');
    const otherTool = fixture(fetch);
    otherTool.tasks[0]!.tools = [{ ...tool('write', 'edit'), name: 'apply_patch' }];
    otherTool.tasks[0]!.writeCapable = true;
    await expect(runNativeMission(otherTool)).rejects.toThrow('Invalid native mission input');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('decides worktree writes with the built-in policy as allowed, and read-only tasks still reject write tools', async () => {
    const run = vi.fn(async () => ({ ok: true, output: 'Created a.txt' }));
    let calls = 0;
    const options = fixture(async () => (++calls === 1 ? writeCall() : answer()));
    options.tasks[0]!.tools = [tool('write', 'edit', run)];
    options.tasks[0]!.writeCapable = true;
    expect((await runNativeMission(options)).state).toBe('completed');
    expect(run).toHaveBeenCalledOnce();
    const fetch = vi.fn<FetchLike>(async () => answer());
    for (const mutate of [
      (value: NativeMissionOptions) => { value.tasks[0]!.tools = [tool('write', 'edit')]; },
      (value: NativeMissionOptions) => { value.tasks[0]!.tools = [tool('write', 'edit')]; value.tasks[0]!.writeCapable = false; },
      (value: NativeMissionOptions) => { value.tasks[0]!.tools = [tool('execute', 'command')]; value.tasks[0]!.writeCapable = true; },
      (value: NativeMissionOptions) => { value.tasks[0]!.tools = [tool('write', 'command')]; value.tasks[0]!.writeCapable = true; },
      (value: NativeMissionOptions) => { value.tasks[0]!.tools = [tool('memory', 'knowledge')]; value.tasks[0]!.writeCapable = true; },
      (value: NativeMissionOptions) => { value.tasks[0]!.writeCapable = 'yes' as unknown as boolean; },
    ]) {
      const value = fixture(fetch); mutate(value);
      await expect(runNativeMission(value)).rejects.toThrow('Invalid native mission input');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
