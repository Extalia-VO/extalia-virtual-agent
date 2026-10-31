import type { AgentHostApi, HostState, SkillRegistryReport, SkillRevisionSummary, SkillRoutingReport } from '@extalia/platform';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { SkillRoutingPanel, SkillRoutingResult } from '../src/skills/SkillRoutingPanel';
import { SkillSecurityCenter } from '../src/skills/SkillSecurityCenter';

const hash = (n: number) => n.toString(16).padStart(64, '0');
const identity = (packageId = 'root', n = 1): SkillRoutingReport['candidates'][number]['identity'] => ({ packageId, version: '1.0.0', revisionId: `skr_${hash(n)}`, treeSha256: hash(n), permissionDigest: hash(100) });
const revision = (packageId: string, n: number): SkillRevisionSummary => ({ ...identity(packageId, n), origin: 'imported', skillMdSha256: hash(101),
  state: 'active', riskClass: 'declarative', manifestInferred: false, permissions: [], active: true, createdAt: '2026-10-31T00:00:00Z', updatedAt: '2026-10-31T00:00:00Z' });
const catalog = (): SkillRegistryReport => ({ mode: 'registry', status: 'ready', scanner: 'pinned', review: true, preflight: true, routingPreview: true,
  approvalTtlMs: 600_000, truncated: false, indexGeneration: 2, revisions: [revision('root', 1), revision('dependency', 2)],
  inspector: { scannerId: 'example', pinned: true, pin: 'example-pin', version: '1.0.0', normalizerVersion: '1', policyVersion: 'example-policy', status: 'ready' } });
const workspace = { id: 'w_mh3p2k1x9f04c2a7', name: 'Example workspace' };
function host(): AgentHostApi {
  return { previewSkillRouting: vi.fn(), skillRegistry: vi.fn(), inspectSkill: vi.fn(), importSkill: vi.fn(), reviewSkill: vi.fn(), approveSkill: vi.fn(),
    activateSkill: vi.fn(), deactivateSkill: vi.fn(), rollbackSkill: vi.fn(), revokeSkill: vi.fn() } as unknown as AgentHostApi;
}
const props = () => ({ agents: host(), report: catalog(), workspaces: [workspace], t: MESSAGES.en });
type Props = Parameters<typeof SkillRoutingPanel>[0];
const panel = (patch: Partial<Props> = {}) => renderToStaticMarkup(createElement(SkillRoutingPanel, { ...props(), ...patch }));
const key = (input: Props) => (SkillRoutingPanel(input) as ReactElement).key;
function result(): SkillRoutingReport {
  const root = identity();
  return { input: { categories: ['quality'], intents: ['review_code'], candidateRevisionIds: [root.revisionId], pins: {}, maxResults: 8 }, dispatchEligible: false,
    status: 'matched', eligibleCount: 1, topTieCount: 1, issues: [], exclusions: [], candidates: [{ identity: root,
      score: { exactIntents: 1, exactCategories: 1, descendantCategories: 1 }, matches: { exactIntents: ['review_code'], exactCategories: ['quality'],
        descendantCategories: [{ requested: 'quality', declared: 'quality.review' }], rationaleTruncated: false }, plan: [root] }] };
}
const resultHtml = (value: SkillRoutingReport, language: 'en' | 'id' = 'en') => renderToStaticMarkup(createElement(SkillRoutingResult, { result: value, t: MESSAGES[language] }));

