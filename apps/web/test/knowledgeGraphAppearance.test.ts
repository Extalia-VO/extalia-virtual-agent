import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Select } from '../src/ui/Select';
import { MESSAGES } from '../src/i18n';
import { GraphAppearanceControls } from '../src/knowledge/vault/GraphAppearanceControls';
import { graphAppearance, GRAPH_PRESETS, type GraphAppearance } from '../src/knowledge/vault/graphAppearance';
import { graphBackdrop } from '../src/knowledge/vault/graphTheme';
import { GRAPH_GALAXY_BACKDROP } from '../src/knowledge/vault/graphReferenceStyle';
import { graphEdgeColour, graphEdgeOpacity } from '../src/knowledge/vault/graphVisualStyle';

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

describe('graph appearance controls', () => {
  it('keeps the preset selection consistent with external values and manual tuning', () => {
    const onChange = vi.fn();
    const select = (value: GraphAppearance) => elements(GraphAppearanceControls({ t: MESSAGES.en, value, onChange })).find(element => element.type === Select)!;
    expect(select(GRAPH_PRESETS.minimal).props.value).toBe('minimal');
    expect(select({ ...GRAPH_PRESETS.minimal, glow: .35 }).props.value).toBe('');
    (select({ ...GRAPH_PRESETS.minimal, showLinks: false }).props.onChange as (value: string) => void)('nebula');
    expect(onChange).toHaveBeenCalledExactlyOnceWith(GRAPH_PRESETS.nebula);
    expect(onChange.mock.calls[0]![0]).not.toBe(GRAPH_PRESETS.nebula);
  });
  it('quiets dense paths with transparency without changing endpoint hues', () => {
    const colour = [.25, .5, 1];
    for (const light of [true, false]) {
      const sparse = graphEdgeOpacity(light, .24, 76, 'normal');
      const dense = graphEdgeOpacity(light, .24, 4000, 'normal');
      expect(dense).toBeGreaterThan(0); expect(dense).toBeLessThan(sparse * .4);
      expect(graphEdgeOpacity(light, .24, 4000, 'focus')).toBeGreaterThan(dense);
      expect(graphEdgeOpacity(light, .24, 4000, 'muted')).toBeLessThan(dense);
      for (const emphasis of ['normal', 'focus', 'muted'] as const) expect(graphEdgeOpacity(light, 0, 4000, emphasis)).toBe(0);
      expect(graphEdgeColour(colour, light)[2]).toBeGreaterThan(graphEdgeColour(colour, light)[0]!);
    }
  });
  it('uses the reference dark backdrop across materials while preserving the light canvas tint', () => {
    const light = graphBackdrop('#eef2f7', true);
    const dark = graphBackdrop('#1e1f22', false);
    const blue = graphBackdrop('#050d16', false);
    expect(light).toBe('#eef2f7');
    expect(dark).toBe(GRAPH_GALAXY_BACKDROP);
    expect(blue).toBe(dark);
    expect(graphBackdrop('unsupported', false)).toBe(GRAPH_GALAXY_BACKDROP);
    expect(graphBackdrop('unsupported', true)).toBe(light);
    expect(graphBackdrop('#fff5e8', true)).not.toBe(light);
  });
  it('bounds every drawing value and rejects non-finite inputs', () => {
    expect(graphAppearance({ nodeSize: Number.NaN, labelSize: 2, glow: Infinity, linkWidth: 900, linkOpacity: -4 })).toMatchObject({
      nodeSize: GRAPH_PRESETS.nebula.nodeSize, labelSize: 12, glow: GRAPH_PRESETS.nebula.glow, linkWidth: 3, linkOpacity: 0,
    });
    expect(graphAppearance({ labelSize: Infinity }).labelSize).toBe(14);
    expect(graphAppearance({ labelSize: 40 }).labelSize).toBe(24);
    expect(graphAppearance()).toEqual(GRAPH_PRESETS.nebula);
  });
  it('keeps focused paths soft and obeys opacity tuning even in a dense graph', () => {
    for (const light of [true, false]) {
      const normal = graphEdgeOpacity(light, .19, 2000, 'normal');
      const focus = graphEdgeOpacity(light, .19, 2000, 'focus');
      expect(focus).toBeGreaterThan(normal * 1.8);
      expect(focus).toBeLessThan(.75);
      expect(graphEdgeOpacity(light, .19, 2000, 'muted')).toBeLessThan(normal / 2);
      expect(graphEdgeOpacity(light, .05, 2000, 'focus')).toBeLessThan(focus);
    }
  });
  for (const language of ['en', 'id'] as const) it(`labels all appearance controls in ${language}`, () => {
    const t = MESSAGES[language];
    const html = renderToStaticMarkup(createElement(GraphAppearanceControls, { t, value: GRAPH_PRESETS.nebula, onChange: () => undefined }));
    for (const label of [t.knowledge.vaultGraph.nodeSize, t.knowledge.vaultGraph.labelSize, t.knowledge.vaultGraph.glowStrength, t.knowledge.vaultGraph.linkWidth,
      t.knowledge.vaultGraph.linkOpacity, t.knowledge.vaultGraph.showLinks, t.knowledge.vaultGraph.presets.nebula]) expect(html).toContain(label);
    expect(html.match(/type="range"/g)).toHaveLength(5);
    expect(html).toContain('type="checkbox"');
  });
});
