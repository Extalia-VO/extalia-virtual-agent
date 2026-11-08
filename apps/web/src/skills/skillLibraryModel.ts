import type { BuiltinSkillInfo, SkillRegistryReport, WorkspaceSkills } from '@extalia/platform';
import { catalogCategory, type CatalogCategory } from './builtinCatalogModel';

export type BookSource = 'builtin' | 'project' | 'registry';
export interface SkillBook {
  id: string;
  title: string;
  description: string;
  category: CatalogCategory;
  source: BookSource;
  status: string;
  workspace?: string;
  digest?: string;
  revision?: string;
  body?: string;
}
export const BOOKS_PER_SHELF = 18;
export const LIST_PAGE_SIZES = [12, 24, 48] as const;
export const DEFAULT_LIST_PAGE_SIZE = 24;
export const BOOK_COLORS: Record<CatalogCategory, string> = {
  planning: '#234c56', development: '#254975', quality: '#57704c', security: '#75434e',
  documentation: '#8b643f', delivery: '#61517d', uncategorized: '#4c6268',
};

/** Presentation only. Distinct workspaces and exact revisions never collapse into one approval. */
export function skillBooks(builtin: readonly BuiltinSkillInfo[], projects: readonly { name: string; report: WorkspaceSkills }[], registry?: SkillRegistryReport): SkillBook[] {
  const books: SkillBook[] = builtin.map(skill => ({ id: `builtin:${skill.name}`, title: skill.name, description: skill.description,
    category: catalogCategory(skill), source: 'builtin', status: 'bundled', ...(skill.body !== undefined ? { body: skill.body } : {}) }));
  if (registry?.mode === 'registry') {
    for (const revision of registry.revisions) books.push({ id: `registry:${revision.revisionId}`, title: revision.packageId,
      description: revision.version, category: 'uncategorized', source: 'registry', status: revision.active ? 'active' : revision.state,
      digest: revision.treeSha256, revision: revision.revisionId });
  } else {
    for (const { name, report } of projects) {
      for (const [status, entries] of [['reviewed', report.allowed], ['pending', report.pending]] as const) {
        for (const skill of entries) books.push({ id: `project:${report.workspaceId}:${skill.name}:${skill.sha256}`, title: skill.name,
          description: skill.description, category: 'uncategorized', source: 'project', status, workspace: name, digest: skill.sha256 });
      }
    }
  }
  return books;
}

export interface IndexedSkillBook { readonly book: SkillBook; readonly searchText: string }
export type SkillBookIndex = readonly IndexedSkillBook[];

const normalizeSearch = (text: string) => text.normalize('NFKC').toLocaleLowerCase();

/** Build once per catalog revision. The original book identity and instruction body stay untouched. */
export function createSkillBookIndex(books: readonly SkillBook[]): SkillBookIndex {
  return books.map(book => ({ book, searchText: normalizeSearch(`${book.title} ${book.description} ${book.workspace ?? ''} ${book.category}`) }));
}

/** A keystroke normalizes only its query, never all catalog metadata again. */
export function filterSkillBookIndex(index: SkillBookIndex, query: string, source: BookSource | 'all', category: CatalogCategory | 'all'): SkillBook[] {
  const terms = query.normalize('NFKC').toLocaleLowerCase().trim().slice(0, 200).split(/\s+/).filter(Boolean);
  return index.filter(({ book, searchText }) => (source === 'all' || book.source === source) && (category === 'all' || book.category === category)
    && terms.every(term => searchText.includes(term))).map(entry => entry.book);
}

/** Compatibility convenience; interactive callers can memoize createSkillBookIndex separately. */
export function filterSkillBooks(books: readonly SkillBook[], query: string, source: BookSource | 'all', category: CatalogCategory | 'all'): SkillBook[] {
  return filterSkillBookIndex(createSkillBookIndex(books), query, source, category);
}

function finiteIndex(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))) : 0;
}

function validPageSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))) : DEFAULT_LIST_PAGE_SIZE;
}

/** Inclusive start/exclusive end; an empty catalog still has one empty page. */
export function catalogPage(count: number, requestedPage: number, pageSize = DEFAULT_LIST_PAGE_SIZE): { page: number; pageCount: number; start: number; end: number } {
  const length = finiteIndex(count), size = validPageSize(pageSize);
  const pageCount = Math.max(1, Math.ceil(length / size));
  const page = Math.min(pageCount - 1, finiteIndex(requestedPage));
  const start = page * size;
  return { page, pageCount, start, end: Math.min(length, start + size) };
}

/** Keep a visible book as the anchor when changing page size; catalogPage performs final clamping. */
export function catalogPageForAnchor(index: number, pageSize = DEFAULT_LIST_PAGE_SIZE): number {
  return Math.floor(finiteIndex(index) / validPageSize(pageSize));
}
