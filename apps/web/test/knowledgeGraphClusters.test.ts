import type { KnowledgeOverview, KnowledgeOverviewNode } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { visibleColourLegend } from '../src/knowledge/vault/graphFocus';
import { assignColours, graphClusters, GRAPH_PALETTE, prepareVaultGraph } from '../src/knowledge/vault/vaultGraphModel';

function node(nodeId: string): KnowledgeOverviewNode {
  return { nodeId, title: nodeId, path: `${nodeId}.md`, folder: '', tags: [], degree: 0, inDegree: 0, outDegree: 0, modifiedAt: '2026-01-01T00:00:00.000Z' };
}

function graph(ids: string[], pairs: [string, string][]) {
  const nodes = ids.map(node);
  const overview: KnowledgeOverview = {
    generation: 1,
    totalNodes: nodes.length,
    totalEdges: pairs.length,
    truncated: false,
    nodes,
    edges: pairs.map(([source, target]) => ({ source, target, type: 'links_to' })),
  };
  return prepareVaultGraph(overview);
}

const clique = (ids: string[]): [string, string][] => ids.flatMap((id, i) => ids.slice(i + 1).map(other => [id, other] as [string, string]));

describe('knowledge graph structural clusters', () => {
  it('separates two dense communities joined by a bridge', () => {
    const left = ['a', 'b', 'c', 'd', 'e'];
    const right = ['f', 'g', 'h', 'i', 'j'];
    const prepared = graph([...left, ...right], [...clique(left), ...clique(right), ['e', 'f']]);
    const labels = graphClusters(prepared);
    expect(labels).toHaveLength(prepared.nodes.length);
    expect(new Set(labels).size).toBe(2);
    expect(new Set(left.map(id => labels[prepared.indexById.get(id)!])).size).toBe(1);
    expect(new Set(right.map(id => labels[prepared.indexById.get(id)!])).size).toBe(1);
    expect(labels[prepared.indexById.get('a')!]).not.toBe(labels[prepared.indexById.get('j')!]);
  });

  it('keeps disconnected components separate and represents each isolate', () => {
    const prepared = graph(['a', 'b', 'c', 'd', 'solo1', 'solo2'], [['a', 'b'], ['c', 'd']]);
    const labels = graphClusters(prepared);
    expect(labels[prepared.indexById.get('a')!]).toBe(labels[prepared.indexById.get('b')!]);
    expect(labels[prepared.indexById.get('c')!]).toBe(labels[prepared.indexById.get('d')!]);
    expect(new Set(labels).size).toBe(4);
    expect(labels[prepared.indexById.get('solo1')!]).not.toBe(labels[prepared.indexById.get('solo2')!]);
  });

  it('is deterministic by note id under input reordering and returns finite positive labels', () => {
    const left = ['a', 'b', 'c', 'd'];
    const right = ['x', 'y', 'z', 'w'];
    const pairs = [...clique(left), ...clique(right), ['d', 'w'] as [string, string]];
    const first = graph([...left, ...right], pairs);
    const reordered = graph([...right].reverse().concat([...left].reverse()), pairs);
    const firstLabels = graphClusters(first);
    const reorderedLabels = graphClusters(reordered);
    expect(Array.from(firstLabels)).toHaveLength(first.nodes.length);
    expect(Array.from(firstLabels).every(Number.isFinite)).toBe(true);
    expect(Array.from(firstLabels).every(label => label > 0)).toBe(true);
    expect(Object.fromEntries(first.nodes.map((item, i) => [item.nodeId, firstLabels[i]])))
      .toEqual(Object.fromEntries(reordered.nodes.map((item, i) => [item.nodeId, reorderedLabels[i]])));
  });

  it('assigns cluster colors by canonical cluster label and safely handles missing graph data', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const prepared = graph(ids, [...clique(ids.slice(0, 3)), ...clique(ids.slice(3))]);
    const assignment = assignColours(prepared.nodes, 'cluster', prepared);
    expect(assignment.legend.map(group => group.key)).toEqual(['1', '2']);
    expect(assignment.colours.slice(0, 3)).toEqual(Array(3).fill(GRAPH_PALETTE[0]));
    expect(assignment.colours.slice(3)).toEqual(Array(3).fill(GRAPH_PALETTE[1]));
    const fallback = assignColours(prepared.nodes, 'cluster');
    expect(new Set(fallback.colours).size).toBe(1);
    expect(fallback.legend).toHaveLength(1);
  });

  it('cycles the palette beyond twelve clusters and counts visible groups by cluster key', () => {
    const prepared = graph(Array.from({ length: 13 }, (_, index) => `note-${String(index + 1).padStart(2, '0')}`), []);
    const assignment = assignColours(prepared.nodes, 'cluster', prepared);
    expect(assignment.keys).toHaveLength(13);
    expect(new Set(assignment.colours)).toEqual(new Set(GRAPH_PALETTE));
    expect(assignment.colours[0]).toBe(assignment.colours[12]);
    expect(assignment.legend.map(group => group.key)).toEqual(Array.from({ length: 12 }, (_, index) => String(index + 1)));
    expect(assignment.other).toBe(1);

    const onlyThirteen = visibleColourLegend(assignment, Uint8Array.from({ length: 13 }, (_, index) => index === 12 ? 1 : 0));
    expect(onlyThirteen).toEqual({ legend: [], other: 1 });
    const firstAndThirteen = visibleColourLegend(assignment, Uint8Array.from({ length: 13 }, (_, index) => index === 0 || index === 12 ? 1 : 0));
    expect(firstAndThirteen.legend).toMatchObject([{ key: '1', count: 1 }]);
    expect(firstAndThirteen.other).toBe(1);
    expect(firstAndThirteen.legend.reduce((sum, group) => sum + group.count, firstAndThirteen.other)).toBe(2);
  });
});
