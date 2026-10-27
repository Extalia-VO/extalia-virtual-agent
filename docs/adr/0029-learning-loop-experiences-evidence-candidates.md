# ADR 0029: Learning loop: experiences, evidence and candidates

Status: Proposed (2026-10-24). Slice 1 of W6 "Evolve" implements the recommended decision in the
Rust core only (`crates/extalia-core/src/learning/`, core schema 6); nothing is on the daemon
wire or in the UI yet, so the owner can still change every default below.

## Context

PRD v1.1 FR-18 splits learning into L1 (capture bounded, redacted, attributable experiences
automatically), L2 (update Extalia-managed notes after verification) and L3 (propose skills that
need inspection and evaluation), and forbids self-approval, trust advantages for self-generated
skills and auto-modification of policy, grants, scanner configuration or the approval workflow.
FR-10 asks for candidates with provenance and counterexamples, FR-20 for claims linked to
evidence with a confidence basis, FR-22/FR-24 forbid fabricated improvement metrics, and the
learning contract (`knowledge-and-learning.md`) says human edits and reviews always override
autonomous proposals and small samples are `insufficient_evidence`, not `improved`. Acceptance:
AC-09 (a rejected skill candidate never becomes active), AC-10 (no cross-profile leakage),
AC-21 (evidence captured, a candidate cannot self-approve), AC-29 (an observed agent's claim of
success without verifiable artifacts stays unverified and never promotes learning).

Repository facts (working tree, 2026-10-24):

- The core store (`core.sqlite`, ADR 0019) holds native missions, their tasks (contract JSON
  with `requirements`, `evidenceIds`, `verification`) and control events. The admission policy
  refuses model prose, tool arguments and results in the journal (ADR 0014), so a task's
  "result" in the core is its terminal state, attempt and requirements, not text. Tasks of a
  finished mission cannot change (`transition_task` refuses), and missions are never deleted.
  A completed task is `verification: unverified` until evidence says otherwise.
- Verified checks exist only in the host: the W4 integration test gate records command, exit
  code and a bounded redacted log digest with `basis: verified_by_extalia` (ADR 0028 §6).
- ADR 0027 defines evidence, confidence basis (`verified_by_extalia`, `user_confirmed`,
  `reported_by_native_agent`, `reported_by_observed_agent`, `inferred`), trust status and the
  `insufficient_evidence` rules, and leaves the sample size *n* to the owner.
- Knowledge writes go through `knowledge::write` (ADR 0024 slice 2b note): compare-and-swap,
  conflict copies, revision journal; `Author::Extalia` may only create or replace notes marked
  `managed_by: extalia`; an Extalia update of a user note becomes a conflict copy.
- Skills enter only through `SkillRegistry::import` into quarantine, then inspection (scanner
  unavailable → stays quarantined, ADR 0023), review, approval and activation (ADR 0025/0026).
  Approvals and reviews already require `user:` principals.
- The credential masking of the host (`redact`) is ported to Rust as
  `knowledge::import::mask_credentials`.

## Options considered

**Where L1 experiences come from**

| Option | For | Against |
| --- | --- | --- |
| Every session, including observed agents' transcripts | Most data | Observed output is untrusted data and may carry injected instructions (AC-29, AC-30); no profile for unmatched sessions (ADR 0024) |
| Native tasks as they run | Fresh | A running task's outcome is not known; partial rows need updates (no append-only) |
| **Finished native missions only, one row per task with a result, idempotent per mission** | Stable inputs (tasks are frozen), append-only rows, profile known from the mission | Learning waits for the mission to end; observed work only contributes as untrusted evidence on a native task |

**What decides an outcome's trust**

| Option | For | Against |
| --- | --- | --- |
| Task state (`completed` = success) | Simple | A model's own report; ADR 0027 forbids it as verification |
| Score combining all signals | Rankable | Fabricated precision; observed claims could add up to "verified" |
| **Only verified evidence (Extalia's own check or the user's confirmation) changes or verifies an outcome; disagreement is `disputed`** | Matches ADR 0027 §3; an observed claim can never verify | Most experiences stay `unverified` until W4 gates are configured |

**How candidates take effect**

