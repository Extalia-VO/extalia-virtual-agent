-- Add asserted amendment/conflict edges without turning note declarations into trust.
-- Preserve existing derived rows, then force a parser refresh on the next successful sync.
-- All changes, including the copy, occur in the migrator's single transaction.
CREATE TEMP TABLE saved_knowledge_edges AS SELECT * FROM knowledge_edges;
CREATE TEMP TABLE saved_knowledge_edge_candidates AS SELECT * FROM knowledge_edge_candidates;
DROP VIEW knowledge_backlinks;
DROP TABLE knowledge_edge_candidates;
DROP TABLE knowledge_edges;

CREATE TABLE knowledge_edges (
  profile_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  edge_type TEXT NOT NULL CHECK (edge_type IN ('links_to', 'related_to', 'learned_from', 'depends_on', 'supersedes', 'updates', 'contradicts', 'used_by')),
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

INSERT INTO knowledge_edges SELECT * FROM saved_knowledge_edges;
INSERT INTO knowledge_edge_candidates SELECT * FROM saved_knowledge_edge_candidates;
DROP TABLE saved_knowledge_edge_candidates;
DROP TABLE saved_knowledge_edges;

CREATE INDEX knowledge_edges_recall ON knowledge_edges (profile_id, target_node_id, edge_type);
ALTER TABLE knowledge_index_state ADD COLUMN parser_revision INTEGER NOT NULL DEFAULT 0 CHECK (parser_revision >= 0);
