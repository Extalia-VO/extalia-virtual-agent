-- Core store schema 6: the learning loop, W6 slice 1 (ADR 0029; ADRs 0024, 0026, 0027).
-- Applied in one transaction by the migrator; no transaction control or PRAGMA statements.
-- Released migrations are immutable: change the schema with a new numbered file.
--
-- Every row carries profile_id (ADR 0024) and every reference is a composite key with it, so
-- a learning row can never point into another profile. Only the core writes these tables
-- (`crate::learning`). Experiences, evidence, their links and the decision history are
-- append-only; a candidate changes only its state (with decided_at/decided_by), only along
-- the allowed transitions and only together with the decision record that explains it.
-- Missions and tasks are never deleted by the core; a learning row also blocks such a delete
-- (no cascade), so retention and erase stay an explicit operation (ADR 0029 §10).

-- Evidence about one native task (ADR 0027 §1, a subset). The kind fixes the trust status:
-- `test_gate` is a check Extalia ran itself (W4 gate, `verified_by_extalia`) and
-- `user_confirmation` a confirmation by the local user (`user_confirmed`), both `verified`;
-- `task_result` is the native agent's own report (`unverified`, written by capture only);
-- `observed_claim` is observed-agent output (always `untrusted`, AC-29). `claim` is what the
-- evidence asserts about the task's outcome; trust says whether it may be believed. Only a
-- digest, a reference and a short redacted excerpt are stored, never raw output.
CREATE TABLE learning_evidence (
  evidence_id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 64),
  mission_id TEXT NOT NULL CHECK (length(mission_id) = 36),
  task_id TEXT NOT NULL CHECK (length(task_id) = 36),
  kind TEXT NOT NULL CHECK (kind IN ('test_gate', 'user_confirmation', 'task_result', 'observed_claim')),
  claim TEXT NOT NULL CHECK (claim IN ('success', 'failure')),
  trust_status TEXT NOT NULL CHECK (trust_status IN ('untrusted', 'unverified', 'verified')),
  digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
  ref TEXT NOT NULL CHECK (length(CAST(ref AS BLOB)) BETWEEN 1 AND 512),
  excerpt TEXT CHECK (excerpt IS NULL OR length(CAST(excerpt AS BLOB)) BETWEEN 1 AND 1024),
  masked_count INTEGER NOT NULL CHECK (masked_count >= 0),
  recorded_by TEXT NOT NULL CHECK (length(recorded_by) BETWEEN 6 AND 69),
  observed_at TEXT NOT NULL,
  CHECK ((kind = 'test_gate' AND trust_status = 'verified' AND substr(recorded_by, 1, 8) = 'extalia:')
      OR (kind = 'user_confirmation' AND trust_status = 'verified' AND substr(recorded_by, 1, 5) = 'user:')
      OR (kind = 'task_result' AND trust_status = 'unverified' AND recorded_by = 'extalia:learning')
      OR (kind = 'observed_claim' AND trust_status = 'untrusted' AND substr(recorded_by, 1, 8) = 'extalia:')),
  UNIQUE (profile_id, evidence_id),
  UNIQUE (profile_id, task_id, kind, digest),
  FOREIGN KEY (profile_id, mission_id) REFERENCES missions (profile_id, mission_id),
  FOREIGN KEY (profile_id, task_id) REFERENCES tasks (profile_id, task_id)
) STRICT;
CREATE INDEX learning_evidence_task ON learning_evidence (profile_id, mission_id, task_id, evidence_id);

CREATE TRIGGER learning_evidence_task_of_mission BEFORE INSERT ON learning_evidence
WHEN NEW.mission_id IS NOT (SELECT mission_id FROM tasks WHERE profile_id = NEW.profile_id AND task_id = NEW.task_id)
BEGIN SELECT RAISE(ABORT, 'learning evidence must name a task of its mission'); END;
CREATE TRIGGER learning_evidence_no_update BEFORE UPDATE ON learning_evidence
BEGIN SELECT RAISE(ABORT, 'learning evidence is append-only'); END;
CREATE TRIGGER learning_evidence_no_delete BEFORE DELETE ON learning_evidence
BEGIN SELECT RAISE(ABORT, 'learning evidence is append-only'); END;

