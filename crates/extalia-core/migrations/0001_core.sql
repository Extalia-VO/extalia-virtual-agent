-- Core store schema 1 (ADR 0019). The migrator applies this file in one transaction and
-- sets user_version; it must not contain transaction control or PRAGMA statements.
-- Released migrations are immutable: change the schema with a new numbered file.
--
-- Every row carries profile_id. Child rows reference their parent through
-- (profile_id, parent_id), so a row can never belong to another profile than its parent.
-- `payload` is the canonical contract JSON (@extalia/protocol) and `digest` its SHA-256:
-- an identical retry returns the original acknowledgement, a different one is a conflict
-- (ADR 0014). Contract validation, caps and ownership checks stay in the store code.

CREATE TABLE missions (
  mission_id TEXT PRIMARY KEY NOT NULL CHECK (length(mission_id) = 36),
  profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 200),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) = 36),
  state TEXT NOT NULL CHECK (state IN ('draft', 'planning', 'queued', 'running', 'waiting', 'awaiting_approval', 'reviewing', 'completed', 'failed', 'cancelled', 'recovering')),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  payload TEXT NOT NULL,
  UNIQUE (profile_id, mission_id)
) STRICT;

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY NOT NULL CHECK (length(task_id) = 36),
  profile_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'blocked', 'assigned', 'running', 'waiting', 'awaiting_approval', 'verifying', 'completed', 'failed', 'cancelled', 'unknown')),
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  updated_at TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  payload TEXT NOT NULL,
  UNIQUE (profile_id, task_id),
  FOREIGN KEY (profile_id, mission_id) REFERENCES missions (profile_id, mission_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX tasks_mission ON tasks (profile_id, mission_id);

-- Mission control events (ADR 0014). The store assigns `sequence` per mission inside the
-- commit transaction; a mission determines its profile, so the unique key below is the
-- per-mission sequence and also serves profile-scoped paginated reads and the cascade.
-- The event ID is globally unique: duplicate IDs are resolved as idempotent or conflicting.
CREATE TABLE events (
  event_id TEXT PRIMARY KEY NOT NULL CHECK (length(event_id) = 36),
  profile_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  task_id TEXT CHECK (task_id IS NULL OR length(task_id) = 36),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 64),
  committed_at TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  -- At most 4 KiB of encoded event data per control event (ADR 0014).
  payload TEXT NOT NULL CHECK (length(CAST(payload AS BLOB)) BETWEEN 1 AND 4096),
  UNIQUE (profile_id, mission_id, sequence),
  FOREIGN KEY (profile_id, mission_id) REFERENCES missions (profile_id, mission_id) ON DELETE CASCADE
) STRICT;

-- At most one lease per task; a stale lease is recovered as unknown, never replayed (ADR 0013).
CREATE TABLE leases (
  lease_id TEXT PRIMARY KEY NOT NULL CHECK (length(lease_id) = 36),
  profile_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  holder_agent_id TEXT NOT NULL CHECK (length(holder_agent_id) = 36),
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (profile_id, task_id),
  FOREIGN KEY (profile_id, task_id) REFERENCES tasks (profile_id, task_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY NOT NULL CHECK (length(approval_id) = 36),
  profile_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  task_id TEXT CHECK (task_id IS NULL OR length(task_id) = 36),
  status TEXT NOT NULL CHECK (status IN ('pending', 'granted', 'rejected', 'expired', 'revoked')),
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  payload TEXT NOT NULL,
  FOREIGN KEY (profile_id, mission_id) REFERENCES missions (profile_id, mission_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX approvals_mission ON approvals (profile_id, mission_id, status);
