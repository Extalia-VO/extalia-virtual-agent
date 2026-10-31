import type { KnowledgeOverview, KnowledgeOverviewNode } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { focusGraph, visibleColourLegend, visibleLinkCount, type FocusHops } from '../src/knowledge/vault/graphFocus';
import { assignColours, GRAPH_OTHER_COLOUR, GRAPH_PALETTE, prepareVaultGraph, type VaultGraph } from '../src/knowledge/vault/vaultGraphModel';

function note(nodeId: string, patch: Partial<KnowledgeOverviewNode> = {}): KnowledgeOverviewNode {
  return { nodeId, title: nodeId, path: `${nodeId}.md`, folder: '', tags: [], degree: 0, inDegree: 0, outDegree: 0, modifiedAt: '2026-10-24T00:00:00Z', ...patch };
}
function overview(nodes: KnowledgeOverviewNode[], edges: [string, string][]): KnowledgeOverview {
  return { generation: 1, nodes, edges: edges.map(([source, target]) => ({ source, target, type: 'links_to' })), totalNodes: nodes.length, totalEdges: edges.length, truncated: false };
}
function visibleIds(graph: VaultGraph, mask: Uint8Array): string[] {
  return graph.nodes.filter((_, index) => mask[index] === 1).map(node => node.nodeId).sort();
}

describe('vault graph neighbourhood focus', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e', 'island', 'same-folder'].map(id => note(id, { folder: 'Shared', tags: ['same-tag'] }));
  const edges: [string, string][] = [['b', 'a'], ['b', 'c'], ['c', 'a'], ['c', 'd'], ['d', 'e']];
  const graph = prepareVaultGraph(overview(nodes, edges));
  const all = new Uint8Array(nodes.length).fill(1);

  it('walks real undirected links with shortest-path hop limits, cycles and disconnected notes', () => {
    expect(visibleIds(graph, focusGraph(graph, all, 'a', 1).mask)).toEqual(['a', 'b', 'c']);
    expect(visibleIds(graph, focusGraph(graph, all, 'a', 2).mask)).toEqual(['a', 'b', 'c', 'd']);
    expect(visibleIds(graph, focusGraph(graph, all, 'a', 3).mask)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(visibleIds(graph, focusGraph(graph, all, 'island', 3).mask)).toEqual(['island']);
    expect(focusGraph(graph, all, 'a', 1)).toMatchObject({ status: 'active', root: 0 });
  });

  it('does not cross a hidden bridge or treat any value other than 1 as visible', () => {
    const mask = all.slice();
    mask[2] = 0;
    expect(visibleIds(graph, focusGraph(graph, mask, 'a', 3).mask)).toEqual(['a', 'b']);
    mask[2] = 2;
    expect(visibleIds(graph, focusGraph(graph, mask, 'a', 3).mask)).toEqual(['a', 'b']);
  });

  it('keeps a longer visible route when a shorter route passes through a hidden note', () => {
    const route = prepareVaultGraph(overview(['root', 'hidden', 'via', 'next', 'target'].map(id => note(id)),
      [['root', 'hidden'], ['hidden', 'target'], ['root', 'via'], ['via', 'next'], ['next', 'target']]));
    const mask = Uint8Array.from([1, 0, 1, 1, 1]);
    expect(visibleIds(route, focusGraph(route, mask, 'root', 2).mask)).toEqual(['next', 'root', 'via']);
    expect(visibleIds(route, focusGraph(route, mask, 'root', 3).mask)).toEqual(['next', 'root', 'target', 'via']);
  });

  it('returns the base mask without mutation when focus is off', () => {
    const mask = Uint8Array.from([1, 0, 1, 0, 1, 0, 1]);
    expect(focusGraph(graph, mask, null, 2)).toEqual({ mask, root: null, status: 'none' });
    expect(focusGraph(graph, mask, null, 2).mask).toBe(mask);
    const before = mask.slice(), offsets = graph.offsets.slice(), adjacency = graph.adjacency.slice();
    focusGraph(graph, mask, 'a', 3);
    expect(mask).toEqual(before);
    expect(graph.offsets).toEqual(offsets);
    expect(graph.adjacency).toEqual(adjacency);
  });

  it('distinguishes a missing root from a filtered root without widening the view', () => {
    expect(focusGraph(graph, all, 'missing', 2)).toEqual({ mask: new Uint8Array(nodes.length), root: null, status: 'missing' });
    const mask = all.slice();
    mask[0] = 0;
    expect(focusGraph(graph, mask, 'a', 2)).toEqual({ mask: new Uint8Array(nodes.length), root: 0, status: 'filtered' });
    const empty = prepareVaultGraph(overview([], []));
    expect(focusGraph(empty, new Uint8Array(), 'a', 3).status).toBe('missing');
  });

  it('resolves the stable root ID after an overview reorder and after removal', () => {
    const refreshed = prepareVaultGraph(overview([...nodes].reverse(), edges));
    const result = focusGraph(refreshed, all, 'a', 2);
    expect(result.root).toBe(nodes.length - 1);
    expect(visibleIds(refreshed, result.mask)).toEqual(['a', 'b', 'c', 'd']);
    const removed = prepareVaultGraph(overview(nodes.filter(node => node.nodeId !== 'a'), edges));
    expect(focusGraph(removed, new Uint8Array(removed.nodes.length).fill(1), 'a', 2).status).toBe('missing');
  });

  it('fails closed for runtime-invalid hop values and mask sizes', () => {
    for (const hops of [0, 4, -1, 1.5, Number.NaN, Infinity, '2', null, undefined]) {
      const result = focusGraph(graph, all, 'a', hops as FocusHops);
      expect(result.mask).toEqual(new Uint8Array(nodes.length));
      expect(result.status).toBe('filtered');
    }
    for (const length of [0, nodes.length - 1, nodes.length + 1]) {
      expect(focusGraph(graph, new Uint8Array(length).fill(1), 'a', 1).mask).toEqual(new Uint8Array(nodes.length));
      expect(focusGraph(graph, new Uint8Array(length).fill(1), null, 1).status).toBe('filtered');
    }
  });

  it('uses only retained edges and notes in a truncated overview', () => {
    const capped = prepareVaultGraph(overview(['a', 'b', 'c', 'd'].map(id => note(id)), [['a', 'b'], ['b', 'c'], ['c', 'd']]), { nodes: 3, edges: 1 });
    expect(capped.truncated).toBe(true);
    const mask = new Uint8Array(capped.nodes.length).fill(1);
    expect(visibleIds(capped, focusGraph(capped, mask, 'a', 3).mask)).toEqual(['a', 'b']);
    expect(focusGraph(capped, mask, 'd', 3).status).toBe('missing');
    expect(visibleLinkCount(capped, mask)).toBe(1);
  });

  it('stays bounded at the overview limits with many cycles', () => {
    const nodes = Array.from({ length: 2_000 }, (_, index) => note(`n${index}`));
    const edges = nodes.flatMap((_, index) => [1, 2, 3, 4].map(step => [`n${index}`, `n${(index + step) % nodes.length}`] as [string, string]));
    const large = prepareVaultGraph(overview(nodes, edges));
    expect(large.edges).toHaveLength(16_000);
    const result = focusGraph(large, new Uint8Array(nodes.length).fill(1), 'n0', 3);
    expect(result.mask.reduce((sum, value) => sum + value, 0)).toBe(25);
    expect(result.mask).toHaveLength(2_000);
  });

  it('counts visible actual links once, requiring both endpoints', () => {
    expect(visibleLinkCount(graph, all)).toBe(5);
    expect(visibleLinkCount(graph, focusGraph(graph, all, 'a', 1).mask)).toBe(3);
    expect(visibleLinkCount(graph, Uint8Array.from([1, 1, 0, 1, 1, 1, 1]))).toBe(2);
    expect(visibleLinkCount(graph, new Uint8Array(nodes.length - 1).fill(1))).toBe(0);
    expect(visibleLinkCount(graph, new Uint8Array(nodes.length))).toBe(0);
  });
});

