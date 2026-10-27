-- Core store schema 2: secure skill registry, W3 slice 1 (ADR 0025; ADRs 0023, 0024, 0026).
-- Applied in one transaction by the migrator; no transaction control or PRAGMA statements.
-- Released migrations are immutable: change the schema with a new numbered file.
--
-- Every row carries profile_id (ADR 0024). Child rows reference their parent through
-- composite keys that include profile_id, so no row can point into another profile.
-- A revision is content addressed: revision_id = 'skr_' || tree_sha256 (canonical tree
-- hash, see crates/extalia-core/src/skills/tree.rs). Only the core writes approvals and
-- activations (blueprint §7). History tables are append-only (triggers below); nothing in
-- this schema cascades deletes, the profile erase flow gets its own migration.

CREATE TABLE skill_packages (
  profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 64),
  package_id TEXT NOT NULL CHECK (length(package_id) BETWEEN 1 AND 64),
  origin TEXT NOT NULL CHECK (origin IN ('user', 'workspace', 'imported', 'generated')),
  source_ref TEXT NOT NULL CHECK (length(source_ref) <= 512),
  created_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, package_id)
) STRICT;

-- One immutable revision per package tree. Only state, state_reason and updated_at change.
CREATE TABLE skill_revisions (
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL CHECK (length(revision_id) = 68),
  package_id TEXT NOT NULL,
  version TEXT NOT NULL CHECK (length(version) BETWEEN 5 AND 128),
  tree_sha256 TEXT NOT NULL CHECK (length(tree_sha256) = 64),
  skill_md_sha256 TEXT NOT NULL CHECK (length(skill_md_sha256) = 64),
  manifest_json TEXT NOT NULL CHECK (length(manifest_json) BETWEEN 2 AND 65536),
  manifest_inferred INTEGER NOT NULL CHECK (manifest_inferred IN (0, 1)),
  risk_class TEXT NOT NULL CHECK (risk_class IN ('declarative', 'tool_using', 'executable')),
  permission_digest TEXT NOT NULL CHECK (length(permission_digest) = 64),
  state TEXT NOT NULL CHECK (state IN ('discovered', 'quarantined', 'inspecting', 'inspected', 'review_required', 'blocked', 'validated', 'evaluating', 'evaluated', 'awaiting_approval', 'auto_eligible', 'approved', 'active', 'superseded', 'deprecated', 'revoked')),
  state_reason TEXT CHECK (state_reason IS NULL OR length(state_reason) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (revision_id = 'skr_' || tree_sha256),
  PRIMARY KEY (profile_id, revision_id),
  UNIQUE (profile_id, package_id, tree_sha256),
  UNIQUE (profile_id, package_id, revision_id),
  FOREIGN KEY (profile_id, package_id) REFERENCES skill_packages (profile_id, package_id)
) STRICT;
CREATE INDEX skill_revisions_state ON skill_revisions (profile_id, state);

CREATE TRIGGER skill_revisions_immutable BEFORE UPDATE OF profile_id, revision_id, package_id, version, tree_sha256, skill_md_sha256, manifest_json, manifest_inferred, risk_class, permission_digest, created_at ON skill_revisions
BEGIN SELECT RAISE(ABORT, 'skill revisions are immutable'); END;

-- Append-only audit of every revision state change.
CREATE TABLE skill_revision_events (
  event_seq INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 64),
  at TEXT NOT NULL,
  FOREIGN KEY (profile_id, revision_id) REFERENCES skill_revisions (profile_id, revision_id)
) STRICT;
CREATE INDEX skill_revision_events_revision ON skill_revision_events (profile_id, revision_id);

CREATE TRIGGER skill_revision_events_no_update BEFORE UPDATE ON skill_revision_events
BEGIN SELECT RAISE(ABORT, 'skill revision events are append-only'); END;
CREATE TRIGGER skill_revision_events_no_delete BEFORE DELETE ON skill_revision_events
BEGIN SELECT RAISE(ABORT, 'skill revision events are append-only'); END;

-- Per-file digests of the immutable object, checked when a file is loaded (hash point g).
CREATE TABLE skill_files (
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 512),
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  executable INTEGER NOT NULL CHECK (executable IN (0, 1)),
  PRIMARY KEY (profile_id, revision_id, path),
  FOREIGN KEY (profile_id, revision_id) REFERENCES skill_revisions (profile_id, revision_id)
) STRICT;

