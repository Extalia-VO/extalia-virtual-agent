# ADR 0027: Evidence and provenance model

Status: Accepted (2026-10-22) with the recommended defaults for its open questions; the owner
may revise them before the wave that implements them.

## Context

PRD §5 rules: "observed ≠ controlled; tool output ≠ verified success; no percentage progress
without task/evidence denominator; source timestamps and observation timestamps must remain
distinct". FR-20 requires every claim to link to source evidence, observation time,
validation method, owner/profile, confidence basis, revision and trust status, and says
AI-generated summaries are not equivalent to verified outcomes. FR-18 and AC-29: observed
logs are untrusted and never evidence of verified success by themselves. The
[knowledge spec](../product/master-prd-v1.1/knowledge-and-learning.md) requires
`insufficient_evidence` instead of `improved` for small samples; FR-22/FR-24 forbid
fabricated metrics; blueprint §5 defines an event envelope with `origin(native|observed)`,
`source`, `observed_at`, `occurred_at?` and `confidence`.

Repository facts (working tree, 2026-10-21):

- `@extalia/protocol` (`orchestration.ts`): `Evidence { id, workspaceId, taskId, kind,
  artifactId, digest, recordedAt, verification: 'unverified' | 'verified' }` ("recording a
  claim does not establish verification"); `EvidenceKind` = test, build, diff, artifact, log,
  review, user_confirmation; `AgentEvent.confidence` = reported | observed | inferred, with
  `sourceTimestamp` separate from `observedAt`; `Experience` and `SkillCandidate` carry
  `evidenceIds`; `AgentOrigin` = native | observed. None of these is enforced (ADR 0007).
- v0 events (`events.ts`) carry `source { runtime, channel, adapter?, adapterVersion? }`
  with channel `stream | hook | transcript | mcp | bridge | import | user | system`, and
  sessions are `managed` or `observed`. Observed events come from transcripts, hooks, MCP and
  imports (`packages/host/src/{observations,transcriptEvents,hooks/*}.ts`,
  `packages/importers`) with deterministic SHA-256-derived ids; "labels only" privacy keeps
  only labels (`observations.ts` `labelsOnly`).
- Native mission results are always `verification: 'unverified'`
  (`packages/runtime/src/mission.ts`), the host summarises "Completed with unverified model
  output" and stores `evidenceIds: []` (`packages/host/src/mission.ts`); dependency answers
  are passed on labelled unverified.
- Memory notes (`packages/host/src/memory.ts`) have no provenance; credentials are masked
  with `redact` / `countSecrets` (`packages/core/src/privacy.ts`), also used by library export.
- `docs/architecture/security.md`: no telemetry is collected.

## Options considered

| Option | For | Against |
| --- | --- | --- |
| Numeric confidence score per claim | Easy to rank | Invites fabricated precision; mixes source trust with validation. Kept only as a derived display value |
| Trust flags inside Markdown front matter | Portable | A user or external editor can type `verification: verified`; FR-23 says metadata edits never change trust. Rejected as authority |
| **Append-only evidence records in `core.sqlite`, referenced by claims; front matter only mirrors ids** | One authority, auditable, profile-scoped, survives index rebuilds | Notes need the database to show trust; a vault copied elsewhere carries ids, not trust |
| Store raw outputs as evidence | Complete | Secrets/personal data in the database and exports; size. Rejected: references + digests + redacted excerpts |

## Recommended decision

1. **Evidence record** (append-only, `profile_id NOT NULL`, ADR 0024; extends the protocol
   `Evidence`): `id`, `schema_version`, `profile_id`, `workspace_id`, `subject`
   (`task_result | memory_claim | knowledge_revision | skill_revision | experience |
   learning_candidate | evaluation`, with subject id and subject revision), `kind`
   (protocol kinds plus `command_result`, `scan`, `evaluation`, `observation`,
   `model_output`), `origin` (`native | observed | imported | user`), `source` (runtime,
   channel, adapter and version, actor id, event ids), `artifact_ref` + `digest`
   (content-addressed artifact, file path + hash, or command + exit code), `occurred_at`
   (source clock, optional) and `observed_at` (Extalia's clock, required), `validation`
   (`method`: `none | extalia_execution | hash_match | user_confirmation | review | scan |
   evaluation`; `performed_by`; validator version), `confidence_basis` (enum below),
   `trust_status`, `redaction` (applied rules, masked count), and `supersedes`.
2. **Confidence basis, not a score:** `verified_by_extalia` (Extalia itself ran the check —
   a workspace-configured test/build command with its exit code, a hash comparison, a
   scanner/evaluation run — and recorded the result), `user_confirmed`,
   `reported_by_native_agent`, `reported_by_observed_agent`, `inferred` (model summary or
   synthesis). A command the model chose is `extalia_execution` evidence of *what ran and
   its exit code*, not of task success, unless the command is the workspace's configured
   check for that requirement.
3. **Trust status:** `untrusted → unverified → verified`, plus `disputed`, `superseded`,
   `revoked`. Only `verified_by_extalia` or `user_confirmed` evidence within the same
   profile can make a claim `verified`. **Observed origin is always `untrusted`**: transcript,
   hook, MCP and imported content is data, never instructions and never proof of success,
   whatever it claims (AC-29, AC-30). Native agent claims stay `unverified` until checked;
   AI summaries are `inferred` and cannot raise trust. A claim's trust is the minimum of the
   evidence it relies on; front matter (`verification:` in a note) mirrors the database and
   is ignored as input (a mismatch is flagged, not adopted). Contradicting evidence sets
   `disputed` and opens a review record; nothing is overwritten silently.
4. **Claims link to evidence.** Task results (`Task.evidenceIds`), memory and knowledge note
   revisions (`knowledge_provenance(revision_id, evidence_id)`), experiences, skill revisions
   (inspection and evaluation records) and learning candidates reference evidence ids; a
   claim without evidence is `unverified`. Progress percentages are shown only with an
   explicit `verified/total` denominator.
5. **`insufficient_evidence` rules.** An evaluation or learning metric reports
   `improved | regressed | no_change | insufficient_evidence | unavailable`.
   `insufficient_evidence` when any of: fewer samples than the minimum per segment
   (difficulty × workspace × provider, owner sets *n*); no comparable baseline in the same
   segment; the supporting evidence is not `verified`; evidence older than its revalidation
   window or revoked; mixed policy/scanner versions across the compared runs. `unavailable`
   when isolation or the evaluator could not run (FR-22). Neither result can promote a
   candidate, auto-update knowledge (L2) or auto-activate a skill (L3); dashboards show the
   reason and the sample count, never an inferred percentage.
6. **Redaction before export (and any future telemetry).** Evidence stores references,
   digests and short redacted excerpts, never raw prompts, file contents, scanner reports
   or skill bodies. `redact()` runs at ingestion of every excerpt; `labelsOnly`
   observations produce label-only evidence. Exports are per profile, by explicit user
   action, and re-run redaction; diagnostics and logs carry ids, reason codes and counts
   only. There is still no telemetry; if one is ever added, it receives only aggregated
   counts and reason codes, by ADR.

## Consequences

- W1 contracts: evidence, confidence basis, trust status and evaluation result enums in
  `@extalia/protocol` with fixtures (observed claim stays untrusted; summary cannot verify;
  front-matter `verified` ignored; small sample → `insufficient_evidence`).
- Mission results remain unverified until W4+ adds configured checks; the UI keeps
  "unverified" labels rather than inferring success from `ok: true` tool events.
- Learning from observed agents (FR-18) is limited to `untrusted` experiences that can only
  feed candidates for human review.
- Content-addressed artifacts need a per-profile store and retention policy (PRD §9).

## Open questions for the owner

1. Minimum sample size per segment for `improved`/`regressed`, and the revalidation window
   per evidence kind.
2. Which workspace checks count as `verified_by_extalia` (test/build commands configured
   per workspace, proposed), and who may configure them?
3. Retention of evidence and artifacts per profile, and whether erase removes evidence or
   tombstones it (audit trail vs right to delete).
4. May a user confirmation (`user_confirmed`) verify claims that originate from an observed
   agent (proposed: yes, explicitly per claim)?
