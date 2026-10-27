/**
 * Knowledge index operations of the daemon wire contract v1 (W5 slice 2a; ADR 0024 and its
 * 2026-10-23 amendment, ADR 0027). Additive within schema version 1: read and sync only,
 * no note writes. A daemon advertises them in `hello` only when it runs with a data
 * directory, and the host sends only advertised operations.
 *
 * Rules beyond the field types:
 * - A daemon serves exactly one profile; the wire carries no profile id and no absolute
 *   path. Paths are vault-relative with `/` separators (`KNOWLEDGE_PATH_PATTERN`); the vault
 *   root is reported only as a label relative to the data directory (`vaults/<profile>`).
 * - The index (`<data>/profiles/<profile>/knowledge.sqlite`) is opened lazily on the first
 *   knowledge operation. When it cannot be opened, `knowledge.status` reports
 *   `unavailable` with a `reason` and the other operations are refused with that reason;
 *   the daemon keeps serving everything else. `knowledge.sync` with `rebuild` discards an
 *   index whose schema or integrity check failed and rebuilds it from Markdown.
 * - `knowledge.sync` creates the default vault root when it is absent (first sync).
 * - Note data (titles, paths, aliases, link text, bodies, snippets) is untrusted vault
 *   content (ADR 0027): `trustStatus` is `untrusted` and `declared*` fields mirror front
 *   matter without granting anything.
 * - A link the profile cannot resolve reads `missing` whether or not another profile has
 *   such a note (ACL denial and non-existence are indistinguishable, AC-24).
 * - `knowledge.node` returns the note body after its front matter only, at most
 *   `DAEMON_KNOWLEDGE_LIMITS.bodyBytes` UTF-8 bytes (`bodyTruncated`), never other files.
 *   `bodyStatus` `changed` means the file differs from the indexed revision (sync again).
 * - Lists that can be long are paginated (`cursor` = offset from a previous `nextCursor`)
 *   or bounded with totals; a daemon also stops a page early to keep every frame below
 *   `DAEMON_MAX_FRAME_BYTES`. A `generation` change between pages means the index changed.
 * - Text the wire cannot carry (control characters, a backslash in a skipped file name) is
 *   replaced by U+FFFD in reports; notes with such paths cannot be addressed by path.
 * - `knowledge.overview` is the bounded whole-vault graph: distinct resolved links between two
 *   different visible notes (ambiguous, missing and self links are left out; repeated links
 *   of one type from one note to another count once). Degrees count that edge set over the
 *   whole vault. When it does not fit, the most connected notes are kept (degree descending,
 *   then node id) and the edges among them by the summed degree of their ends descending
 *   (then source, target, type); a daemon also lowers both limits to keep the frame below
 *   `DAEMON_MAX_FRAME_BYTES`. `truncated` is set whenever `nodes` or `edges` is shorter than
 *   its total.
 * - Refusals carry a `reason`: `index_locked`, `index_unavailable`, `index_newer_schema`,
 *   `index_corrupt` (rebuild recreates it), `vault_unavailable`, `vault_too_large`,
 *   `note_changed` (retry), `node_not_found`, `result_too_large`, `io_failure`,
 *   `unrepresentable_result` (`internal`).
 *
 * Note writes, history and memory import (W5 slice 2c; ADR 0024 slice 2b note):
 * - `knowledge.read` is the reviewed read: the whole file (front matter included) exactly as
 *   stored, at most `readBytes` UTF-8 bytes (`truncated`), and the SHA-256 of all its bytes.
 *   That hash is the `expectedSha256` of a later write; a truncated body must not be written
 *   back. Missing note: `not_found` / `note_not_found`.
 * - `knowledge.write` is a compare-and-swap: `expectedSha256` is the hash of the read, `null`
 *   (or absent) when the note must not exist yet. Nothing is replaced on a mismatch: the
 *   proposal becomes a conflict copy next to the note (`outcome: 'conflict'`, `conflictPath`,
 *   `conflictReason`) and `sha256` is then what is on disk now (absent: no note). `written`
 *   carries the new `sha256` and the replaced `previousSha256` (absent for a new note);
 *   `unchanged` means the note already has exactly this content. Only `author: 'user'` (a
 *   person who reviewed the read) exists on the wire; Extalia-authored writes stay inside
 *   the daemon. Content is at most `contentBytes` UTF-8 bytes (the frame limit also applies)
 *   and must be well-formed Unicode.
 * - `knowledge.history` lists the note's revision journal, newest first: `write` (create or
 *   update), `rollback`, `conflict` (`sha256` = the conflict copy, `previousSha256` = what was
 *   on disk, `conflictPath`) and `external` (a version written outside Extalia, seen as the
 *   previous content of a later journal entry; `author: 'external'`). Every listed `sha256`
 *   of a `write`, `rollback` or `external` entry, and every `previousSha256`, can be restored.
 * - `knowledge.rollback` restores a version from the note's own history through the same
 *   compare-and-swap (`expectedSha256` from a read; `null` restores a deleted note).
 *   Unknown version: `not_found` / `unknown_version`.
 * - `knowledge.importMemory` imports the host's legacy memory notes of one workspace
 *   (`<data>/workspaces/<workspaceId>/memory/*.md`; never a path from the wire) into
 *   `Projects/<workspaceId>/Memory/<name>.md` as Extalia-managed notes, idempotently;
 *   `dryRun` reports the outcomes without writing anything. The host sends only workspaces of
 *   the daemon's profile. `masked` counts credentials masked by this import.
 * - After a write, rollback or import that changed the vault the daemon runs an incremental
 *   sync, so index reads reflect it.
 * - Write refusals: `invalid_request` (`invalid_path`), `capacity_exceeded` (`too_large`),
 *   `denied` (`not_utf8`, `unsafe_path`: a symbolic link, special file or hard link on the
 *   note's path), `not_found` (`note_not_found`, `unknown_version`), `storage_failure`
 *   (`history_unavailable`, `vault_unavailable`, `io_failure`) and `conflict` (`note_changed`).
 * - Vault root: the default `<data>/vaults/<profile>` (label `vaults/<profile>`) or a
 *   user-chosen folder passed to the daemon (`--vault-root`), reported only as
 *   `custom:<folder name>`. A custom root is never created or replaced by another path; when
 *   it is missing or moved the vault is `vault_unavailable`.
 */

