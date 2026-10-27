/**
 * Knowledge (W5, ADR 0024 and its 2026-10-23 amendment): the host API over the Rust core's
 * per-profile knowledge index. Markdown in the profile's vault is the authored truth; the index
 * is derived data. The host scopes every call to the caller's profile (no method takes a profile
 * id or an absolute path), and every title, alias, path, link text, snippet and body is untrusted
 * vault content (ADR 0027): front matter `verification` is declared, never trust.
 *
 * Result types reuse the daemon contract (`@extalia/protocol` `daemonKnowledge.ts`) unchanged, so
 * the host forwards daemon results; only `KnowledgeStatus` adds the skipped-file list of the latest
 * sync the host ran. The validators bound every value a client sends before the host acts on it.
 * Pure functions only: the host, the Bridge, Desktop and the Web client all use this module.
 */
import {
  DAEMON_KNOWLEDGE_LIMITS, KNOWLEDGE_NODE_ID_PATTERN, KNOWLEDGE_PATH_PATTERN, KNOWLEDGE_SYNC_MODES,
  type DaemonKnowledgeOperations, type KnowledgeBodyStatus, type KnowledgeCounts, type KnowledgeEdgeType, type KnowledgeGraphEdge, type KnowledgeIndexState,
  type KnowledgeLink, type KnowledgeLinkPage, type KnowledgeLinkStatus, type KnowledgeNode, type KnowledgeNodeRef, type KnowledgeOverviewEdge, type KnowledgeOverviewNode, type KnowledgeRename, type KnowledgeResolution,
  type KnowledgeSearchHit, type KnowledgeSkippedFile, type KnowledgeSkipReason, type KnowledgeSyncMode, type KnowledgeSyncSummary, type KnowledgeTrustStatus,
} from '@extalia/protocol';

export type {
  KnowledgeBodyStatus, KnowledgeCounts, KnowledgeEdgeType, KnowledgeGraphEdge, KnowledgeIndexState, KnowledgeLink, KnowledgeLinkPage, KnowledgeLinkStatus, KnowledgeNode,
  KnowledgeNodeRef, KnowledgeOverviewEdge, KnowledgeOverviewNode, KnowledgeRename, KnowledgeResolution, KnowledgeSearchHit, KnowledgeSkippedFile, KnowledgeSkipReason, KnowledgeSyncMode, KnowledgeSyncSummary,
  KnowledgeTrustStatus,
};

type Result<Op extends keyof DaemonKnowledgeOperations> = DaemonKnowledgeOperations[Op]['result'];

/**
 * `knowledge.status`, plus the files the latest sync this host ran did not index (at most
 * `DAEMON_KNOWLEDGE_LIMITS.reportItems`; `counts.skipped` and `lastSync.skipped` are the totals).
 * Empty after a host restart until the next sync. `state: 'unavailable'` carries a `reason`.
 */
export type KnowledgeStatus = Result<'knowledge.status'> & {
  skipped: KnowledgeSkippedFile[];
  /** Which edit operations the native core serves (`knowledgeEdit.ts`); absent: none (read-only page). */
  editing?: KnowledgeEditing;
};
/** Note editing (read, write, history, rollback) and memory import, as the host can serve them now. */
export interface KnowledgeEditing { notes: boolean; memoryImport: boolean }
export type KnowledgeSyncReport = Result<'knowledge.sync'>;
/** A sync's report with the fresh status. */
export interface KnowledgeSyncOutcome { report: KnowledgeSyncReport; status: KnowledgeStatus }
/** One note: provenance, and its body after the front matter (`bodyStatus` `changed`: sync again). */
export type KnowledgeNoteResult = Result<'knowledge.node'>;
export type KnowledgeSearchResult = Result<'knowledge.search'>;
export type KnowledgeGraph = Result<'knowledge.graph'>;
/** Look a note up by node id or by vault-relative path. */
export type KnowledgeNodeLookup = { nodeId: string } | { path: string };

/** Bounds of `knowledge.overview` (the whole-vault graph): notes and edges per answer (the daemon's defaults are these caps). */
export const KNOWLEDGE_OVERVIEW_LIMITS = { nodes: DAEMON_KNOWLEDGE_LIMITS.overviewNodes, edges: DAEMON_KNOWLEDGE_LIMITS.overviewEdges } as const;
/** How much of the vault graph to return; the daemon uses its defaults for what is left out. */
export type KnowledgeOverviewOptions = DaemonKnowledgeOperations['knowledge.overview']['params'];
/**
 * `knowledge.overview`: the most connected notes (with folder, tags, degrees and mtime) and the resolved links among
 * them; `truncated` when `nodes` or `edges` is shorter than its total (`totalNodes`, `totalEdges`).
 */
export type KnowledgeOverview = Result<'knowledge.overview'>;

