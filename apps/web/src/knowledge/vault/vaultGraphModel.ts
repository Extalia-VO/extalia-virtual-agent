import { KNOWLEDGE_OVERVIEW_LIMITS, type KnowledgeOverview, type KnowledgeOverviewNode } from '@extalia/platform';

/**
 * Pure logic of the whole-vault 3D graph: capping, adjacency, colour groups, degree → size and
 * glow, the modified-time filter and client-side search over the overview. No three.js here, so
 * the page shell and the tests load none of the renderer.
 */

export type ColourMode = 'folder' | 'kind' | 'tag';
export const COLOUR_MODES: readonly ColourMode[] = ['folder', 'kind', 'tag'];
export type TimeWindow = '1d' | '1w' | '1m' | '1y' | 'all';
export const TIME_WINDOWS: readonly TimeWindow[] = ['1d', '1w', '1m', '1y', 'all'];

/** A prepared overview: nodes in a fixed order (index = instance id), undirected edge pairs and CSR adjacency. */
export interface VaultGraph {
  nodes: KnowledgeOverviewNode[];
  indexById: Map<string, number>;
  /** Edge endpoints as node indices, two per edge. */
  edges: Uint32Array;
  /** CSR adjacency: neighbours of `i` are `adjacency[offsets[i]..offsets[i + 1])`. */
  offsets: Uint32Array;
  adjacency: Uint32Array;
  /** Degree used for size and glow: the vault-wide degree, never below the edges shown. */
  degree: Uint32Array;
  maxDegree: number;
  /** Node indices by degree (most connected first), ties by title. */
  hubs: number[];
  /** Notes or edges left out (here or by the host). */
  truncated: boolean;
  totalNodes: number;
  totalEdges: number;
}

/**
 * Cap at the overview limits (most connected notes first), drop self-links, links to notes not
 * shown and repeated pairs (an undirected line is drawn once whatever its types), and index.
 */
export function prepareVaultGraph(overview: KnowledgeOverview, limits: { nodes: number; edges: number } = KNOWLEDGE_OVERVIEW_LIMITS): VaultGraph {
  let nodes = overview.nodes;
  let truncated = overview.truncated;
  if (nodes.length > limits.nodes) {
    nodes = [...nodes].sort((a, b) => b.degree - a.degree || (a.nodeId < b.nodeId ? -1 : 1)).slice(0, limits.nodes);
    truncated = true;
  }
  const indexById = new Map<string, number>();
  nodes = nodes.filter(node => (indexById.has(node.nodeId) ? false : (indexById.set(node.nodeId, indexById.size), true)));
  const pairs: number[] = [];
  const seen = new Set<number>();
  for (const edge of overview.edges) {
    const a = indexById.get(edge.source), b = indexById.get(edge.target);
    if (a === undefined || b === undefined || a === b) continue;
    const key = Math.min(a, b) * nodes.length + Math.max(a, b);
    if (seen.has(key)) continue;
    if (pairs.length / 2 >= limits.edges) { truncated = true; break; }
    seen.add(key);
    pairs.push(a, b);
  }
  const edges = Uint32Array.from(pairs);
  const count = nodes.length;
  const local = new Uint32Array(count);
  for (const index of edges) local[index]! += 1;
  const offsets = new Uint32Array(count + 1);
  for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i]! + local[i]!;
  const adjacency = new Uint32Array(edges.length);
  const fill = offsets.slice(0, count);
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e]!, b = edges[e + 1]!;
    adjacency[fill[a]!++] = b;
    adjacency[fill[b]!++] = a;
  }
  const degree = new Uint32Array(count);
  let maxDegree = 0;
  nodes.forEach((node, i) => { degree[i] = Math.max(Number.isFinite(node.degree) ? node.degree : 0, local[i]!); maxDegree = Math.max(maxDegree, degree[i]!); });
  const hubs = nodes.map((_, i) => i).sort((a, b) => degree[b]! - degree[a]! || nodes[a]!.title.localeCompare(nodes[b]!.title));
  return { nodes, indexById, edges, offsets, adjacency, degree, maxDegree, hubs, truncated, totalNodes: Math.max(overview.totalNodes, nodes.length), totalEdges: Math.max(overview.totalEdges, edges.length / 2) };
}

