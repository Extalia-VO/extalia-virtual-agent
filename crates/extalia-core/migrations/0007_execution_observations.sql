-- Authority-captured admissions and once-only supervisor promise observations.
-- No historical admissions are inferred from legacy tasks or leases.
CREATE TABLE execution_admissions (
  lease_id TEXT PRIMARY KEY NOT NULL CHECK (length(lease_id) = 36),
  profile_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) = 36),
  task_id TEXT NOT NULL,
  holder_agent_id TEXT NOT NULL CHECK (length(holder_agent_id) = 36),
  supervisor_id TEXT NOT NULL CHECK (length(supervisor_id) = 36),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  mission_version INTEGER NOT NULL CHECK (mission_version >= 1),
  task_digest TEXT NOT NULL CHECK (length(task_digest) = 64),
  graph_digest TEXT NOT NULL CHECK (length(graph_digest) = 64),
  admission_digest TEXT NOT NULL CHECK (length(admission_digest) = 64),
  admitted_at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (length(CAST(payload AS BLOB)) BETWEEN 1 AND 4096),
  UNIQUE (profile_id, lease_id),
  UNIQUE (profile_id, mission_id, task_id),
  FOREIGN KEY (profile_id, mission_id) REFERENCES missions (profile_id, mission_id) ON DELETE RESTRICT,
  FOREIGN KEY (profile_id, task_id) REFERENCES tasks (profile_id, task_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id) REFERENCES events (event_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX execution_admissions_mission ON execution_admissions (profile_id, mission_id);
CREATE TRIGGER execution_admissions_limit BEFORE INSERT ON execution_admissions
WHEN (SELECT count(*) FROM execution_admissions WHERE profile_id = NEW.profile_id AND mission_id = NEW.mission_id) >= 64
BEGIN SELECT RAISE(ABORT, 'execution admission limit'); END;
CREATE TRIGGER execution_admissions_no_update BEFORE UPDATE ON execution_admissions
BEGIN SELECT RAISE(ABORT, 'execution admissions are immutable'); END;
CREATE TRIGGER execution_admissions_no_delete BEFORE DELETE ON execution_admissions
BEGIN SELECT RAISE(ABORT, 'execution admissions are immutable'); END;

CREATE TABLE execution_observations (
  observation_id TEXT PRIMARY KEY NOT NULL CHECK (length(observation_id) = 36),
  profile_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  holder_agent_id TEXT NOT NULL CHECK (length(holder_agent_id) = 36),
  supervisor_id TEXT NOT NULL CHECK (length(supervisor_id) = 36),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  admission_digest TEXT NOT NULL CHECK (length(admission_digest) = 64),
  kind TEXT NOT NULL CHECK (kind = 'turn-promise-settled'),
  recorded_at TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  payload TEXT NOT NULL CHECK (length(CAST(payload AS BLOB)) BETWEEN 1 AND 4096),
  UNIQUE (profile_id, lease_id),
  FOREIGN KEY (profile_id, lease_id) REFERENCES execution_admissions (profile_id, lease_id) ON DELETE RESTRICT
) STRICT;
CREATE TRIGGER execution_observations_no_update BEFORE UPDATE ON execution_observations
BEGIN SELECT RAISE(ABORT, 'execution observations are immutable'); END;
CREATE TRIGGER execution_observations_no_delete BEFORE DELETE ON execution_observations
BEGIN SELECT RAISE(ABORT, 'execution observations are immutable'); END;
