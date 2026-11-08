import { describe, expect, it } from 'vitest';
import { BOOKS_PER_SHELF, DEFAULT_LIST_PAGE_SIZE, LIST_PAGE_SIZES, catalogPage, catalogPageForAnchor, createSkillBookIndex, filterSkillBookIndex, filterSkillBooks, type SkillBook } from '../src/skills/skillLibraryModel';

function catalog(count: number): SkillBook[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `registry:revision-${index}`, title: `workspace-tools/skill-${String(index).padStart(4, '0')}`,
    description: index % 2 ? 'Review release quality' : 'Plan implementation work',
    workspace: `Workspace zone${index % 10}`, category: index % 2 ? 'quality' : 'planning',
    source: 'registry', status: index % 3 ? 'active' : 'quarantined',
    revision: `revision-${index}`, digest: index.toString(16).padStart(64, '0'), body: `private-instruction-${index}`,
  }));
}

describe('large skill metadata catalogs', () => {
  it('filters 1,000 distinct books with stable identities, ordering and AND terms', () => {
    const books = catalog(1000), index = createSkillBookIndex(books);
    expect(index).toHaveLength(1000);
    expect(filterSkillBookIndex(index, '', 'all', 'all')).toEqual(books);
    const result = filterSkillBookIndex(index, 'QUALITY workspace zone7', 'registry', 'quality');
    expect(result).toHaveLength(100);
    expect(result[0]).toBe(books[7]); expect(result.at(-1)).toBe(books[997]);
    expect(new Set(result.map(book => book.id)).size).toBe(100);
    expect(filterSkillBookIndex(index, 'skill-0753', 'registry', 'quality')).toEqual([books[753]]);
    expect(filterSkillBookIndex(index, 'skill-0753', 'builtin', 'quality')).toEqual([]);
    expect(filterSkillBookIndex(index, 'skill-0753', 'registry', 'planning')).toEqual([]);
  });

  it('precomputes catalog text once while preserving the existing convenience-filter behavior', () => {
    let titleReads = 0, descriptionReads = 0;
    const book: SkillBook = {
      id: 'builtin:indexed', get title() { titleReads++; return 'Code Review'; },
      get description() { descriptionReads++; return 'Check correctness'; },
      source: 'builtin', status: 'bundled', category: 'quality', workspace: 'Example project',
    };
    const index = createSkillBookIndex([book]);
    expect(titleReads).toBe(1); expect(descriptionReads).toBe(1);
    for (const query of ['code', 'CODE correctness', 'example quality', 'unmatched']) filterSkillBookIndex(index, query, 'all', 'all');
    expect(titleReads).toBe(1); expect(descriptionReads).toBe(1);
    const books = catalog(1000);
    const prepared = createSkillBookIndex(books);
    for (const query of ['', '  ＷＯＲＫＳＰＡＣＥ　７ quality ', 'skill-0034', 'private-instruction-1', 'unknown']) {
      expect(filterSkillBookIndex(prepared, query, 'all', 'all')).toEqual(filterSkillBooks(books, query, 'all', 'all'));
    }
  });

  it('normalizes NFKC metadata/query, bounds query text and never searches instruction bodies or security identities', () => {
    const book: SkillBook = { id: 'registry:identity-only', title: 'Ｃａｆé Code', description: 'Review releases', workspace: 'Ａｔｌａｓ',
      source: 'registry', category: 'quality', status: 'quarantined', revision: 'revision-only', digest: 'digest-only', body: 'body-only-secret' };
    const index = createSkillBookIndex([book]);
    expect(filterSkillBookIndex(index, '  café　ATLAS REVIEW  ', 'registry', 'quality')).toEqual([book]);
    expect(filterSkillBookIndex(index, 'cafe', 'all', 'all')).toEqual([]);
    for (const query of ['body-only-secret', 'identity-only', 'revision-only', 'digest-only', 'quarantined']) expect(filterSkillBookIndex(index, query, 'all', 'all')).toEqual([]);
    const long = createSkillBookIndex([{ ...book, description: 'x'.repeat(200) }]);
    expect(filterSkillBookIndex(long, 'x'.repeat(200) + 'unmatched-after-limit', 'all', 'all')).toEqual([expect.objectContaining({ id: book.id })]);
  });

  it('keeps exact revisions and workspaces separate even with identical package titles', () => {
    const books: SkillBook[] = [
      { id: 'registry:rev-a', title: 'example/review', description: '1.0', category: 'quality', source: 'registry', status: 'active', revision: 'rev-a', digest: 'a'.repeat(64) },
      { id: 'registry:rev-b', title: 'example/review', description: '1.0', category: 'quality', source: 'registry', status: 'quarantined', revision: 'rev-b', digest: 'b'.repeat(64) },
      { id: 'project:one:review:hash', title: 'example/review', description: '1.0', category: 'quality', source: 'project', status: 'reviewed', workspace: 'First' },
      { id: 'project:two:review:hash', title: 'example/review', description: '1.0', category: 'quality', source: 'project', status: 'pending', workspace: 'Second' },
    ];
    const index = createSkillBookIndex(books), result = filterSkillBookIndex(index, 'example/review', 'all', 'quality');
    result.forEach((book, position) => expect(book).toBe(books[position]));
    expect(result.map(book => book.id)).toEqual(books.map(book => book.id));
    expect(filterSkillBookIndex(index, 'second', 'project', 'all')).toEqual([books[3]]);
    expect(result.slice(0, 2).map(book => book.status)).toEqual(['active', 'quarantined']);
  });
});