| Option | For | Against |
| --- | --- | --- |
| Auto-apply L2 notes and auto-activate declarative L3 skills | Fully autonomous | FR-18 allows auto-activation only after inspection and evaluation, which do not run yet (scanner pin, sandbox); no self-approval |
| Learning writes skill rows directly (generated origin) | One step | A second path into the skill tables, bypassing hash points and the import rules (ADR 0025); "no special path for a trusted agent" (blueprint §7) |
| **Candidates are proposals; the local user decides; L2 accept writes through the managed-note CAS path; L3 accept only stages a package into an inbox the normal W3 import reads** | No new trust path; conflicts and history reuse the knowledge write path; skills keep one entry point | Two steps for skills (accept, then import/inspect/approve); hybrid auto-activation is deferred |

## Recommended decision

1. **Experience (L1).** Captured only from a *finished* native mission (`completed`, `failed` or
   `cancelled`) in the core store, one experience per task with a result (`completed` or
   `failed`; cancelled, unknown or never-started tasks are skipped). Capture is idempotent per
   mission (`UNIQUE (profile_id, mission_id, task_id)`; tasks of a finished mission are frozen).
   Fields: profile, workspace, mission, task, the task row's digest at capture (revision),
   assignee agent, `origin = native`, task state, outcome (`success | failure | disputed`),
   verification basis, a summary and its masked count, cited evidence, `created_at`.
   Observed sessions never become experiences; their output can only be attached to a native
   task as `observed_claim` evidence.
2. **Redaction and size.** The summary is built from structured task fields only (state,
   attempt, requirements, evidence kind/claim/trust/reference), never model prose, and is passed
   through the Rust port of `redact` *before* it is cut to 4 KiB (cutting first could split a
   credential past its pattern). Evidence references (≤ 512 bytes, refused if longer after
   masking) and excerpts (≤ 1 KiB, cut) are masked at ingestion; proposals, findings and
   rationales are masked too. Bounds: 32 evidence records per task, 64 experiences per
   candidate, 128 KiB per proposal, 256 open candidates per profile.
