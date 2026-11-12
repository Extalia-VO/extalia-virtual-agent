-- Immutable import provenance, scoped to the content-addressed revision.
-- Existing revisions deliberately remain unknown: package source_ref described only
-- the first package import and cannot establish the source of later revisions.
CREATE TABLE skill_revision_sources (
  source_seq INTEGER PRIMARY KEY CHECK (source_seq > 0),
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('user', 'workspace', 'imported', 'generated')),
  source_ref TEXT NOT NULL CHECK (length(source_ref) <= 512),
  recorded_at TEXT NOT NULL,
  UNIQUE (profile_id, revision_id, origin, source_ref),
  FOREIGN KEY (profile_id, revision_id) REFERENCES skill_revisions (profile_id, revision_id)
) STRICT;
CREATE INDEX skill_revision_sources_revision ON skill_revision_sources (profile_id, revision_id, source_seq);
CREATE TRIGGER skill_revision_sources_no_update BEFORE UPDATE ON skill_revision_sources
BEGIN SELECT RAISE(ABORT, 'skill revision sources are append-only'); END;
CREATE TRIGGER skill_revision_sources_no_delete BEFORE DELETE ON skill_revision_sources
BEGIN SELECT RAISE(ABORT, 'skill revision sources are append-only'); END;
-- SQLite REPLACE can bypass DELETE triggers. Guard both the logical key and rowid alias.
CREATE TRIGGER skill_revision_sources_no_replace BEFORE INSERT ON skill_revision_sources
WHEN EXISTS (SELECT 1 FROM skill_revision_sources WHERE source_seq=NEW.source_seq
  OR (profile_id=NEW.profile_id AND revision_id=NEW.revision_id
      AND origin=NEW.origin AND source_ref=NEW.source_ref))
BEGIN SELECT RAISE(ABORT, 'skill revision sources cannot be replaced'); END;
