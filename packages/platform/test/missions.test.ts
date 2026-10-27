import { describe, expect, it } from 'vitest';
import { isHostMissionRecoveryMetadata, isHostMissionTaskUsage, isHostMissionUsage, normalizeHostMissionBudget, normalizeHostMissionRequest } from '../src/missions.js';

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `Task ${id}`, instructions: `Do ${id}`, connectionId: 'c_primary', model: 'model-a', ...extra,
});

describe('normalizeHostMissionRequest', () => {
  it('normalizes defaults and preserves a multi-connection dependency DAG', () => {
    const result = normalizeHostMissionRequest({
      title: '  Research  ', maxConcurrency: 3,
      tasks: [task('prepare'), task('review', { connectionId: 'legacy.connection:two', model: 'provider/model-b', dependsOn: ['prepare'], instructions: '  Preserve this prompt  ' })],
    });
    expect(result).toEqual({
      title: 'Research', maxConcurrency: 3,
      tasks: [
        { id: 'prepare', title: 'Task prepare', instructions: 'Do prepare', connectionId: 'c_primary', model: 'model-a', dependsOn: [], timeoutMs: 60_000, maxSteps: 8 },
        { id: 'review', title: 'Task review', instructions: '  Preserve this prompt  ', connectionId: 'legacy.connection:two', model: 'provider/model-b', dependsOn: ['prepare'], timeoutMs: 60_000, maxSteps: 8 },
      ],
    });
  });

  it('rejects extra, inherited, accessor, and prototype-bearing properties', () => {
    expect(() => normalizeHostMissionRequest({ title: 'x', tasks: [task('a')], tools: [] })).toThrow('Invalid native mission request.');
    const inherited = Object.create({ tasks: [task('a')] }) as Record<string, unknown>;
    inherited.title = 'x';
    expect(() => normalizeHostMissionRequest(inherited)).toThrow('Invalid native mission request.');
    const accessor = { title: 'x', tasks: [task('a')] };
    Object.defineProperty(accessor, 'maxConcurrency', { enumerable: true, get: () => 2 });
    expect(() => normalizeHostMissionRequest(accessor)).toThrow('Invalid native mission request.');
    expect(() => normalizeHostMissionRequest(Object.assign(Object.create(null), { title: 'x', tasks: [task('a')] }))).not.toThrow();
  });

  it('rejects invalid bounds, non-finite numbers, references, duplicates, and cycles', () => {
    const sparseTasks = new Array(3);
    sparseTasks[0] = task('a');
    sparseTasks[2] = task('c');
    const invalid: unknown[] = [
      { title: 'x', tasks: [] },
      { title: 'x', tasks: Array.from({ length: 17 }, (_, i) => task(`task${i}`)) },
      { title: 'x', maxConcurrency: Number.NaN, tasks: [task('a')] },
      { title: 'x', maxConcurrency: 9, tasks: [task('a')] },
      { title: 'x', tasks: [task('a', { timeoutMs: Infinity })] },
      { title: 'x', tasks: [task('a', { maxSteps: 0 })] },
      { title: 'x', tasks: [task('a', { dependsOn: ['missing'] })] },
      { title: 'x', tasks: [task('a', { dependsOn: ['a'] })] },
      { title: 'x', tasks: [task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })] },
      { title: 'x', tasks: [task('a'), task('a')] },
      { title: 'x', tasks: [task('bad/id')] },
      { title: 'x', tasks: [task('a', { model: '--flag' })] },
      { title: 'x', tasks: [task('a', { connectionId: '../secret' })] },
      { title: 'x', tasks: [task('a', { connectionId: ' c_id' })] },
      { title: 'bad\ttitle', tasks: [task('a')] },
      { title: 'bad\u0000title', tasks: [task('a')] },
      { title: 'bad\u007ftitle', tasks: [task('a')] },
      { title: 'bad\u2028title', tasks: [task('a')] },
      { title: 'x', tasks: sparseTasks },
    ];
    for (const value of invalid) expect(() => normalizeHostMissionRequest(value)).toThrow('Invalid native mission request.');
  });

  it('returns detached arrays and task objects', () => {
    const input: { title: string; tasks: Array<Record<string, unknown>> } = { title: 'Mission', tasks: [task('one'), task('two', { dependsOn: ['one'] })] };
    const result = normalizeHostMissionRequest(input);
    (input.tasks[1]!.dependsOn as string[]).push('two');
    input.tasks[0]!.title = 'mutated';
    expect(result.tasks[1]!.dependsOn).toEqual(['one']);
    expect(result.tasks[0]!.title).toBe('Task one');
  });
});

