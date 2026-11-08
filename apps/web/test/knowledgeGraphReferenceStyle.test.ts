import { Color, NormalBlending } from 'three';
import { describe, expect, it } from 'vitest';
import { createGraphNodeMaterial } from '../src/knowledge/vault/graphNodeMaterial';
import { GRAPH_GALAXY_BACKDROP, GRAPH_GALAXY_PALETTE, GRAPH_STAR_CORE_RATIO, graphStarHaloOpacity } from '../src/knowledge/vault/graphReferenceStyle';
import { graphEdgeColour } from '../src/knowledge/vault/graphVisualStyle';

describe('reference graph style', () => {
  it('keeps the halo faint at its rim and progressively brighter toward the compact core', () => {
    const samples = Array.from({ length: 101 }, (_, index) => graphStarHaloOpacity(index / 100));
    expect(samples[0]).toBeGreaterThan(.3);
    expect(samples[0]).toBeLessThan(.5);
    expect(graphStarHaloOpacity(GRAPH_STAR_CORE_RATIO)).toBe(samples[0]);
    expect(graphStarHaloOpacity(.99)).toBeGreaterThan(0);
    expect(graphStarHaloOpacity(.99)).toBeLessThan(.02);
    expect(samples.at(-1)).toBe(0);
    for (let index = 1; index < samples.length; index++) expect(samples[index]!).toBeLessThanOrEqual(samples[index - 1]!);
    for (const radius of [-1, 1, 2, Number.NaN, Infinity]) expect(graphStarHaloOpacity(radius)).toBe(0);
  });

  it('composites overlapping halo layers instead of making them opaque or summing their alpha', () => {
    // At radius .91 only the outer two upstream fills overlap (.012 and .021).
    expect(graphStarHaloOpacity(.91)).toBeCloseTo(1 - (1 - .012) * (1 - .021));
    expect(graphStarHaloOpacity(.91)).toBeLessThan(.012 + .021);
  });

  it('keeps categorical colours distinct and visible against the galaxy backdrop', () => {
    const backdrop = new Color(GRAPH_GALAXY_BACKDROP);
    expect(new Set(GRAPH_GALAXY_PALETTE).size).toBe(GRAPH_GALAXY_PALETTE.length);
    const luminance = (color: Color) => .2126 * color.r + .7152 * color.g + .0722 * color.b;
    for (const hex of GRAPH_GALAXY_PALETTE) {
      const colour = new Color(hex);
      expect((luminance(colour) + .05) / (luminance(backdrop) + .05)).toBeGreaterThan(3);
      expect(Math.max(colour.r, colour.g, colour.b) - Math.min(colour.r, colour.g, colour.b)).toBeGreaterThan(.35);
    }
  });

  for (const light of [false, true]) it(`follows endpoint colours and preserves local focus in ${light ? 'light' : 'dark'} mode`, () => {
    const background = light ? [.9, .92, .95] : [.003, .003, .006];
    const first = [1, 0, 0], second = [0, .2, 1];
    const edge = (emphasis: 'normal' | 'focus' | 'muted', opacity = .24) => graphEdgeColour(first, second, background, light, opacity, 1000, emphasis);
    const normal = edge('normal');
    const end = graphEdgeColour(second, first, background, light, .24, 1000, 'normal');
    expect(normal[0]).toBeGreaterThan(end[0]!);
    expect(end[2]).toBeGreaterThan(normal[2]!);
    expect(graphEdgeColour(first, first, background, light, .24, 1000, 'normal')).toEqual(normal);
    const midpoint = normal.map((value, index) => (value + end[index]!) / 2);
    expect(midpoint[0]).toBeGreaterThan(end[0]!);
    expect(midpoint[2]).toBeGreaterThan(normal[2]!);
    expect(edge('normal', 0)).toEqual(background);
    const distance = (rgb: readonly number[]) => Math.hypot(...rgb.map((value, index) => value - background[index]!));
    expect(distance(edge('focus'))).toBeGreaterThan(distance(normal));
    expect(distance(edge('muted'))).toBeLessThan(distance(normal));
  });

  for (const light of [false, true]) it(`keeps sparse paths visible without overpowering focused links in ${light ? 'light' : 'dark'} mode`, () => {
    const backgroundColour = new Color(light ? '#eef2f7' : GRAPH_GALAXY_BACKDROP);
    const background = [backgroundColour.r, backgroundColour.g, backgroundColour.b];
    const luminance = (rgb: readonly number[]) => .2126 * rgb[0]! + .7152 * rgb[1]! + .0722 * rgb[2]!;
    const contrast = (rgb: readonly number[]) => (Math.max(luminance(rgb), luminance(background)) + .05) / (Math.min(luminance(rgb), luminance(background)) + .05);
    const edge = (emphasis: 'normal' | 'focus' | 'muted') => graphEdgeColour([1, 0, 0], [0, 0, 1], background, light, .24, 76, emphasis);
    const baseline = contrast(edge('normal'));
    expect(baseline).toBeGreaterThan(light ? 1.9 : 1.8);
    if (!light) expect(baseline).toBeLessThan(3);
    expect(contrast(edge('focus'))).toBeGreaterThan(baseline);
    expect(contrast(edge('muted'))).toBeLessThan(baseline);
  });

  it('keeps core depth occlusion and independent Three fog uniforms while halos remain separate', () => {
    const first = createGraphNodeMaterial(), second = createGraphNodeMaterial();
    try {
      expect(first.blending).toBe(NormalBlending);
      expect(first.depthWrite).toBe(true);
      expect(first.depthTest).toBe(true);
      expect(first.fog).toBe(true);
      expect(first.toneMapped).toBe(false);
      for (const uniform of ['fogColor', 'fogNear', 'fogFar', 'uLight', 'uViewportHeight']) expect(first.uniforms[uniform]).toBeDefined();
      first.uniforms.fogColor!.value.set('#ff0000');
      expect(first.uniforms.fogColor!.value).not.toEqual(second.uniforms.fogColor!.value);
    } finally { first.dispose(); second.dispose(); }
  });
});
