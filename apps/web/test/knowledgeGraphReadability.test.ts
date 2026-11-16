import type { KnowledgeOverviewNode } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { graphViewportInsets, minimumNodeScreenRadius, nodeScreenRadius, placeGraphLabels, prepareVaultGraph, readableLabelCandidates, QUALITY_TIERS, updateQuality,
  type GraphLabelCandidate } from '../src/knowledge/vault/vaultGraphModel';

const node = (index: number): KnowledgeOverviewNode => ({ nodeId: `node-${index}`, title: `Knowledge ${index}`, path: `Notes/${index}.md`, folder: 'Notes', tags: [],
  degree: 0, inDegree: 0, outDegree: 0, modifiedAt: '2026-11-16T00:00:00.000Z' });
const label = (index: number, x: number, y: number, patch: Partial<GraphLabelCandidate> = {}): GraphLabelCandidate => ({
  index, x, y, width: 150, height: 26, radius: 5, priority: 'context', ...patch,
});
const overlaps = (a: { left: number; top: number; width: number; height: number }, b: { left: number; top: number; width: number; height: number }) =>
  a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;

describe('readable graph screen-space presentation', () => {
  it('keeps normal nodes at nine CSS pixels across fit depths, with larger hubs and selection', () => {
    const normal = minimumNodeScreenRadius(0, 100, false);
    const hub = minimumNodeScreenRadius(100, 100, false);
    const selected = minimumNodeScreenRadius(0, 100, true);
    expect(normal * 2).toBe(9);
    expect(hub).toBeGreaterThan(normal);
    expect(selected).toBeGreaterThan(hub);
    for (const pixelsPerWorldUnit of [.001, .1, 1, 100]) {
      expect(nodeScreenRadius(1.2, pixelsPerWorldUnit, normal) * 2).toBeGreaterThanOrEqual(9);
      expect(nodeScreenRadius(1.2, pixelsPerWorldUnit, hub)).toBeGreaterThanOrEqual(hub);
      expect(nodeScreenRadius(2, pixelsPerWorldUnit, selected)).toBeLessThanOrEqual(selected * 1.8);
      expect(nodeScreenRadius(0, pixelsPerWorldUnit, selected)).toBe(0);
    }
  });

  it('prioritizes current notes and actual neighbors before hubs, without revealing hidden neighbors', () => {
    const nodes = Array.from({ length: 6 }, (_, index) => node(index));
    const graph = prepareVaultGraph({ generation: 1, totalNodes: 6, totalEdges: 4, truncated: false, nodes,
      edges: [0, 1, 2, 3].map(index => ({ source: `node-${index}`, target: 'node-4', type: 'links_to' })) });
    const mask = Uint8Array.of(1, 0, 1, 1, 1, 1);
    const candidates = readableLabelCandidates(graph, mask, [0], true);
    expect(candidates[0]).toBe(0);
    expect(candidates[1]).toBe(4);
    expect(candidates).not.toContain(1);
    expect(readableLabelCandidates(graph, mask, [0], false)).toEqual([0]);
  });

  it('places a dense 263-note overview deterministically with bounded readable nonoverlapping labels', () => {
    const candidates = Array.from({ length: 263 }, (_, index) => label(index, 48 + index % 18 * 74, 42 + Math.floor(index / 18) * 53));
    const desktop = placeGraphLabels(candidates, { width: 1440, height: 900 }, 48);
    expect(desktop.length).toBe(48);
    expect(placeGraphLabels(candidates, { width: 1440, height: 900 }, 48)).toEqual(desktop);
    for (const [index, box] of desktop.entries()) {
      expect(box.left).toBeGreaterThanOrEqual(8);
      expect(box.top).toBeGreaterThanOrEqual(8);
      expect(box.left + box.width).toBeLessThanOrEqual(1432);
      expect(box.top + box.height).toBeLessThanOrEqual(892);
      for (const other of desktop.slice(index + 1)) expect(overlaps(box, other)).toBe(false);
    }
    const phone = placeGraphLabels(candidates.map(candidate => ({ ...candidate, x: candidate.x / 4, y: candidate.y / 2 })), { width: 390, height: 500 }, 16);
    expect(phone.length).toBeGreaterThanOrEqual(8);
    expect(phone.length).toBeLessThanOrEqual(16);
    for (const box of phone) expect(box.left + box.width).toBeLessThanOrEqual(382);
  });

  it('reserves collision-free space for focused notes and neighbors before overview text, including edge notes', () => {
    const candidates = [label(0, 200, 200), label(1, 200, 200, { priority: 'neighbor' }),
      label(2, 200, 200, { priority: 'focus' }), label(3, 2, 2, { priority: 'focus', width: 260 })];
    const placed = placeGraphLabels(candidates, { width: 600, height: 400 }, 3);
    expect(placed.map(candidate => candidate.index)).toEqual([2, 3, 1]);
    for (const [index, box] of placed.entries()) for (const other of placed.slice(index + 1)) expect(overlaps(box, other)).toBe(false);
  });

  it('keeps labels outside top and bottom graph controls even at phone width', () => {
    const placed = placeGraphLabels([label(0, 3, 3, { priority: 'focus', width: 260 }), label(1, 380, 485)],
      { width: 390, height: 500 }, 16, graphViewportInsets(390));
    expect(placed).toHaveLength(2);
    expect(graphViewportInsets(900)).toEqual({ top: 64, bottom: 54 });
    for (const box of placed) {
      expect(box.top).toBeGreaterThanOrEqual(132);
      expect(box.top + box.height).toBeLessThanOrEqual(446);
      expect(box.left + box.width).toBeLessThanOrEqual(382);
    }
  });

  it('retains overview labels after repeated slow windows rather than dropping them forever in demand mode', () => {
    let quality = { tier: 0, slow: 0, fast: 0 };
    for (let window = 0; window < 4; window++) quality = updateQuality(quality, 25);
    expect(quality.tier).toBe(QUALITY_TIERS.length - 1);
    expect(QUALITY_TIERS[quality.tier]!.hubLabels).toBeGreaterThanOrEqual(8);
  });
});
