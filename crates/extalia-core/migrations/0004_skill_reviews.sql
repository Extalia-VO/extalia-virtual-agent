-- Core store schema 4: human skill reviews, W0 consent as stored review input and durable
-- built-in skill registrations, W3 slice 2 (ADR 0025 §4, §7 and its 2026-10-23 notes;
-- ADR 0026 §5; gap-map decision 10).
-- Applied in one transaction by the migrator; no transaction control or PRAGMA statements.
-- Released migrations are immutable: change the schema with a new numbered file.
--
-- Every row carries profile_id (ADR 0024) and every revision reference is a composite key
-- with it. All three tables are append-only (triggers below). Only the core writes them.

-- A human decision on a `review_required` revision. It binds the tree hash the reviewer was
-- shown and the inspection (attestation) whose findings were reviewed. The principal is the
-- local user (`user:<id>`); agents, models, scanners and the policy cannot review
-- (ADR 0026 §5). accept → `validated`, reject → `quarantined` (`review-rejected`).
CREATE TABLE skill_reviews (
  review_id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  tree_sha256 TEXT NOT NULL CHECK (length(tree_sha256) = 64),
  inspection_id INTEGER NOT NULL,
  principal TEXT NOT NULL CHECK (length(principal) BETWEEN 6 AND 69 AND substr(principal, 1, 5) = 'user:'),
  decision TEXT NOT NULL CHECK (decision IN ('accept', 'reject')),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL,
  CHECK (revision_id = 'skr_' || tree_sha256),
  FOREIGN KEY (profile_id, revision_id) REFERENCES skill_revisions (profile_id, revision_id),
  FOREIGN KEY (profile_id, revision_id, inspection_id) REFERENCES skill_inspections (profile_id, revision_id, inspection_id)
) STRICT;
CREATE INDEX skill_reviews_revision ON skill_reviews (profile_id, revision_id, review_id);

CREATE TRIGGER skill_reviews_no_update BEFORE UPDATE ON skill_reviews
BEGIN SELECT RAISE(ABORT, 'skill reviews are append-only'); END;
CREATE TRIGGER skill_reviews_no_delete BEFORE DELETE ON skill_reviews
BEGIN SELECT RAISE(ABORT, 'skill reviews are append-only'); END;

-- Information shown to a reviewer, never a decision (ADR 0025 §7): a W0 consent of a
-- workspace whose SHA-256 equals the revision's stored SKILL.md. Recording one changes no
-- state. Each (revision, workspace, consent digest) is recorded once.
CREATE TABLE skill_review_inputs (
  input_id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('w0-consent')),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) = 36),
  consent_sha256 TEXT NOT NULL CHECK (length(consent_sha256) = 64),
  allowed_at TEXT CHECK (allowed_at IS NULL OR length(allowed_at) BETWEEN 1 AND 64),
  observed_at TEXT NOT NULL,
  UNIQUE (profile_id, revision_id, source, workspace_id, consent_sha256),
  FOREIGN KEY (profile_id, revision_id) REFERENCES skill_revisions (profile_id, revision_id)
) STRICT;

CREATE TRIGGER skill_review_inputs_match BEFORE INSERT ON skill_review_inputs
WHEN NEW.consent_sha256 IS NOT (SELECT skill_md_sha256 FROM skill_revisions
                                WHERE profile_id = NEW.profile_id AND revision_id = NEW.revision_id)
BEGIN SELECT RAISE(ABORT, 'a consent input must match the revision''s SKILL.md'); END;
CREATE TRIGGER skill_review_inputs_no_update BEFORE UPDATE ON skill_review_inputs
BEGIN SELECT RAISE(ABORT, 'skill review inputs are append-only'); END;
CREATE TRIGGER skill_review_inputs_no_delete BEFORE DELETE ON skill_review_inputs
BEGIN SELECT RAISE(ABORT, 'skill review inputs are append-only'); END;

-- Audit of built-in skills (packages shipped with the app, gap-map decision 10). Kept apart
-- from skill_packages on purpose: a built-in never becomes a revision, so it cannot enter the
-- lifecycle, approvals or the activation pointer, and skill_packages.origin keeps admitting
-- only the four import origins. The latest row of a package is its current registration:
-- `registered` (these bytes, re-verified against the object store on every start),
-- `integrity` (the stored object no longer hashes to the recorded tree; not loaded) or
-- `retired` (no longer shipped).
CREATE TABLE skill_builtin_registrations (
  registration_id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 64),
  package_id TEXT NOT NULL CHECK (length(package_id) BETWEEN 1 AND 64),
  revision_id TEXT NOT NULL CHECK (length(revision_id) = 68),
  tree_sha256 TEXT NOT NULL CHECK (length(tree_sha256) = 64),
  skill_md_sha256 TEXT NOT NULL CHECK (length(skill_md_sha256) = 64),
  version TEXT NOT NULL CHECK (length(version) BETWEEN 5 AND 128),
  risk_class TEXT NOT NULL CHECK (risk_class IN ('declarative', 'tool_using', 'executable')),
  permission_digest TEXT NOT NULL CHECK (length(permission_digest) = 64),
  event TEXT NOT NULL CHECK (event IN ('registered', 'integrity', 'retired')),
  at TEXT NOT NULL,
  CHECK (revision_id = 'skr_' || tree_sha256)
) STRICT;
CREATE INDEX skill_builtin_registrations_package ON skill_builtin_registrations (profile_id, package_id, registration_id);

CREATE TRIGGER skill_builtin_registrations_no_update BEFORE UPDATE ON skill_builtin_registrations
BEGIN SELECT RAISE(ABORT, 'built-in skill registrations are append-only'); END;
CREATE TRIGGER skill_builtin_registrations_no_delete BEFORE DELETE ON skill_builtin_registrations
BEGIN SELECT RAISE(ABORT, 'built-in skill registrations are append-only'); END;
