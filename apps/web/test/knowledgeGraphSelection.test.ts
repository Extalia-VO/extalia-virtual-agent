import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { GraphSelectedNotePanel } from '../src/knowledge/vault/GraphFilterControls';
import { GraphFocusTrail, GraphSelectionTools } from '../src/knowledge/vault/GraphSelectionTools';

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function button(tree: ReactNode, text: string) {
  const found = elements(tree).find(element => element.type === 'button' && element.props.children === text);
  if (!found) throw new Error(`No button ${text}`);
  return found.props as { onClick: () => void; 'aria-pressed'?: boolean };
}

describe('graph note focus navigation', () => {
  const t = MESSAGES.en;
  const k = t.knowledge.vaultGraph;

  it('offers immediate selected-note focus without opening appearance controls', () => {
    const onFocus = vi.fn(), onClose = vi.fn();
    const tree = GraphSelectionTools({ t, title: '<literal title>', focused: false, onFocus, onClose });
    button(tree, k.focusSelected).onClick();
    expect(onFocus).toHaveBeenCalledOnce();
    button(tree, k.closeFilteredNote).onClick();
    expect(onClose).toHaveBeenCalledOnce();
    const html = renderToStaticMarkup(tree);
    expect(html).toContain(k.focusSelected);
    expect(html).toContain('&lt;literal title&gt;');
    expect(html).not.toContain('<literal title>');
    expect(button(tree, k.focusSelected)['aria-pressed']).toBe(false);
    expect(button(GraphSelectionTools({ t, title: 'Note', focused: true, onFocus, onClose }), k.focusSelected)['aria-pressed']).toBe(true);
  });

  it('shows active focus, depth and clear actions independently of the selected note panel', () => {
    const onClear = vi.fn(), onHops = vi.fn();
    const tree = GraphFocusTrail({ t, status: 'active', rootTitle: 'Source note', hops: 2, onClear, onHops });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain(k.focusOn('Source note'));
    expect(html).toContain(`aria-label="${k.focusDepth}"`);
    expect(button(tree, k.focusHops(2))['aria-pressed']).toBe(true);
    button(tree, k.focusHops(3)).onClick();
    expect(onHops).toHaveBeenCalledExactlyOnceWith(3);
    button(tree, k.clearFocus).onClick();
    expect(onClear).toHaveBeenCalledOnce();
  });

  for (const language of ['en', 'id'] as const) it(`keeps filtered/missing focus recoverable without stale title leakage in ${language}`, () => {
    const messages = MESSAGES[language], labels = messages.knowledge.vaultGraph;
    for (const status of ['filtered', 'missing'] as const) {
      const onClear = vi.fn();
      const tree = GraphFocusTrail({ t: messages, status, rootTitle: 'HIDDEN-NOTE-TITLE', hops: 1, onHops: () => undefined, onClear });
      const html = renderToStaticMarkup(tree);
      expect(html).not.toContain('HIDDEN-NOTE-TITLE');
      expect(html).toContain(status === 'filtered' ? labels.focusFilteredNote : labels.focusMissingNote);
      button(tree, labels.clearFocus).onClick();
      expect(onClear).toHaveBeenCalledOnce();
    }
  });

  it('does not mount a hidden selected note or its quick-focus action', () => {
    const onClose = vi.fn();
    const children = createElement('div', null, createElement(GraphSelectionTools, { t, title: 'HIDDEN-TITLE', focused: false, onFocus: () => undefined, onClose }), 'HIDDEN-CONTENT');
    const tree = GraphSelectedNotePanel({ t, visible: false, onClose, children });
    const html = renderToStaticMarkup(tree);
    expect(html).toContain(k.selectedFiltered);
    expect(html).not.toContain('HIDDEN-TITLE');
    expect(html).not.toContain('HIDDEN-CONTENT');
    expect(html).not.toContain(k.focusSelected);
    button(tree, k.closeFilteredNote).onClick();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('omits the trail when focus is off', () => {
    expect(GraphFocusTrail({ t, status: 'none', rootTitle: 'STALE', hops: 1, onHops: () => undefined, onClear: () => undefined })).toBeNull();
  });
});