-- Declared permissions: a request and a ceiling, never a grant (ADR 0026).
CREATE TABLE skill_permissions (
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN ('filesystem_read', 'filesystem_write', 'network', 'terminal', 'secrets')),
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 256),
  PRIMARY KEY (profile_id, revision_id, capability, scope),
  FOREIGN KEY (profile_id, revision_id) REFERENCES skill_revisions (profile_id, revision_id)
) STRICT;

CREATE TABLE skill_dependencies (
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  required_package_id TEXT NOT NULL CHECK (length(required_package_id) BETWEEN 1 AND 64),
  version_range TEXT NOT NULL CHECK (length(version_range) BETWEEN 1 AND 128),
  PRIMARY KEY (profile_id, revision_id, required_package_id),
  FOREIGN KEY (profile_id, revision_id) REFERENCES skill_revisions (profile_id, revision_id)
) STRICT;

CREATE TABLE skill_conflicts (
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  conflicting_package_id TEXT NOT NULL CHECK (length(conflicting_package_id) BETWEEN 1 AND 64),
  version_range TEXT CHECK (version_range IS NULL OR length(version_range) BETWEEN 1 AND 128),
  PRIMARY KEY (profile_id, revision_id, conflicting_package_id),
  FOREIGN KEY (profile_id, revision_id) REFERENCES skill_revisions (profile_id, revision_id)
) STRICT;

CREATE TABLE skill_compatibility (
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  fact_id TEXT NOT NULL CHECK (length(fact_id) BETWEEN 1 AND 64),
  version_range TEXT NOT NULL CHECK (length(version_range) BETWEEN 1 AND 128),
  PRIMARY KEY (profile_id, revision_id, fact_id),
  FOREIGN KEY (profile_id, revision_id) REFERENCES skill_revisions (profile_id, revision_id)
) STRICT;

CREATE TABLE skill_categories (
  profile_id TEXT NOT NULL,
  category_id TEXT NOT NULL CHECK (length(category_id) BETWEEN 1 AND 128),
  parent_id TEXT,
  PRIMARY KEY (profile_id, category_id),
  FOREIGN KEY (profile_id, parent_id) REFERENCES skill_categories (profile_id, category_id)
) STRICT;

CREATE TABLE skill_category_edges (
  profile_id TEXT NOT NULL,
  from_category_id TEXT NOT NULL,
  to_category_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('related_to')),
  PRIMARY KEY (profile_id, from_category_id, to_category_id, relation),
  FOREIGN KEY (profile_id, from_category_id) REFERENCES skill_categories (profile_id, category_id),
  FOREIGN KEY (profile_id, to_category_id) REFERENCES skill_categories (profile_id, category_id)
) STRICT;

CREATE TABLE skill_category_aliases (
  profile_id TEXT NOT NULL,
  alias TEXT NOT NULL CHECK (length(alias) BETWEEN 1 AND 128),
  category_id TEXT NOT NULL,
  PRIMARY KEY (profile_id, alias),
  FOREIGN KEY (profile_id, category_id) REFERENCES skill_categories (profile_id, category_id)
) STRICT;

CREATE TABLE skill_category_map (
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  PRIMARY KEY (profile_id, revision_id, category_id),
  FOREIGN KEY (profile_id, revision_id) REFERENCES skill_revisions (profile_id, revision_id),
  FOREIGN KEY (profile_id, category_id) REFERENCES skill_categories (profile_id, category_id)
) STRICT;
CREATE INDEX skill_category_map_category ON skill_category_map (profile_id, category_id);

CREATE TABLE skill_intents (
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (length(intent) BETWEEN 1 AND 64),
  PRIMARY KEY (profile_id, revision_id, intent),
  FOREIGN KEY (profile_id, revision_id) REFERENCES skill_revisions (profile_id, revision_id)
) STRICT;
CREATE INDEX skill_intents_intent ON skill_intents (profile_id, intent);

