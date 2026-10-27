-- Core store schema 5: skill tables accept the host's workspace ids (ADR 0025 note
-- 2026-10-23, "workspace ids"). Schemas 2 and 4 required a 36-character workspace id (a UUID),
-- but the host names workspaces `w_<base36 ms><8 hex>` (`HOST_WORKSPACE_ID_PATTERN` in
-- @extalia/protocol), so W0 consent could not be stored as review input and an approval could
-- not name its workspace.
-- Applied in one transaction by the migrator; no transaction control or PRAGMA statements.
-- Released migrations are immutable: change the schema with a new numbered file.
--
-- SQLite cannot alter a CHECK, so skill_approvals and skill_review_inputs are rebuilt.
-- skill_approvals is the parent of skill_activations and skill_activation_events (composite
-- foreign keys), and the migrator runs with foreign keys on, so both children are rebuilt as
-- well: every row is copied to a TEMP table first, the children are dropped before their
-- parent (DROP TABLE deletes implicitly without firing triggers, and deleting child rows
-- violates nothing), each table is recreated with its schema-2/4 definition (only the
-- workspace CHECK differs), the rows are copied back with their ids, and the indexes and
-- append-only triggers are recreated after the copy. The migrator then runs
-- foreign_key_check and the exact-schema check. No row is changed or dropped.
--
-- The new workspace CHECK: NULL (approvals only), a host id (`w_`, 9 to 19 characters of
-- [0-9a-z] whose last 8 are [0-9a-f]), or any 36-character id as before, so every row that
-- schema 4 admitted is still admitted. The core validates ids strictly
-- (`skills::is_workspace_id`: host ids and lowercase UUIDs only); this CHECK is the backstop.

CREATE TEMP TABLE m5_skill_approvals AS SELECT * FROM skill_approvals;
CREATE TEMP TABLE m5_skill_activations AS SELECT * FROM skill_activations;
CREATE TEMP TABLE m5_skill_activation_events AS SELECT * FROM skill_activation_events;
CREATE TEMP TABLE m5_skill_review_inputs AS SELECT * FROM skill_review_inputs;

DROP TABLE skill_activation_events;
DROP TABLE skill_activations;
DROP TABLE skill_approvals;
DROP TABLE skill_review_inputs;

-- An approval binds the revision, its tree hash, the attestation it relied on, the profile,
-- an optional workspace scope, the declared permission set's digest and an expiry. Only
-- status (granted -> revoked) and revoked_at may change, once.
CREATE TABLE skill_approvals (
  approval_id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  tree_sha256 TEXT NOT NULL CHECK (length(tree_sha256) = 64),
  inspection_id INTEGER NOT NULL,
  workspace_id TEXT CHECK (workspace_id IS NULL
    OR (length(workspace_id) BETWEEN 11 AND 21 AND substr(workspace_id, 1, 2) = 'w_'
        AND substr(workspace_id, 3) NOT GLOB '*[^0-9a-z]*'
        AND substr(workspace_id, -8) NOT GLOB '*[^0-9a-f]*')
    OR length(workspace_id) = 36),
  permission_digest TEXT NOT NULL CHECK (length(permission_digest) = 64),
  kind TEXT NOT NULL CHECK (kind IN ('user', 'auto')),
  approver TEXT NOT NULL CHECK (length(approver) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status IN ('granted', 'revoked')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (revision_id = 'skr_' || tree_sha256),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  UNIQUE (profile_id, revision_id, approval_id),
  FOREIGN KEY (profile_id, revision_id, inspection_id) REFERENCES skill_inspections (profile_id, revision_id, inspection_id)
) STRICT;
INSERT INTO skill_approvals (approval_id, profile_id, revision_id, tree_sha256, inspection_id, workspace_id,
  permission_digest, kind, approver, status, created_at, expires_at, revoked_at)
SELECT approval_id, profile_id, revision_id, tree_sha256, inspection_id, workspace_id,
  permission_digest, kind, approver, status, created_at, expires_at, revoked_at
FROM temp.m5_skill_approvals ORDER BY approval_id;
CREATE INDEX skill_approvals_revision ON skill_approvals (profile_id, revision_id, status);

CREATE TRIGGER skill_approvals_immutable BEFORE UPDATE OF approval_id, profile_id, revision_id, tree_sha256, inspection_id, workspace_id, permission_digest, kind, approver, created_at, expires_at ON skill_approvals
BEGIN SELECT RAISE(ABORT, 'skill approvals are immutable'); END;
CREATE TRIGGER skill_approvals_revoke_once BEFORE UPDATE OF status, revoked_at ON skill_approvals
WHEN OLD.status <> 'granted'
BEGIN SELECT RAISE(ABORT, 'a revoked skill approval stays revoked'); END;
CREATE TRIGGER skill_approvals_no_delete BEFORE DELETE ON skill_approvals
BEGIN SELECT RAISE(ABORT, 'skill approvals are kept for audit'); END;

-- The single activation pointer per (profile, package), changed together with an
-- append-only skill_activation_events row and the index generation in one transaction.
CREATE TABLE skill_activations (
  profile_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  approval_id INTEGER NOT NULL,
  activated_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, package_id),
  FOREIGN KEY (profile_id, package_id, revision_id) REFERENCES skill_revisions (profile_id, package_id, revision_id),
  FOREIGN KEY (profile_id, revision_id, approval_id) REFERENCES skill_approvals (profile_id, revision_id, approval_id)
) STRICT;
INSERT INTO skill_activations (profile_id, package_id, revision_id, approval_id, activated_at)
SELECT profile_id, package_id, revision_id, approval_id, activated_at
FROM temp.m5_skill_activations ORDER BY profile_id, package_id;