describe('mission budget normalization (ADR 0015)', () => {
  it('unifies concurrency into one budget object and keeps omitted limits unenforced', () => {
    expect(normalizeHostMissionRequest({ title: 'x', tasks: [task('a')] })).toEqual(expect.not.objectContaining({ budget: expect.anything() }));
    expect(normalizeHostMissionRequest({ title: 'x', tasks: [task('a')], budget: {} })).toMatchObject({ maxConcurrency: 3, budget: { maxConcurrency: 3 } });
    expect(normalizeHostMissionRequest({ title: 'x', tasks: [task('a')], maxConcurrency: 2, budget: { maxTokens: 500, maxTaskTokens: 500 } }))
      .toMatchObject({ maxConcurrency: 2, budget: { maxTokens: 500, maxTaskTokens: 500, maxConcurrency: 2 } });
    expect(normalizeHostMissionRequest({ title: 'x', tasks: [task('a')], budget: { maxConcurrency: 5, maxDurationMs: 1_000 } }))
      .toMatchObject({ maxConcurrency: 5, budget: { maxConcurrency: 5, maxDurationMs: 1_000 } });
    expect(normalizeHostMissionBudget({ maxDurationMs: 86_400_000, maxTokens: 100_000_000 })).toEqual({ maxDurationMs: 86_400_000, maxTokens: 100_000_000, maxConcurrency: 3 });
  });

  it('rejects unknown keys, non-integers, out-of-range and contradictory limits instead of clamping', () => {
    const invalid: unknown[] = [
      null, [], 'budget', { maxCostUsd: 1 }, { maxTokens: 0 }, { maxTokens: 100_000_001 }, { maxTokens: 1.5 }, { maxTokens: Number.NaN },
      { maxTokens: '100' }, { maxTaskTokens: 0 }, { maxDurationMs: 999 }, { maxDurationMs: 86_400_001 }, { maxConcurrency: 9 }, { maxConcurrency: 0 },
      { maxTokens: 100, maxTaskTokens: 101 }, Object.create({ maxTokens: 1 }),
    ];
    for (const budget of invalid) expect(() => normalizeHostMissionRequest({ title: 'x', tasks: [task('a')], budget })).toThrow('Invalid native mission request.');
    expect(() => normalizeHostMissionRequest({ title: 'x', tasks: [task('a')], maxConcurrency: 2, budget: { maxConcurrency: 3 } })).toThrow('Invalid native mission request.');
    const accessor = {};
    Object.defineProperty(accessor, 'maxTokens', { enumerable: true, get: () => 5 });
    expect(() => normalizeHostMissionBudget(accessor)).toThrow('Invalid native mission request.');
  });

  it('checks retained usage shapes strictly and never accepts estimates', () => {
    expect(isHostMissionUsage({ unknownTasks: 0 }, 1)).toBe(true);
    expect(isHostMissionUsage({ inputTokens: 3, outputTokens: 4, unknownTasks: 1 }, 1)).toBe(true);
    for (const usage of [{}, { unknownTasks: 2 }, { unknownTasks: -1 }, { inputTokens: 1.2, unknownTasks: 0 }, { unknownTasks: 0, costUsd: 1 }, { unknownTasks: 0, estimated: true }, null]) {
      expect(isHostMissionUsage(usage, 1)).toBe(false);
    }
    expect(isHostMissionTaskUsage({})).toBe(true);
    expect(isHostMissionTaskUsage({ inputTokens: 1, unknown: true })).toBe(true);
    for (const usage of [{ unknown: false }, { outputTokens: -1 }, { cachedInputTokens: 1 }, []]) expect(isHostMissionTaskUsage(usage)).toBe(false);
  });
});


describe('persisted mission authority and recovery metadata', () => {
  it('accepts absent legacy ownership and only explicit valid backend identities and provenance', () => {
    const authority = { backend: 'rust' as const, profileId: 'default', workspaceId: '00000000-0000-4000-8000-000000000001' };
    expect(isHostMissionRecoveryMetadata({})).toBe(true);
    expect(isHostMissionRecoveryMetadata({ authority: { backend: 'typescript' } })).toBe(true);
    expect(isHostMissionRecoveryMetadata({ authority, recovery: { source: 'host-restart', at: '2026-10-27T00:00:00.000Z' } })).toBe(true);
    for (const invalid of [null, { backend: 'other' }, { backend: 'typescript', workspaceId: authority.workspaceId }, { ...authority, workspaceId: 'host-workspace' }, { ...authority, profileId: '../other' }, { ...authority, extra: true }]) {
      expect(isHostMissionRecoveryMetadata({ authority: invalid } as never)).toBe(false);
    }
    for (const recovery of [{ source: 'host-restart', at: 'yesterday' }, { source: 'inferred', at: '2026-10-27T00:00:00.000Z' }, { source: 'host-restart', at: '2026-10-27T00:00:00.000Z', extra: true }]) {
      expect(isHostMissionRecoveryMetadata({ recovery } as never)).toBe(false);
    }
    const accessor = Object.defineProperty({}, 'backend', { enumerable: true, get() { throw new Error('Getter must not run'); } });
    expect(isHostMissionRecoveryMetadata({ authority: accessor } as never)).toBe(false);
  });
});
