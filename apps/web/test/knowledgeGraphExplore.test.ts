import type { KnowledgeOverview, KnowledgeOverviewNode } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { createGraphExploreState, GRAPH_EXPLORE_TRAIL_LIMIT, projectGraphExplore, reduceGraphExplore, type GraphExploreContext } from '../src/knowledge/vault/graphExplore';
import { graphFacetMask } from '../src/knowledge/vault/graphFilters';
import { focusGraph } from '../src/knowledge/vault/graphFocus';
import { prepareVaultGraph, timeMask, type VaultGraph } from '../src/knowledge/vault/vaultGraphModel';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const note = (nodeId: string, patch: Partial<KnowledgeOverviewNode> = {}): KnowledgeOverviewNode => ({
  nodeId, title: nodeId, path: `${nodeId}.md`, folder: 'Docs', kind: 'knowledge', tags: ['shared'],
  degree: 100, inDegree: 50, outDegree: 50, modifiedAt: new Date(NOW).toISOString(), ...patch,
});
function graphOf(nodes: KnowledgeOverviewNode[], pairs: [string, string][], limits?: { nodes: number; edges: number }): VaultGraph {
  const overview: KnowledgeOverview = { generation: 1, nodes, edges: pairs.map(([source, target]) => ({ source, target, type: 'links_to' })), totalNodes: nodes.length, totalEdges: pairs.length, truncated: false };
  return prepareVaultGraph(overview, limits);
}
function context(graph: VaultGraph, mask: Uint8Array = new Uint8Array(graph.nodes.length).fill(1)): GraphExploreContext { return { graph, mask }; }
function projectedIds(indices: number[], graph: VaultGraph): string[] { return indices.map(index => graph.nodes[index]!.nodeId); }

