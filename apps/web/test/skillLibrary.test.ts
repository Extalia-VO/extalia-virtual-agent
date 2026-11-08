import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SkillRegistryReport, WorkspaceSkills } from '@extalia/platform';
import { Select, type SelectProps } from '../src/ui/Select';
import { MESSAGES } from '../src/i18n';
import { SkillLibraryView } from '../src/skills/SkillLibrary';
import { filterSkillBooks, skillBooks } from '../src/skills/skillLibraryModel';

const builtin = [{ name: 'release-plan', description: 'Prepare a release', category: 'planning' as const, body: '# Plan\n<untrusted>\n' }];
const project: WorkspaceSkills = { workspaceId: 'a', allowed: [{ name: 'review-code', description: 'Review code', sha256: 'a'.repeat(64) }], pending: [{ name: 'new-code', description: 'New', sha256: 'b'.repeat(64), source: 'workspace', reason: 'not-allowed' }], warnings: [] };

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

describe('skill library data', () => {
  it('preserves workspace identities, hashes and review status without calling project skills active', () => {
    const books = skillBooks(builtin, [{ name: 'First', report: project }, { name: 'Second', report: { ...project, workspaceId: 'b' } }]);
    expect(new Set(books.map(book => book.id)).size).toBe(5);
    expect(books[1]).toMatchObject({ source: 'project', workspace: 'First', digest: 'a'.repeat(64), status: 'reviewed', category: 'uncategorized' });
    expect(books[2]?.status).toBe('pending');
    expect(filterSkillBooks(books, 'second review', 'project', 'all')).toHaveLength(1);
    expect(filterSkillBooks(books, 'release', 'builtin', 'security')).toHaveLength(0);
  });
  it('uses exact registry revisions rather than merging local consent into activation', () => {
    const registry = { mode: 'registry', revisions: [{ packageId: 'example/skill', revisionId: 'rev-1', version: '1.0', treeSha256: 'c'.repeat(64), state: 'quarantined', active: false }] } as SkillRegistryReport;
    const books = skillBooks(builtin, [{ name: 'First', report: project }], registry);
    expect(books).toHaveLength(2);
    expect(books[1]).toMatchObject({ revision: 'rev-1', status: 'quarantined', source: 'registry' });
  });

});

describe('skill library accessible index', () => {
  for (const language of ['en', 'id'] as const) it(`renders real books with source, status and list fallback in ${language}`, () => {
    const t = MESSAGES[language];
    let tree: ReactNode;
    function Capture() { tree = SkillLibraryView({ t, books: skillBooks(builtin, [{ name: 'First', report: project }]) }); return tree; }
    const html = renderToStaticMarkup(createElement(Capture));
    const picker = elements(tree).find(element => element.type === Select && element.props['aria-label'] === t.skillLibrary.books)!.props as unknown as SelectProps;
    expect(picker.value).toBe('');
    expect(picker.options).toHaveLength(3);
    expect(picker.options.map(option => option.label)).toContain(`review-code · First · ${t.skillLibrary.statuses.reviewed}`);
    expect(picker.options.some(option => option.label.startsWith('release-plan · '))).toBe(true);
    expect(html).toContain(t.skillLibrary.title);
    expect(html).toContain(`aria-label="${t.skillLibrary.books}"`);
    expect(html).toContain(t.skillLibrary.views.list);
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('skill-shelf-picker');
    expect(html).not.toContain('class="skill-book-index');
    expect(html).not.toContain('<untrusted>');
  });
});