-- L1: one bounded, redacted experience per finished native task with a result (completed or
-- failed), captured once per (mission, task). `outcome` and `basis` are derived from the
-- verified evidence at capture time; `task_digest` is the task row's digest then (revision).
-- A disputed outcome (verified evidence disagrees) is never verified.
CREATE TABLE learning_experiences (
  experience_id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 64),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 64),
  mission_id TEXT NOT NULL CHECK (length(mission_id) = 36),
  task_id TEXT NOT NULL CHECK (length(task_id) = 36),
  task_digest TEXT NOT NULL CHECK (length(task_digest) = 64),
  agent_id TEXT CHECK (agent_id IS NULL OR length(agent_id) = 36),
  origin TEXT NOT NULL CHECK (origin = 'native'),
  task_state TEXT NOT NULL CHECK (task_state IN ('completed', 'failed')),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'disputed')),
  basis TEXT NOT NULL CHECK (basis IN ('verified_by_extalia', 'user_confirmed', 'unverified')),
  summary TEXT NOT NULL CHECK (length(CAST(summary AS BLOB)) BETWEEN 1 AND 4096),
  masked_count INTEGER NOT NULL CHECK (masked_count >= 0),
  created_at TEXT NOT NULL,
  CHECK (outcome <> 'disputed' OR basis = 'unverified'),
  UNIQUE (profile_id, experience_id),
  UNIQUE (profile_id, mission_id, task_id),
  FOREIGN KEY (profile_id, mission_id) REFERENCES missions (profile_id, mission_id),
  FOREIGN KEY (profile_id, task_id) REFERENCES tasks (profile_id, task_id)
) STRICT;

CREATE TRIGGER learning_experiences_task_of_mission BEFORE INSERT ON learning_experiences
WHEN NEW.mission_id IS NOT (SELECT mission_id FROM tasks WHERE profile_id = NEW.profile_id AND task_id = NEW.task_id)
  OR NEW.workspace_id IS NOT (SELECT workspace_id FROM missions WHERE profile_id = NEW.profile_id AND mission_id = NEW.mission_id)
BEGIN SELECT RAISE(ABORT, 'a learning experience must match its task and mission'); END;
CREATE TRIGGER learning_experiences_no_update BEFORE UPDATE ON learning_experiences
BEGIN SELECT RAISE(ABORT, 'learning experiences are append-only'); END;
CREATE TRIGGER learning_experiences_no_delete BEFORE DELETE ON learning_experiences
BEGIN SELECT RAISE(ABORT, 'learning experiences are append-only'); END;

-- The evidence an experience cites: only evidence about the same task.
CREATE TABLE learning_experience_evidence (
  profile_id TEXT NOT NULL,
  experience_id INTEGER NOT NULL,
  evidence_id INTEGER NOT NULL,
  PRIMARY KEY (profile_id, experience_id, evidence_id),
  FOREIGN KEY (profile_id, experience_id) REFERENCES learning_experiences (profile_id, experience_id),
  FOREIGN KEY (profile_id, evidence_id) REFERENCES learning_evidence (profile_id, evidence_id)
) STRICT;

CREATE TRIGGER learning_experience_evidence_same_task BEFORE INSERT ON learning_experience_evidence
WHEN (SELECT task_id FROM learning_evidence WHERE profile_id = NEW.profile_id AND evidence_id = NEW.evidence_id)
  IS NOT (SELECT task_id FROM learning_experiences WHERE profile_id = NEW.profile_id AND experience_id = NEW.experience_id)
BEGIN SELECT RAISE(ABORT, 'an experience cites evidence of its own task only'); END;
CREATE TRIGGER learning_experience_evidence_no_update BEFORE UPDATE ON learning_experience_evidence
BEGIN SELECT RAISE(ABORT, 'learning experience evidence is append-only'); END;
CREATE TRIGGER learning_experience_evidence_no_delete BEFORE DELETE ON learning_experience_evidence
BEGIN SELECT RAISE(ABORT, 'learning experience evidence is append-only'); END;

