import { Color, NormalBlending } from 'three';
import { describe, expect, it } from 'vitest';
import { createGraphNodeMaterial } from '../src/knowledge/vault/graphNodeMaterial';
import { GRAPH_GALAXY_BACKDROP, GRAPH_GALAXY_PALETTE, GRAPH_STAR_CORE_RATIO, graphStarHaloOpacity } from '../src/knowledge/vault/graphReferenceStyle';
import { graphEdgeColour, graphEdgeOpacity } from '../src/knowledge/vault/graphVisualStyle';

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

  for (const light of [false, true]) it(`retains saturated endpoint gradients with independent transparency in ${light ? 'light' : 'dark'} mode`, () => {
    const first = graphEdgeColour([1, 0, 0], light), second = graphEdgeColour([0, .2, 1], light);
    expect(first[0]).toBeGreaterThan(second[0]! + .5);
    expect(second[2]).toBeGreaterThan(first[2]! + .5);
    const midpoint = first.map((value, index) => (value + second[index]!) / 2);
    expect(midpoint[0]).toBeGreaterThan(second[0]!); expect(midpoint[2]).toBeGreaterThan(first[2]!);
    const normal = graphEdgeOpacity(light, .24, 1000, 'normal');
    expect(graphEdgeOpacity(light, .24, 1000, 'focus')).toBeGreaterThan(normal);
    expect(graphEdgeOpacity(light, .24, 1000, 'muted')).toBeLessThan(normal);
    expect(graphEdgeOpacity(light, 0, 1000, 'focus')).toBe(0);
  });

  for (const light of [false, true]) it(`keeps sparse paths visible but softer than focus in ${light ? 'light' : 'dark'} mode`, () => {
    const canvas = new Color(light ? '#eef2f7' : GRAPH_GALAXY_BACKDROP);
    const background = [canvas.r, canvas.g, canvas.b];
    const luminance = (rgb: readonly number[]) => .2126 * rgb[0]! + .7152 * rgb[1]! + .0722 * rgb[2]!;
    const contrast = (emphasis: 'normal' | 'focus' | 'muted') => {
      const alpha = graphEdgeOpacity(light, .24, 76, emphasis), colour = graphEdgeColour([1, 0, 0], light);
      const mixed = colour.map((value, index) => value * alpha + background[index]! * (1 - alpha));
      return (Math.max(luminance(mixed), luminance(background)) + .05) / (Math.min(luminance(mixed), luminance(background)) + .05);
    };
    const normal = contrast('normal');
    expect(normal).toBeGreaterThan(light ? 1.15 : 1.5);
    expect(normal).toBeLessThan(3);
    expect(contrast('focus')).toBeGreaterThan(normal);
    expect(contrast('muted')).toBeLessThan(normal);
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
