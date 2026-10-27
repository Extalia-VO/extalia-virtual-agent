import { KNOWLEDGE_HOST_METHODS, KNOWLEDGE_UI_LIMITS, type AgentHostApi, type KnowledgeEdgeType, type KnowledgeGraph, type KnowledgeLink, type KnowledgeLinkPage, type KnowledgeNodeRef } from '@extalia/platform';

/** The whole-vault overview is optional: the page works without it, only the 3D vault graph needs it. */
type OptionalKnowledgeMethod = 'knowledgeOverview';
const REQUIRED_KNOWLEDGE_METHODS = KNOWLEDGE_HOST_METHODS.filter((method): method is Exclude<(typeof KNOWLEDGE_HOST_METHODS)[number], OptionalKnowledgeMethod> => method !== 'knowledgeOverview');

/** Every knowledge method, all present (the overview only after `overviewMethodPresent`). */
export type KnowledgeApi = Pick<Required<AgentHostApi>, (typeof KNOWLEDGE_HOST_METHODS)[number]>;

/** Whether `agents` has every knowledge method the page needs (Desktop and the Bridge forward them all; the host may still lack them). */
export function knowledgeMethodsPresent(agents: Partial<AgentHostApi> | undefined): agents is Partial<AgentHostApi> & Omit<KnowledgeApi, OptionalKnowledgeMethod> {
  return Boolean(agents) && REQUIRED_KNOWLEDGE_METHODS.every(method => typeof agents![method] === 'function');
}

/** Whether the host offers the whole-vault overview (the 3D vault graph is shown only then). */
export function overviewMethodPresent(agents: Partial<AgentHostApi> | undefined): agents is Partial<AgentHostApi> & Pick<Required<AgentHostApi>, OptionalKnowledgeMethod> {
  return typeof agents?.knowledgeOverview === 'function';
}

/**
 * Desktop and the Bridge answer a method the host does not implement with this message (an older
 * Bridge or Desktop build does not know the method name at all).
 */
const UNSUPPORTED = ['This host does not support this action.', 'Unknown method.', 'Unknown agent host method.'];
export function isUnsupportedMessage(message: string): boolean {
  return UNSUPPORTED.includes(message);
}

/** The key a body wikilink and an index edge share: the written target, case-insensitive (resolution depends only on it). */
export const linkKey = (target: string): string => target.trim().replace(/\.md$/i, '').toLowerCase();

/** Outgoing links by written target. Every occurrence of the same target in one note resolves the same way. */
export function linksByTarget(links: readonly KnowledgeLink[]): Map<string, KnowledgeLink> {
  const map = new Map<string, KnowledgeLink>();
  for (const link of links) if (!map.has(linkKey(link.target))) map.set(linkKey(link.target), link);
  return map;
}

/** Visible notes a link page names (targets, sources, candidates), by node id. */
export const pageNodes = (page: KnowledgeLinkPage | undefined): Map<string, KnowledgeNodeRef> => new Map((page?.nodes ?? []).map(node => [node.nodeId, node]));

/** A note the page does not describe still gets a readable label (its path for a `path:` id). */
export function nodeLabel(nodes: ReadonlyMap<string, KnowledgeNodeRef>, nodeId: string): { title: string; path?: string } {
  const node = nodes.get(nodeId);
  if (node) return { title: node.title, path: node.path };
  return nodeId.startsWith('path:') ? { title: nodeId.slice(5).replace(/\.md$/i, '').split('/').pop()!, path: nodeId.slice(5) } : { title: nodeId };
}

export interface GraphPoint { id: string; title: string; depth: number; x: number; y: number }
export interface GraphLine { source: string; target: string; edgeType: KnowledgeEdgeType; x1: number; y1: number; x2: number; y2: number }
export interface GraphLayout { points: GraphPoint[]; lines: GraphLine[]; size: number; hidden: number }

const RING = 104;
const MARGIN = 84;

/**
 * A force-free radial layout: the note in the middle, neighbours on ring 1, their neighbours on ring 2
 * next to the note that reached them. At most `maxNodes` notes (nearest first); edges among them only.
 */
export function layoutGraph(graph: KnowledgeGraph, maxNodes: number = KNOWLEDGE_UI_LIMITS.graphNodes): GraphLayout {
  const byId = new Map(graph.nodes.map(node => [node.nodeId, node]));
  if (!byId.has(graph.rootNodeId)) return { points: [], lines: [], size: 2 * MARGIN, hidden: 0 };
  const neighbours = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.source === edge.target || !byId.has(edge.source) || !byId.has(edge.target)) continue;
    neighbours.set(edge.source, [...(neighbours.get(edge.source) ?? []), edge.target]);
    neighbours.set(edge.target, [...(neighbours.get(edge.target) ?? []), edge.source]);
  }
  const title = (id: string) => byId.get(id)!.title;
  const depth = new Map<string, number>([[graph.rootNodeId, 0]]);
  const parent = new Map<string, string>();
  const order = [graph.rootNodeId];
  for (let at = 0; at < order.length; at++) {
    const current = order[at]!;
    const next = [...new Set(neighbours.get(current) ?? [])].filter(id => !depth.has(id)).sort((a, b) => title(a).localeCompare(title(b)));
    for (const id of next) { depth.set(id, depth.get(current)! + 1); parent.set(id, current); order.push(id); }
  }
  const kept = order.slice(0, Math.max(1, maxNodes));
  const hidden = byId.size - kept.length;
  const maxDepth = Math.max(0, ...kept.map(id => depth.get(id)!));
  const center = maxDepth * RING + MARGIN;
  const angle = new Map<string, number>([[graph.rootNodeId, 0]]);
  const points: GraphPoint[] = [];
  const place = (id: string, a: number) => {
    const d = depth.get(id)!;
    angle.set(id, a);
    const node = byId.get(id)!;
    points.push({ id, title: node.title, depth: d, x: Math.round(center + Math.cos(a) * d * RING), y: Math.round(center + Math.sin(a) * d * RING) });
  };
  place(graph.rootNodeId, 0);
  for (let ring = 1; ring <= maxDepth; ring++) {
    // Keep each note near the note that reached it, so lines stay short.
    const members = kept.filter(id => depth.get(id) === ring)
      .sort((a, b) => (angle.get(parent.get(a)!) ?? 0) - (angle.get(parent.get(b)!) ?? 0) || title(a).localeCompare(title(b)));
    const slot = (index: number) => -Math.PI / 2 + (2 * Math.PI * index) / members.length;
    // Turn the ring so each note sits as close as possible to its parent's direction (circular mean of the offsets).
    const ideal = members.map(id => angle.get(parent.get(id)!) ?? 0);
    const turn = ring === 1 ? 0 : Math.atan2(
      ideal.reduce((sum, a, index) => sum + Math.sin(a - slot(index)), 0),
      ideal.reduce((sum, a, index) => sum + Math.cos(a - slot(index)), 0),
    );
    members.forEach((id, index) => place(id, slot(index) + turn));
  }
  const at = new Map(points.map(point => [point.id, point]));
  const seen = new Set<string>();
  const lines: GraphLine[] = [];
  for (const edge of graph.edges) {
    const a = at.get(edge.source), b = at.get(edge.target);
    const key = `${edge.source}\n${edge.target}\n${edge.edgeType}`;
    if (!a || !b || a === b || seen.has(key)) continue;
    seen.add(key);
    lines.push({ source: a.id, target: b.id, edgeType: edge.edgeType, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  return { points, lines, size: 2 * center, hidden };
}

/** A label that fits under a graph node. */
export const shortLabel = (text: string, max = 18): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
