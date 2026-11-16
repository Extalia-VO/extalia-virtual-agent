import {
  AGENT_HOST_METHODS, normalizeSkillMarketPreviewInput, normalizeSkillMarketQuery, normalizeSkillMarketRefresh, normalizeSkillMarketReviewId, skillMarketPinnedSourceUrl,
  type AgentHostApi, type SkillActionResult, type SkillMarketPreview, type SkillMarketPreviewInput, type SkillMarketSearchResult,
} from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { SkillMarketplace, SkillMarketplaceController, SkillMarketplaceView, skillMarketSupported, skillMarketWarning, type SkillMarketplaceViewProps } from '../src/skills/SkillMarketplace';

const reviewId = '11111111-1111-4111-8111-111111111111';
const secondReviewId = '22222222-2222-4222-8222-222222222222';
const source: SkillMarketPreviewInput = { repository: 'example/skills', skill: 'review-code' };
const preview = (): SkillMarketPreview => ({ reviewId, expiresAt: '2099-11-12T01:00:00Z', repository: source.repository, commit: 'a'.repeat(40), directory: 'skills/review-code', sourceRef: `github:example/skills@${'a'.repeat(40)}#skills/review-code`, files: [{ path: 'SKILL.md', size: 42, sha256: 'b'.repeat(64) }], totalBytes: 42, treeSha256: 'c'.repeat(64), license: 'MIT', warnings: ['Read source terms before reuse.'] });
const searchResult = (query = 'review', count = 1): SkillMarketSearchResult => ({ provider: 'skills-sh', query, entries: Array.from({ length: count }, (_, index) => ({ id: `review-code-${index}`, name: `Review workflow ${index}`, source: 'example/skills', installs: 200 - index, url: `https://skills.sh/example/skills/review-code-${index}` })), fetchedAt: '2026-11-12T01:00:00Z', cached: false, stale: false });
const imported = (): SkillActionResult => ({ revisionId: `skr_${'d'.repeat(64)}`, packageId: 'review-code', state: 'quarantined', stateReason: 'scanner-unavailable', created: true,
  report: { mode: 'registry', status: 'ready', scanner: 'unpinned', review: true, approvalTtlMs: 600000, revisions: [], truncated: false } });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (failure: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
function harness() {
  const host = { skillMarketSearch: vi.fn(async (query: string) => searchResult(query)), previewMarketSkill: vi.fn(async (_input: SkillMarketPreviewInput) => preview()), installMarketSkill: vi.fn(async (_review: string) => imported()), discardMarketSkillPreview: vi.fn(async (_review: string): Promise<void> => undefined), approveSkill: vi.fn(), activateSkill: vi.fn() };
  const changed = vi.fn(), reveal = vi.fn(), agents = host as unknown as AgentHostApi;
  const owner = new SkillMarketplaceController(agents, changed, reveal);
  return { host, owner, agents, changed, reveal };
}
const props = (): SkillMarketplaceViewProps => ({ t: MESSAGES.en, supported: true, state: { query: '', repository: '', skill: '', confirmed: false, importUncertain: false }, onQuery: vi.fn(), onSearch: vi.fn(), onSource: vi.fn(), onPreview: vi.fn(), onConfirm: vi.fn(), onImport: vi.fn(), onDiscard: vi.fn(), onReviewLibrary: vi.fn() });
const markup = (value: SkillMarketplaceViewProps) => renderToStaticMarkup(createElement(SkillMarketplaceView, value));
const importButton = (html: string, label = MESSAGES.en.skillMarket.import) => html.match(new RegExp(`<button\\b[^>]*>(?:(?!<\\/button>).)*${label}<\\/button>`, 's'))?.[0];

describe('explicit marketplace requests and prepared-package ownership', () => {
  it('performs no network call on construction, activation or initial rendering, including older hosts', () => {
    const h = harness(); h.owner.activate();
    const html = renderToStaticMarkup(createElement(SkillMarketplace, { t: MESSAGES.en, agents: h.agents }));
    expect(html).toContain(MESSAGES.en.skillMarket.privacy); expect(h.host.skillMarketSearch).not.toHaveBeenCalled(); expect(h.host.previewMarketSkill).not.toHaveBeenCalled();
    expect(skillMarketSupported(h.agents)).toBe(true);
    const absent = { ...h.agents, installMarketSkill: undefined };
    expect(skillMarketSupported(absent)).toBe(false);
    const unavailable = renderToStaticMarkup(createElement(SkillMarketplace, { t: MESSAGES.id, agents: absent }));
    expect(unavailable).toContain(MESSAGES.id.skillMarket.unavailable); expect(unavailable).not.toContain('<form');
  });

  it('sends only the submitted query and an explicit refresh choice, without importing or previewing', async () => {
    const h = harness(); h.owner.editQuery('  review  '); await h.owner.search();
    expect(h.host.skillMarketSearch).toHaveBeenCalledExactlyOnceWith('review', false);
    expect(h.owner.value.result?.query).toBe('review');
    await h.owner.search(true); expect(h.host.skillMarketSearch).toHaveBeenLastCalledWith('review', true);
    expect(h.host.previewMarketSkill).not.toHaveBeenCalled(); expect(h.host.installMarketSkill).not.toHaveBeenCalled();
  });

  it('rejects duplicate searches and discards an old search result after query editing', async () => {
    const h = harness(), pending = deferred<SkillMarketSearchResult>(); h.host.skillMarketSearch.mockReturnValueOnce(pending.promise);
    h.owner.editQuery('old query'); const first = h.owner.search(), duplicate = h.owner.search(); await settle();
    h.owner.editQuery('new query'); pending.resolve(searchResult('old query')); await first; await duplicate;
    expect(h.host.skillMarketSearch).toHaveBeenCalledOnce(); expect(h.owner.value.query).toBe('new query'); expect(h.owner.value.result).toBeUndefined(); expect(h.owner.value.busy).toBeUndefined();
    await h.owner.search(); expect(h.owner.value.result?.query).toBe('new query');
  });

  it('keeps search errors visible without manufacturing cached results and allows an explicit next request', async () => {
    const h = harness(); h.owner.editQuery('review'); h.host.skillMarketSearch.mockRejectedValueOnce(new Error('Network unavailable'));
    await h.owner.search(); expect(h.owner.value.error).toBe('Network unavailable'); expect(h.owner.value.result).toBeUndefined();
    await h.owner.search(); expect(h.owner.value.result?.entries).toHaveLength(1); expect(h.owner.value.error).toBeUndefined();
  });

  it('waits for exclusive preview cleanup before preparing a different package', async () => {
    const h = harness(), release = deferred<void>(), order: string[] = []; let exclusive = false, previews = 0;
    const admit = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
      if (exclusive) throw new Error('Marketplace operation still active');
      exclusive = true; order.push(name);
      try { return await action(); } finally { exclusive = false; order.push(`${name}:settled`); }
    };
    h.host.previewMarketSkill.mockImplementation(async input => admit(`preview:${input.skill}`, async () => ({ ...preview(), reviewId: ++previews === 1 ? reviewId : secondReviewId })));
    h.host.discardMarketSkillPreview.mockImplementationOnce(async () => admit('discard', () => release.promise));
    await h.owner.preview(source); const next = h.owner.preview({ repository: 'other/skills', skill: 'second' }); await settle();
    expect(h.owner.value.busy).toBe('preview'); expect(h.host.previewMarketSkill).toHaveBeenCalledOnce(); expect(order.at(-1)).toBe('discard');
    release.resolve(); await next;
    expect(h.owner.value.preview?.reviewId).toBe(secondReviewId); expect(h.owner.value.error).toBeUndefined();
    expect(order.indexOf('preview:second')).toBeGreaterThan(order.indexOf('discard:settled'));
  });

  it('waits for exclusive preview cleanup before searching and skips a request whose query changed during cleanup', async () => {
    const h = harness(), release = deferred<void>(); let exclusive = false;
    h.host.discardMarketSkillPreview.mockImplementationOnce(async () => { exclusive = true; try { await release.promise; } finally { exclusive = false; } });
    h.host.skillMarketSearch.mockImplementation(async query => { if (exclusive) throw Error('Marketplace operation still active'); return searchResult(query); });
    await h.owner.preview(source); h.owner.editQuery('review'); const request = h.owner.search(); await settle();
    expect(h.owner.value.busy).toBe('search'); expect(h.host.skillMarketSearch).not.toHaveBeenCalled();
    release.resolve(); await request; expect(h.owner.value.result?.query).toBe('review'); expect(h.owner.value.error).toBeUndefined();

    await h.owner.preview(source); const secondRelease = deferred<void>(); h.host.discardMarketSkillPreview.mockReturnValueOnce(secondRelease.promise);
    h.owner.editQuery('old query'); const outdated = h.owner.search(); await settle(); h.owner.editQuery('new query');
    secondRelease.resolve(); await outdated;
    expect(h.host.skillMarketSearch).toHaveBeenCalledOnce(); expect(h.owner.value.query).toBe('new query'); expect(h.owner.value.result).toBeUndefined(); expect(h.owner.value.busy).toBeUndefined();
  });

  it('requires an exact prepared preview and separate confirmation before importing', async () => {
    const h = harness(); await h.owner.import(); expect(h.host.installMarketSkill).not.toHaveBeenCalled();
    await h.owner.preview(source); expect(h.host.previewMarketSkill).toHaveBeenCalledExactlyOnceWith(source);
    expect(h.owner.value.preview?.treeSha256).toBe('c'.repeat(64)); await h.owner.import(); expect(h.host.installMarketSkill).not.toHaveBeenCalled();
    h.owner.confirm(true); await h.owner.import();
    expect(h.host.installMarketSkill).toHaveBeenCalledExactlyOnceWith(reviewId); expect(h.owner.value.imported?.state).toBe('quarantined');
    expect(h.changed).toHaveBeenCalledOnce(); expect(h.reveal).toHaveBeenCalledOnce(); expect(h.host.approveSkill).not.toHaveBeenCalled(); expect(h.host.activateSkill).not.toHaveBeenCalled();
  });

  it('clears and releases a previous prepared package when a different source fails validation', async () => {
    const h = harness(); await h.owner.preview(source); h.owner.confirm(true);
    await h.owner.preview({ repository: 'https://example.com/unsafe', skill: 'review-code' });
    expect(h.host.discardMarketSkillPreview).toHaveBeenCalledExactlyOnceWith(reviewId); expect(h.owner.value.preview).toBeUndefined(); expect(h.owner.value.confirmed).toBe(false);
    expect(h.host.previewMarketSkill).toHaveBeenCalledOnce(); await h.owner.import(); expect(h.host.installMarketSkill).not.toHaveBeenCalled();
  });

  it('releases late previews after source editing or disposal without exposing or importing them', async () => {
    const h = harness(), first = deferred<SkillMarketPreview>(), second = deferred<SkillMarketPreview>();
    h.host.previewMarketSkill.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const request = h.owner.preview(source); await settle(); h.owner.editSource('repository', 'other/skills'); first.resolve(preview()); await request;
    expect(h.owner.value.preview).toBeUndefined(); expect(h.owner.value.repository).toBe('other/skills'); expect(h.host.discardMarketSkillPreview).toHaveBeenCalledWith(reviewId);
    const next = h.owner.preview(source); await settle(); h.owner.dispose(); second.resolve({ ...preview(), reviewId: secondReviewId }); await next;
    expect(h.host.discardMarketSkillPreview).toHaveBeenCalledWith(secondReviewId); expect(h.host.installMarketSkill).not.toHaveBeenCalled();
  });

  it('ignores late search success/failure after the owner closes', async () => {
    const h = harness(), pending = deferred<SkillMarketSearchResult>(); h.host.skillMarketSearch.mockReturnValueOnce(pending.promise);
    h.owner.editQuery('review'); const request = h.owner.search(); await settle(); h.owner.dispose(); pending.reject(new Error('Old host failed')); await request;
    expect(h.owner.value.result).toBeUndefined(); expect(h.owner.value.error).toBeUndefined(); expect(h.changed).not.toHaveBeenCalled();
  });

  it('imports once while keeping entered package ownership out of close/edit cleanup', async () => {
    const h = harness(); await h.owner.preview(source); h.owner.confirm(true);
    const pending = deferred<SkillActionResult>(); h.host.installMarketSkill.mockReturnValueOnce(pending.promise);
    const first = h.owner.import(), duplicate = h.owner.import();
    h.owner.editSource('skill', 'another'); h.owner.editQuery('other'); h.owner.closePreview();
    expect(h.owner.value.skill).toBe(source.skill); expect(h.owner.value.query).toBe('');
    expect(h.host.discardMarketSkillPreview).not.toHaveBeenCalled(); expect(h.host.installMarketSkill).toHaveBeenCalledExactlyOnceWith(reviewId);
    pending.resolve(imported()); await first; await duplicate;
    expect(h.owner.value.preview).toBeUndefined(); expect(h.changed).toHaveBeenCalledOnce();
  });

  it('treats import failure as uncertain, reveals the registry and never retries the same prepared identity', async () => {
    const h = harness(); await h.owner.preview(source); h.owner.confirm(true); h.host.installMarketSkill.mockRejectedValueOnce(new Error('Lost import acknowledgement'));
    await h.owner.import(); await h.owner.import();
    expect(h.host.installMarketSkill).toHaveBeenCalledOnce(); expect(h.owner.value.importUncertain).toBe(true); expect(h.owner.value.imported).toBeUndefined(); expect(h.owner.value.preview).toBeUndefined();
    expect(h.owner.value.error).toBe('Lost import acknowledgement'); expect(h.changed).toHaveBeenCalledOnce(); expect(h.reveal).toHaveBeenCalledOnce();
  });

  it('does not discard or publish an entered import when its view unmounts', async () => {
    const h = harness(); await h.owner.preview(source); h.owner.confirm(true);
    const pending = deferred<SkillActionResult>(); h.host.installMarketSkill.mockReturnValueOnce(pending.promise);
    const request = h.owner.import(); h.owner.dispose(); pending.resolve(imported()); await request;
    expect(h.host.discardMarketSkillPreview).not.toHaveBeenCalled(); expect(h.changed).not.toHaveBeenCalled(); expect(h.reveal).not.toHaveBeenCalled(); expect(h.owner.value.imported).toBeUndefined();
  });

  it('does not reclassify a known import if a UI refresh callback throws', async () => {
    const h = harness(); h.owner.setChanged(() => { throw new Error('Renderer refresh failed'); }); await h.owner.preview(source); h.owner.confirm(true); await h.owner.import();
    expect(h.owner.value.imported).toMatchObject({ packageId: 'review-code', state: 'quarantined' }); expect(h.owner.value.importUncertain).toBe(false); expect(h.reveal).toHaveBeenCalledOnce();
  });
});

