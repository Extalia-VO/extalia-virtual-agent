import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { GraphFilterControls, GraphSelectedNotePanel, type GraphFilterControlsProps } from '../src/knowledge/vault/GraphFilterControls';
import { EMPTY_GRAPH_FILTERS } from '../src/knowledge/vault/graphFilters';

const props = (patch: Partial<GraphFilterControlsProps> = {}): GraphFilterControlsProps => ({
  t: MESSAGES.en, options: { folders: ['', 'Docs', 'Docs/Sub'], kinds: ['', 'knowledge'], tags: ['', 'common', 'secondary'] }, filters: { ...EMPTY_GRAPH_FILTERS }, onChange: vi.fn(), onClear: vi.fn(), ...patch,
});
const render = (patch: Partial<GraphFilterControlsProps> = {}) => renderToStaticMarkup(createElement(GraphFilterControls, props(patch)));

describe('explicit vault graph filter controls', () => {
  it.each(['en', 'id'] as const)('renders labelled keyboard-native selects and localized unrestricted/absence choices in %s', language => {
    const k = MESSAGES[language].knowledge.vaultGraph, html = render({ t: MESSAGES[language] });
    expect(html.match(/<select /g)).toHaveLength(3); expect(html.match(/<label for=/g)).toHaveLength(3);
    for (const label of [k.filters, k.filterFolder, k.filterKind, k.filterTag, k.allFolders, k.allKinds, k.allTags, k.root, k.noKind, k.noTags, k.clearFilters]) expect(html).toContain(label);
    expect(html.match(/value="" selected=""/g)).toHaveLength(3); expect(html).toContain('disabled=""');
  });

  it('keeps All and exact root/no-kind/untagged options distinct and enables clearing absence filters', () => {
    const html = render({ filters: { folder: null, kind: null, tag: null } });
    for (const value of ['folder:', 'kind:', 'tag:']) expect(html).toContain(`value="${value}" selected=""`);
    expect(html).not.toContain('disabled=""'); expect(html).not.toContain('role="status"');
  });

  it.each(['en', 'id'] as const)('retains missing selections after refresh as explicit unavailable options in %s', language => {
    const k = MESSAGES[language].knowledge.vaultGraph;
    const html = render({ t: MESSAGES[language], options: { folders: [], kinds: [], tags: [] }, filters: { folder: 'Removed', kind: 'retired-kind', tag: 'retired-tag' } });
    expect(html).toContain('value="folder:Removed" selected=""'); expect(html).toContain('value="kind:retired-kind" selected=""'); expect(html).toContain('value="tag:retired-tag" selected=""');
    expect(html).toContain(k.filterUnavailable('Removed')); expect(html).toContain(k.clearFilters); expect(html).toContain('role="status"'); expect(html).not.toContain('disabled=""');
  });

  it('keeps missing absence choices visible in an empty refreshed graph and escapes literal facet names', () => {
    const k = MESSAGES.en.knowledge.vaultGraph;
    const missing = render({ options: { folders: [], kinds: [], tags: [] }, filters: { folder: null, kind: null, tag: null } });
    for (const label of [k.root, k.noKind, k.noTags]) expect(missing).toContain(k.filterUnavailable(label));
    const escaped = render({ filters: { folder: '<script>', kind: '', tag: '' } });
    expect(escaped).toContain('&lt;script&gt;'); expect(escaped).not.toContain('<script>');
  });

  it.each(['en', 'id'] as const)('hides filtered selected-note content while keeping a localized close action in %s', language => {
    const k = MESSAGES[language].knowledge.vaultGraph;
    const panel = (visible: boolean) => renderToStaticMarkup(createElement(GraphSelectedNotePanel, { t: MESSAGES[language], visible, onClose: vi.fn(), children: createElement('p', null, 'Selected note content') }));
    const hidden = panel(false); expect(hidden).not.toContain('Selected note content'); expect(hidden).toContain(k.selectedFiltered); expect(hidden).toContain(k.closeFilteredNote); expect(hidden).toContain('role="status"');
    const shown = panel(true); expect(shown).toContain('Selected note content'); expect(shown).not.toContain(k.selectedFiltered);
  });
});
