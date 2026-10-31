-- Provisional allocation bookkeeping only, never an execution grant or command queue.
-- No legacy rows, implicit pools, refunds, dispatcher or runtime activation.
CREATE TABLE delegation_pools (
  pool_id TEXT PRIMARY KEY NOT NULL CHECK (length(pool_id) = 36),
  profile_id TEXT NOT NULL CHECK (length(profile_id) = 36),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) = 36),
  root_mission_id TEXT NOT NULL CHECK (length(root_mission_id) = 36),
  root_run_id TEXT NOT NULL CHECK (length(root_run_id) = 36),
  kind TEXT NOT NULL CHECK (kind = 'provisional'),
  state_version INTEGER NOT NULL CHECK (state_version BETWEEN 1 AND 9007199254740991),
  revoked INTEGER NOT NULL CHECK (revoked IN (0,1)),
  observed_ms INTEGER NOT NULL,
  initialized_at TEXT NOT NULL,
  seed_digest TEXT NOT NULL CHECK (length(seed_digest) = 64),
  seed_payload TEXT NOT NULL CHECK (length(CAST(seed_payload AS BLOB)) BETWEEN 1 AND 16384),
  UNIQUE (profile_id,workspace_id,root_mission_id,root_run_id),
  UNIQUE (profile_id,pool_id)
) STRICT;
CREATE TRIGGER delegation_pools_immutable BEFORE UPDATE ON delegation_pools
WHEN NEW.pool_id != OLD.pool_id OR NEW.profile_id != OLD.profile_id OR NEW.workspace_id != OLD.workspace_id
 OR NEW.root_mission_id != OLD.root_mission_id OR NEW.root_run_id != OLD.root_run_id OR NEW.kind != OLD.kind
 OR NEW.initialized_at != OLD.initialized_at OR NEW.seed_digest != OLD.seed_digest OR NEW.seed_payload != OLD.seed_payload
 OR NEW.state_version < OLD.state_version OR NEW.state_version > OLD.state_version + 1
 OR (NEW.revoked != OLD.revoked AND NEW.state_version != OLD.state_version + 1)
 OR NEW.revoked < OLD.revoked OR NEW.observed_ms < OLD.observed_ms
BEGIN SELECT RAISE(ABORT, 'immutable delegation pool identity or monotonic state'); END;
CREATE TRIGGER delegation_pools_no_delete BEFORE DELETE ON delegation_pools
BEGIN SELECT RAISE(ABORT, 'delegation pool history is retained'); END;

CREATE TABLE delegation_branches (
  profile_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  branch_id TEXT NOT NULL CHECK (length(branch_id) = 36),
  parent_branch_id TEXT CHECK (parent_branch_id IS NULL OR (length(parent_branch_id) = 36 AND parent_branch_id != branch_id)),
  task_id TEXT NOT NULL CHECK (length(task_id) = 36),
  idempotency_key TEXT NOT NULL,
  envelope_digest TEXT NOT NULL CHECK (length(envelope_digest) = 64),
  envelope_payload TEXT NOT NULL CHECK (length(CAST(envelope_payload AS BLOB)) BETWEEN 1 AND 16384),
  slots_remaining INTEGER NOT NULL CHECK (slots_remaining BETWEEN 0 AND 1000),
  wall_ms_remaining INTEGER NOT NULL CHECK (wall_ms_remaining BETWEEN 0 AND 9007199254740991),
  tokens_remaining INTEGER NOT NULL CHECK (tokens_remaining BETWEEN 0 AND 9007199254740991),
  tools_remaining INTEGER NOT NULL CHECK (tools_remaining BETWEEN 0 AND 9007199254740991),
  cost_remaining INTEGER NOT NULL CHECK (cost_remaining BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (profile_id,pool_id,branch_id),
  UNIQUE (profile_id,pool_id,task_id),
  UNIQUE (profile_id,pool_id,idempotency_key),
  FOREIGN KEY (profile_id,pool_id) REFERENCES delegation_pools(profile_id,pool_id) ON DELETE RESTRICT,
  FOREIGN KEY (profile_id,pool_id,parent_branch_id) REFERENCES delegation_branches(profile_id,pool_id,branch_id) ON DELETE RESTRICT
) STRICT;
CREATE TRIGGER delegation_branches_limit BEFORE INSERT ON delegation_branches
WHEN (SELECT count(*) FROM delegation_branches WHERE profile_id = NEW.profile_id AND pool_id = NEW.pool_id) >= 1001
BEGIN SELECT RAISE(ABORT, 'delegation branch limit'); END;
CREATE TRIGGER delegation_branches_immutable BEFORE UPDATE ON delegation_branches
WHEN NEW.profile_id != OLD.profile_id OR NEW.pool_id != OLD.pool_id OR NEW.branch_id != OLD.branch_id
 OR NEW.parent_branch_id IS NOT OLD.parent_branch_id OR NEW.task_id != OLD.task_id OR NEW.idempotency_key != OLD.idempotency_key
 OR NEW.envelope_digest != OLD.envelope_digest OR NEW.envelope_payload != OLD.envelope_payload
 OR NEW.slots_remaining > OLD.slots_remaining OR NEW.wall_ms_remaining > OLD.wall_ms_remaining
 OR NEW.tokens_remaining > OLD.tokens_remaining OR NEW.tools_remaining > OLD.tools_remaining OR NEW.cost_remaining > OLD.cost_remaining
BEGIN SELECT RAISE(ABORT, 'immutable delegation branch or increased balance'); END;
CREATE TRIGGER delegation_branches_no_delete BEFORE DELETE ON delegation_branches
BEGIN SELECT RAISE(ABORT, 'delegation branch history is retained'); END;

CREATE TABLE delegation_reservations (
  profile_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  parent_branch_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  pool_version INTEGER NOT NULL CHECK (pool_version BETWEEN 2 AND 9007199254740991),
  recorded_at TEXT NOT NULL,
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
  intent_payload TEXT NOT NULL CHECK (length(CAST(intent_payload AS BLOB)) BETWEEN 1 AND 16384),
  PRIMARY KEY (profile_id,pool_id,branch_id),
  UNIQUE (profile_id,pool_id,idempotency_key),
  UNIQUE (profile_id,pool_id,pool_version),
  FOREIGN KEY (profile_id,pool_id,branch_id) REFERENCES delegation_branches(profile_id,pool_id,branch_id) ON DELETE RESTRICT,
  FOREIGN KEY (profile_id,pool_id,parent_branch_id) REFERENCES delegation_branches(profile_id,pool_id,branch_id) ON DELETE RESTRICT
) STRICT;
CREATE TRIGGER delegation_reservations_no_update BEFORE UPDATE ON delegation_reservations
BEGIN SELECT RAISE(ABORT, 'delegation receipts are immutable'); END;
CREATE TRIGGER delegation_reservations_no_delete BEFORE DELETE ON delegation_reservations
BEGIN SELECT RAISE(ABORT, 'delegation receipts are immutable'); END;
