import { normalizeSkillMarketPreviewInput, normalizeSkillMarketQuery, normalizeSkillMarketRefresh, normalizeSkillMarketReviewId,
  type SkillActionResult, type SkillMarketPreview, type SkillMarketPreviewInput, type SkillMarketSearchResult } from '@extalia/platform';

export interface SkillMarketPort {
  search(query: string, refresh?: boolean): Promise<SkillMarketSearchResult>;
  preview(input: SkillMarketPreviewInput): Promise<SkillMarketPreview>;
  stage(reviewId: string): Promise<{ path: string; treeSha256: string; sourceRef: string }>;
  discard(reviewId: string): Promise<void>;
}

/** Admission and receipts only; Rust owns remote bytes, cache, pins and staging. */
export class SkillMarketplace {
  private readonly imports = new Map<string, { done: Promise<SkillActionResult>; settled: boolean }>();
  private readonly previews = new Map<string, { treeSha256: string; sourceRef: string; expiresAt: number }>();
  private busy = false;

  constructor(private readonly backend: SkillMarketPort, private readonly registry: {
    importPreparedMarket(staged: { path: string; treeSha256: string; sourceRef: string }): Promise<SkillActionResult>;
  }) {}

  private admit<T>(work: () => Promise<T>): Promise<T> {
    // One profile owner serializes cache cleanup, review pruning and import.
    // Refuse overlap instead of accumulating an unbounded waiting queue.
    if (this.busy) return Promise.reject(new Error('Skill marketplace is busy. Wait for the current operation.'));
    this.busy = true;
    return Promise.resolve().then(work).finally(() => { this.busy = false; });
  }

  search(query: string, refresh?: boolean): Promise<SkillMarketSearchResult> {
    const normalized = normalizeSkillMarketQuery(query), fresh = normalizeSkillMarketRefresh(refresh);
    return this.admit(() => this.backend.search(normalized, fresh));
  }

  async preview(input: SkillMarketPreviewInput): Promise<SkillMarketPreview> {
    const normalized = normalizeSkillMarketPreviewInput(input);
    return this.admit(async () => {
      const preview = await this.backend.preview(normalized);
      const now = Date.now();
      for (const [id, value] of this.previews) if (value.expiresAt <= now) this.previews.delete(id);
      if (this.previews.size >= 64) throw new Error('Close an existing skill preview before preparing another.');
      this.previews.set(preview.reviewId, {
        treeSha256: preview.treeSha256, sourceRef: preview.sourceRef, expiresAt: Date.parse(preview.expiresAt),
      });
      return preview;
    });
  }

  install(rawReviewId: string): Promise<SkillActionResult> {
    const reviewId = normalizeSkillMarketReviewId(rawReviewId);
    const previous = this.imports.get(reviewId);
    if (previous) return previous.done;
    if (this.busy) return Promise.reject(new Error('Skill marketplace is busy. Wait for the current operation.'));
    // A repeated UI click gets its original receipt, including uncertainty. It
    // cannot replay an import. Fresh previews remain independent exact revisions.
    if (this.imports.size >= 64) {
      const oldest = [...this.imports].find(([, value]) => value.settled);
      if (!oldest) return Promise.reject(new Error('Skill marketplace is busy.'));
      this.imports.delete(oldest[0]);
    }
    const entry = { done: this.admit(() => this.importOnce(reviewId)), settled: false };
    entry.done = entry.done.finally(() => { entry.settled = true; });
    this.imports.set(reviewId, entry);
    return entry.done;
  }

  private async importOnce(reviewId: string): Promise<SkillActionResult> {
    const expected = this.previews.get(reviewId);
    if (!expected || !Number.isFinite(expected.expiresAt) || expected.expiresAt <= Date.now()) {
      throw new Error('Prepare a fresh skill preview before importing.');
    }
    const staged = await this.backend.stage(reviewId);
    try {
      if (staged.treeSha256 !== expected.treeSha256 || staged.sourceRef !== expected.sourceRef) {
        throw new Error('The staged skill changed after preview. Prepare a fresh preview.');
      }
      return await this.registry.importPreparedMarket(staged);
    }
    finally {
      // The immutable registry receipt remains authoritative if temporary cache
      // cleanup fails. Rust also expires its own bounded preview directories.
      await this.backend.discard(reviewId).catch(() => undefined);
      this.previews.delete(reviewId);
    }
  }

  async discard(rawReviewId: string): Promise<void> {
    const reviewId = normalizeSkillMarketReviewId(rawReviewId);
    const entered = this.imports.get(reviewId);
    if (entered && !entered.settled) throw new Error('This skill import is still settling.');
    await this.admit(() => this.backend.discard(reviewId));
    this.previews.delete(reviewId);
  }
}