-- Attestations (ADR 0023 §2, ADR 0025 §5). Append-only. Valid only while tree hash,
-- scanner id/pin/version, normalizer version and policy version equal the current values.
CREATE TABLE skill_inspections (
  inspection_id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  tree_sha256 TEXT NOT NULL CHECK (length(tree_sha256) = 64),
  scanner_id TEXT NOT NULL CHECK (length(scanner_id) BETWEEN 1 AND 128),
  scanner_pin TEXT CHECK (scanner_pin IS NULL OR length(scanner_pin) BETWEEN 1 AND 256),
  scanner_version TEXT CHECK (scanner_version IS NULL OR length(scanner_version) BETWEEN 1 AND 128),
  normalizer_version TEXT CHECK (normalizer_version IS NULL OR length(normalizer_version) BETWEEN 1 AND 128),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 128),
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'scanner-unavailable', 'incomplete', 'timeout', 'error', 'invalid-output', 'integrity')),
  coverage TEXT NOT NULL CHECK (coverage IN ('complete', 'partial', 'none')),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('none', 'low', 'medium', 'high', 'critical')),
  report_ref TEXT CHECK (report_ref IS NULL OR length(report_ref) BETWEEN 1 AND 512),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  CHECK ((outcome = 'completed') = (verdict IS NOT NULL)),
  CHECK (revision_id = 'skr_' || tree_sha256),
  UNIQUE (profile_id, revision_id, inspection_id),
  FOREIGN KEY (profile_id, revision_id) REFERENCES skill_revisions (profile_id, revision_id)
) STRICT;

CREATE TRIGGER skill_inspections_no_update BEFORE UPDATE ON skill_inspections
BEGIN SELECT RAISE(ABORT, 'skill inspections are append-only'); END;
CREATE TRIGGER skill_inspections_no_delete BEFORE DELETE ON skill_inspections
BEGIN SELECT RAISE(ABORT, 'skill inspections are append-only'); END;

CREATE TABLE skill_evaluations (
  evaluation_id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  tree_sha256 TEXT NOT NULL CHECK (length(tree_sha256) = 64),
  baseline_revision_id TEXT CHECK (baseline_revision_id IS NULL OR length(baseline_revision_id) = 68),
  result TEXT NOT NULL CHECK (result IN ('passed', 'failed', 'insufficient_evidence')),
  evidence_ref TEXT CHECK (evidence_ref IS NULL OR length(evidence_ref) BETWEEN 1 AND 512),
  evaluated_at TEXT NOT NULL,
  CHECK (revision_id = 'skr_' || tree_sha256),
  FOREIGN KEY (profile_id, revision_id) REFERENCES skill_revisions (profile_id, revision_id)
) STRICT;

CREATE TRIGGER skill_evaluations_no_update BEFORE UPDATE ON skill_evaluations
BEGIN SELECT RAISE(ABORT, 'skill evaluations are append-only'); END;
CREATE TRIGGER skill_evaluations_no_delete BEFORE DELETE ON skill_evaluations
BEGIN SELECT RAISE(ABORT, 'skill evaluations are append-only'); END;

-- An approval binds the revision, its tree hash, the attestation it relied on, the profile,
-- an optional workspace scope, the declared permission set's digest and an expiry. Only
-- status (granted -> revoked) and revoked_at may change, once.
CREATE TABLE skill_approvals (
  approval_id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  tree_sha256 TEXT NOT NULL CHECK (length(tree_sha256) = 64),
  inspection_id INTEGER NOT NULL,
  workspace_id TEXT CHECK (workspace_id IS NULL OR length(workspace_id) = 36),
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
CREATE INDEX skill_activation_events_package ON skill_activation_events (profile_id, package_id, event_seq);

CREATE TRIGGER skill_activation_events_no_update BEFORE UPDATE ON skill_activation_events
BEGIN SELECT RAISE(ABORT, 'skill activation history is append-only'); END;
CREATE TRIGGER skill_activation_events_no_delete BEFORE DELETE ON skill_activation_events
BEGIN SELECT RAISE(ABORT, 'skill activation history is append-only'); END;

-- Bumped with every activation change so routers can invalidate caches (hot reload).
CREATE TABLE skill_index_generation (
  profile_id TEXT PRIMARY KEY NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 64),
  generation INTEGER NOT NULL CHECK (generation >= 1)
) STRICT;
