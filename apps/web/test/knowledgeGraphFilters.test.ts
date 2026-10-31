import type { KnowledgeOverview, KnowledgeOverviewNode } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { EMPTY_GRAPH_FILTERS, facetFromSelect, facetSelectValue, graphFacetMask, graphFacetOptions, hasGraphFilters, visibleGraphDegrees, type GraphFacetFilters } from '../src/knowledge/vault/graphFilters';
import { focusGraph, visibleColourLegend, visibleLinkCount } from '../src/knowledge/vault/graphFocus';
import { assignColours, prepareVaultGraph, rankSearch, timeMask } from '../src/knowledge/vault/vaultGraphModel';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const note = (nodeId: string, patch: Partial<KnowledgeOverviewNode> = {}): KnowledgeOverviewNode => ({ nodeId, title: `Plan ${nodeId}`, path: `${nodeId}.md`, folder: '', tags: [], degree: 0, inDegree: 0, outDegree: 0, modifiedAt: new Date(NOW).toISOString(), ...patch });
const nodes = [
  note('root', { kind: 'knowledge', tags: ['common', 'secondary'] }),
  note('docs', { folder: 'Docs', kind: 'knowledge', tags: ['common', 'secondary'] }),
  note('child', { folder: 'Docs/Sub', kind: 'knowledge', tags: ['secondary'] }),
  note('bridge', { folder: 'Docs', kind: 'bridge', tags: ['common'] }),
  note('target', { folder: 'Docs', kind: 'knowledge', tags: ['secondary'] }),
  note('old', { folder: 'Docs', kind: 'knowledge', tags: ['secondary'], modifiedAt: new Date(NOW - 40 * 86_400_000).toISOString() }),
];
const overview = (notes = nodes): KnowledgeOverview => ({ generation: 1, nodes: notes, edges: [['root', 'docs'], ['docs', 'bridge'], ['bridge', 'target'], ['docs', 'child'], ['docs', 'old']].map(([source, target]) => ({ source: source!, target: target!, type: 'links_to' })), totalNodes: notes.length, totalEdges: 5, truncated: false });
const graph = prepareVaultGraph(overview());
const filters = (patch: Partial<GraphFacetFilters> = {}): GraphFacetFilters => ({ ...EMPTY_GRAPH_FILTERS, ...patch });
const ids = (mask: Uint8Array, notes = graph.nodes) => notes.filter((_, index) => mask[index] === 1).map(node => node.nodeId);

