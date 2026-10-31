import { GRAPH_OTHER_COLOUR, type ColourAssignment, type ColourGroup, type VaultGraph } from './vaultGraphModel';

export type FocusHops = 1 | 2 | 3;
export interface GraphFocus {
  mask: Uint8Array;
  root: number | null;
  status: 'none' | 'active' | 'missing' | 'filtered';
}

/**
 * A bounded neighbourhood in the prepared overview, never through a filtered note. Resolve the
 * stable ID on every call: an overview refresh can reorder or omit notes. Invalid options fail
 * closed rather than accidentally revealing the whole vault.
 */
export function focusGraph(graph: VaultGraph, baseMask: Uint8Array, rootId: string | null, hops: FocusHops): GraphFocus {
  const count = graph.nodes.length;
  const candidate = rootId === null ? undefined : graph.indexById.get(rootId);
  const root = candidate !== undefined && Number.isInteger(candidate) && candidate >= 0 && candidate < count
    && graph.nodes[candidate]!.nodeId === rootId ? candidate : null;
  const empty = (): GraphFocus => ({ mask: new Uint8Array(count), root, status: rootId !== null && root === null ? 'missing' : 'filtered' });
  if (!(baseMask instanceof Uint8Array) || baseMask.length !== count || (hops !== 1 && hops !== 2 && hops !== 3)) return empty();
  if (rootId === null) return { mask: baseMask, root: null, status: 'none' };
  if (root === null || baseMask[root] !== 1) return empty();

  const mask = new Uint8Array(count);
  // Each note enters the queue once; layer boundaries avoid a second distances array.
  const queue = new Uint32Array(count);
  queue[0] = root;
  mask[root] = 1;
  let head = 0, tail = 1;
  for (let depth = 0; depth < hops && head < tail; depth++) {
    const layerEnd = tail;
    while (head < layerEnd) {
      const index = queue[head++]!;
      const start = graph.offsets[index] ?? 0;
      const end = Math.min(graph.offsets[index + 1] ?? 0, graph.adjacency.length);
      for (let at = start; at < end; at++) {
        const neighbour = graph.adjacency[at]!;
        if (neighbour >= count || baseMask[neighbour] !== 1 || mask[neighbour] === 1) continue;
        mask[neighbour] = 1;
        queue[tail++] = neighbour;
      }
    }
  }
  return { mask, root, status: 'active' };
}

/** Count only real prepared links with both endpoints visible, not vault-wide degrees. */
export function visibleLinkCount(graph: Pick<VaultGraph, 'nodes' | 'edges'>, mask: Uint8Array): number {
  if (mask.length !== graph.nodes.length) return 0;
  let count = 0;
  for (let at = 0; at + 1 < graph.edges.length; at += 2) {
    if (mask[graph.edges[at]!] === 1 && mask[graph.edges[at + 1]!] === 1) count++;
  }
  return count;
}

/**
 * Keep the vault's original group keys, palette and order while counting visible notes. Palette
 * colours uniquely identify its legend groups; all overflow groups keep sharing `other`.
 * In particular, tag membership is never recalculated from the filtered subset.
 */
export function visibleColourLegend(assignment: ColourAssignment, mask: Uint8Array): { legend: ColourGroup[]; other: number } {
  if (mask.length !== assignment.colours.length) return { legend: [], other: 0 };
  const counts = new Map<string, number>();
  for (let index = 0; index < mask.length; index++) {
    if (mask[index] !== 1) continue;
    const colour = assignment.colours[index]!;
    counts.set(colour, (counts.get(colour) ?? 0) + 1);
  }
  return {
    legend: assignment.legend.flatMap(group => {
      const count = counts.get(group.colour) ?? 0;
      return count ? [{ ...group, count }] : [];
    }),
    other: counts.get(GRAPH_OTHER_COLOUR) ?? 0,
  };
}
