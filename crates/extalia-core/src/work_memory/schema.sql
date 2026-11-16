CREATE TABLE work_memory_state (profile_id TEXT NOT NULL PRIMARY KEY);
CREATE TABLE work_memory_records (
  id TEXT NOT NULL UNIQUE,
  scope_key TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_session TEXT NOT NULL,
  source_episode TEXT NOT NULL,
  source_access TEXT NOT NULL,
  revision TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  record_json TEXT NOT NULL
);
CREATE INDEX work_memory_scope_time ON work_memory_records(scope_key, captured_at DESC, id);
CREATE VIRTUAL TABLE work_memory_fts USING fts5(title, summary, body, tokenize='unicode61 remove_diacritics 2');