export const DAEMON_KNOWLEDGE_OPS = [
  'knowledge.status', 'knowledge.sync', 'knowledge.node', 'knowledge.links', 'knowledge.backlinks', 'knowledge.search', 'knowledge.graph',
  'knowledge.overview', 'knowledge.read', 'knowledge.write', 'knowledge.history', 'knowledge.rollback', 'knowledge.importMemory',
] as const;
export type DaemonKnowledgeOp = (typeof DAEMON_KNOWLEDGE_OPS)[number];

export const KNOWLEDGE_SYNC_MODES = ['incremental', 'rebuild'] as const;
export type KnowledgeSyncMode = (typeof KNOWLEDGE_SYNC_MODES)[number];
export const KNOWLEDGE_INDEX_STATES = ['ready', 'unavailable'] as const;
export type KnowledgeIndexState = (typeof KNOWLEDGE_INDEX_STATES)[number];
export const KNOWLEDGE_EDGE_TYPES = ['links_to', 'related_to', 'learned_from', 'depends_on', 'supersedes', 'used_by'] as const;
export type KnowledgeEdgeType = (typeof KNOWLEDGE_EDGE_TYPES)[number];
export const KNOWLEDGE_LINK_STATUSES = ['resolved', 'missing', 'ambiguous'] as const;
export type KnowledgeLinkStatus = (typeof KNOWLEDGE_LINK_STATUSES)[number];
/** Resolution tier of a resolved link: exact path, unique path suffix, file name, alias. */
export const KNOWLEDGE_RESOLUTIONS = ['path', 'path_suffix', 'title', 'alias'] as const;
export type KnowledgeResolution = (typeof KNOWLEDGE_RESOLUTIONS)[number];
export const KNOWLEDGE_SKIP_REASONS = [
  'symlink', 'special_file', 'hard_link', 'invalid_name', 'too_deep', 'too_large', 'not_utf8', 'invalid_front_matter', 'profile_mismatch', 'duplicate_id',
] as const;
export type KnowledgeSkipReason = (typeof KNOWLEDGE_SKIP_REASONS)[number];
export const KNOWLEDGE_BODY_STATUSES = ['current', 'changed', 'unavailable'] as const;
export type KnowledgeBodyStatus = (typeof KNOWLEDGE_BODY_STATUSES)[number];
export const KNOWLEDGE_ORIGINS = ['vault'] as const;
/** ADR 0027 trust statuses; indexed vault notes are always `untrusted`. */
export const KNOWLEDGE_TRUST_STATUSES = ['untrusted', 'unverified', 'verified', 'disputed', 'superseded', 'revoked'] as const;
export type KnowledgeTrustStatus = (typeof KNOWLEDGE_TRUST_STATUSES)[number];
export const KNOWLEDGE_WRITE_OUTCOMES = ['written', 'unchanged', 'conflict'] as const;
export type KnowledgeWriteOutcome = (typeof KNOWLEDGE_WRITE_OUTCOMES)[number];
export const KNOWLEDGE_CONFLICT_REASONS = ['hash_mismatch', 'changed_during_write', 'not_managed'] as const;
export type KnowledgeConflictReason = (typeof KNOWLEDGE_CONFLICT_REASONS)[number];
/** Wire authors of a write; Extalia-authored writes are daemon-internal. */
export const KNOWLEDGE_WRITE_AUTHORS = ['user'] as const;
export type KnowledgeWriteAuthor = (typeof KNOWLEDGE_WRITE_AUTHORS)[number];
export const KNOWLEDGE_HISTORY_KINDS = ['write', 'rollback', 'conflict', 'external'] as const;
export type KnowledgeHistoryKind = (typeof KNOWLEDGE_HISTORY_KINDS)[number];
export const KNOWLEDGE_IMPORT_OUTCOMES = ['created', 'updated', 'unchanged', 'conflict', 'pending_conflict', 'missing_in_vault', 'skipped'] as const;
export type KnowledgeImportOutcome = (typeof KNOWLEDGE_IMPORT_OUTCOMES)[number];
/** Journal author: `user`, `external` (written outside Extalia) or an Extalia component (`extalia:memory-import`). */
export const KNOWLEDGE_HISTORY_AUTHOR_PATTERN = /^(?:user|external|extalia:[a-z0-9][a-z0-9-]{0,63})$/;

