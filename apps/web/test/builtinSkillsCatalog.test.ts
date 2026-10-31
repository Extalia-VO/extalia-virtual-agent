import type { BuiltinSkillInfo } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { BuiltinSkillsCatalogView } from '../src/skills/BuiltinSkillsCatalog';
import { builtinCatalogCounts, catalogCategory, filterBuiltinCatalog, type CatalogFilter } from '../src/skills/builtinCatalogModel';

const labels = MESSAGES.en.skillsPage.builtinCategories;
const skills: BuiltinSkillInfo[] = [
  { name: 'plan-release', description: 'Prepare a release checklist', category: 'planning', body: 'Step 1\nStep 2' },
  { name: 'review-code', description: 'Inspect source for regressions', category: 'quality' },
  { name: 'legacy-notes', description: 'Write clear project notes' },
];

function view(overrides: Partial<Parameters<typeof BuiltinSkillsCatalogView>[0]> = {}) {
  return createElement(BuiltinSkillsCatalogView, {
    t: MESSAGES.en, skills, query: '', category: 'all', onQuery: () => undefined,
    onCategory: () => undefined, onClear: () => undefined, ...overrides,
  });
}

describe('built-in skill catalog model', () => {
  it('filters by category, supports multiple search terms, and searches localized category labels', () => {
    expect(filterBuiltinCatalog(skills, '', 'planning', labels).map(skill => skill.name)).toEqual(['plan-release']);
    expect(filterBuiltinCatalog(skills, 'source regression', 'all', labels).map(skill => skill.name)).toEqual(['review-code']);
    expect(filterBuiltinCatalog(skills, 'perencanaan', 'all', MESSAGES.id.skillsPage.builtinCategories).map(skill => skill.name)).toEqual(['plan-release']);
    expect(filterBuiltinCatalog(skills, 'notes', 'uncategorized', labels).map(skill => skill.name)).toEqual(['legacy-notes']);
    expect(catalogCategory(skills[2]!)).toBe('uncategorized');
  });

  it('does not mutate the source list, bounds query length, and returns an empty result for empty-match filters', () => {
    const input = [...skills];
    const before = [...input];
    expect(filterBuiltinCatalog(input, '  PLAN release  ', 'all', labels).map(skill => skill.name)).toEqual(['plan-release']);
    expect(input).toEqual(before);
    expect(filterBuiltinCatalog(skills, 'x'.repeat(201), 'all', labels)).toEqual([]);
    expect(filterBuiltinCatalog(skills, 'absent', 'all', labels)).toEqual([]);
    expect(filterBuiltinCatalog(skills, '', 'security' as CatalogFilter, labels)).toEqual([]);
    expect(builtinCatalogCounts(skills)).toMatchObject({ all: 3, planning: 1, quality: 1, uncategorized: 1 });
  });
});

describe('built-in skill catalog view', () => {
  it('shows localized category labels, whole-catalog counts, and browse-only controls in English and Indonesian', () => {
    const en = renderToStaticMarkup(view());
    expect(en).toContain('Planning <span>(1)</span>');
    expect(en).toContain('Uncategorized <span>(1)</span>');
    expect(en).toContain('3 of 3 built-in skills');
    expect(en).toContain('does not run a skill or change agent permissions');
    expect(en).toContain('Read instructions');

    const id = renderToStaticMarkup(view({ t: MESSAGES.id }));
    expect(id).toContain('Perencanaan <span>(1)</span>');
    expect(id).toContain('Tanpa kategori <span>(1)</span>');
    expect(id).toContain('3 dari 3 skill bawaan');
    expect(id).toContain('tidak menjalankan skill atau mengubah izin agent');
    expect(id).toContain('Baca instruksi');
  });

  it('renders instructions as literal text and reports missing instructions honestly', () => {
    const hostile = [{ name: 'unsafe-example', description: 'Example', body: '<script>alert(1)</script><img src=x onerror=alert(2)>' }];
    const html = renderToStaticMarkup(view({ skills: hostile }));
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');

    const legacy = renderToStaticMarkup(view({ skills: [{ name: 'legacy-skill', description: 'Old host entry' }] }));
    expect(legacy).toContain('Uncategorized');
    expect(legacy).toContain('This host does not include instructions in its catalog.');
  });

  it('keeps category/search/clear controls browse-only', () => {
    const html = renderToStaticMarkup(view({ query: 'plan', category: 'planning', onQuery: vi.fn(), onCategory: vi.fn(), onClear: vi.fn() }));
    expect(html).toContain('type="search"');
    expect(html).toContain('aria-pressed="true">Planning');
    expect(html).toContain('>Clear filters</button>');
    expect(html).not.toContain('Install');
    expect(html).not.toContain('Activate');
    expect(html).not.toContain('Allow');
  });
});
