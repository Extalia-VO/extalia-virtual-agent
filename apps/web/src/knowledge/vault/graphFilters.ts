import type { KnowledgeOverviewNode } from '@extalia/platform';
import type { VaultGraph } from './vaultGraphModel';

/** Empty strings mean unrestricted; `null` selects root / no kind / untagged exactly. */
export interface GraphFacetFilters { folder: string | null; kind: string | null; tag: string | null }
export interface GraphFacetOptions { folders: string[]; kinds: string[]; tags: string[] }
export const EMPTY_GRAPH_FILTERS: Readonly<GraphFacetFilters> = Object.freeze({ folder: '', kind: '', tag: '' });
export const hasGraphFilters = (filters: GraphFacetFilters): boolean => filters.folder !== '' || filters.kind !== '' || filters.tag !== '';

const sorted = (values: Iterable<string>) => [...new Set(values)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);

/** Options always come from the complete prepared overview, never the current mask. */
export function graphFacetOptions(nodes: readonly KnowledgeOverviewNode[]): GraphFacetOptions {
  return {
    folders: sorted(nodes.map(node => node.folder)),
    kinds: sorted(nodes.map(node => node.kind ?? '')),
    tags: sorted(nodes.flatMap(node => node.tags.length ? node.tags : [''])),
  };
}

/** Preserve raw folder names while giving the root a distinct native-select value. */
export function facetSelectValue(value: string | null, facet: keyof GraphFacetFilters): string { return value === '' ? '' : `${facet}:${value ?? ''}`; }
export function facetFromSelect(value: string, facet: keyof GraphFacetFilters): string | null | undefined {
  return value === '' ? '' : value.startsWith(`${facet}:`) ? value.slice(facet.length + 1) || null : undefined;
}

/** Exact dimensions AND together, intersecting the time mask before neighbourhood traversal. */
export function graphFacetMask(nodes: readonly KnowledgeOverviewNode[], filters: GraphFacetFilters, time?: Uint8Array): Uint8Array {
  if ([filters.folder, filters.kind, filters.tag].some(value => value !== null && typeof value !== 'string')
    || time !== undefined && (!(time instanceof Uint8Array) || time.length !== nodes.length)) return new Uint8Array(nodes.length);
  return Uint8Array.from(nodes, (node, index) => Number((time === undefined || time[index] === 1)
    && (filters.folder === '' || node.folder === (filters.folder ?? ''))
    && (filters.kind === '' || (node.kind ?? '') === (filters.kind ?? ''))
    && (filters.tag === '' || (filters.tag === null ? node.tags.length === 0 : node.tags.includes(filters.tag)))));
}

/** Row link counts describe the visible induced graph; visual sizes retain vault-wide degree. */
export function visibleGraphDegrees(graph: Pick<VaultGraph, 'nodes' | 'edges'>, mask: Uint8Array): Uint32Array {
  const degree = new Uint32Array(graph.nodes.length);
  if (mask.length !== graph.nodes.length) return degree;
  for (let at = 0; at + 1 < graph.edges.length; at += 2) {
    const a = graph.edges[at]!, b = graph.edges[at + 1]!;
    if (mask[a] === 1 && mask[b] === 1) { degree[a]!++; degree[b]!++; }
  }
  return degree;
}