describe('read-only vault graph Explore navigation', () => {
  const nodes = ['a', 'b', 'c', 'branch', 'island'].map(id => note(id));
  const pairs: [string, string][] = [['a', 'b'], ['b', 'c'], ['a', 'branch']];
  const graph = graphOf(nodes, pairs);
  const all = context(graph);
  const enter = (nodeId = 'a', ctx = all) => reduceGraphExplore(createGraphExploreState(), { type: 'enter', nodeId }, ctx);

  it('waits for an explicit visible choice instead of guessing a start note', () => {
    const initial = createGraphExploreState();
    expect(projectGraphExplore(initial, graph, all.mask)).toMatchObject({ status: 'off', current: null, trail: [], neighbours: [] });
    for (const nodeId of [undefined, null, 'missing', '']) {
      const choosing = reduceGraphExplore(initial, { type: 'enter', nodeId }, all);
      expect(projectGraphExplore(choosing, graph, all.mask)).toMatchObject({ status: 'choosing', current: null });
      const picked = reduceGraphExplore(choosing, { type: 'navigate', nodeId: 'island' }, all);
      expect(picked).toMatchObject({ currentId: 'island', trail: ['island'] });
    }
    const hidden = context(graph, Uint8Array.from([0, 1, 1, 1, 1]));
    expect(enter('a', hidden)).toMatchObject({ enabled: true, currentId: null, trail: [] });
    expect(reduceGraphExplore(initial, { type: 'navigate', nodeId: 'a', jump: true }, all)).toBe(initial);
  });

  it('follows actual direct undirected adjacency, without inferring links from metadata or degree', () => {
    const state = enter();
    expect(projectedIds(projectGraphExplore(state, graph, all.mask).neighbours, graph)).toEqual(['b', 'branch']);
    for (const nodeId of ['c', 'island', 'missing', 'a']) {
      expect(reduceGraphExplore(state, { type: 'navigate', nodeId }, all)).toBe(state);
    }
    const atB = reduceGraphExplore(state, { type: 'navigate', nodeId: 'b' }, all);
    expect(atB).toMatchObject({ currentId: 'b', trail: ['a', 'b'], revision: 2 });
    expect(reduceGraphExplore(atB, { type: 'navigate', nodeId: 'a' }, all).currentId).toBe('a');
    expect(reduceGraphExplore(state, { type: 'navigate', nodeId: 'island', jump: true }, all).currentId).toBe('island');
  });

  it('intersects time, folder, kind, tag and focus filters without crossing a hidden bridge', () => {
    const filteredGraph = graphOf([
      note('root'), note('bridge', { kind: 'bridge' }), note('target'), note('old', { modifiedAt: '2020-01-01T00:00:00Z' }),
      note('other-folder', { folder: 'Other' }), note('other-tag', { tags: ['other'] }), note('direct'),
    ], [['root', 'bridge'], ['bridge', 'target'], ['root', 'old'], ['root', 'other-folder'], ['root', 'other-tag'], ['root', 'direct']]);
    const facets = graphFacetMask(filteredGraph.nodes, { folder: 'Docs', kind: 'knowledge', tag: 'shared' }, timeMask(filteredGraph.nodes, '1d', NOW));
    const mask = focusGraph(filteredGraph, facets, 'root', 3).mask;
    const ctx = context(filteredGraph, mask);
    const state = enter('root', ctx);
    const projection = projectGraphExplore(state, filteredGraph, mask);
    expect(projectedIds(projection.neighbours, filteredGraph)).toEqual(['direct']);
    for (const nodeId of ['bridge', 'target', 'old', 'other-folder', 'other-tag']) {
      expect(reduceGraphExplore(state, { type: 'navigate', nodeId, jump: true }, ctx)).toBe(state);
    }
    expect(reduceGraphExplore(state, { type: 'navigate', nodeId: 'direct' }, ctx).currentId).toBe('direct');
  });

  it('never navigates through hidden notes even when another visible note is reachable behind them', () => {
    const mask = Uint8Array.from([1, 0, 1, 1, 1]);
    const ctx = context(graph, mask), state = enter('a', ctx);
    expect(projectedIds(projectGraphExplore(state, graph, mask).neighbours, graph)).toEqual(['branch']);
    expect(reduceGraphExplore(state, { type: 'navigate', nodeId: 'c' }, ctx)).toBe(state);
    expect(reduceGraphExplore(state, { type: 'navigate', nodeId: 'b', jump: true }, ctx)).toBe(state);
    expect(reduceGraphExplore(state, { type: 'navigate', nodeId: 'c', jump: true }, ctx).currentId).toBe('c');
  });

  it('rewinds one transition and branches from the current note without retaining a forward branch', () => {
    const atB = reduceGraphExplore(enter(), { type: 'navigate', nodeId: 'b' }, all);
    const atC = reduceGraphExplore(atB, { type: 'navigate', nodeId: 'c' }, all);
    const backB = reduceGraphExplore(atC, { type: 'back' }, all);
    expect(backB).toMatchObject({ currentId: 'b', trail: ['a', 'b'], revision: 4 });
    const backA = reduceGraphExplore(backB, { type: 'back' }, all);
    const branch = reduceGraphExplore(backA, { type: 'navigate', nodeId: 'branch' }, all);
    expect(branch.trail).toEqual(['a', 'branch']);
    expect(reduceGraphExplore(backA, { type: 'back' }, all)).toBe(backA);
  });

  it('blocks Back at the immediately hidden or deleted entry rather than skipping history', () => {
    const state = reduceGraphExplore(reduceGraphExplore(enter(), { type: 'navigate', nodeId: 'b' }, all), { type: 'navigate', nodeId: 'c' }, all);
    const hidden = context(graph, Uint8Array.from([1, 0, 1, 1, 1]));
    expect(reduceGraphExplore(state, { type: 'back' }, hidden)).toBe(state);
    const projection = projectGraphExplore(state, graph, hidden.mask);
    expect(projection.canGoBack).toBe(false);
    expect(projectedIds(projection.trail, graph)).toEqual(['c']);
    const removed = context(graphOf(nodes.filter(node => node.nodeId !== 'b'), pairs));
    expect(reduceGraphExplore(state, { type: 'back' }, removed)).toBe(state);
    expect(projectGraphExplore(state, removed.graph, removed.mask).canGoBack).toBe(false);
    expect(reduceGraphExplore(state, { type: 'back' }, all).currentId).toBe('b');
  });

  it('resolves current, neighbours and history by stable ID after a reordered refresh', () => {
    const state = reduceGraphExplore(enter(), { type: 'navigate', nodeId: 'b' }, all);
    const refreshed = context(graphOf([...nodes].reverse(), pairs));
    const projection = projectGraphExplore(state, refreshed.graph, refreshed.mask);
    expect(projection.current).toBe(3);
    expect(projectedIds(projection.neighbours, refreshed.graph)).toEqual(['a', 'c']);
    expect(projectedIds(projection.trail, refreshed.graph)).toEqual(['a', 'b']);
    expect(reduceGraphExplore(state, { type: 'back' }, refreshed).currentId).toBe('a');
  });

  it('keeps filtered and missing current states explicit without exposing their indices or history', () => {
    const state = reduceGraphExplore(enter(), { type: 'navigate', nodeId: 'b' }, all);
    const hidden = context(graph, Uint8Array.from([1, 0, 1, 1, 1]));
    expect(projectGraphExplore(state, graph, hidden.mask)).toEqual({ status: 'filtered', current: null, neighbours: [], trail: [], canGoBack: true });
    expect(reduceGraphExplore(state, { type: 'navigate', nodeId: 'c' }, hidden)).toBe(state);
    expect(reduceGraphExplore(state, { type: 'back' }, hidden).currentId).toBe('a');
    const removed = context(graphOf(nodes.filter(node => node.nodeId !== 'b'), pairs));
    expect(projectGraphExplore(state, removed.graph, removed.mask)).toMatchObject({ status: 'missing', current: null, neighbours: [], trail: [] });
    expect(projectGraphExplore(state, graph, all.mask).status).toBe('active');
    expect(state.currentId).toBe('b');
  });

  it('fails closed for malformed masks and treats only the byte 1 as visible', () => {
    const state = enter();
    for (const mask of [new Uint8Array(), new Uint8Array(nodes.length - 1).fill(1), new Uint8Array(nodes.length + 1).fill(1), [1, 1, 1, 1, 1], null, undefined]) {
      const ctx = { graph, mask: mask as Uint8Array };
      expect(projectGraphExplore(state, graph, ctx.mask)).toMatchObject({ status: 'filtered', current: null, neighbours: [], trail: [] });
      expect(reduceGraphExplore(state, { type: 'navigate', nodeId: 'b', jump: true }, ctx)).toBe(state);
      expect(reduceGraphExplore(createGraphExploreState(), { type: 'enter', nodeId: 'a' }, ctx).currentId).toBeNull();
    }
    const mask = Uint8Array.from([1, 2, 1, 1, 1]);
    expect(projectedIds(projectGraphExplore(state, graph, mask).neighbours, graph)).toEqual(['branch']);
    expect(reduceGraphExplore(state, { type: 'navigate', nodeId: 'b', jump: true }, context(graph, mask))).toBe(state);
  });

  it('does not trust stale index maps or edges omitted from a bounded prepared graph', () => {
    const stale = context({ ...graph, indexById: new Map([...graph.indexById, ['a', 2], ['missing', 0]]) });
    expect(enter('a', stale).currentId).toBeNull();
    expect(enter('missing', stale).currentId).toBeNull();
    const limited = graphOf(nodes, pairs, { nodes: nodes.length, edges: 1 });
    expect(limited.truncated).toBe(true);
    const ctx = context(limited);
    const state = enter('a', ctx);
    expect(projectedIds(projectGraphExplore(state, limited, ctx.mask).neighbours, limited)).toEqual(['b']);
    expect(reduceGraphExplore(state, { type: 'navigate', nodeId: 'branch' }, ctx)).toBe(state);
  });

  it('caps repeated cyclic travel while retaining the newest current note and usable Back', () => {
    let state = enter();
    for (let at = 0; at < 250; at++) state = reduceGraphExplore(state, { type: 'navigate', nodeId: state.currentId === 'a' ? 'b' : 'a' }, all);
    expect(state.trail).toHaveLength(GRAPH_EXPLORE_TRAIL_LIMIT);
    expect(state.trail.at(-1)).toBe(state.currentId);
    expect(state.revision).toBe(251);
    expect(projectGraphExplore(state, graph, all.mask).canGoBack).toBe(true);
    expect(reduceGraphExplore(state, { type: 'back' }, all).trail).toHaveLength(99);
  });

  it('releases to choosing, exits completely, and leaves all graph inputs and old state untouched', () => {
    const state = enter(), before = structuredClone(graph), mask = all.mask.slice();
    Object.freeze(state.trail); Object.freeze(state);
    const next = reduceGraphExplore(state, { type: 'navigate', nodeId: 'b' }, all);
    const released = reduceGraphExplore(next, { type: 'release' }, all);
    expect(released).toMatchObject({ enabled: true, currentId: null, trail: [], revision: 3 });
    expect(projectGraphExplore(released, graph, all.mask).status).toBe('choosing');
    expect(reduceGraphExplore(released, { type: 'back' }, all)).toBe(released);
    const exited = reduceGraphExplore(next, { type: 'exit' }, all);
    expect(exited).toMatchObject({ enabled: false, currentId: null, trail: [], revision: 3 });
    expect(reduceGraphExplore(exited, { type: 'release' }, all)).toBe(exited);
    expect(state).toMatchObject({ currentId: 'a', trail: ['a'], revision: 1 });
    expect(graph).toEqual(before); expect(all.mask).toEqual(mask);
  });
});
