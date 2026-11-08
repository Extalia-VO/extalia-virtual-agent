/*! @license Advanced Graph View — Copyright (c) 2026 n23eos — MIT.
 * See THIRD_PARTY_SOFTWARE.md for the full copyright and license notice. */
import type { VaultGraph } from './vaultGraphModel';

/**
 * Explore navigation adapted from Advanced Graph View (MIT), pinned at
 * 17e3eb1fd0e64d4d13d9a130c4bd77b2f287b48d:
 * https://github.com/n23eos/advanced_graph_view/blob/17e3eb1fd0e64d4d13d9a130c4bd77b2f287b48d/src/explore/navigationTrail.ts
 * https://github.com/n23eos/advanced_graph_view/blob/17e3eb1fd0e64d4d13d9a130c4bd77b2f287b48d/src/explore/ExploreController.ts
 * See THIRD_PARTY_NOTICES.md for the upstream copyright and MIT license.
 *
 * Extalia keeps stable note IDs, resolves them against each loaded overview, and
 * checks its combined visibility mask before every transition. This model owns
 * no camera, renderer, host operation, note content or external application.
 */

export const GRAPH_EXPLORE_TRAIL_LIMIT = 100;

export interface GraphExploreState {
  enabled: boolean;
  currentId: string | null;
  /** Oldest first, including currentId. Back discards the newer branch. */
  trail: readonly string[];
  /** Changes only on accepted transitions, for deliberate camera travel. */
  revision: number;
}

export type GraphExploreAction =
  | { type: 'enter'; nodeId?: string | null }
  | { type: 'exit' }
  | { type: 'release' }
  | { type: 'back' }
  | { type: 'navigate'; nodeId: string; jump?: boolean };

export interface GraphExploreContext {
  graph: VaultGraph;
  /** The final intersection of time, facets and neighbourhood filters. */
  mask: Uint8Array;
}

export interface GraphExploreProjection {
  current: number | null;
  neighbours: number[];
  /** Visible, resolved suffix only; never join history across a hidden note. */
  trail: number[];
  canGoBack: boolean;
  status: 'off' | 'choosing' | 'active' | 'missing' | 'filtered';
}

export function createGraphExploreState(): GraphExploreState {
  return { enabled: false, currentId: null, trail: [], revision: 0 };
}

function resolveId(graph: VaultGraph, id: string): number | null {
  const index = graph.indexById.get(id);
  return index !== undefined && Number.isInteger(index) && index >= 0 && index < graph.nodes.length
    && graph.nodes[index]!.nodeId === id ? index : null;
}

function visibleIndex(graph: VaultGraph, mask: Uint8Array, id: string): number | null {
  if (!(mask instanceof Uint8Array) || mask.length !== graph.nodes.length) return null;
  const index = resolveId(graph, id);
  return index !== null && mask[index] === 1 ? index : null;
}

function visibleNeighbours(graph: VaultGraph, mask: Uint8Array, current: number): number[] {
  const start = graph.offsets[current], end = graph.offsets[current + 1];
  if (start === undefined || end === undefined || start > end || end > graph.adjacency.length) return [];
  const neighbours = new Set<number>();
  for (let at = start; at < end; at++) {
    const index = graph.adjacency[at]!;
    if (index !== current && index < graph.nodes.length && mask[index] === 1) neighbours.add(index);
  }
  return [...neighbours];
}

function previousId(state: GraphExploreState, graph: VaultGraph, mask: Uint8Array): string | null {
  if (state.trail.length < 2 || state.trail[state.trail.length - 1] !== state.currentId) return null;
  const id = state.trail[state.trail.length - 2]!;
  return visibleIndex(graph, mask, id) !== null ? id : null;
}

/** Resolve indices afresh without mutating history or substituting another note. */
export function projectGraphExplore(state: GraphExploreState, graph: VaultGraph, mask: Uint8Array): GraphExploreProjection {
  const empty = { current: null, neighbours: [], trail: [], canGoBack: false };
  if (!state.enabled) return { ...empty, status: 'off' };
  if (state.currentId === null) return { ...empty, status: 'choosing' };
  const canGoBack = previousId(state, graph, mask) !== null;
  const current = resolveId(graph, state.currentId);
  if (current === null) return { ...empty, canGoBack, status: 'missing' };
  if (visibleIndex(graph, mask, state.currentId) === null) return { ...empty, canGoBack, status: 'filtered' };
  const trail: number[] = [];
  for (let at = state.trail.length - 1; at >= 0; at--) {
    const index = visibleIndex(graph, mask, state.trail[at]!);
    if (index === null) break;
    trail.push(index);
  }
  trail.reverse();
  return { current, neighbours: visibleNeighbours(graph, mask, current), trail, canGoBack, status: 'active' };
}

/**
 * Normal travel follows a real visible direct link. A deliberate chooser/search
 * jump may start another route; neither operation widens the loaded graph mask.
 */
export function reduceGraphExplore(state: GraphExploreState, action: GraphExploreAction, { graph, mask }: GraphExploreContext): GraphExploreState {
  const transition = (enabled: boolean, currentId: string | null, trail: readonly string[]): GraphExploreState =>
    ({ enabled, currentId, trail, revision: state.revision + 1 });
  if (action.type === 'exit') {
    return state.enabled ? transition(false, null, []) : state;
  }
  if (action.type === 'enter') {
    const id = action.nodeId;
    const currentId = typeof id === 'string' && visibleIndex(graph, mask, id) !== null ? id : null;
    return transition(true, currentId, currentId === null ? [] : [currentId]);
  }
  if (!state.enabled) return state;
  if (action.type === 'release') {
    return state.currentId === null && state.trail.length === 0 ? state : transition(true, null, []);
  }
  if (action.type === 'back') {
    const id = previousId(state, graph, mask);
    return id === null ? state : transition(true, id, state.trail.slice(0, -1));
  }
  if (visibleIndex(graph, mask, action.nodeId) === null || action.nodeId === state.currentId) return state;
  if (state.currentId !== null && action.jump !== true) {
    const projection = projectGraphExplore(state, graph, mask);
    const target = resolveId(graph, action.nodeId);
    if (projection.status !== 'active' || target === null || !projection.neighbours.includes(target)) return state;
  }
  return transition(true, action.nodeId, [...state.trail, action.nodeId].slice(-GRAPH_EXPLORE_TRAIL_LIMIT));
}
