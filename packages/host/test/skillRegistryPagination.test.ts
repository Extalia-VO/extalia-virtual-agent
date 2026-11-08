import type { SkillRevisionSummary } from '@extalia/platform';
import type { DaemonOp } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { DaemonRequestError, DaemonUnavailableError, type DaemonClient, type DaemonSidecar } from '../src/daemon/index.js';
import { MAX_REPORT_REVISIONS, SKILL_REGISTRY_OPS, SkillRegistry } from '../src/skillRegistry.js';

const summary = (index: number, origin: SkillRevisionSummary['origin'] = 'imported'): SkillRevisionSummary => ({
  packageId: `skill-${String(index).padStart(4, '0')}`, revisionId: `skr_${index.toString(16).padStart(64, '0')}`, origin,
  version: '1.0.0', treeSha256: 'a'.repeat(64), skillMdSha256: 'b'.repeat(64), state: 'quarantined', riskClass: 'declarative',
  manifestInferred: true, permissionDigest: 'c'.repeat(64), permissions: [], active: false,
  createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z',
});
const cursorOf = (revision: SkillRevisionSummary) => `${revision.packageId}/${revision.revisionId}`;

function fixture(revisions: SkillRevisionSummary[], options: { generation?: (request: number) => number; fail?: boolean; missing?: boolean; refuse?: boolean } = {}) {
  const calls: { op: string; params: { limit?: number; cursor?: string } }[] = [];
  const client = {
    capabilities: options.missing ? [] : SKILL_REGISTRY_OPS,
    request: async (op: DaemonOp, params: { limit?: number; cursor?: string }) => {
      calls.push({ op, params });
      if (options.fail) throw new DaemonUnavailableError('crashed');
      if (options.refuse) throw new DaemonRequestError('invalid_request', 'cursor_invalid');
      if (op !== 'skill.list') throw new Error(`Unexpected ${op}`);
      const offset = params.cursor ? revisions.findIndex(revision => cursorOf(revision) === params.cursor) + 1 : 0;
      const page = revisions.slice(offset, offset + params.limit!);
      return { revisions: page, indexGeneration: options.generation?.(calls.length) ?? 7,
        ...(offset + page.length < revisions.length ? { nextCursor: cursorOf(page.at(-1)!) } : {}) };
    },
  } as unknown as DaemonClient;
  const daemon = { connect: async () => client } as unknown as DaemonSidecar;
  const service = new SkillRegistry({ daemon, dataDirectory: '/tmp/example-data', profile: 'default', workspaceRoot: () => '/tmp/example-workspace' });
  return { service, calls };
}

describe('bounded skill registry metadata continuation', () => {
  it('ends the initial report at exactly 500 raw rows and continues past 1000 without skipped or duplicated revisions', async () => {
    const revisions = Array.from({ length: 1207 }, (_, index) => summary(index));
    const { service, calls } = fixture(revisions);
    const report = await service.report();
    expect(report.status).toBe('ready');
    expect(report.revisions).toHaveLength(MAX_REPORT_REVISIONS);
    expect(report.nextCursor).toBe(cursorOf(revisions[499]!));
    expect(report.truncated).toBe(true);
    expect(calls.map(call => call.params.limit)).toEqual([99, 99, 99, 99, 99, 5]);
    const collected = [...report.revisions];
    let cursor = report.nextCursor;
    while (cursor) {
      const page = await service.page({ cursor });
      expect(page.revisions.length).toBeLessThanOrEqual(99);
      expect(page.indexGeneration).toBe(report.indexGeneration);
      collected.push(...page.revisions); cursor = page.nextCursor;
    }
    expect(collected.map(revision => revision.revisionId)).toEqual(revisions.map(revision => revision.revisionId));
    expect(calls.every(call => call.op === 'skill.list')).toBe(true);
    expect(calls.slice(6).every(call => call.params.limit === 99)).toBe(true);
  });

  it('marks a complete report honestly when the final page is exactly the report cap', async () => {
    const { service } = fixture(Array.from({ length: 500 }, (_, index) => summary(index)));
    const report = await service.report();
    expect(report.revisions).toHaveLength(500);
    expect(report.truncated).toBe(false);
    expect(report.nextCursor).toBeUndefined();
  });

  it('excludes builtins from continuation metadata while preserving its daemon cursor and generation', async () => {
    const revisions = Array.from({ length: 101 }, (_, index) => summary(index, index < 100 ? 'builtin' : 'imported'));
    const { service } = fixture(revisions);
    const page = await service.page({ cursor: cursorOf(revisions[0]!) });
    expect(page.revisions).toEqual([]);
    expect(page.nextCursor).toBe(cursorOf(revisions[99]!));
    const final = await service.page({ cursor: page.nextCursor! });
    expect(final.revisions).toEqual([revisions[100]]);
    expect(final.indexGeneration).toBe(7);
  });

  it('rejects malformed input before connecting or requesting a daemon operation', async () => {
    const { service, calls } = fixture([]);
    for (const input of [null, {}, { cursor: '' }, { cursor: 'x' }, { cursor: cursorOf(summary(0)), profile: 'other' }]) {
      await expect(service.page(input as never)).rejects.toThrow('Invalid skill catalog cursor.');
    }
    expect(calls).toEqual([]);
  });

  it('fails safely when registry metadata is unavailable or the daemon refuses a cursor', async () => {
    const input = { cursor: cursorOf(summary(0)) };
    const legacy = new SkillRegistry({ daemon: undefined, dataDirectory: '/tmp/example-data', profile: 'default', workspaceRoot: () => '' });
    await expect(legacy.page(input)).rejects.toThrow(/does not serve/);
    await expect(fixture([], { missing: true }).service.page(input)).rejects.toThrow(/does not serve/);
    await expect(fixture([], { fail: true }).service.page(input)).rejects.toThrow(/unavailable.*crashed/);
    await expect(fixture([], { refuse: true }).service.page(input)).rejects.toThrow(/refused.*cursor_invalid/);
  });

  it('does not return a mixed-generation initial report, and carries changed page generations for callers to reject', async () => {
    const revisions = Array.from({ length: 110 }, (_, index) => summary(index));
    const changing = fixture(revisions, { generation: request => request === 1 ? 7 : 8 });
    expect((await changing.service.report()).status).toBe('unavailable');
    const page = await changing.service.page({ cursor: cursorOf(revisions[98]!) });
    expect(page.indexGeneration).toBe(8);
  });
});
