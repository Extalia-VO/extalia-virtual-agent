import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Select, type SelectProps } from '../src/ui/Select';
import { MESSAGES } from '../src/i18n';
import { GraphFilterControls, GraphSelectedNotePanel, type GraphFilterControlsProps } from '../src/knowledge/vault/GraphFilterControls';
import { EMPTY_GRAPH_FILTERS } from '../src/knowledge/vault/graphFilters';

const props = (patch: Partial<GraphFilterControlsProps> = {}): GraphFilterControlsProps => ({
  t: MESSAGES.en, options: { folders: ['', 'Docs', 'Docs/Sub'], kinds: ['', 'knowledge'], tags: ['', 'common', 'secondary'] }, filters: { ...EMPTY_GRAPH_FILTERS }, onChange: vi.fn(), onClear: vi.fn(), ...patch,
});
const render = (patch: Partial<GraphFilterControlsProps> = {}) => renderToStaticMarkup(createElement(GraphFilterControls, props(patch)));

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function controls(patch: Partial<GraphFilterControlsProps> = {}) {
  let tree: ReactNode;
  function Capture() { tree = GraphFilterControls(props(patch)); return tree; }
  renderToStaticMarkup(createElement(Capture));
  return elements(tree).filter(item => item.type === Select).map(item => item.props as unknown as SelectProps);
}

describe('explicit vault graph filter controls', () => {
  it.each(['en', 'id'] as const)('renders labelled comboboxes and localized unrestricted choices in %s', language => {
    const k = MESSAGES[language].knowledge.vaultGraph, html = render({ t: MESSAGES[language] });
    expect(html.match(/role="combobox"/g)).toHaveLength(3); expect(html.match(/<label for=/g)).toHaveLength(3);
    for (const label of [k.filters, k.filterFolder, k.filterKind, k.filterTag, k.allFolders, k.allKinds, k.allTags, k.clearFilters]) expect(html).toContain(label);
    expect(controls({ t: MESSAGES[language] }).map(control => control.value)).toEqual(['', '', '']);
    expect(html).toContain('disabled=""');
  });

  it('keeps All and exact root/no-kind/untagged options distinct and enables clearing absence filters', () => {
    const html = render({ filters: { folder: null, kind: null, tag: null } });
    expect(controls({ filters: { folder: null, kind: null, tag: null } }).map(control => control.value)).toEqual(['folder:', 'kind:', 'tag:']);
    for (const label of [MESSAGES.en.knowledge.vaultGraph.root, MESSAGES.en.knowledge.vaultGraph.noKind, MESSAGES.en.knowledge.vaultGraph.noTags]) expect(html).toContain(label);
    expect(html).not.toContain('disabled=""'); expect(html).not.toContain('role="status"');
  });

  it.each(['en', 'id'] as const)('retains missing selections after refresh as explicit unavailable options in %s', language => {
    const k = MESSAGES[language].knowledge.vaultGraph;
    const html = render({ t: MESSAGES[language], options: { folders: [], kinds: [], tags: [] }, filters: { folder: 'Removed', kind: 'retired-kind', tag: 'retired-tag' } });
    const selected = controls({ t: MESSAGES[language], options: { folders: [], kinds: [], tags: [] }, filters: { folder: 'Removed', kind: 'retired-kind', tag: 'retired-tag' } });
    expect(selected.map(control => control.value)).toEqual(['folder:Removed', 'kind:retired-kind', 'tag:retired-tag']);
    expect(selected.map(control => control.options.find(option => option.value === control.value)?.label)).toEqual(['Removed', 'retired-kind', 'retired-tag'].map(value => k.filterUnavailable(value)));
    expect(html).toContain(k.filterUnavailable('Removed')); expect(html).toContain(k.clearFilters); expect(html).toContain('role="status"'); expect(html).not.toContain('disabled=""');
  });

  it('dispatches exact facet values while keeping all, root, and literal sentinel names distinct', () => {
    const onChange = vi.fn(), filters = { folder: 'Docs', kind: 'knowledge', tag: 'common' };
    const [folder, kind, tag] = controls({ filters, onChange });
    expect(folder!.options).toContainEqual({ value: '', label: MESSAGES.en.knowledge.vaultGraph.allFolders });
    expect(folder!.options).toContainEqual({ value: 'folder:', label: MESSAGES.en.knowledge.vaultGraph.root });
    folder!.onChange('folder:');
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, folder: null });
    folder!.onChange('');
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, folder: '' });
    folder!.onChange('folder:folder:');
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, folder: 'folder:' });
    kind!.onChange('kind:');
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, kind: null });
    tag!.onChange('tag:secondary');
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, tag: 'secondary' });
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
