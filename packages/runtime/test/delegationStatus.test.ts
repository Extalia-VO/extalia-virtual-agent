import type { TeamMember } from '@extalia/core';
import { describe, expect, it } from 'vitest';
import { createDelegationTool, type AnyTool, type ModelProvider } from '../src/index.js';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const member: TeamMember = { id: 'member-example', name: 'Reviewer', role: 'reviewer', models: ['model-a'], access: 'write' };
const write: AnyTool = { name: 'write_example', description: 'Write', access: 'write', kind: 'edit', parameters: { type: 'object', properties: {} }, describe: () => ({ label: 'Write' }), run: async () => ({ ok: true, output: 'Done' }) };

describe('delegation physical invocation observers', () => {
  it('does not count queued or cancelled writers, and waits for an abort-ignoring provider', async () => {
    const entered = deferred<void>(), release = deferred<void>(), live = new Set<string>(), labels: (string | undefined)[] = [];
    const provider: ModelProvider = { api: 'openai-chat', listModels: async () => [], complete: async () => { entered.resolve(); await release.promise; return { text: 'Done', toolCalls: [], stop: 'end' }; } };
    const tool = createDelegationTool({ providerFor: () => provider, workerTools: [], maxDelegations: 2, workspace: { name: 'Project', root: '/projects/example' }, emit: () => undefined,
      team: { members: [member], leadModels: ['model-a'], providerForModel: () => provider, writeTools: [write] },
      onWorkerStarted: (id, label) => { live.add(id); labels.push(label); }, onWorkerSettled: id => { live.delete(id); } });
    const first = new AbortController(), second = new AbortController();
    const firstRun = tool.run({ task: 'Inspect', member: member.id }, { signal: first.signal, toolCallId: 'first', emit: () => undefined });
    await entered.promise;
    const secondRun = tool.run({ task: 'Inspect again', member: member.id }, { signal: second.signal, toolCallId: 'second', emit: () => undefined });
    expect(live.size).toBe(1);
    expect(labels).toEqual(['Reviewer']);
    first.abort(); second.abort();
    await Promise.resolve(); expect(live.size).toBe(1);
    release.resolve(); await Promise.all([firstRun, secondRun]);
    expect(live.size).toBe(0);
  });

  it('makes observer errors harmless to worker execution', async () => {
    let calls = 0;
    const provider: ModelProvider = { api: 'openai-chat', listModels: async () => [], complete: async () => { calls++; return { text: 'Findings', toolCalls: [], stop: 'end' }; } };
    const tool = createDelegationTool({ providerFor: () => provider, workerTools: [], maxDelegations: 1, workspace: { name: 'Project', root: '/projects/example' }, emit: () => undefined,
      onWorkerStarted: () => { throw new Error('observer failure'); }, onWorkerSettled: () => { throw new Error('observer failure'); } });
    expect(await tool.run({ task: 'Inspect' }, { signal: new AbortController().signal, toolCallId: 'first', emit: () => undefined })).toEqual({ ok: true, output: 'Findings' });
    expect(calls).toBe(1);
  });
});
