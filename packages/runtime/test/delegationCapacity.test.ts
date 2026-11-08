import { MAX_NATIVE_TEAM_CONCURRENT, type TeamMember } from '@extalia/core';
import { describe, expect, it, vi } from 'vitest';
import { createDelegationTool, type ModelProvider } from '../src/index.js';

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness() {
  const members: TeamMember[] = Array.from({ length: 32 }, (_, index) => ({ id: `m-${index}`, name: `Reader ${index}`, role: 'Reader', models: ['model'] }));
  const gates = members.map(() => deferred());
  const calls: string[] = [], waiting: string[] = [], live = new Set<string>();
  let peak = 0;
  const tool = createDelegationTool({
    providerFor: () => { throw new Error('Unexpected tier worker'); }, workerTools: [], maxDelegations: 0,
    workspace: { name: 'Example', root: '/projects/example' },
    emit: body => { if (body.type === 'subagent.state' && body.state === 'waiting' && body.summary === 'Waiting for Native worker capacity') waiting.push(body.subagentId); },
    onWorkerStarted: id => { live.add(id); peak = Math.max(peak, live.size); }, onWorkerSettled: id => { live.delete(id); },
    team: { members, leadModels: ['model'], providerForModel: (_model, member): ModelProvider => ({
      api: 'openai-chat', listModels: async () => [], complete: async () => {
        calls.push(member!.id);
        await gates[members.indexOf(member!)]!.promise;
        return { text: 'Verified', toolCalls: [], stop: 'end' };
      },
    }) },
  });
  const run = (index: number, signal = new AbortController().signal) => tool.run({ task: 'Inspect', member: members[index]!.id }, { signal, toolCallId: `call-${index}`, emit: () => undefined });
  return { run, gates, calls, waiting, live, peak: () => peak };
}

describe('Native delegation capacity', () => {
  it('admits a 32-reader burst in FIFO batches of at most eight active invocations', async () => {
    const h = harness();
    expect(MAX_NATIVE_TEAM_CONCURRENT).toBe(8);
    const runs = Array.from({ length: 32 }, (_, index) => h.run(index));
    for (let count = 8; count <= 32; count += 8) {
      await vi.waitFor(() => expect(h.calls).toHaveLength(count));
      expect(h.live.size).toBe(8);
      expect(h.calls).toEqual(Array.from({ length: count }, (_, index) => `m-${index}`));
      for (const gate of h.gates.slice(count - 8, count)) gate.resolve();
    }
    expect((await Promise.all(runs)).every(result => result.ok)).toBe(true);
    expect(h.peak()).toBe(8);
    expect(h.live.size).toBe(0);
    expect(await h.run(0)).toMatchObject({ ok: false, output: expect.stringContaining('limit') });
  });

  it.each([false, true])('cancels queued work and releases capacity only when an active provider settles (abort active: %s)', async abortActive => {
    const h = harness(), activeAbort = new AbortController(), queuedAbort = new AbortController();
    const active = Array.from({ length: 8 }, (_, index) => h.run(index, index === 0 ? activeAbort.signal : undefined));
    await vi.waitFor(() => expect(h.calls).toHaveLength(8));
    const cancelled = h.run(8, queuedAbort.signal), next = h.run(9);
    await vi.waitFor(() => expect(h.waiting).toEqual(['m-8', 'm-9']));
    queuedAbort.abort();
    expect(await cancelled).toMatchObject({ ok: false });
    if (abortActive) activeAbort.abort();
    await Promise.resolve();
    expect(h.calls).toHaveLength(8);
    expect(h.live.size).toBe(8);
    // This provider ignores abort. Its physical failure, not abort, releases capacity.
    h.gates[0]!.reject(new Error('Provider failed'));
    await vi.waitFor(() => expect(h.calls).toEqual([...Array.from({ length: 8 }, (_, index) => `m-${index}`), 'm-9']));
    expect(h.live.size).toBe(8);
    for (const gate of h.gates) gate.resolve();
    expect((await Promise.all([...active, next])).map(result => result.ok)).toEqual([false, true, true, true, true, true, true, true, true]);
    expect(h.peak()).toBe(8);
    expect(h.live.size).toBe(0);
    expect(await h.run(10)).toMatchObject({ ok: true });
  });
});