describe('explicit vault graph facets', () => {
  it('distinguishes all from exact root and uses exact folders without descendants', () => {
    expect(ids(graphFacetMask(graph.nodes, filters()))).toEqual(nodes.map(node => node.nodeId));
    expect(ids(graphFacetMask(graph.nodes, filters({ folder: null })))).toEqual(['root']);
    expect(ids(graphFacetMask(graph.nodes, filters({ folder: 'Docs' })))).toEqual(['docs', 'bridge', 'target', 'old']);
    expect(ids(graphFacetMask(graph.nodes, filters({ folder: 'docs' })))).toEqual([]);
  });

  it('round-trips native select values without colliding with All or literal prefixes', () => {
    for (const facet of ['folder', 'kind', 'tag'] as const) for (const value of ['', null, 'Docs/Sub', `${facet}:`, '日本語', '<note>']) {
      expect(facetFromSelect(facetSelectValue(value, facet), facet)).toBe(value);
    }
    expect(facetSelectValue(null, 'folder')).not.toBe(facetSelectValue('', 'folder'));
    expect(facetFromSelect('kind:knowledge', 'folder')).toBeUndefined();
  });

  it('supports exact no-kind and untagged choices independently from unrestricted filters', () => {
    const notes = [note('absent'), note('kind-only', { kind: 'knowledge' }), note('tag-only', { tags: ['x'] }), note('both', { kind: 'knowledge', tags: ['x'] })];
    expect(graphFacetOptions(notes)).toEqual({ folders: [''], kinds: ['', 'knowledge'], tags: ['', 'x'] });
    expect(ids(graphFacetMask(notes, filters({ kind: null })), notes)).toEqual(['absent', 'tag-only']);
    expect(ids(graphFacetMask(notes, filters({ tag: null })), notes)).toEqual(['absent', 'kind-only']);
    expect(ids(graphFacetMask(notes, filters({ kind: null, tag: null })), notes)).toEqual(['absent']);
  });

  it('matches secondary actual tags even when colour assigns a different representative tag', () => {
    const notes = [note('both', { tags: ['common', 'secondary'] }), ...[1, 2, 3].map(n => note(`common${n}`, { tags: ['common'] }))];
    const colours = assignColours(notes, 'tag');
    expect(colours.legend[0]!.key).toBe('common');
    expect(ids(graphFacetMask(notes, filters({ tag: 'secondary' })), notes)).toEqual(['both']);
    expect(graphFacetOptions(notes).tags).toEqual(['common', 'secondary']);
  });

  it('ANDs dimensions and intersects time before focus traverses visible edges', () => {
    const selected = filters({ folder: 'Docs', kind: 'knowledge', tag: 'secondary' });
    expect(ids(graphFacetMask(graph.nodes, selected))).toEqual(['docs', 'target', 'old']);
    const time = timeMask(graph.nodes, '1d', NOW), before = time.slice();
    const base = graphFacetMask(graph.nodes, selected, time);
    expect(ids(base)).toEqual(['docs', 'target']); expect(time).toEqual(before);
    const focus = focusGraph(graph, base, 'docs', 3);
    expect(ids(focus.mask)).toEqual(['docs']); expect(focus.status).toBe('active');
    // Target is two edges away, but its hidden bridge cannot connect it.
    expect(focus.mask[graph.indexById.get('target')!]).toBe(0);
  });

  it('keeps missing and filtered focus roots explicit instead of resetting to the full graph', () => {
    const base = graphFacetMask(graph.nodes, filters({ tag: 'missing' }));
    expect(focusGraph(graph, base, 'docs', 2).status).toBe('filtered');
    expect(focusGraph(graph, base, 'removed-root', 2).status).toBe('missing');
    expect(ids(focusGraph(graph, base, 'docs', 2).mask)).toEqual([]);
  });

  it('derives stable sorted options from all retained nodes, never from filtered or focused matches', () => {
    const before = structuredClone(nodes);
    const options = graphFacetOptions(graph.nodes);
    expect(options).toEqual({ folders: ['', 'Docs', 'Docs/Sub'], kinds: ['bridge', 'knowledge'], tags: ['common', 'secondary'] });
    graphFacetMask(graph.nodes, filters({ folder: 'Docs/Sub' }));
    expect(graphFacetOptions([...graph.nodes].reverse())).toEqual(options);
    expect(nodes).toEqual(before);
  });

  it('retains missing selected facet values after refresh and clearing an empty result restores the graph', () => {
    const selected = filters({ folder: 'Removed', kind: 'removed-kind', tag: 'removed-tag' });
    const before = { ...selected }, refreshed = [note('fresh')];
    expect(ids(graphFacetMask(refreshed, selected), refreshed)).toEqual([]);
    expect(selected).toEqual(before); expect(hasGraphFilters(selected)).toBe(true);
    expect(graphFacetOptions(refreshed)).toEqual({ folders: [''], kinds: [''], tags: [''] });
    expect(ids(graphFacetMask(refreshed, filters()), refreshed)).toEqual(['fresh']);
    expect(hasGraphFilters(filters({ folder: null }))).toBe(true); expect(hasGraphFilters(filters())).toBe(false);
    expect(graphFacetMask([], selected)).toEqual(new Uint8Array());
  });

  it('uses the final mask consistently for search, list hubs, counts, links, legend and selected visibility', () => {
    const colours = assignColours(graph.nodes, 'folder'), original = structuredClone(colours);
    const mask = focusGraph(graph, graphFacetMask(graph.nodes, filters({ folder: 'Docs', kind: 'knowledge', tag: 'secondary' }), timeMask(graph.nodes, '1d', NOW)), null, 1).mask;
    expect(rankSearch(graph, 'Plan', 50, mask).map(index => graph.nodes[index]!.nodeId).sort()).toEqual(['docs', 'target']);
    expect(graph.hubs.filter(index => mask[index] === 1).map(index => graph.nodes[index]!.nodeId)).toEqual(['docs', 'target']);
    expect(mask.reduce((sum, value) => sum + value, 0)).toBe(2); expect(visibleLinkCount(graph, mask)).toBe(0);
    expect(Array.from(visibleGraphDegrees(graph, mask))).toEqual(new Array(nodes.length).fill(0));
    expect(visibleColourLegend(colours, mask).legend).toEqual([{ key: 'Docs', colour: colours.colours[1], count: 2 }]);
    expect(mask[graph.indexById.get('root')!]).toBe(0); expect(mask[graph.indexById.get('target')!]).toBe(1);
    expect(colours).toEqual(original); expect(graph.degree[1]).toBe(4);
  });

  it('counts only visible induced links and fails closed for mismatched masks', () => {
    const mask = graphFacetMask(graph.nodes, filters({ folder: 'Docs' }));
    expect(visibleLinkCount(graph, mask)).toBe(3); expect(Array.from(visibleGraphDegrees(graph, mask))).toEqual([0, 2, 0, 2, 1, 1]);
    expect(graphFacetMask(graph.nodes, filters(), new Uint8Array(nodes.length - 1))).toEqual(new Uint8Array(nodes.length));
    expect(visibleGraphDegrees(graph, new Uint8Array())).toEqual(new Uint32Array(nodes.length));
  });
});
