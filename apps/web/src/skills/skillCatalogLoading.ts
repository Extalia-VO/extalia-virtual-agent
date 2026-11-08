import type { SkillRegistryPage, SkillRevisionSummary } from '@extalia/platform';

export class SkillCatalogChanged extends Error {}

/** One user action reads at most five bounded metadata pages. Publish the batch atomically. */
export async function loadSkillCatalogBatch(
  read: (cursor: string) => Promise<SkillRegistryPage>,
  cursor: string, generation: number, isCurrent: () => boolean,
): Promise<{ revisions: SkillRevisionSummary[]; nextCursor?: string } | undefined> {
  const revisions = new Map<string, SkillRevisionSummary>();
  const visited = new Set<string>();
  let next: string | undefined = cursor;
  for (let count = 0; count < 5 && next; count++) {
    if (!isCurrent()) return undefined;
    if (visited.has(next)) throw new SkillCatalogChanged();
    visited.add(next);
    const page = await read(next);
    if (!isCurrent()) return undefined;
    if (page.indexGeneration !== generation || (page.nextCursor && visited.has(page.nextCursor))) throw new SkillCatalogChanged();
    for (const revision of page.revisions) revisions.set(revision.revisionId, revision);
    next = page.nextCursor;
  }
  return { revisions: [...revisions.values()], ...(next ? { nextCursor: next } : {}) };
}
