-- Original planner membership, captured atomically by new mission creation only.
-- No backfill: old missions have explicit unavailable membership history.
CREATE TABLE mission_planned_tasks (
  mission_id TEXT PRIMARY KEY NOT NULL CHECK(length(mission_id)=36),
  profile_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL CHECK(length(workspace_id)=36),
  creation_version INTEGER NOT NULL CHECK(creation_version>=1),
  task_count INTEGER NOT NULL CHECK(task_count BETWEEN 1 AND 64),
  graph_digest TEXT NOT NULL CHECK(length(graph_digest)=64),
  membership_digest TEXT NOT NULL CHECK(length(membership_digest)=64),
  payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 1048576),
  UNIQUE(profile_id,mission_id),
  FOREIGN KEY(profile_id,mission_id) REFERENCES missions(profile_id,mission_id) ON DELETE RESTRICT
-- No hidden rowid aliases: REPLACE must conflict on a guarded logical identity.
) STRICT, WITHOUT ROWID;
CREATE TRIGGER mission_planned_tasks_no_update BEFORE UPDATE ON mission_planned_tasks
BEGIN SELECT RAISE(ABORT,'original planned tasks are immutable'); END;
CREATE TRIGGER mission_planned_tasks_no_delete BEFORE DELETE ON mission_planned_tasks
BEGIN SELECT RAISE(ABORT,'original planned tasks are immutable'); END;
-- REPLACE does not fire DELETE triggers unless recursive_triggers is enabled.
CREATE TRIGGER mission_planned_tasks_no_replace BEFORE INSERT ON mission_planned_tasks
WHEN EXISTS(SELECT 1 FROM mission_planned_tasks WHERE mission_id=NEW.mission_id)
BEGIN SELECT RAISE(ABORT,'original planned tasks cannot be replaced'); END;
CREATE TRIGGER mission_planned_tasks_scope BEFORE INSERT ON mission_planned_tasks
WHEN NOT EXISTS(SELECT 1 FROM missions WHERE profile_id=NEW.profile_id AND mission_id=NEW.mission_id
  AND workspace_id=NEW.workspace_id AND version=NEW.creation_version)
BEGIN SELECT RAISE(ABORT,'original planned task scope differs'); END;
