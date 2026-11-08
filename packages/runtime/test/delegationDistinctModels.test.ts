import { MAX_NATIVE_TEAM_CONCURRENT, type TeamMember } from '@extalia/core';
import type { EventBody } from '@extalia/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createDelegationTool, type ModelProvider } from '../src/index.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Native delegation with distinct member models', () => {
  it('runs eight different models together and queues a ninth until one settles', async () => {
    expect(MAX_NATIVE_TEAM_CONCURRENT).toBe(8);
    const members: TeamMember[] = Array.from({ length: 9 }, (_, index) => ({
      id: `member-${index + 1}`,
      name: `Reader ${index + 1}`,
      role: 'Reader',
      models: [`model-${index + 1}`],
    }));
    const gates = members.map(() => deferred());
    const modelRoutes: string[] = [];
    const events: EventBody[] = [];
    const live = new Set<string>();
    let peak = 0;
    const tool = createDelegationTool({
      providerFor: () => { throw new Error('Unexpected tier worker'); },
      workerTools: [],
      maxDelegations: 0,
      workspace: { name: 'Example', root: '/projects/example' },
      emit: body => events.push(body),
      onWorkerStarted: id => { live.add(id); peak = Math.max(peak, live.size); },
      onWorkerSettled: id => { live.delete(id); },
      team: {
        members,
        leadModels: ['lead-model'],
        providerForModel: (model, member): ModelProvider => {
          modelRoutes.push(`${member!.id}:${model}`);
          return {
            api: 'openai-chat',
            listModels: async () => [],
            complete: async () => {
              await gates[members.indexOf(member!)]!.promise;
              return { text: `Finished on ${model}`, toolCalls: [], stop: 'end' };
            },
          };
        },
      },
    });
    const run = (index: number) => tool.run(
      { task: `Inspect ${index + 1}`, member: members[index]!.id },
      { signal: new AbortController().signal, toolCallId: `call-${index + 1}`, emit: () => undefined },
    );

    const runs = members.map((_, index) => run(index));
    await vi.waitFor(() => expect(modelRoutes).toHaveLength(MAX_NATIVE_TEAM_CONCURRENT));

    expect(modelRoutes).toEqual(Array.from({ length: 8 }, (_, index) => `member-${index + 1}:model-${index + 1}`));
    expect(live.size).toBe(8);
    expect(peak).toBe(8);
    expect(events).toContainEqual({ type: 'subagent.state', subagentId: 'member-9', state: 'waiting', summary: 'Waiting for Native worker capacity' });
    expect(events).toContainEqual({ type: 'subagent.spawned', subagentId: 'member-8', role: 'Reader', label: 'Reader 8', model: 'model-8' });
    expect(events.some(event => event.type === 'subagent.spawned' && event.subagentId === 'member-9' && event.model)).toBe(false);

    gates[0]!.resolve();
    await vi.waitFor(() => expect(modelRoutes).toHaveLength(9));
    expect(modelRoutes[8]).toBe('member-9:model-9');
    expect(peak).toBe(8);
    expect(live.size).toBe(8);
    expect(events).toContainEqual({ type: 'subagent.spawned', subagentId: 'member-9', role: 'Reader', label: 'Reader 9', model: 'model-9' });

    for (const gate of gates) gate.resolve();
    const results = await Promise.all(runs);
    expect(results.map(result => result.output)).toEqual(members.map((_, index) => `Finished on model-${index + 1}`));
    expect(peak).toBe(8);
    expect(live.size).toBe(0);
  });
});
