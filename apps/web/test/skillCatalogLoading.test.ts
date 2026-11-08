import type { SkillRegistryPage, SkillRevisionSummary } from '@extalia/platform';
import { describe, expect, it, vi } from 'vitest';
import { loadSkillCatalogBatch, SkillCatalogChanged } from '../src/skills/skillCatalogLoading';

function revision(index: number): SkillRevisionSummary {
  const digest = index.toString(16).padStart(64, '0');
  return { packageId: `example/skill-${index}`, revisionId: `skr_${digest}`, origin: 'user', version: '1.0.0', treeSha256: digest,
    skillMdSha256: digest, state: 'quarantined', riskClass: 'declarative', manifestInferred: false,
    permissionDigest: digest, permissions: [], active: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
}

describe('incremental registry catalog loading', () => {
  it('keeps an explicit continuation after at most five pages and deduplicates exact revisions', async () => {
    let index = 0;
    const read = vi.fn(async () => ({ revisions: [revision(index++), revision(0)], nextCursor: `cursor-${index}`, indexGeneration: 3 }));
    const batch = await loadSkillCatalogBatch(read, 'start', 3, () => true);
    expect(read).toHaveBeenCalledTimes(5);
    expect(batch?.revisions.map(item => item.revisionId)).toEqual(Array.from({ length: 5 }, (_, id) => revision(id).revisionId));
    expect(batch?.nextCursor).toBe('cursor-5');
  });

  it('handles empty external pages and stops when the actual cursor ends', async () => {
    const read = vi.fn().mockResolvedValueOnce({ revisions: [], nextCursor: 'next', indexGeneration: 2 })
      .mockResolvedValueOnce({ revisions: [revision(8)], indexGeneration: 2 });
    expect(await loadSkillCatalogBatch(read, 'start', 2, () => true)).toEqual({ revisions: [revision(8)] });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('rejects a changed generation or cursor cycle before publishing a partial batch', async () => {
    for (const changed of [true, false]) {
      const read = vi.fn().mockResolvedValueOnce({ revisions: [revision(0)], nextCursor: 'next', indexGeneration: 2 })
        .mockResolvedValueOnce({ revisions: [revision(1)], nextCursor: 'start', indexGeneration: changed ? 3 : 2 });
      await expect(loadSkillCatalogBatch(read, 'start', 2, () => true)).rejects.toBeInstanceOf(SkillCatalogChanged);
    }
  });

  it('does not fetch or append after host/profile/refresh ownership changes', async () => {
    const untouched = vi.fn();
    expect(await loadSkillCatalogBatch(untouched, 'start', 2, () => false)).toBeUndefined();
    expect(untouched).not.toHaveBeenCalled();
    let current = true;
    const read = vi.fn(async (): Promise<SkillRegistryPage> => { current = false; return { revisions: [revision(0)], nextCursor: 'next', indexGeneration: 2 }; });
    expect(await loadSkillCatalogBatch(read, 'start', 2, () => current)).toBeUndefined();
    expect(read).toHaveBeenCalledOnce();
  });

  it('propagates read failure without claiming the successful prefix was appended', async () => {
    const read = vi.fn().mockResolvedValueOnce({ revisions: [revision(0)], nextCursor: 'next', indexGeneration: 2 })
      .mockRejectedValueOnce(new Error('catalog unavailable'));
    await expect(loadSkillCatalogBatch(read, 'start', 2, () => true)).rejects.toThrow('catalog unavailable');
  });
});