-- L2/L3 proposals. `knowledge`: a managed-note proposal, `target_ref` the vault-relative note
-- path and `base_sha256` the note it was built against (NULL: absent). `skill`: a SKILL.md
-- proposal, `target_ref` the package name; accepting it only stages it into the profile's
-- skill import inbox (`base_sha256` is NULL). `proposal_digest` is the SHA-256 of `proposal`,
-- and every decision must cite it. A proposal is always by an Extalia component, a decision
-- (accepted, rejected) always by the local user, so a candidate can never approve itself.
-- `insufficient_evidence` carries its reason code; it cannot be accepted (ADR 0027 §5).
-- At most one open (proposed or insufficient_evidence) candidate per target: a new proposal
-- for the same target supersedes the open one.
CREATE TABLE learning_candidates (
  candidate_id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 64),
  kind TEXT NOT NULL CHECK (kind IN ('knowledge', 'skill')),
  state TEXT NOT NULL CHECK (state IN ('proposed', 'rejected', 'accepted', 'superseded', 'insufficient_evidence')),
  target_ref TEXT NOT NULL CHECK (length(CAST(target_ref AS BLOB)) BETWEEN 1 AND 512),
  base_sha256 TEXT CHECK (base_sha256 IS NULL OR length(base_sha256) = 64),
  proposal TEXT NOT NULL CHECK (length(CAST(proposal AS BLOB)) BETWEEN 1 AND 131072),
  proposal_digest TEXT NOT NULL CHECK (length(proposal_digest) = 64 AND proposal_digest NOT GLOB '*[^0-9a-f]*'),
  rationale TEXT NOT NULL CHECK (length(CAST(rationale AS BLOB)) BETWEEN 1 AND 2048),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 64),
  verified_count INTEGER NOT NULL CHECK (verified_count >= 0),
  sample_count INTEGER NOT NULL CHECK (sample_count >= 1 AND sample_count >= verified_count),
  proposed_by TEXT NOT NULL CHECK (length(proposed_by) BETWEEN 9 AND 40 AND substr(proposed_by, 1, 8) = 'extalia:'),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT CHECK (decided_by IS NULL OR (length(decided_by) BETWEEN 6 AND 69 AND substr(decided_by, 1, 5) = 'user:')),
  CHECK (kind = 'knowledge' OR base_sha256 IS NULL),
  CHECK ((decided_by IS NOT NULL) = (state IN ('accepted', 'rejected'))),
  CHECK ((decided_at IS NOT NULL) = (state IN ('accepted', 'rejected', 'superseded'))),
  CHECK (state <> 'insufficient_evidence' OR reason IS NOT NULL),
  UNIQUE (profile_id, candidate_id)
) STRICT;
CREATE UNIQUE INDEX learning_candidates_open_target ON learning_candidates (profile_id, kind, target_ref)
WHERE state IN ('proposed', 'insufficient_evidence');
CREATE INDEX learning_candidates_state ON learning_candidates (profile_id, state, candidate_id);

-- The experiences a candidate relies on, and their evidence.
CREATE TABLE learning_candidate_experiences (
  profile_id TEXT NOT NULL,
  candidate_id INTEGER NOT NULL,
  experience_id INTEGER NOT NULL,
  PRIMARY KEY (profile_id, candidate_id, experience_id),
  FOREIGN KEY (profile_id, candidate_id) REFERENCES learning_candidates (profile_id, candidate_id),
  FOREIGN KEY (profile_id, experience_id) REFERENCES learning_experiences (profile_id, experience_id)
) STRICT;

CREATE TRIGGER learning_candidate_experiences_no_update BEFORE UPDATE ON learning_candidate_experiences
BEGIN SELECT RAISE(ABORT, 'learning candidate experiences are append-only'); END;
CREATE TRIGGER learning_candidate_experiences_no_delete BEFORE DELETE ON learning_candidate_experiences
BEGIN SELECT RAISE(ABORT, 'learning candidate experiences are append-only'); END;