/** A node and its direct neighbours. */
export function neighbourSet(graph: Pick<VaultGraph, 'offsets' | 'adjacency'>, index: number): Set<number> {
  const set = new Set<number>([index]);
  for (let at = graph.offsets[index] ?? 0, end = graph.offsets[index + 1] ?? 0; at < end; at++) set.add(graph.adjacency[at]!);
  return set;
}

/** 0..1 connectedness on a log scale, so a few huge hubs do not flatten everyone else. */
export function degreeWeight(degree: number, maxDegree: number): number {
  if (maxDegree <= 0 || degree <= 0) return 0;
  return Math.min(1, Math.log1p(degree) / Math.log1p(maxDegree));
}

export interface NodeLook {
  /** Core sphere radius (world units). */
  radius: number;
  /** Halo sprite diameter (world units). */
  halo: number;
  /** Halo intensity 0..1. */
  glow: number;
  /** How far the core colour is lifted towards white (hubs read as hot spots). */
  lift: number;
}

/** Size and brightness from connectedness: the most connected notes are the biggest and glow the most. */
export function nodeLook(degree: number, maxDegree: number): NodeLook {
  const w = degreeWeight(degree, maxDegree);
  const radius = 1.2 + 4 * w;
  return { radius, halo: radius * (3 + 5 * w), glow: 0.16 + 0.84 * w ** 1.4, lift: 0.35 * w * w };
}

/** Curated for the graph's near-black stage: saturated but not neon, distinct in hue and lightness. */
export const GRAPH_PALETTE = [
  '#7c9cff', '#5eead4', '#f472b6', '#fbbf24', '#a78bfa', '#4ade80',
  '#fb923c', '#38bdf8', '#f87171', '#e879f9', '#a3e635', '#fde68a',
] as const;
/** Groups beyond the palette share a quiet slate. */
export const GRAPH_OTHER_COLOUR = '#8a94ab';
export const GRAPH_BACKGROUND = '#05070d';

export interface ColourGroup { key: string; colour: string; count: number }
export interface ColourAssignment {
  /** Palette colour per node (hex). */
  colours: string[];
  /** Groups shown in the legend (largest first), then `other` when some share the slate. */
  legend: ColourGroup[];
  other: number;
}

/** The group a note belongs to in a colour mode. `''` is the vault root / no kind / untagged. */
export function groupKey(node: KnowledgeOverviewNode, mode: ColourMode, tagCounts?: ReadonlyMap<string, number>): string {
  if (mode === 'folder') return node.folder;
  if (mode === 'kind') return node.kind ?? '';
  if (!node.tags.length) return '';
  // A note with several tags joins the most common one, so groups stay few and meaningful.
  return [...node.tags].sort((a, b) => (tagCounts?.get(b) ?? 0) - (tagCounts?.get(a) ?? 0) || a.localeCompare(b))[0]!;
}