CREATE TABLE skill_activation_events (
  event_seq INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('activate', 'rollback', 'deactivate', 'revoke')),
  from_revision_id TEXT CHECK (from_revision_id IS NULL OR length(from_revision_id) = 68),
  to_revision_id TEXT CHECK (to_revision_id IS NULL OR length(to_revision_id) = 68),
  approval_id INTEGER,
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 64),
  at TEXT NOT NULL,
  CHECK ((to_revision_id IS NULL) = (action IN ('deactivate', 'revoke'))),
  CHECK ((approval_id IS NULL) = (to_revision_id IS NULL)),
  FOREIGN KEY (profile_id, package_id) REFERENCES skill_packages (profile_id, package_id),
  FOREIGN KEY (profile_id, package_id, from_revision_id) REFERENCES skill_revisions (profile_id, package_id, revision_id),
  FOREIGN KEY (profile_id, package_id, to_revision_id) REFERENCES skill_revisions (profile_id, package_id, revision_id),
  FOREIGN KEY (profile_id, to_revision_id, approval_id) REFERENCES skill_approvals (profile_id, revision_id, approval_id)
) STRICT;
INSERT INTO skill_activation_events (event_seq, profile_id, package_id, action, from_revision_id, to_revision_id,
  approval_id, reason, at)
SELECT event_seq, profile_id, package_id, action, from_revision_id, to_revision_id, approval_id, reason, at
FROM temp.m5_skill_activation_events ORDER BY event_seq;
CREATE INDEX skill_activation_events_package ON skill_activation_events (profile_id, package_id, event_seq);

CREATE TRIGGER skill_activation_events_no_update BEFORE UPDATE ON skill_activation_events
BEGIN SELECT RAISE(ABORT, 'skill activation history is append-only'); END;
CREATE TRIGGER skill_activation_events_no_delete BEFORE DELETE ON skill_activation_events
BEGIN SELECT RAISE(ABORT, 'skill activation history is append-only'); END;

-- Information shown to a reviewer, never a decision (ADR 0025 §7): a W0 consent of a
-- workspace whose SHA-256 equals the revision's stored SKILL.md. Recording one changes no
-- state. Each (revision, workspace, consent digest) is recorded once.
CREATE TABLE skill_review_inputs (
  input_id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('w0-consent')),
  workspace_id TEXT NOT NULL CHECK (
    (length(workspace_id) BETWEEN 11 AND 21 AND substr(workspace_id, 1, 2) = 'w_'
     AND substr(workspace_id, 3) NOT GLOB '*[^0-9a-z]*'
     AND substr(workspace_id, -8) NOT GLOB '*[^0-9a-f]*')
    OR length(workspace_id) = 36),
  consent_sha256 TEXT NOT NULL CHECK (length(consent_sha256) = 64),
  allowed_at TEXT CHECK (allowed_at IS NULL OR length(allowed_at) BETWEEN 1 AND 64),
  observed_at TEXT NOT NULL,
  UNIQUE (profile_id, revision_id, source, workspace_id, consent_sha256),
  FOREIGN KEY (profile_id, revision_id) REFERENCES skill_revisions (profile_id, revision_id)
) STRICT;
INSERT INTO skill_review_inputs (input_id, profile_id, revision_id, source, workspace_id, consent_sha256,
  allowed_at, observed_at)
SELECT input_id, profile_id, revision_id, source, workspace_id, consent_sha256, allowed_at, observed_at
FROM temp.m5_skill_review_inputs ORDER BY input_id;

CREATE TRIGGER skill_review_inputs_match BEFORE INSERT ON skill_review_inputs
WHEN NEW.consent_sha256 IS NOT (SELECT skill_md_sha256 FROM skill_revisions
                                WHERE profile_id = NEW.profile_id AND revision_id = NEW.revision_id)
BEGIN SELECT RAISE(ABORT, 'a consent input must match the revision''s SKILL.md'); END;
CREATE TRIGGER skill_review_inputs_no_update BEFORE UPDATE ON skill_review_inputs
BEGIN SELECT RAISE(ABORT, 'skill review inputs are append-only'); END;
CREATE TRIGGER skill_review_inputs_no_delete BEFORE DELETE ON skill_review_inputs
BEGIN SELECT RAISE(ABORT, 'skill review inputs are append-only'); END;

DROP TABLE temp.m5_skill_approvals;
DROP TABLE temp.m5_skill_activations;
DROP TABLE temp.m5_skill_activation_events;
DROP TABLE temp.m5_skill_review_inputs;