CREATE TABLE learning_candidate_evidence (
  profile_id TEXT NOT NULL,
  candidate_id INTEGER NOT NULL,
  evidence_id INTEGER NOT NULL,
  PRIMARY KEY (profile_id, candidate_id, evidence_id),
  FOREIGN KEY (profile_id, candidate_id) REFERENCES learning_candidates (profile_id, candidate_id),
  FOREIGN KEY (profile_id, evidence_id) REFERENCES learning_evidence (profile_id, evidence_id)
) STRICT;

CREATE TRIGGER learning_candidate_evidence_cited BEFORE INSERT ON learning_candidate_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM learning_candidate_experiences AS c
  JOIN learning_experience_evidence AS e ON e.profile_id = c.profile_id AND e.experience_id = c.experience_id
  WHERE c.profile_id = NEW.profile_id AND c.candidate_id = NEW.candidate_id AND e.evidence_id = NEW.evidence_id)
BEGIN SELECT RAISE(ABORT, 'a candidate cites evidence of its own experiences only'); END;
CREATE TRIGGER learning_candidate_evidence_no_update BEFORE UPDATE ON learning_candidate_evidence
BEGIN SELECT RAISE(ABORT, 'learning candidate evidence is append-only'); END;
CREATE TRIGGER learning_candidate_evidence_no_delete BEFORE DELETE ON learning_candidate_evidence
BEGIN SELECT RAISE(ABORT, 'learning candidate evidence is append-only'); END;

-- Append-only decision history. `propose` opens a candidate (no from_state); `supersede` and
-- `revalidate` (proposed -> insufficient_evidence when its evidence no longer suffices) are by
-- an Extalia component; `accept`, `reject` and `conflict` (an accept whose note write became a
-- conflict copy; the candidate stays proposed) are by the local user. Every record cites the
-- candidate's proposal digest; `outcome_ref` names what an accept produced (the note path and
-- hash, the inbox folder, or the conflict copy).
CREATE TABLE learning_candidate_decisions (
  decision_id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL,
  candidate_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('propose', 'accept', 'reject', 'conflict', 'supersede', 'revalidate')),
  from_state TEXT CHECK (from_state IS NULL OR from_state IN ('proposed', 'insufficient_evidence')),
  to_state TEXT NOT NULL CHECK (to_state IN ('proposed', 'rejected', 'accepted', 'superseded', 'insufficient_evidence')),
  principal TEXT NOT NULL CHECK (length(principal) BETWEEN 6 AND 69),
  proposal_digest TEXT NOT NULL CHECK (length(proposal_digest) = 64),
  outcome_ref TEXT CHECK (outcome_ref IS NULL OR length(CAST(outcome_ref AS BLOB)) BETWEEN 1 AND 1024),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  at TEXT NOT NULL,
  CHECK ((action IN ('accept', 'reject', 'conflict')) = (substr(principal, 1, 5) = 'user:')),
  CHECK ((action IN ('propose', 'supersede', 'revalidate')) = (substr(principal, 1, 8) = 'extalia:')),
  CHECK ((action = 'propose') = (from_state IS NULL)),
  CHECK (action <> 'propose' OR to_state IN ('proposed', 'insufficient_evidence')),
  CHECK (action <> 'accept' OR (from_state = 'proposed' AND to_state = 'accepted')),
  CHECK (action <> 'conflict' OR (from_state = 'proposed' AND to_state = 'proposed')),
  CHECK (action <> 'reject' OR to_state = 'rejected'),
  CHECK (action <> 'supersede' OR to_state = 'superseded'),
  CHECK (action <> 'revalidate' OR (from_state = 'proposed' AND to_state = 'insufficient_evidence')),
  FOREIGN KEY (profile_id, candidate_id) REFERENCES learning_candidates (profile_id, candidate_id)
) STRICT;
CREATE INDEX learning_candidate_decisions_candidate ON learning_candidate_decisions (profile_id, candidate_id, decision_id);

