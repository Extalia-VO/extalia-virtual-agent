import type { SkillRevisionDetails } from '@extalia/platform';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { SkillDetails } from '../src/skills/SkillSecurityCenter';

const detail = (extra: Partial<SkillRevisionDetails> = {}): SkillRevisionDetails => ({
  revision: { packageId: 'demo', revisionId: `skr_${'a'.repeat(64)}`, origin: 'imported', version: '1.0.0',
    treeSha256: 'a'.repeat(64), skillMdSha256: 'b'.repeat(64), state: 'quarantined', riskClass: 'declarative',
    permissionDigest: 'c'.repeat(64), permissions: [], active: false, manifestInferred: true,
    createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z' },
  manifest: '{}', files: [], inspections: [], approvals: [], history: [], consent: [], ...extra,
});

describe('exact revision import provenance', () => {
  it.each(['en', 'id'] as const)('shows recorded sources and omitted records in %s without inheriting legacy trust', language => {
    const t = MESSAGES[language], sourceRef = `github:example/skills@${'d'.repeat(40)}#demo`;
    const html = renderToStaticMarkup(createElement(SkillDetails, { t, detail: detail({
      sources: [{ origin: 'imported', sourceRef, recordedAt: '2026-11-12T00:00:00.000Z' }], sourcesTotal: 21, sourcesOmitted: 20,
    }) }));
    expect(html).toContain(sourceRef); expect(html).toContain(t.skillCenter.sourceCounts(1, 21));
    expect(html).toContain(t.skillCenter.sourcesOmitted(20)); expect(html).not.toContain(t.skillCenter.sourcesUnknown);
    const legacy = renderToStaticMarkup(createElement(SkillDetails, { t, detail: detail() }));
    expect(legacy).toContain(t.skillCenter.sourcesUnknown); expect(legacy).not.toContain(sourceRef);
  });

  it('renders source references as literal text, never source-authored markup or links', () => {
    const html = renderToStaticMarkup(createElement(SkillDetails, { t: MESSAGES.en, detail: detail({
      sources: [{ origin: 'user', sourceRef: 'folder:<script>untrusted</script>', recordedAt: '2026-11-12T00:00:00.000Z' }], sourcesTotal: 1, sourcesOmitted: 0,
    }) }));
    expect(html).toContain('&lt;script&gt;untrusted&lt;/script&gt;'); expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="folder:');
  });
});