describe('marketplace rendering and source evidence', () => {
  it.each(['en', 'id'] as const)('renders the explicit preview/import workflow and truthful warnings (%s)', language => {
    const p = props(); p.t = MESSAGES[language]; p.state.preview = preview();
    const html = markup(p), text = p.t.skillMarket;
    for (const value of [text.privacy, text.confirm, text.importLimit, text.unknownLicense, text.import, text.commit, text.files]) {
      if (value !== text.unknownLicense) expect(html).toContain(value);
    }
    expect(html).toContain('a'.repeat(40)); expect(html).toContain('c'.repeat(64)); expect(html).toContain('SKILL.md'); expect(html).toContain('Read source terms before reuse.');
    expect(importButton(html, text.import)).toContain('disabled=""');
    p.state.confirmed = true; expect(importButton(markup(p), text.import)).not.toContain('disabled=""');
    expect(html).toContain('target="_blank"'); expect(html).toContain('rel="noopener noreferrer"'); expect(html).toContain(`/tree/${'a'.repeat(40)}/skills/review-code`);
  });

  it.each(['en', 'id'] as const)('shows bounded permission and runtime declarations before import (%s)', language => {
    const p = props();
    p.t = MESSAGES[language];
    p.state.preview = { ...preview(), manifest: {
      id: 'review-code', version: '1.2.3', inferred: false, riskClass: 'tool_using',
      permissions: [{ capability: 'filesystem_read', scope: 'docs/**' }], permissionsTotal: 2,
      compatibility: [{ id: 'extalia', range: '>=0.4.0' }], compatibilityTotal: 1,
    } };
    const html = markup(p), text = p.t.skillMarket;
    expect(html).toContain(text.declarations);
    expect(html).toContain('<code>1.2.3</code>');
    expect(html).toContain(p.t.skillCenter.risks.tool_using);
    expect(html).toContain(p.t.skillCenter.capabilities.filesystem_read);
    expect(html).toContain('<code>docs/**</code>');
    expect(html).toContain(text.omittedRows(1));
    expect(html).toContain('<code>extalia</code><code>&gt;=0.4.0</code>');
    expect(html).toContain(text.compatibilityUnchecked);
    expect(importButton(html, text.import)).toContain('disabled=""');
  });

  it('distinguishes an older host’s missing declarations from an inferred empty manifest', () => {
    const p = props(), text = p.t.skillMarket;
    p.state.preview = preview();
    expect(markup(p)).toContain(text.declarationsUnavailable);
    expect(markup(p)).not.toContain(p.t.skillCenter.noPermissions);
    p.state.preview = { ...preview(), manifest: {
      id: 'review-code', version: '0.0.0+tree.abcd', inferred: true, riskClass: 'declarative',
      permissions: [], permissionsTotal: 0, compatibility: [], compatibilityTotal: 0,
    } };
    const html = markup(p);
    expect(html).toContain(p.t.skillCenter.inferred);
    expect(html).toContain(p.t.skillCenter.noPermissions);
    expect(html).toContain(text.noRuntimeRequirements);
    expect(html).not.toContain(text.declarationsUnavailable);
  });

  it('shows a localized invalid-manifest refusal without offering import', () => {
    const p = props();
    p.t = MESSAGES.id;
    p.state.error = 'Native skill market unavailable (invalid_manifest).';
    const html = markup(p);
    expect(html).toContain(p.t.skillMarket.invalidManifest);
    expect(importButton(html, p.t.skillMarket.import)).toBeUndefined();
  });

  it('localizes only known Extalia-owned warnings and leaves arbitrary source text literal', () => {
    const sentence = 'No license notice was found for this package. Marketplace listing does not establish permission to use or redistribute it.';
    expect(skillMarketWarning(sentence, MESSAGES.id)).toBe(MESSAGES.id.skillMarket.warningNoLicense);
    expect(skillMarketWarning('A repository-specific warning.', MESSAGES.id)).toBe('A repository-specific warning.');
  });

  it('keeps remote metadata literal and never creates executable markup or an arbitrary source link', () => {
    const p = props(); p.state.preview = { ...preview(), repository: 'javascript:alert(1)', license: '<img src=x onerror=alert(1)>', warnings: ['<script>alert(1)</script>'],
      manifest: {
        id: 'review-code', version: '1.2.3', inferred: false, riskClass: 'tool_using',
        permissions: [{ capability: 'filesystem_read', scope: '<iframe>scope</iframe>' }], permissionsTotal: 1,
        compatibility: [{ id: 'extalia', range: '<object>range</object>' }], compatibilityTotal: 1,
      },
    };
    const html = markup(p);
    expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&lt;img'); expect(html).not.toContain('<script>'); expect(html).not.toContain('<img'); expect(html).not.toContain('href="javascript:'); expect(html).not.toContain('target="_blank"');
    expect(html).toContain('&lt;iframe&gt;scope&lt;/iframe&gt;');
    expect(html).toContain('&lt;object&gt;range&lt;/object&gt;');
    expect(html).not.toContain('<iframe>');
    expect(html).not.toContain('<object>');
  });

  it('shows cached/stale provenance and distinguishes network absence from a genuine empty search', () => {
    const p = props(); p.state.result = { ...searchResult(), cached: true, stale: true, problem: 'network' };
    let html = markup(p); expect(html).toContain(MESSAGES.en.skillMarket.cached); expect(html).toContain(MESSAGES.en.skillMarket.stale); expect(html).toContain('2026-11-12T01:00:00Z');
    p.state.result = { ...searchResult(), entries: [], cached: false, stale: true, problem: 'network', fetchedAt: undefined }; html = markup(p);
    expect(html).not.toContain(MESSAGES.en.skillMarket.empty); expect(html).not.toContain(MESSAGES.en.skillMarket.fetched + ':');
    p.state.result = { ...searchResult(), entries: [] }; expect(markup(p)).toContain(MESSAGES.en.skillMarket.empty);
  });

  it('bounds initial catalog rendering and exposes the full result count with explicit continuation', () => {
    const p = props(); p.state.result = searchResult('review', 200); const html = markup(p);
    expect(html).toContain('(12/200)'); expect(html).toContain(MESSAGES.en.skillMarket.showMore); expect(html).toContain('Review workflow 11'); expect(html).not.toContain('Review workflow 12');
  });

  it('shows registry candidate status rather than activation success, including already-imported bytes', () => {
    const p = props(); p.state.imported = { ...imported(), created: false }; const html = markup(p);
    expect(html).toContain(MESSAGES.en.skillMarket.imported); expect(html).toContain(MESSAGES.en.skillMarket.alreadyImported); expect(html).toContain(MESSAGES.en.skillCenter.states.quarantined); expect(html).toContain('scanner-unavailable');
    expect(html).not.toMatch(/installed successfully|activated successfully/i);
    p.state.imported = undefined; p.state.importUncertain = true; const uncertain = markup(p); expect(uncertain).toContain(MESSAGES.en.skillMarket.importUncertain); expect(uncertain).not.toContain(MESSAGES.en.skillMarket.imported);
  });
});

