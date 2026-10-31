import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentHostApi, SkillPreflightReport, SkillRegistryReport } from '@extalia/platform';
import { SkillPreflightView } from '../src/skills/SkillPreflightPanel';
import { createMockSkillRegistry } from '../src/host/mockSkillRegistry';
import { skillPreflightContext } from '../src/skills/skillPreflightContext';
import { MESSAGES } from '../src/i18n';

const root = `skr_${'a'.repeat(64)}`, dependency = `skr_${'b'.repeat(64)}`;
const revision = (id: string, revisionId: string) => ({ packageId: id, revisionId, origin: 'imported' as const, version: '1.0.0', treeSha256: revisionId.slice(4), skillMdSha256: 'a'.repeat(64),
  state: 'quarantined' as const, riskClass: 'declarative' as const, manifestInferred: false, permissionDigest: 'c'.repeat(64), permissions: [], active: false, createdAt: '', updatedAt: '' });
const report: SkillRegistryReport = { mode: 'registry', status: 'ready', scanner: 'unpinned', review: false, preflight: true, truncated: false, approvalTtlMs: 600000,
  revisions: [revision('root', root), revision('dependency', dependency)] };
function props() { return { t: MESSAGES.en, report, available: true, root, pins: {}, error: false, busy: false, onRoot: vi.fn(), onPin: vi.fn(), onRemove: vi.fn(), onRun: vi.fn() }; }
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
describe('skill dependency check presentation', () => {
  it('does not require the optional capability to keep the existing Skills center usable', () => {
    const html = renderToStaticMarkup(createElement(SkillPreflightView, { ...props(), available: false }));
    expect(html).toContain(MESSAGES.en.skillPreflight.unsupported);
    expect(html).not.toContain('<select');
  });
  it('starts with no automatic pins and sends exact dropdown choices', () => {
    const input = props(), tree = SkillPreflightView(input);
    const selects = elements(tree).filter(item => item.type === 'select');
    expect(selects).toHaveLength(2);
    expect(selects[1]!.props.value).toBe('');
    (selects[1]!.props.onChange as (event: unknown) => void)({ target: { value: dependency } });
    expect(input.onPin).toHaveBeenCalledWith(dependency);
    expect(input.onRun).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(tree)).toContain(MESSAGES.en.skillPreflight.noPins);
  });
  it.each(['en', 'id'] as const)('labels blocked and consistent diagnostics without granting actions (%s)', language => {
    const t = MESSAGES[language];
    const blocked: SkillPreflightReport = { rootRevisionId: root, dispatchEligible: false, status: 'blocked', issues: [{ code: 'missing_pin', packageId: 'root', relatedPackageId: 'dependency' }], truncated: true };
    const html = renderToStaticMarkup(createElement(SkillPreflightView, { ...props(), t, result: blocked }));
    expect(html).toContain(t.skillPreflight.blocked);
    expect(html).toContain(t.skillPreflight.noAuthority);
    expect(html).toContain(t.skillPreflight.truncated);
    expect(html).not.toContain(`>${t.skillCenter.approve}<`);
    const consistent: SkillPreflightReport = { rootRevisionId: root, dispatchEligible: false, status: 'consistent', issues: [], truncated: false,
      plan: [{ packageId: 'root', version: '1.0.0', revisionId: root, treeSha256: 'a'.repeat(64), permissionDigest: 'c'.repeat(64) }] };
    expect(renderToStaticMarkup(createElement(SkillPreflightView, { ...props(), t, result: consistent }))).toContain(t.skillPreflight.consistent);
  });
  it('escapes supplied revision text, handles busy/errors and disables a missing root', () => {
    const input = props();
    const html = renderToStaticMarkup(createElement(SkillPreflightView, { ...input, report: { ...report, revisions: [{ ...revision('root', root), version: '<script>bad()</script>' }] }, error: true, busy: true }));
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain(MESSAGES.en.skillPreflight.checking); expect(html).toContain('disabled');
    expect(html).toContain(MESSAGES.en.skillPreflight.failed);
    expect(renderToStaticMarkup(createElement(SkillPreflightView, { ...input, root: '' }))).toContain('disabled');
  });
  it('mock check never changes lifecycle/history/activation or permits execution', async () => {
    const host = createMockSkillRegistry('registry', async () => {}), before = await host.skillRegistry();
    const result = await host.preflightSkill!({ rootRevisionId: before.revisions[0]!.revisionId, pins: {} });
    expect(result.status).toBe('blocked'); expect(result.dispatchEligible).toBe(false);
    expect(await host.skillRegistry()).toEqual(before);
  });
});


it('invalidates the component identity on host, scanner/policy or revision context changes', () => {
  const first = {} as AgentHostApi, second = {} as AgentHostApi;
  const base = skillPreflightContext(first, report);
  expect(skillPreflightContext(first, { ...report })).toBe(base);
  expect(skillPreflightContext(second, report)).not.toBe(base);
  expect(skillPreflightContext(first, { ...report, inspector: { scannerId: 'new', pinned: false, status: 'unavailable', policyVersion: 'new-policy' } })).not.toBe(base);
  expect(skillPreflightContext(first, { ...report, indexGeneration: 10 })).not.toBe(base);
});