3. **Evidence and provenance.** Append-only `learning_evidence` rows (subset of ADR 0027 §1):
   kind, claim (`success | failure`), trust status, digest, reference, excerpt, recorder and
   observation time. The kind fixes the trust status, in code and by `CHECK`:
   `test_gate` (Extalia ran the check, recorded by an `extalia:` component) and
   `user_confirmation` (recorded by `user:<id>`) are `verified`; `task_result` (the native
   agent's report, written by capture only) is `unverified`; `observed_claim` is always
   `untrusted`, whatever it says (ADR 0027). Recording the same kind and digest again is
   idempotent; a different claim for it is refused.
4. **Verification basis.** From the task's verified evidence only: all agree → that outcome,
   `verified_by_extalia` if a test gate is among them, else `user_confirmed`; they disagree →
   `disputed` with basis `unverified`; none → the reported outcome with basis `unverified`.
   Native reports and observed claims never change an outcome. The experience row is a
   snapshot; revalidation (item 9) derives the basis again from the evidence recorded since.
5. **Candidates.** `knowledge` (L2): a managed-note proposal and its vault path below
   `Knowledge/`, `Experiences/` or `Learning/` (never `Skills/`, `Decisions/`, `Projects/` or
   the root), built without writing: a new note with `managed_by: extalia`, `kind: knowledge`,
   `source_task_ids` and a front-matter `verification` mirror; an existing managed note gets the
   finding appended (every existing line, human edits included, is kept); next to a user note a
   standalone managed proposal is built, which an accept turns into a conflict copy. The note's
   SHA-256 at proposal time is the CAS base. `skill` (L3): a Markdown-only `SKILL.md` (no
   `extalia-skill.json`, so no declared permissions; the W3 import infers a declarative
   manifest) and the inbox folder `skill-inbox/<name>-<12 hex of the digest>` it would be staged
   in; nothing is written and the skill tables are never read or written. States: `proposed`,
   `insufficient_evidence`, `accepted`, `rejected`, `superseded`. A new proposal for the same
   target supersedes the open one; the identical proposal again returns it unchanged.
6. **`insufficient_evidence`**, evaluated over the cited experiences, in order:
   `disputed_evidence` (verified evidence disagrees about an outcome), `no_verified_evidence`
   (no verified success: only native reports and/or observed claims — AC-29),
   `too_few_verified` (fewer than `MIN_VERIFIED_EXPERIENCES` = **2** verified successes),
   `contradicted` (at least as many verified failures as verified successes). Such a candidate
   is stored with its reason and sample counts, can be rejected or superseded, never accepted.
   Segmentation by difficulty, workspace and provider (ADR 0027 §5) needs the evaluation slice.
7. **Decisions; no self-approval.** Only `user:<id>` accepts or rejects, citing the proposal
   digest that was shown (digest-bound, ADR 0026). Proposals are always by `extalia:<component>`,
   so proposer and decider can never be the same principal; agents, models, policies and
   Extalia itself cannot decide (triggers and `CHECK`s on `decided_by` and on the append-only
   decision history: `propose`, `accept`, `reject`, `conflict`, `supersede`, `revalidate`).
   A candidate's state changes only along the allowed transitions and only together with its
   latest decision record. Accepting a knowledge candidate writes the proposal through
   `knowledge::write` as `Author::Extalia` with the CAS base: a managed note is created or
   replaced (journaled, recoverable with rollback); a user note, or a note edited since the
   proposal, becomes a conflict copy, the candidate stays `proposed` and a `conflict` record
   names the copy. Accepting a skill candidate only stages the exact `SKILL.md` into
   `<data>/profiles/<profile>/skill-inbox/<name>-<12 hex>/` (private folder, new file, nothing
   else in it); importing it (`Origin::Generated`), inspection, review, approval and activation
   stay the normal W3 path with no shortcut and no trust advantage.
8. **No policy self-modification.** The learning module has no access path to permission
   policy, grants, approvals, scanner configuration, skill revisions or activations, and its
   targets exclude them; a skill proposal cannot declare permissions.
9. **Revalidation triggers.** Every accept first re-derives the basis of the cited experiences
   from the evidence recorded *now*; if it no longer suffices (for example a user confirms a
   failure that contradicts a passed gate), the candidate becomes `insufficient_evidence` with a
   `revalidate` record and nothing is written or staged. Future triggers (owner question 4):
   dependency or version change of a target, an expired evidence window, a policy or scanner
   version change, an explicit user request. Nothing rescans continuously.
10. **Human edits override.** Extalia never replaces a user note; a managed note edited after a
    proposal makes the accept a conflict copy; a user removing `managed_by` takes the note over;
    the inbox is only read by an explicit import.
11. **Retention.** Learning rows are append-only and kept for audit as long as their mission
    (no cascade: a learning row blocks a mission delete, and the core deletes none). Candidates
    are never deleted; conflict copies and history follow the knowledge rules; staged inbox
    folders are never deleted automatically. Erasing a profile or exporting learning records
    needs a later explicit operation (ADR 0027 open question 3).
12. **Profiles.** Every row has `profile_id` and every reference is a composite key with it, so a
    learning row cannot point into another profile; every API takes the profile from the
    `Learning` handle and refuses another profile's vault or history (AC-10).

Schema 6 (`crates/extalia-core/migrations/0006_learning.sql`): `learning_evidence`,
`learning_experiences`, `learning_experience_evidence`, `learning_candidates` (partial unique
index: one open candidate per target), `learning_candidate_experiences`,
`learning_candidate_evidence`, `learning_candidate_decisions`; append-only and transition
triggers as above.

## Consequences

- AC-21 and AC-29 are testable in the core today; AC-09 holds because a skill candidate reaches
  at most the quarantine of the normal import. Hybrid auto-activation of declarative skills
  (FR-18) and sandbox evaluation (FR-22) remain for later W6 slices and must use the W3 gate.
- Most experiences are `unverified` until workspaces configure W4 test gates and the host
  forwards gate results as `test_gate` evidence; that forwarding must come only from the
  integration queue, never from a model tool.
- Next slices: daemon operations (capture after a mission ends, evidence from the W4 gate,
  propose/decide), host and Learning Center UI with candidate review, evaluation records
  (`learning_evaluations`), segment metrics without inferred percentages, export/erase.
- A rejected or superseded candidate's proposal stays in `core.sqlite` (masked); exports must
  re-run redaction (ADR 0027 §6).

## Open questions for the owner

1. Is `MIN_VERIFIED_EXPERIENCES = 2` right, and should knowledge (L2) and skills (L3) differ or
   be segmented (difficulty × workspace × provider) before the evaluation slice?
2. Should a `user_confirmation` be able to confirm a task whose only other evidence is an
   observed claim (proposed: yes, explicitly per task, as ADR 0027 question 4)?
3. Should an accepted knowledge candidate's note record a per-revision provenance row
   (`knowledge_provenance`) in addition to the decision record, and in which database?
4. Which revalidation windows per evidence kind, and should a contradiction recorded after an
   *accepted* note open a review record automatically?
5. Retention and erase: keep learning rows for audit until the profile is erased, or tombstone
   them earlier (and how long staged inbox folders live)?
6. Should Extalia ever auto-propose from failures (counterexample notes), or only from verified
   successes as now?
