CREATE TABLE observed_state (profile_id TEXT NOT NULL PRIMARY KEY);
CREATE TABLE observed_episodes (
  id TEXT NOT NULL PRIMARY KEY,
  scope_key TEXT NOT NULL,
  episode_key TEXT NOT NULL,
  revision TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  searchable TEXT NOT NULL,
  UNIQUE(scope_key, episode_key)
);
CREATE INDEX observed_scope_time ON observed_episodes(scope_key, captured_at DESC, id);
