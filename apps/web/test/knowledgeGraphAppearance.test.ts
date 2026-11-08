import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Select } from '../src/ui/Select';
import { MESSAGES } from '../src/i18n';
import { GraphAppearanceControls } from '../src/knowledge/vault/GraphAppearanceControls';
import { graphAppearance, GRAPH_PRESETS, type GraphAppearance } from '../src/knowledge/vault/graphAppearance';
import { graphBackdrop } from '../src/knowledge/vault/graphTheme';
import { GRAPH_GALAXY_BACKDROP } from '../src/knowledge/vault/graphReferenceStyle';
import { graphEdgeColour } from '../src/knowledge/vault/graphVisualStyle';

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
  it('keeps a dense web quieter than sparse paths while preserving focused and hidden links', () => {
    const colour = [.25, .5, 1], background = [.003, .003, .006];
    const edge = (count: number, emphasis: 'normal' | 'focus' | 'muted', opacity = .24) => graphEdgeColour(colour, colour, background, false, opacity, count, emphasis);
    const sparse = edge(76, 'normal'), dense = edge(4000, 'normal');
    for (let i = 0; i < 3; i++) {
      expect(dense[i]!).toBeGreaterThan(background[i]!);
      expect(dense[i]!).toBeLessThan(sparse[i]! * .4);
      expect(edge(4000, 'focus')[i]!).toBeGreaterThan(dense[i]!);
      expect(edge(4000, 'muted')[i]!).toBeLessThan(dense[i]!);
    }
    expect(edge(4000, 'normal', 0)).toEqual(background);
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
    expect(graphAppearance({ nodeSize: Number.NaN, glow: Infinity, linkWidth: 900, linkOpacity: -4 })).toMatchObject({
      nodeSize: GRAPH_PRESETS.nebula.nodeSize, glow: GRAPH_PRESETS.nebula.glow, linkWidth: 3, linkOpacity: .01,
    });
  });
  for (const language of ['en', 'id'] as const) it(`labels all appearance controls in ${language}`, () => {
    const t = MESSAGES[language];
    const html = renderToStaticMarkup(createElement(GraphAppearanceControls, { t, value: GRAPH_PRESETS.nebula, onChange: () => undefined }));
    for (const label of [t.knowledge.vaultGraph.nodeSize, t.knowledge.vaultGraph.glowStrength, t.knowledge.vaultGraph.linkWidth,
      t.knowledge.vaultGraph.linkOpacity, t.knowledge.vaultGraph.showLinks, t.knowledge.vaultGraph.presets.nebula]) expect(html).toContain(label);
    expect(html.match(/type="range"/g)).toHaveLength(4);
    expect(html).toContain('type="checkbox"');
  });
});
