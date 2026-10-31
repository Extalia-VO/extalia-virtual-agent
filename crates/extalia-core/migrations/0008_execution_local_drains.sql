-- Scoped local operation evidence, separate from weaker turn observations.
-- Never infer proof from existing receipts or terminal state.
CREATE TABLE execution_local_drains (
  proof_id TEXT PRIMARY KEY NOT NULL CHECK (length(proof_id) = 36),
  profile_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  holder_agent_id TEXT NOT NULL CHECK (length(holder_agent_id) = 36),
  supervisor_id TEXT NOT NULL CHECK (length(supervisor_id) = 36),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  admission_digest TEXT NOT NULL CHECK (length(admission_digest) = 64),
  kind TEXT NOT NULL CHECK (kind = 'local-operations-drained'),
  coverage TEXT NOT NULL CHECK (coverage = 'extalia-native-local-v1'),
  provider_operations INTEGER NOT NULL CHECK (provider_operations BETWEEN 0 AND 20),
  tool_operations INTEGER NOT NULL CHECK (tool_operations BETWEEN 0 AND 80),
  recorded_at TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  payload TEXT NOT NULL CHECK (length(CAST(payload AS BLOB)) BETWEEN 1 AND 4096),
  UNIQUE (lease_id),
  FOREIGN KEY (profile_id, lease_id) REFERENCES execution_admissions (profile_id, lease_id) ON DELETE RESTRICT,
  FOREIGN KEY (profile_id, lease_id) REFERENCES execution_observations (profile_id, lease_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX execution_local_drains_mission ON execution_local_drains (profile_id, mission_id);
CREATE TRIGGER execution_local_drains_limit BEFORE INSERT ON execution_local_drains
WHEN (SELECT count(*) FROM execution_local_drains WHERE profile_id = NEW.profile_id AND mission_id = NEW.mission_id) >= 64
BEGIN SELECT RAISE(ABORT, 'execution local drain limit'); END;
CREATE TRIGGER execution_local_drains_no_update BEFORE UPDATE ON execution_local_drains
BEGIN SELECT RAISE(ABORT, 'execution local drains are immutable'); END;
CREATE TRIGGER execution_local_drains_no_delete BEFORE DELETE ON execution_local_drains
BEGIN SELECT RAISE(ABORT, 'execution local drains are immutable'); END;
