-- Planning lifetime only: pending is durable and never expires or auto-settles.
CREATE TABLE planning_admissions (
  profile_id TEXT NOT NULL CHECK(length(profile_id) BETWEEN 1 AND 200),
  invocation_id TEXT NOT NULL CHECK(length(invocation_id)=36),
  supervisor_id TEXT NOT NULL CHECK(length(supervisor_id)=36),
  session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 200),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 200),
  admitted_at TEXT NOT NULL,
  admission_digest TEXT NOT NULL CHECK(length(admission_digest)=64),
  payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 32768),
  PRIMARY KEY(profile_id,invocation_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER planning_admissions_limit BEFORE INSERT ON planning_admissions
WHEN (SELECT count(*) FROM planning_admissions WHERE profile_id=NEW.profile_id)>=1024
BEGIN SELECT RAISE(ABORT,'planning history capacity'); END;
CREATE TRIGGER planning_admissions_no_replace BEFORE INSERT ON planning_admissions
WHEN EXISTS(SELECT 1 FROM planning_admissions WHERE profile_id=NEW.profile_id AND invocation_id=NEW.invocation_id)
BEGIN SELECT RAISE(ABORT,'planning admission immutable'); END;
CREATE TRIGGER planning_admissions_no_update BEFORE UPDATE ON planning_admissions
BEGIN SELECT RAISE(ABORT,'planning admission immutable'); END;
CREATE TRIGGER planning_admissions_no_delete BEFORE DELETE ON planning_admissions
BEGIN SELECT RAISE(ABORT,'planning admission immutable'); END;

CREATE TABLE planning_observations (
  profile_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  admission_digest TEXT NOT NULL CHECK(length(admission_digest)=64),
  kind TEXT NOT NULL CHECK(kind='local-pipeline-settled'),
  recorded_at TEXT NOT NULL,
  digest TEXT NOT NULL CHECK(length(digest)=64),
  payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 32768),
  PRIMARY KEY(profile_id,invocation_id),
  FOREIGN KEY(profile_id,invocation_id) REFERENCES planning_admissions(profile_id,invocation_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TRIGGER planning_observations_scope BEFORE INSERT ON planning_observations
WHEN NOT EXISTS(SELECT 1 FROM planning_admissions WHERE profile_id=NEW.profile_id AND invocation_id=NEW.invocation_id AND admission_digest=NEW.admission_digest)
BEGIN SELECT RAISE(ABORT,'planning observation scope'); END;
CREATE TRIGGER planning_observations_no_replace BEFORE INSERT ON planning_observations
WHEN EXISTS(SELECT 1 FROM planning_observations WHERE profile_id=NEW.profile_id AND invocation_id=NEW.invocation_id)
BEGIN SELECT RAISE(ABORT,'planning observation immutable'); END;
CREATE TRIGGER planning_observations_no_update BEFORE UPDATE ON planning_observations
BEGIN SELECT RAISE(ABORT,'planning observation immutable'); END;
CREATE TRIGGER planning_observations_no_delete BEFORE DELETE ON planning_observations
BEGIN SELECT RAISE(ABORT,'planning observation immutable'); END;

-- Claims are retained as immutable history. An observation releases contention only;
-- no observation means active forever, including after restart or supervisor loss.
CREATE TABLE planning_resource_claims (
  profile_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK(resource_kind IN ('session','connection')),
  resource_id TEXT NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 200),
  PRIMARY KEY(profile_id,invocation_id,resource_kind,resource_id),
  FOREIGN KEY(profile_id,invocation_id) REFERENCES planning_admissions(profile_id,invocation_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE INDEX planning_resource_lookup ON planning_resource_claims(profile_id,resource_kind,resource_id);
CREATE TRIGGER planning_resource_claims_pending BEFORE INSERT ON planning_resource_claims
WHEN EXISTS(SELECT 1 FROM planning_resource_claims c WHERE c.profile_id=NEW.profile_id AND c.resource_kind=NEW.resource_kind AND c.resource_id=NEW.resource_id
  AND NOT EXISTS(SELECT 1 FROM planning_observations o WHERE o.profile_id=c.profile_id AND o.invocation_id=c.invocation_id))
 OR EXISTS(SELECT 1 FROM planning_observations WHERE profile_id=NEW.profile_id AND invocation_id=NEW.invocation_id)
BEGIN SELECT RAISE(ABORT,'planning resource already pending'); END;
CREATE TRIGGER planning_resource_claims_no_replace BEFORE INSERT ON planning_resource_claims
WHEN EXISTS(SELECT 1 FROM planning_resource_claims WHERE profile_id=NEW.profile_id AND invocation_id=NEW.invocation_id AND resource_kind=NEW.resource_kind AND resource_id=NEW.resource_id)
BEGIN SELECT RAISE(ABORT,'planning claim immutable'); END;
CREATE TRIGGER planning_resource_claims_limit BEFORE INSERT ON planning_resource_claims
WHEN (SELECT count(*) FROM planning_resource_claims WHERE profile_id=NEW.profile_id AND invocation_id=NEW.invocation_id)>=17
BEGIN SELECT RAISE(ABORT,'planning claim capacity'); END;
CREATE TRIGGER planning_resource_claims_no_update BEFORE UPDATE ON planning_resource_claims
BEGIN SELECT RAISE(ABORT,'planning claim immutable'); END;
CREATE TRIGGER planning_resource_claims_no_delete BEFORE DELETE ON planning_resource_claims
BEGIN SELECT RAISE(ABORT,'planning claim immutable'); END;
