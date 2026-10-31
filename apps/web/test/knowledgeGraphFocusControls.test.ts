import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { GraphFocusControls, type GraphFocusControlsProps } from '../src/knowledge/vault/GraphFocusControls';

const props = (patch: Partial<GraphFocusControlsProps> = {}): GraphFocusControlsProps => ({
  t: MESSAGES.en, selectedTitle: null, rootTitle: null, status: 'none', hops: 1,
  onFocus: vi.fn(), onClear: vi.fn(), onHops: vi.fn(), ...patch,
});
const render = (patch: Partial<GraphFocusControlsProps> = {}) => renderToStaticMarkup(createElement(GraphFocusControls, props(patch)));

describe('neighbourhood focus controls', () => {
  it('explains selection before enabling focus, without offering a fake active neighbourhood', () => {
    const html = render();
    expect(html).toContain('disabled=""');
    expect(html).toContain(MESSAGES.en.knowledge.vaultGraph.focusHint);
    expect(html).not.toContain(MESSAGES.en.knowledge.vaultGraph.clearFocus);
    const selected = render({ selectedTitle: 'Plan' });
    expect(selected).not.toContain('disabled=""');
    expect(selected).toContain(MESSAGES.en.knowledge.vaultGraph.focusSelectedTitle('Plan'));
  });

  it('keeps the rooted status separate from another selected note and exposes bounded depth', () => {
    const html = render({ selectedTitle: 'Other note', rootTitle: 'Plan', status: 'active', hops: 2 });
    expect(html).toContain(MESSAGES.en.knowledge.vaultGraph.focusOn('Plan'));
    expect(html).toContain(MESSAGES.en.knowledge.vaultGraph.focusSelectedTitle('Other note'));
    expect(html).toMatch(/aria-pressed="true"[^>]*>2 hops</);
    expect(html).toContain('1 hop');
    expect(html).toContain('3 hops');
    expect(html).not.toContain('4 hops');
    expect(html).toContain(MESSAGES.en.knowledge.vaultGraph.clearFocus);
  });

  it('keeps a clear action available for missing/filtered roots and escapes note titles', () => {
    for (const status of ['missing', 'filtered'] as const) {
      const html = render({ rootTitle: '<img src=x>', status });
      const message = status === 'missing' ? MESSAGES.en.knowledge.vaultGraph.focusMissing : MESSAGES.en.knowledge.vaultGraph.focusFiltered;
      expect(html).toContain(message('&lt;img src=x&gt;'));
      expect(html).not.toContain('<img');
      expect(html).toContain(MESSAGES.en.knowledge.vaultGraph.clearFocus);
      expect(html).toContain('role="status"');
    }
  });

  it('renders the same controls and explanations in Indonesian', () => {
    const k = MESSAGES.id.knowledge.vaultGraph;
    const html = render({ t: MESSAGES.id, rootTitle: 'Plan', status: 'filtered', hops: 3 });
    expect(html).toContain(k.focusFiltered('Plan'));
    expect(html).toContain(k.clearFocus);
    expect(html).toContain(k.focusDepth);
    expect(html).toMatch(/aria-pressed="true"[^>]*>3 langkah</);
  });
});