/**
 * Vault-relative note or file path: `/`-separated segments, none empty or starting with `.`,
 * no backslash or control character, at most `DAEMON_KNOWLEDGE_LIMITS.path` characters.
 */
// eslint-disable-next-line no-control-regex -- Protocol paths explicitly exclude C0 control characters.
export const KNOWLEDGE_PATH_PATTERN = /^[^./\\\x00-\x1f\x7f][^/\\\x00-\x1f\x7f]*(?:\/[^./\\\x00-\x1f\x7f][^/\\\x00-\x1f\x7f]*)*$/;
/**
 * The vault root as reported, never absolute: `vaults/<profile>` (the default, relative to the
 * data directory) or `custom:<folder name>` for a user-chosen root (ADR 0024 V3), the last
 * folder name only (control characters and backslashes replaced, at most `customLabel`
 * characters).
 */
// eslint-disable-next-line no-control-regex -- The folder name excludes C0 control characters like paths do.
export const KNOWLEDGE_VAULT_LABEL_PATTERN = /^(?:vaults\/[a-z0-9][a-z0-9-]{0,63}|custom:[^/\\\x00-\x1f\x7f]+)$/;
/** Node id: a front matter `id` (`^[a-z0-9][a-z0-9._-]{0,127}$`) or `path:` and a vault path. */
// eslint-disable-next-line no-control-regex -- Path-based identifiers use the same explicit control-character exclusion.
export const KNOWLEDGE_NODE_ID_PATTERN = /^(?:[a-z0-9][a-z0-9._-]{0,127}|path:[^./\\\x00-\x1f\x7f][^/\\\x00-\x1f\x7f]*(?:\/[^./\\\x00-\x1f\x7f][^/\\\x00-\x1f\x7f]*)*)$/;
/** A note's vault-relative parent folder: a vault path, or `''` for the vault root. */
export const KNOWLEDGE_FOLDER_PATTERN = new RegExp(`^(?:${KNOWLEDGE_PATH_PATTERN.source.slice(1, -1)})?$`);

export const DAEMON_KNOWLEDGE_LIMITS = {
  path: 1024,
  nodeId: 1100,
  title: 512,
  kind: 32,
  verification: 32,
  alias: 256,
  tag: 128,
  taskId: 128,
  /** Aliases, tags and source task ids per node. */
  listItems: 64,
  linkText: 512,
  candidates: 16,
  query: 200,
  searchLimit: 50,
  searchDefault: 20,
  snippet: 300,
  /** `knowledge.links` / `knowledge.backlinks` page size. */
  pageLimit: 200,
  pageDefault: 100,
  graphDepth: 3,
  graphDepthDefault: 1,
  graphNodes: 500,
  graphNodesDefault: 200,
  graphEdges: 2_000,
  /** `knowledge.overview` caps and defaults (the defaults are the caps). */
  overviewNodes: 2_000,
  overviewEdges: 8_000,
  /** Tags per overview node and their length (clipped). */
  overviewTags: 8,
  overviewTag: 64,
  /** Renames and skipped files listed by `knowledge.sync`; the totals count all. */
  reportItems: 100,
  /** Largest note body `knowledge.node` returns, in UTF-8 bytes. */
  bodyBytes: 256 * 1024,
  /** Largest file text `knowledge.read` returns, in UTF-8 bytes. */
  readBytes: 256 * 1024,
  /** Largest `knowledge.write` content, in UTF-8 bytes (a note's size cap; the frame limit also applies). */
  contentBytes: 1024 * 1024,
  /** `knowledge.history` entries. */
  historyLimit: 50,
  historyDefault: 20,
  /** Notes listed by `knowledge.importMemory`; the counts count all. */
  importNotes: 500,
  /** Source file name as reported by `knowledge.importMemory` (clipped). */
  importName: 128,
  /** Folder name in a `custom:` vault label (clipped). */
  customLabel: 128,
  /** Length of a journal author. */
  author: 80,
} as const;