describe('visible vault graph legend', () => {
  it('retains palette, keys and group order when visible group sizes change', () => {
    const nodes = [note('a', { folder: 'A' }), note('b', { folder: 'A' }), note('c', { folder: 'A' }), note('d', { folder: 'B' }), note('e', { folder: 'B' }), note('f', { folder: 'C' })];
    const assignment = assignColours(nodes, 'folder');
    const original = structuredClone(assignment);
    const result = visibleColourLegend(assignment, Uint8Array.from([0, 0, 1, 1, 1, 0]));
    expect(result).toEqual({ legend: [{ key: 'A', colour: GRAPH_PALETTE[0], count: 1 }, { key: 'B', colour: GRAPH_PALETTE[1], count: 2 }], other: 0 });
    expect(assignment).toEqual(original);
  });

  it('keeps the original tag assignment when a subset would choose a different tag', () => {
    const nodes = [note('both', { tags: ['a', 'b'] }), note('a1', { tags: ['a'] }), note('a2', { tags: ['a'] }), note('b1', { tags: ['b'] }), note('b2', { tags: ['b'] })];
    const assignment = assignColours(nodes, 'tag');
    const mask = Uint8Array.from([1, 0, 0, 1, 1]);
    expect(assignColours(nodes.filter((_, index) => mask[index]), 'tag').legend).toHaveLength(1);
    expect(visibleColourLegend(assignment, mask)).toEqual({ legend: [{ key: 'a', colour: GRAPH_PALETTE[0], count: 1 }, { key: 'b', colour: GRAPH_PALETTE[1], count: 2 }], other: 0 });
  });

  it('counts visible overflow groups together and handles empty or mismatched masks', () => {
    const assignment = assignColours(Array.from({ length: GRAPH_PALETTE.length + 3 }, (_, index) => note(`n${index}`, { folder: `group${String(index).padStart(2, '0')}` })), 'folder');
    const mask = new Uint8Array(assignment.colours.length);
    mask[0] = 1;
    mask[GRAPH_PALETTE.length] = 1;
    mask[GRAPH_PALETTE.length + 2] = 1;
    expect(assignment.colours[GRAPH_PALETTE.length]).toBe(GRAPH_OTHER_COLOUR);
    expect(visibleColourLegend(assignment, mask)).toEqual({ legend: [{ ...assignment.legend[0]!, count: 1 }], other: 2 });
    expect(visibleColourLegend(assignment, new Uint8Array(mask.length))).toEqual({ legend: [], other: 0 });
    expect(visibleColourLegend(assignment, new Uint8Array(mask.length - 1).fill(1))).toEqual({ legend: [], other: 0 });
  });
});
