import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillMarketplace, type SkillMarketPort } from '../src/skillMarketplace.js';
import type { SkillActionResult, SkillMarketPreview } from '@extalia/platform';

const reviewId = '11111111-1111-4111-8111-111111111111';
const expiredReviewId = '22222222-2222-4222-8222-222222222222';
const unpreparedReviewId = '33333333-3333-4333-8333-333333333333';
const treeSha256 = 'a'.repeat(64);
const sourceRef = `github:acme/skills@${'b'.repeat(40)}#demo`;
const staged = { path: `market-${reviewId}`, treeSha256, sourceRef };
const previewRecord = (expiresAt = new Date(Date.now() + 60_000).toISOString(), id = reviewId): SkillMarketPreview => ({ reviewId: id, expiresAt, repository: 'acme/skills', commit: 'b'.repeat(40), directory: 'demo', sourceRef,
  files: [{ path: 'SKILL.md', size: 1, sha256: treeSha256 }], totalBytes: 1, treeSha256, warnings: [] });
const receipt = { revisionId: `skr_${'c'.repeat(64)}`, packageId: 'demo', state: 'quarantined', created: true } as SkillActionResult;
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const backend: SkillMarketPort = { search: vi.fn(async query => ({ provider: 'skills-sh' as const, query, entries: [], cached: false, stale: false })),
    preview: vi.fn(async () => previewRecord()), stage: vi.fn(async () => staged), discard: vi.fn(async () => undefined) };
  const registry = { importPreparedMarket: vi.fn(async () => receipt) };
  return { backend, registry, market: new SkillMarketplace(backend, registry) };
}

describe('SkillMarketplace admission wrapper', () => {
  it('deduplicates concurrent install and preserves the original rejection while cleaning the staged review', async () => {
    const f = fixture(), wait = deferred<typeof staged>(), started = deferred<void>();
    await f.market.preview({ repository: 'acme/skills', skill: 'demo' });
    vi.mocked(f.backend.stage).mockImplementation(() => { started.resolve(); return wait.promise; });
    const first = f.market.install(reviewId), duplicate = f.market.install(reviewId);
    expect(duplicate).toBe(first); await started.promise; expect(f.backend.stage).toHaveBeenCalledTimes(1);
    await expect(f.market.discard(reviewId)).rejects.toThrow(/still settling/);
    expect(f.backend.discard).not.toHaveBeenCalled();
    const failure = new Error('registry rejected fixture'); wait.resolve(staged); vi.mocked(f.registry.importPreparedMarket).mockRejectedValueOnce(failure);
    await expect(first).rejects.toBe(failure); await expect(duplicate).rejects.toBe(failure);
    expect(f.registry.importPreparedMarket).toHaveBeenCalledOnce(); expect(f.backend.discard).toHaveBeenCalledOnce();
  });

  it('returns the successful import receipt once and never activates or replays it', async () => {
    const f = fixture();
    await f.market.preview({ repository: 'acme/skills', skill: 'demo' });
    const first = f.market.install(reviewId), second = f.market.install(reviewId);
    expect(second).toBe(first); await expect(first).resolves.toBe(receipt);
    await expect(second).resolves.toBe(receipt);
    expect(f.backend.stage).toHaveBeenCalledOnce(); expect(f.registry.importPreparedMarket).toHaveBeenCalledWith(staged);
    expect(f.backend.discard).toHaveBeenCalledOnce();
    expect(f.market).not.toHaveProperty('activate');
  });

  it('refuses overlapping search/preview work while a profile operation owns admission', async () => {
    const f = fixture(), wait = deferred<Awaited<ReturnType<SkillMarketPort['search']>>>(), started = deferred<void>();
    vi.mocked(f.backend.search).mockImplementation(() => { started.resolve(); return wait.promise; });
    const first = f.market.search('skills'); await started.promise;
    await expect(f.market.preview({ repository: 'acme/skills', skill: 'demo' })).rejects.toThrow(/busy/i);
    await expect(f.market.search('other')).rejects.toThrow(/busy/i);
    expect(f.backend.preview).not.toHaveBeenCalled(); expect(f.backend.search).toHaveBeenCalledOnce();
    wait.resolve({ provider: 'skills-sh', query: 'skills', entries: [], cached: false, stale: false });
    await expect(first).resolves.toMatchObject({ query: 'skills' });
  });

  it('rejects unprepared and expired reviews before stage, and preserves stage uncertainty without retry', async () => {
    const f = fixture();
    expect(() => f.market.install('../untrusted')).toThrow(/preview/i);
    await expect(f.market.install(unpreparedReviewId)).rejects.toThrow(/fresh skill preview/i);
    expect(f.backend.stage).not.toHaveBeenCalled();
    vi.mocked(f.backend.preview).mockResolvedValueOnce(previewRecord(new Date(Date.now() - 60_000).toISOString(), expiredReviewId));
    await f.market.preview({ repository: 'acme/skills', skill: 'demo' });
    await expect(f.market.install(expiredReviewId)).rejects.toThrow(/fresh skill preview/i);
    expect(f.backend.stage).not.toHaveBeenCalled(); expect(f.backend.discard).not.toHaveBeenCalled();
    await f.market.preview({ repository: 'acme/skills', skill: 'demo' });
    const failed = new Error('stage acknowledgement unavailable'); vi.mocked(f.backend.stage).mockRejectedValueOnce(failed);
    const first = f.market.install(reviewId); await expect(first).rejects.toBe(failed);
    await expect(f.market.install(reviewId)).rejects.toBe(failed);
    expect(f.backend.stage).toHaveBeenCalledOnce(); expect(f.registry.importPreparedMarket).not.toHaveBeenCalled();
    expect(f.backend.discard).not.toHaveBeenCalled();
  });

  it.each([
    { treeSha256: 'd'.repeat(64), sourceRef },
    { treeSha256, sourceRef: `github:other/repo@${'e'.repeat(40)}#demo` },
  ])('refuses staged hash/source drift from the minted preview and cleans the staging receipt', async drift => {
    const f = fixture(); await f.market.preview({ repository: 'acme/skills', skill: 'demo' });
    vi.mocked(f.backend.stage).mockResolvedValueOnce({ path: staged.path, ...drift });
    await expect(f.market.install(reviewId)).rejects.toThrow(/changed after preview/i);
    expect(f.registry.importPreparedMarket).not.toHaveBeenCalled(); expect(f.backend.discard).toHaveBeenCalledOnce();
  });
});
