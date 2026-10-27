-- Knowledge index schema 1: one profile's rebuildable graph index (ADR 0024 §5 and its
-- 2026-10-23 amendment; provenance per ADR 0027).
--
-- File: <data>/profiles/<profile-id>/knowledge.sqlite, written only by the core. It is
-- NOT core.sqlite and has its own user_version. Markdown in the profile's vault is the
-- authored truth; every row here is derived from it and the file can be deleted and
-- rebuilt at any time. Applied in one transaction; no transaction control or PRAGMA here.
--
-- Every row carries profile_id; child rows reference their parent through composite keys
-- that include profile_id, so no row can point into another profile. Visibility is
-- 'profile' only in schema 1; workspace-scoped notes (memory import) arrive with a new
-- schema version and a rebuild.

-- The single profile this file belongs to and the graph generation (cache key, ADR 0024 §3).
CREATE TABLE knowledge_index_state (
  profile_id TEXT PRIMARY KEY NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 64),
  generation INTEGER NOT NULL CHECK (generation >= 0)
) STRICT;

-- One row per Markdown file the walker accepted: its stat and content digest (incremental
-- change detection) and whether it became a node. Skipped files keep their reason so an
-- unchanged file is not read again.
CREATE TABLE knowledge_documents (
  profile_id TEXT NOT NULL,
  path TEXT NOT NULL CHECK (length(path) BETWEEN 4 AND 1024),
  size INTEGER NOT NULL CHECK (size >= 0),
  mtime_ns INTEGER NOT NULL,
  sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('indexed', 'skipped')),
  skip_reason TEXT CHECK (skip_reason IS NULL OR skip_reason IN ('too_large', 'not_utf8', 'invalid_front_matter', 'profile_mismatch', 'duplicate_id')),
  claimed_id TEXT CHECK (claimed_id IS NULL OR length(claimed_id) BETWEEN 1 AND 128),
  CHECK ((status = 'skipped') = (skip_reason IS NOT NULL)),
  CHECK ((skip_reason IS 'duplicate_id') = (claimed_id IS NOT NULL)),
  CHECK (sha256 IS NOT NULL OR skip_reason IS 'too_large'),
  PRIMARY KEY (profile_id, path),
  FOREIGN KEY (profile_id) REFERENCES knowledge_index_state (profile_id)
) STRICT;

-- Notes. node_seq is the FTS rowid only; node_id is the identity: the front matter id, or
-- 'path:' || path when the note has none (front matter ids cannot contain ':').
CREATE TABLE knowledge_nodes (
  node_seq INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL,
  node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 1100),
  id_source TEXT NOT NULL CHECK (id_source IN ('front_matter', 'path')),
  path TEXT NOT NULL,
  -- Resolution keys (Unicode lowercase): path without '.md', and the file stem (title).
  path_key TEXT NOT NULL,
  stem_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 32),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
  tags_json TEXT NOT NULL CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array'),
  visibility TEXT NOT NULL CHECK (visibility = 'profile'),
  -- Provenance (ADR 0027). Authored Markdown is untrusted data; trust lives only in
  -- core.sqlite evidence. declared_* mirror the front matter and are never authority.
  origin TEXT NOT NULL CHECK (origin = 'vault'),
  trust_status TEXT NOT NULL CHECK (trust_status = 'untrusted'),
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  source_mtime_ns INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  declared_verification TEXT CHECK (declared_verification IS NULL OR length(declared_verification) BETWEEN 1 AND 32),
  declared_revision INTEGER CHECK (declared_revision IS NULL OR declared_revision >= 0),
  declared_source_task_ids TEXT NOT NULL CHECK (json_valid(declared_source_task_ids) AND json_type(declared_source_task_ids) = 'array'),
  UNIQUE (profile_id, node_id),
  UNIQUE (profile_id, path),
  FOREIGN KEY (profile_id, path) REFERENCES knowledge_documents (profile_id, path)
) STRICT;
CREATE INDEX knowledge_nodes_path_key ON knowledge_nodes (profile_id, path_key);
CREATE INDEX knowledge_nodes_stem_key ON knowledge_nodes (profile_id, stem_key);

