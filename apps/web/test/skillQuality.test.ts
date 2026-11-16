import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SkillRegistryReport, SkillRevisionDetails, SkillRevisionSummary } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { SkillQualityDetails, skillEvaluationCurrent } from '../src/skills/SkillQualityPanel';
import { Select } from '../src/ui/Select';
import { SkillLibraryView } from '../src/skills/SkillLibrary';
import { filterSkillBooks, skillBooks } from '../src/skills/skillLibraryModel';

const revision = (digit = 'a', patch: Partial<SkillRevisionSummary> = {}): SkillRevisionSummary => ({ packageId: 'validation', revisionId: `skr_${digit.repeat(64)}`, treeSha256: digit.repeat(64),
  skillMdSha256: digit.repeat(64), origin: 'generated', version: '2.0.0', state: 'awaiting_approval', riskClass: 'declarative', manifestInferred: false,
  permissionDigest: 'd'.repeat(64), permissions: [], active: false, createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:00.000Z', ...patch });
const candidate = revision('a'), baseline = revision('b', { active: true, state: 'active', version: '1.0.0' });
type Quality = NonNullable<SkillRevisionDetails['learnedQuality']>;
const quality = (patch: Partial<Quality> = {}): Quality => ({ complete: true, missingSections: [], testCount: 4, baseline,
  evaluation: { revisionId: candidate.revisionId, treeSha256: candidate.treeSha256, baselineRevisionId: baseline.revisionId, baselineTreeSha256: baseline.treeSha256,
    status: 'passed', passed: 4, total: 4, baselinePassed: 3, evaluatedAt: '2026-11-16T01:00:00.000Z', scope: 'synthetic-declarative' }, ...patch });
const render = (value?: Quality, language: 'en' | 'id' = 'en', active = baseline) => renderToStaticMarkup(createElement(SkillQualityDetails,
  { t: MESSAGES[language], revision: candidate, baseline: active, quality: value }));

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

describe('declared skill taxonomy and usage discovery', () => {
  it('indexes real descriptions, category slugs and task-intent IDs without guessing category or changing revision identity', () => {
    const source = revision('a', { description: 'Use when checking parsed records before storage.', categories: ['data.validation', 'quality'], intents: ['validate_records', 'review_schema'] });
    const report = { mode: 'registry', revisions: [source] } as SkillRegistryReport;
    const books = skillBooks([], [], report);
    expect(books[0]).toMatchObject({ id: `registry:${source.revisionId}`, description: source.description, categories: source.categories, intents: source.intents, category: 'quality' });
    expect(filterSkillBooks(books, 'validate_records', 'all', 'data.validation')).toHaveLength(1);
    expect(filterSkillBooks(books, 'parsed records', 'all', 'all')).toHaveLength(1);
    expect(filterSkillBooks(books, '', 'all', 'security')).toEqual([]);
    const unrecognized = skillBooks([], [], { ...report, revisions: [{ ...source, categories: ['constructor', 'data.validation'] }] });
    expect(unrecognized[0]!.category).toBe('uncategorized');
    expect(unrecognized[0]!.categories).toEqual(['constructor', 'data.validation']);
  });

  it.each(['en', 'id'] as const)('offers declared custom categories in the actual library control in %s', language => {
    const books = skillBooks([], [], { mode: 'registry', revisions: [revision('a', { categories: ['data.validation'], intents: ['validate_records'] })] } as SkillRegistryReport);
    let tree: ReactNode;
    function Capture() { tree = SkillLibraryView({ t: MESSAGES[language], books }); return tree; }
    renderToStaticMarkup(createElement(Capture));
    const category = elements(tree).find(node => node.type === Select && node.props['aria-label'] === MESSAGES[language].skillLibrary.category)!;
    expect((category.props.options as { value: string; label: string }[])).toContainEqual({ value: 'data.validation', label: 'data.validation' });
  });

  it('preserves older catalogs without metadata and the existing bundled category', () => {
    const books = skillBooks([{ name: 'planning', description: 'Plan work', category: 'planning' }], [], { mode: 'registry', revisions: [candidate] } as SkillRegistryReport);
    expect(books[0]!.category).toBe('planning');
    expect(books[1]).toMatchObject({ description: '2.0.0', category: 'uncategorized', categories: [], intents: [] });
  });
});

describe('exact-revision candidate testing presentation', () => {
  it.each(['en', 'id'] as const)('shows honest unchecked and incomplete states in %s', language => {
    const s = MESSAGES[language].skillCenter.quality;
    expect(render(undefined, language)).toContain(s.unchecked);
    expect(render(undefined, language)).not.toContain(s.complete);
    const incomplete = render(quality({ complete: false, testCount: 0, missingSections: ['When to Use', 'Verification'], evaluation: undefined }), language);
    expect(incomplete).toContain(s.incomplete);
    expect(incomplete).toContain(s.testCount(0));
    expect(incomplete).toContain('When to Use, Verification');
    expect(incomplete).not.toContain(s.statuses.passed);
  });

  it.each(['en', 'id'] as const)('shows candidate and tested baseline identities, actual check counts and bounded scope in %s', language => {
    const s = MESSAGES[language].skillCenter.quality, html = render(quality(), language);
    expect(html).toContain(candidate.revisionId); expect(html).toContain(baseline.revisionId);
    expect(html).toContain(s.complete); expect(html).toContain(s.checks(4, 4)); expect(html).toContain(s.baselineChecks(3));
    expect(html).toContain(s.statuses.passed); expect(html).toContain(s.scope); expect(html).toContain(s.noActivation);
    expect(html).toContain(s.evaluatedBaseline);
    expect(html).not.toContain('<button');
  });

  it('marks changes to candidate bytes or active baseline stale and preserves explicit backend stale status', () => {
    const q = quality(), result = q.evaluation!;
    expect(skillEvaluationCurrent(candidate, baseline, result)).toBe(true);
    expect(skillEvaluationCurrent({ ...candidate, treeSha256: 'c'.repeat(64) }, baseline, result)).toBe(false);
    expect(skillEvaluationCurrent(candidate, revision('c', { active: true }), result)).toBe(false);
    expect(render(q, 'en', revision('c', { active: true }))).toContain(MESSAGES.en.skillCenter.quality.statuses.stale);
    expect(render(quality({ evaluation: { ...result, status: 'stale' } }))).toContain(MESSAGES.en.skillCenter.quality.statuses.stale);
  });

  it('retains historical passing evidence after the tested candidate becomes active itself', () => {
    const html = render(quality(), 'en', { ...candidate, active: true, state: 'active' });
    expect(html).toContain(MESSAGES.en.skillCenter.quality.statuses.passed);
    expect(html).not.toContain(MESSAGES.en.skillCenter.quality.statuses.stale);
    expect(html).toContain(baseline.revisionId);
  });

  it('does not call zero checks sufficient and escapes backend issue text', () => {
    const q = quality();
    const html = render(quality({ evaluation: { ...q.evaluation!, passed: 0, total: 0, issues: ['<script>untrusted</script>'] } }));
    expect(html).toContain(MESSAGES.en.skillCenter.quality.statuses['insufficient-evidence']);
    expect(html).not.toContain(MESSAGES.en.skillCenter.quality.statuses.passed);
    expect(html).toContain('&lt;script&gt;untrusted&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
});