CREATE TRIGGER learning_candidate_decisions_match BEFORE INSERT ON learning_candidate_decisions
WHEN NEW.proposal_digest IS NOT (SELECT proposal_digest FROM learning_candidates
                                 WHERE profile_id = NEW.profile_id AND candidate_id = NEW.candidate_id)
  OR NEW.from_state IS NOT (CASE WHEN NEW.action = 'propose' THEN NULL
                                 ELSE (SELECT state FROM learning_candidates
                                       WHERE profile_id = NEW.profile_id AND candidate_id = NEW.candidate_id) END)
BEGIN SELECT RAISE(ABORT, 'a candidate decision must cite its proposal and current state'); END;
CREATE TRIGGER learning_candidate_decisions_no_update BEFORE UPDATE ON learning_candidate_decisions
BEGIN SELECT RAISE(ABORT, 'learning candidate decisions are append-only'); END;
CREATE TRIGGER learning_candidate_decisions_no_delete BEFORE DELETE ON learning_candidate_decisions
BEGIN SELECT RAISE(ABORT, 'learning candidate decisions are append-only'); END;

-- A candidate's proposal, basis and provenance never change; its state follows the allowed
-- transitions only, each together with the latest decision record of that candidate (same
-- from/to state, same time, and for accept/reject the same user principal).
CREATE TRIGGER learning_candidates_immutable BEFORE UPDATE OF candidate_id, profile_id, kind, target_ref, base_sha256, proposal, proposal_digest, rationale, reason, verified_count, sample_count, proposed_by, created_at ON learning_candidates
WHEN NOT (NEW.state = 'insufficient_evidence' AND OLD.state = 'proposed'
          AND NEW.reason IS NOT NULL AND OLD.reason IS NULL
          AND NEW.candidate_id IS OLD.candidate_id AND NEW.profile_id IS OLD.profile_id
          AND NEW.kind IS OLD.kind AND NEW.target_ref IS OLD.target_ref
          AND NEW.base_sha256 IS OLD.base_sha256 AND NEW.proposal IS OLD.proposal
          AND NEW.proposal_digest IS OLD.proposal_digest AND NEW.rationale IS OLD.rationale
          AND NEW.verified_count IS OLD.verified_count AND NEW.sample_count IS OLD.sample_count
          AND NEW.proposed_by IS OLD.proposed_by AND NEW.created_at IS OLD.created_at)
BEGIN SELECT RAISE(ABORT, 'learning candidates are immutable except their state'); END;
CREATE TRIGGER learning_candidates_transition BEFORE UPDATE ON learning_candidates
WHEN NOT ((OLD.state = 'proposed' AND NEW.state IN ('accepted', 'rejected', 'superseded', 'insufficient_evidence'))
          OR (OLD.state = 'insufficient_evidence' AND NEW.state IN ('rejected', 'superseded')))
BEGIN SELECT RAISE(ABORT, 'learning candidate state change is not allowed'); END;
CREATE TRIGGER learning_candidates_decided BEFORE UPDATE ON learning_candidates
WHEN NOT EXISTS (
  SELECT 1 FROM learning_candidate_decisions AS d
  WHERE d.profile_id = NEW.profile_id AND d.candidate_id = NEW.candidate_id
    AND d.from_state = OLD.state AND d.to_state = NEW.state
    AND d.at IS coalesce(NEW.decided_at, d.at)
    AND (NEW.decided_by IS NULL OR d.principal = NEW.decided_by)
    AND d.decision_id = (SELECT max(decision_id) FROM learning_candidate_decisions
                         WHERE profile_id = NEW.profile_id AND candidate_id = NEW.candidate_id))
BEGIN SELECT RAISE(ABORT, 'a candidate state change needs its decision record'); END;
CREATE TRIGGER learning_candidates_no_delete BEFORE DELETE ON learning_candidates
BEGIN SELECT RAISE(ABORT, 'learning candidates are kept for audit'); END;