CREATE TABLE knowledge_aliases (
  profile_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  alias TEXT NOT NULL CHECK (length(alias) BETWEEN 1 AND 256),
  alias_key TEXT NOT NULL,
  PRIMARY KEY (profile_id, node_id, alias_key),
  FOREIGN KEY (profile_id, node_id) REFERENCES knowledge_nodes (profile_id, node_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX knowledge_aliases_key ON knowledge_aliases (profile_id, alias_key);

-- Typed edges, first-class rows (ADR 0024 §4), one per link occurrence. Unresolved links
-- are kept (target_node_id NULL): 'missing' or 'ambiguous' (candidates below). A target
-- outside the profile can never resolve, so a denied link is stored exactly like a
-- missing one.
CREATE TABLE knowledge_edges (
  profile_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  edge_type TEXT NOT NULL CHECK (edge_type IN ('links_to', 'related_to', 'learned_from', 'depends_on', 'supersedes', 'used_by')),
  embed INTEGER NOT NULL CHECK (embed IN (0, 1)),
  line INTEGER NOT NULL CHECK (line >= 1),
  target_text TEXT NOT NULL CHECK (length(target_text) BETWEEN 1 AND 512),
  -- Normalized target (relative segments applied, '.md' removed) and its lowercase key.
  target TEXT NOT NULL,
  target_key TEXT NOT NULL,
  path_only INTEGER NOT NULL CHECK (path_only IN (0, 1)),
  heading TEXT CHECK (heading IS NULL OR length(heading) BETWEEN 1 AND 512),
  display TEXT CHECK (display IS NULL OR length(display) BETWEEN 1 AND 512),
  target_node_id TEXT,
  resolution TEXT NOT NULL CHECK (resolution IN ('path', 'path_suffix', 'title', 'alias', 'missing', 'ambiguous')),
  visibility TEXT NOT NULL CHECK (visibility = 'profile'),
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  CHECK ((target_node_id IS NOT NULL) = (resolution IN ('path', 'path_suffix', 'title', 'alias'))),
  PRIMARY KEY (profile_id, source_node_id, ordinal),
  FOREIGN KEY (profile_id, source_node_id) REFERENCES knowledge_nodes (profile_id, node_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id, target_node_id) REFERENCES knowledge_nodes (profile_id, node_id)
) STRICT;
CREATE INDEX knowledge_edges_target ON knowledge_edges (profile_id, target_node_id);
CREATE INDEX knowledge_edges_key ON knowledge_edges (profile_id, target_key);

CREATE TABLE knowledge_edge_candidates (
  profile_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  candidate_node_id TEXT NOT NULL,
  PRIMARY KEY (profile_id, source_node_id, ordinal, candidate_node_id),
  FOREIGN KEY (profile_id, source_node_id, ordinal) REFERENCES knowledge_edges (profile_id, source_node_id, ordinal) ON DELETE CASCADE,
  FOREIGN KEY (profile_id, candidate_node_id) REFERENCES knowledge_nodes (profile_id, node_id)
) STRICT;
CREATE INDEX knowledge_edge_candidates_node ON knowledge_edge_candidates (profile_id, candidate_node_id);

-- Backlinks: resolved edges seen from their target.
CREATE VIEW knowledge_backlinks AS
SELECT e.profile_id, e.target_node_id AS node_id, e.source_node_id, e.ordinal, e.edge_type, e.embed, e.line, e.heading
FROM knowledge_edges e
WHERE e.target_node_id IS NOT NULL;

-- Full-text index of title, aliases and body; rowid = knowledge_nodes.node_seq. Contentless:
-- note text is not duplicated here, results are joined back to profile-filtered nodes.
CREATE VIRTUAL TABLE knowledge_fts USING fts5(title, aliases, body, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2');
