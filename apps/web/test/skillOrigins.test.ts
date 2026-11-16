import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SkillRegistryReport, SkillRevisionSummary } from '@extalia/platform';
import { MESSAGES } from '../src/i18n';
import { SkillOriginBadge } from '../src/skills/SkillOriginBadge';
import { SkillRevisionRow } from '../src/skills/SkillSecurityCenter';
import { filterSkillBooks, registrySkillOrigin, skillBookOrigin, skillBooks } from '../src/skills/skillLibraryModel';

const revision = (id: string, origin: SkillRevisionSummary['origin'], marketplaceSource?: boolean): SkillRevisionSummary & { marketplaceSource?: boolean } => ({
  packageId: 'same-name', revisionId: id, origin, version: '1.0.0', treeSha256: 'a'.repeat(64), skillMdSha256: 'b'.repeat(64),
  state: 'quarantined', riskClass: 'declarative', manifestInferred: true, permissionDigest: 'c'.repeat(64), permissions: [], active: false,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...(marketplaceSource === undefined ? {} : { marketplaceSource }),
});

describe('skill origin markers', () => {
  it('keeps exact-revision origin distinct from storage, names and lifecycle', () => {
    const revisions = [revision('market', 'imported', true), revision('legacy', 'imported'), revision('manual', 'user'),
      revision('native', 'generated'), revision('workspace', 'workspace')];
    const report = { mode: 'registry', revisions } as SkillRegistryReport;
    const books = skillBooks([{ name: 'same-name', description: 'Shipped procedure' }], [], report);
    expect(books.map(skillBookOrigin)).toEqual(['builtin', 'marketplace', 'imported', 'custom', 'custom', 'project']);
    expect(filterSkillBooks(books, '', 'marketplace', 'all').map(b => b.revision)).toEqual(['market']);
    expect(filterSkillBooks(books, '', 'custom', 'all').map(b => b.revision)).toEqual(['manual', 'native']);
    expect(filterSkillBooks(books, '', 'imported', 'all').map(b => b.revision)).toEqual(['legacy']);
    expect(filterSkillBooks(books, '', 'registry', 'all')).toHaveLength(5);
    expect(books.slice(1).every(b => b.status === 'quarantined')).toBe(true);
    expect(revisions.every(r => !r.active && r.state === 'quarantined')).toBe(true);
  });

  it('requires an explicit marketplace projection and preserves unknown legacy imports', () => {
    expect(registrySkillOrigin(revision('old-peer', 'imported'))).toBe('imported');
    expect(registrySkillOrigin(revision('no-source', 'imported', false))).toBe('imported');
    expect(registrySkillOrigin(revision('generated', 'generated', true))).toBe('custom');
    expect(registrySkillOrigin(revision('workspace', 'workspace', true))).toBe('project');
    expect(skillBookOrigin({ source: 'registry' })).toBe('imported');
  });

  for (const language of ['en', 'id'] as const) it(`shows readable origin text separately from approval in ${language}`, () => {
    const t = MESSAGES[language];
    const html = renderToStaticMarkup(createElement(SkillOriginBadge, { origin: 'marketplace', t }));
    expect(html).toContain('data-origin="marketplace"');
    expect(html).toContain(t.skillLibrary.origins.marketplace);
    expect(html).toContain(t.skillLibrary.originHints.marketplace);
    expect(html).not.toContain('class="badge ok"');
    expect(renderToStaticMarkup(createElement(SkillOriginBadge, { origin: 'custom', t }))).toContain(t.skillLibrary.origins.custom);
    const row = renderToStaticMarkup(createElement(SkillRevisionRow, { t, revision: revision('review-only', 'generated'), busy: false,
      report: { scanner: 'unpinned' } as SkillRegistryReport, confirm: null, onConfirm: () => {}, onAction: () => {}, onToggleDetails: () => {} }));
    expect(row).toContain(t.skillLibrary.origins.custom);
    expect(row).toContain(t.skillCenter.states.quarantined);
  });
});
