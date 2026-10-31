import { BUILTIN_SKILL_CATEGORIES, type BuiltinSkillCategory, type BuiltinSkillInfo } from '@extalia/platform';

export type CatalogCategory = BuiltinSkillCategory | 'uncategorized';
export type CatalogFilter = CatalogCategory | 'all';
export const CATALOG_FILTERS: readonly CatalogFilter[] = ['all', ...BUILTIN_SKILL_CATEGORIES, 'uncategorized'];

/** Display metadata only; category labels never select or authorize an agent skill. */
export function catalogCategory(skill: BuiltinSkillInfo): CatalogCategory {
  return BUILTIN_SKILL_CATEGORIES.some(category => category === skill.category) ? skill.category! : 'uncategorized';
}

const fold = (text: string) => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Search names, descriptions and category labels, leaving instruction bodies unchanged. */
export function filterBuiltinCatalog(skills: readonly BuiltinSkillInfo[], query: string, category: CatalogFilter,
  labels: Readonly<Record<CatalogFilter, string>>): BuiltinSkillInfo[] {
  if (!CATALOG_FILTERS.includes(category)) return [];
  const terms = fold(query.slice(0, 200)).trim().split(/\s+/).filter(Boolean);
  return skills.filter(skill => {
    const kind = catalogCategory(skill);
    if (category !== 'all' && kind !== category) return false;
    const haystack = fold(`${skill.name} ${skill.description} ${kind} ${labels[kind]}`);
    return terms.every(term => haystack.includes(term));
  });
}

/** Counts describe the entire received catalog, independent of the current search. */
export function builtinCatalogCounts(skills: readonly BuiltinSkillInfo[]): Record<CatalogFilter, number> {
  const counts = Object.fromEntries(CATALOG_FILTERS.map(category => [category, 0])) as Record<CatalogFilter, number>;
  counts.all = skills.length;
  for (const skill of skills) counts[catalogCategory(skill)]++;
  return counts;
}