describe('bounded catalog pages', () => {
  it('bounds every page for a 1,000-book catalog at shelf and all list sizes', () => {
    expect(LIST_PAGE_SIZES).toEqual([12, 24, 48]); expect(DEFAULT_LIST_PAGE_SIZE).toBe(24); expect(BOOKS_PER_SHELF).toBe(18);
    const books = catalog(1000);
    for (const size of [BOOKS_PER_SHELF, ...LIST_PAGE_SIZES]) {
      const count = Math.ceil(books.length / size);
      const seen: string[] = [];
      for (let requested = 0; requested < count; requested++) {
        const result = catalogPage(books.length, requested, size);
        expect(result.pageCount).toBe(count); expect(result.page).toBe(requested);
        const visible = books.slice(result.start, result.end);
        expect(visible.length).toBeGreaterThan(0); expect(visible.length).toBeLessThanOrEqual(size);
        seen.push(...visible.map(book => book.id));
      }
      expect(seen).toEqual(books.map(book => book.id));
    }
    expect(catalogPage(1000, 999, 24)).toEqual({ page: 41, pageCount: 42, start: 984, end: 1000 });
  });

  it('clamps after a catalog shrinks and gives an empty catalog a single empty page', () => {
    expect(catalogPage(13, 41, 24)).toEqual({ page: 0, pageCount: 1, start: 0, end: 13 });
    expect(catalogPage(25, 41, 24)).toEqual({ page: 1, pageCount: 2, start: 24, end: 25 });
    expect(catalogPage(0, 41, 24)).toEqual({ page: 0, pageCount: 1, start: 0, end: 0 });
    expect(catalogPage(100, -5, 24).page).toBe(0);
    expect(catalogPage(100.9, 1.8, 12.9)).toEqual({ page: 1, pageCount: 9, start: 12, end: 24 });
  });

  it('handles nonfinite counts/pages and invalid page sizes without NaN or unbounded slices', () => {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(catalogPage(invalid, 4, 24)).toEqual({ page: 0, pageCount: 1, start: 0, end: 0 });
      expect(catalogPage(1000, invalid, 24).page).toBe(0);
      expect(catalogPage(1000, 1, invalid)).toEqual({ page: 1, pageCount: 42, start: 24, end: 48 });
    }
    for (const size of [0, -1]) expect(catalogPage(1000, 1, size)).toEqual({ page: 1, pageCount: 42, start: 24, end: 48 });
    expect(catalogPage(-100, 2, 24)).toEqual({ page: 0, pageCount: 1, start: 0, end: 0 });
  });

  it('keeps the visible anchor on its new page when changing list size', () => {
    expect(catalogPageForAnchor(480, 48)).toBe(10); expect(catalogPageForAnchor(480, 24)).toBe(20);
    expect(catalogPageForAnchor(479, 12)).toBe(39);
    for (const invalid of [NaN, Infinity, -Infinity, -5]) expect(catalogPageForAnchor(invalid, 24)).toBe(0);
    expect(catalogPageForAnchor(49, 0)).toBe(2);
    expect(catalogPage(13, catalogPageForAnchor(999, 48), 48).page).toBe(0);
  });
});