/** Host methods of this module, in `AGENT_HOST_METHODS` order. All optional on `AgentHostApi`. */
export const KNOWLEDGE_HOST_METHODS = [
  'knowledgeStatus', 'syncKnowledge', 'knowledgeNode', 'knowledgeLinks', 'knowledgeBacklinks', 'searchKnowledge', 'knowledgeGraph', 'knowledgeOverview',
] as const;

/** What the host asks the daemon for on the UI's behalf (within `DAEMON_KNOWLEDGE_LIMITS`). */
export const KNOWLEDGE_UI_LIMITS = {
  /** Search hits per query (`knowledge.search` `limit`). */
  searchResults: DAEMON_KNOWLEDGE_LIMITS.searchDefault,
  /** Links per page (`knowledge.links` / `knowledge.backlinks` `limit`). */
  linkPage: DAEMON_KNOWLEDGE_LIMITS.pageDefault,
  /** The UI offers depth 1 and 2; the daemon allows up to 3. */
  graphDepth: 2,
  /** Notes of one local graph (`knowledge.graph` `limit`): small enough to read. */
  graphNodes: 60,
} as const;

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});
// eslint-disable-next-line no-control-regex -- Intentionally reject control characters in untrusted input.
const CONTROL = /[\u0000-\u001f\u007f]/;

export function normalizeKnowledgeSyncMode(value: unknown): KnowledgeSyncMode {
  if (value === undefined || value === null) return 'incremental';
  if (typeof value !== 'string' || !(KNOWLEDGE_SYNC_MODES as readonly string[]).includes(value)) throw new Error('Invalid knowledge sync mode.');
  return value as KnowledgeSyncMode;
}

/** A vault-relative note path (`KNOWLEDGE_PATH_PATTERN`): `/`-separated, no segment empty or starting with `.`, no backslash. */
export function normalizeKnowledgePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > DAEMON_KNOWLEDGE_LIMITS.path || !KNOWLEDGE_PATH_PATTERN.test(value)) throw new Error('Invalid note path.');
  return value;
}

/** A node id: a front matter id, or `path:` and a vault-relative path. */
export function normalizeKnowledgeNodeId(value: unknown): string {
  if (typeof value !== 'string' || value.length > DAEMON_KNOWLEDGE_LIMITS.nodeId || !KNOWLEDGE_NODE_ID_PATTERN.test(value)) throw new Error('Invalid note id.');
  return value;
}

export function normalizeKnowledgeNodeLookup(value: unknown): KnowledgeNodeLookup {
  const input = record(value);
  const hasId = input.nodeId !== undefined, hasPath = input.path !== undefined;
  if (hasId && !hasPath) return { nodeId: normalizeKnowledgeNodeId(input.nodeId) };
  if (hasPath && !hasId) return { path: normalizeKnowledgePath(input.path) };
  throw new Error('Name a note by id or by path.');
}

/** Search text: trimmed, single-line, 1–200 characters. The daemon quotes every term (no query syntax). */
export function normalizeKnowledgeQuery(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter search text.');
  const text = value.trim();
  if (!text) throw new Error('Enter search text.');
  if (text.length > DAEMON_KNOWLEDGE_LIMITS.query || CONTROL.test(text)) throw new Error(`Search text must be one line of at most ${DAEMON_KNOWLEDGE_LIMITS.query} characters.`);
  return text;
}

/** Graph depth: an integer from 1 to 3 (the UI offers 1 and 2); 1 when left out. */
export function normalizeKnowledgeGraphDepth(value: unknown): number {
  if (value === undefined || value === null) return DAEMON_KNOWLEDGE_LIMITS.graphDepthDefault;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > DAEMON_KNOWLEDGE_LIMITS.graphDepth) throw new Error('Invalid graph depth.');
  return value;
}

/** A page cursor from a previous `nextCursor`; 0 when left out. */
export function normalizeKnowledgeCursor(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid page cursor.');
  return value;
}

/** Overview bounds: integers within `KNOWLEDGE_OVERVIEW_LIMITS`; left out (or `null`) means the daemon's default. */
export function normalizeKnowledgeOverviewOptions(value: unknown): KnowledgeOverviewOptions {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid graph overview options.');
  const input = value as Record<string, unknown>;
  const bound = (raw: unknown, max: number, label: string): number | undefined => {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > max) throw new Error(`The graph overview ${label} limit must be a whole number from 1 to ${max}.`);
    return raw;
  };
  const nodeLimit = bound(input.nodeLimit, KNOWLEDGE_OVERVIEW_LIMITS.nodes, 'note');
  const edgeLimit = bound(input.edgeLimit, KNOWLEDGE_OVERVIEW_LIMITS.edges, 'link');
  return { ...(nodeLimit !== undefined ? { nodeLimit } : {}), ...(edgeLimit !== undefined ? { edgeLimit } : {}) };
}
