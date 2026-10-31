-- Non-executable edit-intent history attached to real native execution admissions.
-- No grant/decision/consumption route and no legacy approval backfill.
CREATE UNIQUE INDEX native_action_approvals_owner ON approvals(profile_id,approval_id);
CREATE TABLE native_action_clocks (
  profile_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  observed_ms INTEGER NOT NULL CHECK (observed_ms BETWEEN -9007199254740991 AND 9007199254740991),
  PRIMARY KEY(profile_id,lease_id),
  FOREIGN KEY(profile_id,lease_id) REFERENCES execution_admissions(profile_id,lease_id) ON DELETE RESTRICT
) STRICT;
CREATE TRIGGER native_action_clocks_no_replace BEFORE INSERT ON native_action_clocks
WHEN EXISTS(SELECT 1 FROM native_action_clocks WHERE profile_id=NEW.profile_id AND lease_id=NEW.lease_id)
BEGIN SELECT RAISE(ABORT,'native action clock cannot be replaced'); END;
CREATE TRIGGER native_action_clocks_monotonic BEFORE UPDATE ON native_action_clocks
WHEN NEW.profile_id!=OLD.profile_id OR NEW.lease_id!=OLD.lease_id OR NEW.observed_ms<OLD.observed_ms
BEGIN SELECT RAISE(ABORT,'native action clock identity or rewind'); END;
CREATE TRIGGER native_action_clocks_no_delete BEFORE DELETE ON native_action_clocks
BEGIN SELECT RAISE(ABORT,'native action clock history retained'); END;
CREATE TABLE native_action_requests (
  approval_id TEXT PRIMARY KEY NOT NULL CHECK(length(approval_id)=36),
  profile_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind='intent-only'),
  UNIQUE(profile_id,lease_id,idempotency_key),
  UNIQUE(profile_id,approval_id),
  FOREIGN KEY(profile_id,approval_id) REFERENCES approvals(profile_id,approval_id) ON DELETE RESTRICT,
  FOREIGN KEY(profile_id,lease_id) REFERENCES execution_admissions(profile_id,lease_id) ON DELETE RESTRICT
) STRICT;
CREATE TRIGGER native_action_requests_limit BEFORE INSERT ON native_action_requests
WHEN (SELECT count(*) FROM native_action_requests WHERE profile_id=NEW.profile_id AND lease_id=NEW.lease_id)>=128
BEGIN SELECT RAISE(ABORT,'native action request limit'); END;
CREATE TRIGGER native_action_requests_insert_guard BEFORE INSERT ON native_action_requests
WHEN EXISTS(SELECT 1 FROM native_action_requests WHERE approval_id=NEW.approval_id OR (profile_id=NEW.profile_id AND lease_id=NEW.lease_id AND idempotency_key=NEW.idempotency_key))
 OR NOT EXISTS(SELECT 1 FROM approvals WHERE profile_id=NEW.profile_id AND approval_id=NEW.approval_id AND status='pending' AND decided_at IS NULL AND task_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'native action requires a new pending projection'); END;
CREATE TRIGGER native_action_requests_no_update BEFORE UPDATE ON native_action_requests
BEGIN SELECT RAISE(ABORT,'native action requests immutable'); END;
CREATE TRIGGER native_action_requests_no_delete BEFORE DELETE ON native_action_requests
BEGIN SELECT RAISE(ABORT,'native action requests immutable'); END;
CREATE TABLE native_action_closures (
  profile_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('revoked','expired')),
  reason TEXT NOT NULL CHECK(reason IN ('withdrawn','expiry','authority-lost','recovery')),
  recorded_at TEXT NOT NULL,
  digest TEXT NOT NULL CHECK(length(digest)=64),
  payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 4096),
  PRIMARY KEY(profile_id,approval_id),
  FOREIGN KEY(profile_id,approval_id) REFERENCES native_action_requests(profile_id,approval_id) ON DELETE RESTRICT
) STRICT;
CREATE TRIGGER native_action_closures_no_replace BEFORE INSERT ON native_action_closures
WHEN EXISTS(SELECT 1 FROM native_action_closures WHERE profile_id=NEW.profile_id AND approval_id=NEW.approval_id)
BEGIN SELECT RAISE(ABORT,'native action closure cannot be replaced'); END;
CREATE TRIGGER native_action_closures_no_update BEFORE UPDATE ON native_action_closures
BEGIN SELECT RAISE(ABORT,'native action closures immutable'); END;
CREATE TRIGGER native_action_closures_no_delete BEFORE DELETE ON native_action_closures
BEGIN SELECT RAISE(ABORT,'native action closures immutable'); END;
CREATE TRIGGER native_action_approval_guard BEFORE UPDATE ON approvals
WHEN EXISTS(SELECT 1 FROM native_action_requests WHERE approval_id=OLD.approval_id)
 AND (NEW.approval_id!=OLD.approval_id OR NEW.profile_id!=OLD.profile_id OR NEW.mission_id!=OLD.mission_id
 OR NEW.task_id IS NOT OLD.task_id OR NEW.requested_at!=OLD.requested_at OR NEW.expires_at!=OLD.expires_at
 OR NEW.digest!=OLD.digest OR NEW.payload!=OLD.payload OR NEW.decided_at IS NOT NULL
 OR NOT(OLD.status='pending' AND NEW.status IN ('revoked','expired')))
BEGIN SELECT RAISE(ABORT,'native intent cannot be changed or granted'); END;
CREATE TRIGGER native_action_approval_no_delete BEFORE DELETE ON approvals
WHEN EXISTS(SELECT 1 FROM native_action_requests WHERE approval_id=OLD.approval_id)
BEGIN SELECT RAISE(ABORT,'native action history retained'); END;
CREATE TRIGGER native_action_approval_no_replace BEFORE INSERT ON approvals
WHEN EXISTS(SELECT 1 FROM native_action_requests WHERE approval_id=NEW.approval_id)
BEGIN SELECT RAISE(ABORT,'native action projection cannot be replaced'); END;