/** `skipped`: files the index read and refused (front matter, size, encoding, duplicate id); walk-time refusals such as symbolic links appear in sync reports only. */
export interface KnowledgeCounts { notes: number; edges: number; unresolvedLinks: number; skipped: number }
export interface KnowledgeSyncSummary {
  mode: KnowledgeSyncMode;
  at: string;
  generation: number;
  notes: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  renamed: number;
  skipped: number;
  unresolvedLinks: number;
}
export interface KnowledgeRename { from: string; to: string }
export interface KnowledgeSkippedFile { path: string; reason: KnowledgeSkipReason }
export interface KnowledgeNodeRef { nodeId: string; path: string; title: string }
/** A note with its provenance (ADR 0027). */
export interface KnowledgeNode {
  nodeId: string;
  idFromFrontMatter: boolean;
  path: string;
  kind: string;
  title: string;
  aliases: string[];
  tags: string[];
  origin: (typeof KNOWLEDGE_ORIGINS)[number];
  trustStatus: KnowledgeTrustStatus;
  sourceSha256: string;
  /** File modification time when indexed (source clock). */
  sourceModifiedAt?: string;
  /** When Extalia indexed this revision. */
  observedAt: string;
  declaredVerification?: string;
  declaredRevision?: number;
  declaredSourceTaskIds: string[];
}
/**
 * One link occurrence. `resolved` carries `targetNodeId` and `via`; `ambiguous` carries the
 * visible `candidates` (sorted by path); `missing` carries neither.
 */
export interface KnowledgeLink {
  sourceNodeId: string;
  ordinal: number;
  edgeType: KnowledgeEdgeType;
  embed: boolean;
  line: number;
  /** The target as written. */
  target: string;
  heading?: string;
  display?: string;
  status: KnowledgeLinkStatus;
  via?: KnowledgeResolution;
  targetNodeId?: string;
  candidates?: string[];
}
export interface KnowledgeLinkPage {
  generation: number;
  nodeId: string;
  links: KnowledgeLink[];
  /** The other endpoints on this page that are visible notes (targets or sources). */
  nodes: KnowledgeNodeRef[];
  nextCursor?: number;
}
export interface KnowledgeSearchHit { nodeId: string; path: string; title: string; snippet?: string }
export interface KnowledgeGraphEdge { source: string; target: string; edgeType: KnowledgeEdgeType }
/** A note of the whole-vault overview. Degrees count overview edges over the whole vault. */
export interface KnowledgeOverviewNode {
  nodeId: string;
  title: string;
  path: string;
  kind?: string;
  /** Vault-relative parent folder, `''` for the vault root. */
  folder: string;
  /** At most `overviewTags` tags of at most `overviewTag` characters each. */
  tags: string[];
  degree: number;
  inDegree: number;
  outDegree: number;
  /** Source file modification time when indexed. */
  modifiedAt: string;
}
/** A resolved link between two included notes; one per source, target and type. */
export interface KnowledgeOverviewEdge { source: string; target: string; type: KnowledgeEdgeType }
/**
 * Result of `knowledge.write` and `knowledge.rollback`. `written`: `sha256` (new), `previousSha256`
 * (absent for a new note). `unchanged`: `sha256` only. `conflict`: `conflictPath`,
 * `conflictReason` and `sha256` = what is on disk now (absent when the note does not exist).
 */
