-- Preparation lifetime only: pending is durable and never expires or auto-settles.
CREATE TABLE preparation_admissions (
  profile_id TEXT NOT NULL CHECK(length(profile_id) BETWEEN 1 AND 200),
  invocation_id TEXT NOT NULL CHECK(length(invocation_id)=36),
  mission_id TEXT NOT NULL CHECK(length(mission_id)=36),
  canonical_workspace_id TEXT NOT NULL CHECK(length(canonical_workspace_id)=36),
  supervisor_id TEXT NOT NULL CHECK(length(supervisor_id)=36),
  session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 200),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 200),
  admitted_at TEXT NOT NULL,
  admission_digest TEXT NOT NULL CHECK(length(admission_digest)=64),
  payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 32768),
  PRIMARY KEY(profile_id,invocation_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER preparation_admissions_limit BEFORE INSERT ON preparation_admissions
WHEN (SELECT count(*) FROM preparation_admissions WHERE profile_id=NEW.profile_id)>=1024
BEGIN SELECT RAISE(ABORT,'preparation history capacity'); END;
CREATE TRIGGER preparation_admissions_no_replace BEFORE INSERT ON preparation_admissions
WHEN EXISTS(SELECT 1 FROM preparation_admissions WHERE profile_id=NEW.profile_id AND invocation_id=NEW.invocation_id)
BEGIN SELECT RAISE(ABORT,'preparation admission immutable'); END;
CREATE TRIGGER preparation_admissions_no_update BEFORE UPDATE ON preparation_admissions
BEGIN SELECT RAISE(ABORT,'preparation admission immutable'); END;
CREATE TRIGGER preparation_admissions_no_delete BEFORE DELETE ON preparation_admissions
BEGIN SELECT RAISE(ABORT,'preparation admission immutable'); END;

CREATE TABLE preparation_observations (
  profile_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  admission_digest TEXT NOT NULL CHECK(length(admission_digest)=64),
  kind TEXT NOT NULL CHECK(kind='local-preparation-settled'),
  recorded_at TEXT NOT NULL,
  digest TEXT NOT NULL CHECK(length(digest)=64),
  payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) BETWEEN 1 AND 32768),
  PRIMARY KEY(profile_id,invocation_id),
  FOREIGN KEY(profile_id,invocation_id) REFERENCES preparation_admissions(profile_id,invocation_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TRIGGER preparation_observations_scope BEFORE INSERT ON preparation_observations
WHEN NOT EXISTS(SELECT 1 FROM preparation_admissions WHERE profile_id=NEW.profile_id AND invocation_id=NEW.invocation_id AND admission_digest=NEW.admission_digest)
BEGIN SELECT RAISE(ABORT,'preparation observation scope'); END;
CREATE TRIGGER preparation_observations_no_replace BEFORE INSERT ON preparation_observations
WHEN EXISTS(SELECT 1 FROM preparation_observations WHERE profile_id=NEW.profile_id AND invocation_id=NEW.invocation_id)
BEGIN SELECT RAISE(ABORT,'preparation observation immutable'); END;
CREATE TRIGGER preparation_observations_no_update BEFORE UPDATE ON preparation_observations
BEGIN SELECT RAISE(ABORT,'preparation observation immutable'); END;
CREATE TRIGGER preparation_observations_no_delete BEFORE DELETE ON preparation_observations
BEGIN SELECT RAISE(ABORT,'preparation observation immutable'); END;

-- Claims are retained as immutable history. An observation releases contention only;
-- no observation means active forever, including after restart or supervisor loss.
CREATE TABLE preparation_resource_claims (
  profile_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK(resource_kind IN ('session','connection')),
  resource_id TEXT NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 200),
  PRIMARY KEY(profile_id,invocation_id,resource_kind,resource_id),
  FOREIGN KEY(profile_id,invocation_id) REFERENCES preparation_admissions(profile_id,invocation_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE INDEX preparation_resource_lookup ON preparation_resource_claims(profile_id,resource_kind,resource_id);
CREATE TRIGGER preparation_resource_claims_pending BEFORE INSERT ON preparation_resource_claims
WHEN EXISTS(SELECT 1 FROM preparation_resource_claims c WHERE c.profile_id=NEW.profile_id AND c.resource_kind=NEW.resource_kind AND c.resource_id=NEW.resource_id
  AND NOT EXISTS(SELECT 1 FROM preparation_observations o WHERE o.profile_id=c.profile_id AND o.invocation_id=c.invocation_id))
 OR EXISTS(SELECT 1 FROM preparation_observations WHERE profile_id=NEW.profile_id AND invocation_id=NEW.invocation_id)
BEGIN SELECT RAISE(ABORT,'preparation resource already pending'); END;
CREATE TRIGGER preparation_resource_claims_no_replace BEFORE INSERT ON preparation_resource_claims
WHEN EXISTS(SELECT 1 FROM preparation_resource_claims WHERE profile_id=NEW.profile_id AND invocation_id=NEW.invocation_id AND resource_kind=NEW.resource_kind AND resource_id=NEW.resource_id)
BEGIN SELECT RAISE(ABORT,'preparation claim immutable'); END;
CREATE TRIGGER preparation_resource_claims_limit BEFORE INSERT ON preparation_resource_claims
WHEN (SELECT count(*) FROM preparation_resource_claims WHERE profile_id=NEW.profile_id AND invocation_id=NEW.invocation_id)>=17
BEGIN SELECT RAISE(ABORT,'preparation claim capacity'); END;
CREATE TRIGGER preparation_resource_claims_no_update BEFORE UPDATE ON preparation_resource_claims
BEGIN SELECT RAISE(ABORT,'preparation claim immutable'); END;
CREATE TRIGGER preparation_resource_claims_no_delete BEFORE DELETE ON preparation_resource_claims
BEGIN SELECT RAISE(ABORT,'preparation claim immutable'); END;

-- Prevent cross-kind claims in the same SQLite write transaction.
CREATE TRIGGER planning_resource_claims_cross_kind BEFORE INSERT ON planning_resource_claims
WHEN EXISTS(SELECT 1 FROM preparation_resource_claims c WHERE c.profile_id=NEW.profile_id AND c.resource_kind=NEW.resource_kind AND c.resource_id=NEW.resource_id
  AND NOT EXISTS(SELECT 1 FROM preparation_observations o WHERE o.profile_id=c.profile_id AND o.invocation_id=c.invocation_id))
BEGIN SELECT RAISE(ABORT,'cross-kind resource already pending'); END;

-- Prevent cross-kind claims in the same SQLite write transaction.
CREATE TRIGGER preparation_resource_claims_cross_kind BEFORE INSERT ON preparation_resource_claims
WHEN EXISTS(SELECT 1 FROM planning_resource_claims c WHERE c.profile_id=NEW.profile_id AND c.resource_kind=NEW.resource_kind AND c.resource_id=NEW.resource_id
  AND NOT EXISTS(SELECT 1 FROM planning_observations o WHERE o.profile_id=c.profile_id AND o.invocation_id=c.invocation_id))
BEGIN SELECT RAISE(ABORT,'cross-kind resource already pending'); END;