describe('public marketplace request contract', () => {
  it('registers all optional application methods without altering skill lifecycle permissions', () => {
    expect(AGENT_HOST_METHODS).toEqual(expect.arrayContaining(['skillMarketSearch', 'previewMarketSkill', 'installMarketSkill', 'discardMarketSkillPreview']));
    expect(normalizeSkillMarketQuery('  code review  ')).toBe('code review'); expect(normalizeSkillMarketQuery('panduan 日本語')).toBe('panduan 日本語');
    expect(normalizeSkillMarketRefresh(undefined)).toBe(false); expect(normalizeSkillMarketRefresh(true)).toBe(true);
    for (const input of ['', ' ', 'x'.repeat(121), 'review\ncode', 'review\0', { query: 'review', project: '/private' }]) expect(() => normalizeSkillMarketQuery(input)).toThrow();
    for (const input of ['true', 1, null]) expect(() => normalizeSkillMarketRefresh(input)).toThrow();
  });

  it('accepts bounded repository-relative skill paths but refuses paths, credentials and traversal authority', () => {
    expect(normalizeSkillMarketPreviewInput({ repository: ' example/skills ', skill: ' skills/review/SKILL.md ' })).toEqual({ repository: 'example/skills', skill: 'skills/review/SKILL.md' });
    for (const repository of ['https://github.com/example/skills', 'file:///tmp/skills', 'example/skills?token=secret', '../skills', 'example/..', 'example/skills/extra', 'example/skills\n']) expect(() => normalizeSkillMarketPreviewInput({ repository, skill: 'review' })).toThrow();
    for (const skill of ['../SKILL.md', '/root', 'skills//review', 'skills/./review', 'skills\\review', 'CON.txt', 'skills/review.', 'x'.repeat(129), 'a/'.repeat(8) + 'skill', 'review\n']) expect(() => normalizeSkillMarketPreviewInput({ repository: 'example/skills', skill })).toThrow();
    expect(() => normalizeSkillMarketPreviewInput({ ...source, url: 'https://example.com' })).toThrow();
    expect(normalizeSkillMarketReviewId(reviewId)).toBe(reviewId);
    for (const id of [reviewId + '/SKILL.md', '../review', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase(), 42]) expect(() => normalizeSkillMarketReviewId(id)).toThrow();
  });

  it('links only immutable public GitHub trees with literal safe path segments', () => {
    expect(skillMarketPinnedSourceUrl(preview())).toBe(`https://github.com/example/skills/tree/${'a'.repeat(40)}/skills/review-code`);
    expect(skillMarketPinnedSourceUrl({ ...preview(), directory: '' })).toBe(`https://github.com/example/skills/tree/${'a'.repeat(40)}`);
    for (const change of [{ repository: 'javascript:alert(1)' }, { repository: 'example/skills?token=secret' }, { commit: 'main' }, { directory: '../private' }, { directory: '/absolute' }, { directory: 'skills/%2e%2e/private' }]) expect(skillMarketPinnedSourceUrl({ ...preview(), ...change })).toBeUndefined();
  });
});