describe('read-only skill routing presentation', () => {
  it.each(['en', 'id'] as const)('offers explicit bounded controls with no automatic candidates, pins or request (%s)', language => {
    const agents = host(), t = MESSAGES[language], html = panel({ agents, t });
    for (const text of [t.skillRouting.title, t.skillRouting.lead, t.skillRouting.limits, t.skillRouting.categories, t.skillRouting.intents,
      t.skillRouting.candidates, t.skillRouting.candidateHint, t.skillRouting.noPins, t.skillRouting.selectorsHint, t.skillRouting.workspace, t.skillRouting.maxResults]) expect(html).toContain(text);
    const candidates = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) expect(candidate).not.toContain('checked');
    expect(html).toMatch(/<input[^>]*type="number"[^>]*min="1"[^>]*max="16"[^>]*value="8"/);
    expect(html).toContain(`<option value="" selected="">${t.skillRouting.choosePin}</option>`);
    expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${t.skillRouting.run}</button>`));
    expect(agents.previewSkillRouting).not.toHaveBeenCalled();
    for (const method of [agents.inspectSkill, agents.approveSkill, agents.activateSkill, agents.revokeSkill]) expect(method).not.toHaveBeenCalled();
    expect(html).not.toContain(`>${t.skillCenter.activate}<`);
  });

  it.each(['en', 'id'] as const)('keeps an unsupported preview separate from the existing Skills controls (%s)', language => {
    const t = MESSAGES[language];
    for (const patch of [
      { report: { ...catalog(), routingPreview: false } }, { report: { ...catalog(), routingPreview: undefined } },
      { report: { ...catalog(), status: 'unavailable' as const } }, { agents: { ...host(), previewSkillRouting: undefined } },
      { report: { ...catalog(), mode: 'legacy' as const, status: 'off' as const } },
    ]) {
      const html = panel({ ...patch, t });
      expect(html).toContain(t.skillRouting.unsupported);
      expect(html).not.toContain('<select');
      expect(html).not.toContain('type="checkbox"');
      expect(html).not.toContain('<button');
    }
  });

  it('explains an empty or incomplete catalog without selecting revisions or filling pins', () => {
    const t = MESSAGES.en;
    expect(panel({ report: { ...catalog(), revisions: [] } })).toContain(t.skillRouting.noCandidates);
    const html = panel({ report: { ...catalog(), truncated: true } });
    expect(html).toContain(t.skillPreflight.incompleteCatalog);
    expect(html).toContain(t.skillRouting.noPins);
    expect(html).not.toContain('checked=""');
  });

  it.each(['en', 'id'] as const)('renders all diagnostic statuses as read-only data (%s)', language => {
    const t = MESSAGES[language];
    for (const status of ['invalid', 'no_safe_skill', 'matched', 'ambiguous'] as const) {
      const value = result(); value.status = status;
      if (status === 'invalid' || status === 'no_safe_skill') { value.candidates = []; value.eligibleCount = 0; value.topTieCount = 0; }
      if (status === 'invalid') value.issues = ['duplicate_candidate_package'];
      if (status === 'ambiguous') { value.eligibleCount = 2; value.topTieCount = 2; value.input.maxResults = 1; }
      const html = resultHtml(value, language);
      expect(html).toContain(t.skillRouting.statuses[status]);
      expect(html).toContain(t.skillRouting.noAuthority);
      expect(html).toContain('role="status"');
      expect(html).not.toContain('<button');
      expect(html).not.toContain('<input');
      if (status === 'invalid') expect(html).toContain(t.skillRouting.inputIssue('duplicate_candidate_package'));
    }
  });

  it.each(['en', 'id'] as const)('preserves ambiguity when one displayed result represents two top ties (%s)', language => {
    const value = result(), t = MESSAGES[language];
    value.status = 'ambiguous'; value.eligibleCount = 2; value.topTieCount = 2; value.input.maxResults = 1;
    value.input.candidateRevisionIds.push(identity('second', 3).revisionId);
    const html = resultHtml(value, language);
    expect(value.candidates).toHaveLength(1);
    expect(html).toContain(t.skillRouting.statuses.ambiguous);
    expect(html).toContain(t.skillRouting.counts(2, 2));
    expect(html).not.toContain(t.skillRouting.statuses.matched);
    expect(html).not.toContain('<button');
  });

  it.each(['en', 'id'] as const)('shows match rationale, bounded dependency order, exclusions and omitted counts (%s)', language => {
    const value = result(), t = MESSAGES[language], candidate = value.candidates[0]!;
    candidate.matches.rationaleTruncated = true;
    candidate.plan = [...Array.from({ length: 17 }, (_, n) => identity(`dependency-${n}`, n + 10)), candidate.identity];
    value.exclusions = [{ identity: identity('blocked', 50), reason: 'inconsistent_preflight', diagnostics: [{ code: 'missing_pin', packageId: 'blocked', relatedPackageId: 'missing' }], omittedDiagnostics: 7 }];
    const html = resultHtml(value, language);
    for (const text of [t.skillRouting.exactIntents, 'review_code', t.skillRouting.exactCategories, 'quality', t.skillRouting.descendants, 'quality → quality.review',
      t.skillRouting.rationaleTruncated, t.skillRouting.ordering, t.skillRouting.omitted(2), t.skillRouting.exclusions, t.skillRouting.reasons.inconsistent_preflight,
      t.skillPreflight.issues.missing_pin, 'blocked → missing', t.skillRouting.omitted(7)]) expect(html).toContain(text);
    expect(html).toContain('dependency-15');
    expect(html).not.toContain('dependency-16');
    expect(html).not.toContain('<button');
  });

  it('escapes untrusted catalog, workspace, identity, rationale and exclusion text', () => {
    const html = panel({ report: { ...catalog(), revisions: [{ ...revision('root', 1), packageId: '<img src=x>', version: '<script>example()</script>' }] },
      workspaces: [{ ...workspace, name: '<script>workspace</script>' }] });
    expect(html).toContain('&lt;img src=x&gt;'); expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<img src=x>');
    const value = result();
    value.candidates[0]!.identity.packageId = '<img src=x>';
    value.candidates[0]!.matches.exactIntents = ['<script>intent</script>'];
    value.candidates[0]!.matches.descendantCategories = [{ requested: '<b>root</b>', declared: '<b>child</b>' }];
    value.exclusions = [{ identity: { ...identity('excluded', 50), version: '<script>version</script>' }, reason: 'root_unavailable',
      diagnostics: [{ code: 'missing_pin', packageId: '<img src=x>', relatedPackageId: '<script>dependency</script>' }], omittedDiagnostics: 1 }];
    const rendered = resultHtml(value);
    expect(rendered).toContain('&lt;script&gt;intent&lt;/script&gt;');
    expect(rendered).toContain('&lt;b&gt;root&lt;/b&gt; → &lt;b&gt;child&lt;/b&gt;');
    expect(rendered).toContain('&lt;script&gt;dependency&lt;/script&gt;');
    expect(rendered).not.toContain('<script>'); expect(rendered).not.toContain('<img src=x>');
  });

  it('keeps complete English and Indonesian control/result label sets', () => {
    expect(Object.keys(MESSAGES.id.skillRouting).sort()).toEqual(Object.keys(MESSAGES.en.skillRouting).sort());
    expect(Object.keys(MESSAGES.id.skillRouting.statuses).sort()).toEqual(Object.keys(MESSAGES.en.skillRouting.statuses).sort());
    expect(Object.keys(MESSAGES.id.skillRouting.reasons).sort()).toEqual(Object.keys(MESSAGES.en.skillRouting.reasons).sort());
    expect(MESSAGES.id.skillRouting.title).not.toBe(MESSAGES.en.skillRouting.title);
  });
});

describe('routing preview context identity', () => {
  it('keeps the form identity for equal values, reordered workspace choices and presentation-only changes', () => {
    const input = props(), second = { id: 'w_mh3p2k1x9f04c2a8', name: 'Second workspace' };
    input.workspaces.push(second);
    const original = key(input);
    expect(original).not.toBeNull();
    expect(key({ ...input, report: structuredClone(input.report), workspaces: [...input.workspaces].reverse().map(item => ({ ...item })) })).toBe(original);
    expect(key({ ...input, t: MESSAGES.id })).toBe(original);
  });

  it('replaces the form identity when host, capability, registry, scanner, revisions or workspace context changes', () => {
    const input = props(), original = key(input);
    const patches: Partial<Props>[] = [
      { agents: host() }, { report: { ...input.report, routingPreview: false } }, { report: { ...input.report, mode: 'legacy' } },
      { report: { ...input.report, status: 'unavailable' } }, { report: { ...input.report, preflight: false } },
      { report: { ...input.report, indexGeneration: 3 } }, { report: { ...input.report, scanner: 'unpinned' } },
      { report: { ...input.report, inspector: { ...input.report.inspector!, policyVersion: 'changed-policy' } } },
      { report: { ...input.report, inspector: { ...input.report.inspector!, pin: 'changed-pin' } } },
      { report: { ...input.report, truncated: true } }, { report: { ...input.report, revisions: [] } },
      { report: { ...input.report, revisions: [{ ...input.report.revisions[0]!, state: 'revoked' }, input.report.revisions[1]!] } },
      { report: { ...input.report, revisions: [{ ...input.report.revisions[0]!, permissionDigest: hash(500) }, input.report.revisions[1]!] } },
      { workspaces: [{ ...workspace, id: 'w_mh3p2k1x9f04c2a8' }] }, { workspaces: [{ ...workspace, name: 'Renamed workspace' }] },
    ];
    for (const patch of patches) expect(key({ ...input, ...patch }), JSON.stringify(Object.keys(patch))).not.toBe(original);
  });

  it('keys the entire Security Center by host so old catalogs and pending results cannot inherit a replacement host', () => {
    const agents = host(), state = { workspaces: [workspace] } as unknown as HostState;
    const input = { agents, state, t: MESSAGES.en };
    const first = SkillSecurityCenter(input), stable = SkillSecurityCenter({ ...input, state: { ...state }, t: MESSAGES.id });
    const replacementHost = host(), replacement = SkillSecurityCenter({ ...input, agents: replacementHost });
    expect(first.type).toBe(replacement.type);
    expect(first.key).not.toBeNull(); expect(stable.key).toBe(first.key); expect(replacement.key).not.toBe(first.key);
    expect(first.props.agents).toBe(agents); expect(replacement.props.agents).toBe(replacementHost);
    // Each newly keyed host starts without a catalog; SSR never renders a previous host's ready report.
    expect(renderToStaticMarkup(first)).toBe(''); expect(renderToStaticMarkup(replacement)).toBe('');
    expect(agents.skillRegistry).not.toHaveBeenCalled(); expect(replacementHost.skillRegistry).not.toHaveBeenCalled();
  });
});