export interface KnowledgeWriteResult {
  outcome: KnowledgeWriteOutcome;
  path: string;
  sha256?: string;
  previousSha256?: string;
  conflictPath?: string;
  conflictReason?: KnowledgeConflictReason;
}
/** One revision journal entry (see the module rules for the kinds). */
export interface KnowledgeHistoryEntry {
  sha256: string;
  at: string;
  kind: KnowledgeHistoryKind;
  author: string;
  /** Content on disk before this entry (absent for a created note). */
  previousSha256?: string;
  /** The conflict copy of a `conflict` entry. */
  conflictPath?: string;
}
/** One legacy memory note. `vaultPath` is absent only for a file skipped as `invalid_name`; `reason` is set exactly for `skipped`. */
export interface KnowledgeImportedNote {
  name: string;
  vaultPath?: string;
  outcome: KnowledgeImportOutcome;
  masked: number;
  reason?: KnowledgeSkipReason;
}
export interface KnowledgeImportCounts {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  conflict: number;
  pendingConflict: number;
  missingInVault: number;
  skipped: number;
  /** Credentials masked over all notes. */
  masked: number;
}

export interface DaemonKnowledgeOperations {
  /** Index availability, generation, counts and this daemon's last sync. Never refused for an unavailable index. */
  'knowledge.status': {
    params: Record<string, never>;
    result: {
      state: KnowledgeIndexState;
      reason?: string;
      /** A label, never a path: `vaults/<profile>` (default) or `custom:<folder name>`. `lastSync` is this daemon process's last sync only. */
      vaultRoot: string;
      vaultPresent: boolean;
      schemaVersion?: number;
      generation: number;
      counts?: KnowledgeCounts;
      lastSync?: KnowledgeSyncSummary;
    };
  };
  /** Bring the index in line with the vault; `rebuild` re-indexes every note from empty. */
  'knowledge.sync': {
    params: { mode: KnowledgeSyncMode };
    result: {
      mode: KnowledgeSyncMode;
      at: string;
      generation: number;
      notes: number;
      added: number;
      updated: number;
      removed: number;
      unchanged: number;
      unresolvedLinks: number;
      renamed: KnowledgeRename[];
      renamedTotal: number;
      skipped: KnowledgeSkippedFile[];
      skippedTotal: number;
      vaultCreated: boolean;
    };
  };
  /** One note by node id or vault-relative path (exactly one of them). */
  'knowledge.node': {
    params: { nodeId: string; path?: never } | { path: string; nodeId?: never };
    result: { generation: number; node: KnowledgeNode; body?: string; bodyStatus: KnowledgeBodyStatus; bodyTruncated: boolean };
  };
  /** Links written in a note, in order, with resolution status. */
  'knowledge.links': { params: { nodeId: string; cursor?: number; limit?: number }; result: KnowledgeLinkPage };
  /** Resolved links pointing at a note, by source then position. */
  'knowledge.backlinks': { params: { nodeId: string; cursor?: number; limit?: number }; result: KnowledgeLinkPage };
  /** Full-text search; every whitespace-separated term must match (no query syntax). */
  'knowledge.search': {
    params: { query: string; limit?: number };
    result: { generation: number; hits: KnowledgeSearchHit[] };
  };
  /** Bounded neighbourhood over resolved edges in both directions. */
  'knowledge.graph': {
    params: { nodeId: string; depth?: number; limit?: number };
    result: { generation: number; rootNodeId: string; depth: number; nodes: Array<{ nodeId: string; title: string }>; edges: KnowledgeGraphEdge[]; truncated: boolean };
  };
  /** Bounded whole-vault graph: the most connected notes and the resolved links among them. */
  'knowledge.overview': {
    params: { nodeLimit?: number; edgeLimit?: number };
    result: {
      generation: number;
      totalNodes: number;
      totalEdges: number;
      truncated: boolean;
      nodes: KnowledgeOverviewNode[];
      edges: KnowledgeOverviewEdge[];
    };
  };
  /** The reviewed read: the file exactly as stored and the hash a later write passes as `expectedSha256`. */
  'knowledge.read': {
    params: { path: string };
    result: { path: string; sha256: string; managed: boolean; body: string; truncated: boolean };
  };
  /** Compare-and-swap note write; never replaces content the caller has not read. */
  'knowledge.write': {
    params: { path: string; content: string; expectedSha256?: string | null; author: KnowledgeWriteAuthor };
    result: KnowledgeWriteResult;
  };
  /** The note's revision journal, newest first. */
  'knowledge.history': {
    params: { path: string; limit?: number };
    result: { path: string; entries: KnowledgeHistoryEntry[] };
  };
  /** Restore a version from the note's own history (compare-and-swap with `expectedSha256`). */
  'knowledge.rollback': {
    params: { path: string; toSha256: string; expectedSha256: string | null };
    result: KnowledgeWriteResult;
  };
  /** Import the host's legacy memory notes of one workspace of this profile; `dryRun` writes nothing. */
  'knowledge.importMemory': {
    params: { workspaceId: string; dryRun?: boolean };
    result: { notes: KnowledgeImportedNote[]; counts: KnowledgeImportCounts; truncated?: boolean };
  };
}