/** Colour by folder, kind or tag: the largest groups take the palette in order (stable for the same vault). */
export function assignColours(nodes: readonly KnowledgeOverviewNode[], mode: ColourMode): ColourAssignment {
  const tagCounts = new Map<string, number>();
  if (mode === 'tag') for (const node of nodes) for (const tag of node.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  const keys = nodes.map(node => groupKey(node, mode, tagCounts));
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const ordered = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const colourOf = new Map<string, string>();
  ordered.forEach(([key], index) => colourOf.set(key, GRAPH_PALETTE[index] ?? GRAPH_OTHER_COLOUR));
  const legend = ordered.slice(0, GRAPH_PALETTE.length).map(([key, count]) => ({ key, colour: colourOf.get(key)!, count }));
  const other = ordered.slice(GRAPH_PALETTE.length).reduce((sum, [, count]) => sum + count, 0);
  return { colours: keys.map(key => colourOf.get(key)!), legend, other };
}

/** sRGB 0..1 channels of `#rrggbb`. */
export function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/** Each end of a line takes mostly its own note's colour with some of the other end's, dimmed to a faint web. */
export function edgeEndColour(own: readonly number[], other: readonly number[], intensity: number): [number, number, number] {
  return [0, 1, 2].map(c => (0.7 * own[c]! + 0.3 * other[c]!) * intensity) as [number, number, number];
}

const DAY = 86_400_000;
const WINDOW_MS: Record<Exclude<TimeWindow, 'all'>, number> = { '1d': DAY, '1w': 7 * DAY, '1m': 30 * DAY, '1y': 365 * DAY };

/** Oldest modification time a window keeps, or `null` for all. */
export function timeCutoff(window: TimeWindow, now: number): number | null {
  return window === 'all' ? null : now - WINDOW_MS[window];
}

/** 1 for notes modified inside the window (unknown dates stay visible only under All). */
export function timeMask(nodes: readonly KnowledgeOverviewNode[], window: TimeWindow, now: number): Uint8Array {
  const cutoff = timeCutoff(window, now);
  return Uint8Array.from(nodes, node => {
    if (cutoff === null) return 1;
    const at = Date.parse(node.modifiedAt);
    return Number.isFinite(at) && at >= cutoff ? 1 : 0;
  });
}

const fold = (text: string): string => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Client-side search over the overview (titles, tags, paths): every term must match somewhere.
 * Title prefix > word start in the title > anywhere in the title > tag > path; then connectedness.
 */
export function rankSearch(graph: Pick<VaultGraph, 'nodes' | 'degree'>, query: string, limit = 20, mask?: Uint8Array): number[] {
  const whole = fold(query.trim());
  const terms = whole.split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return [];
  const scored: { index: number; score: number }[] = [];
  graph.nodes.forEach((node, index) => {
    if (mask && !mask[index]) return;
    const title = fold(node.title), path = fold(node.path), tags = node.tags.map(fold);
    let score = 0;
    for (const term of terms) {
      const s = title.startsWith(term) ? 6
        : title.split(/[\s\-_/.()[\]]+/).some(word => word.startsWith(term)) ? 4
          : title.includes(term) ? 3
            : tags.some(tag => tag === term) ? 3
              : tags.some(tag => tag.startsWith(term)) ? 2
                : path.includes(term) ? 1 : 0;
      if (!s) return;
      score += s;
    }
    if (title === whole) score += 10;
    scored.push({ index, score: score + 0.25 * Math.log1p(graph.degree[index] ?? 0) });
  });
  scored.sort((a, b) => b.score - a.score || graph.nodes[a.index]!.title.localeCompare(graph.nodes[b.index]!.title));
  return scored.slice(0, limit).map(item => item.index);
}

/** The notes that get a label: hovered, selected and the active search result first, then the top hubs still shown. */
export function labelCandidates(graph: Pick<VaultGraph, 'hubs'>, mask: Uint8Array, focus: readonly (number | null | undefined)[], hubCount: number): number[] {
  const out: number[] = [];
  for (const index of focus) if (index !== null && index !== undefined && mask[index] && !out.includes(index)) out.push(index);
  let hubs = 0;
  for (const index of graph.hubs) {
    if (hubs >= hubCount) break;
    if (!mask[index]) continue;
    hubs++;
    if (!out.includes(index)) out.push(index);
  }
  return out;
}

/** Steps the quality tier on measured frame rate: two slow windows step down, five smooth ones step back up. */
export interface QualityState { tier: number; slow: number; fast: number }
export const QUALITY_TIERS = [
  { haloScale: 1, hubLabels: 8 },
  { haloScale: 0.7, hubLabels: 5 },
  { haloScale: 0.45, hubLabels: 0 },
] as const;
export function updateQuality(state: QualityState, fps: number): QualityState {
  const slow = fps < 45 ? state.slow + 1 : 0;
  const fast = fps >= 57 ? state.fast + 1 : 0;
  if (slow >= 2 && state.tier < QUALITY_TIERS.length - 1) return { tier: state.tier + 1, slow: 0, fast: 0 };
  if (fast >= 5 && state.tier > 0) return { tier: state.tier - 1, slow: 0, fast: 0 };
  return { tier: state.tier, slow, fast };
}
