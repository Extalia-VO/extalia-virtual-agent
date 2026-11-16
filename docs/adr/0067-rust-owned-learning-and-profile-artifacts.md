# ADR 0067: Rust owns learning jobs and profile artifacts

Status: Implemented locally on Unix in v0.4.239, 2026-11-09; Windows artifact support remains unavailable

## Context

The Knowledge page already uses Rust for vault indexing, search, note reads,
compare-and-swap writes and history. Skills use the Rust registry for import,
inspection and lifecycle decisions. Automatic Chat learning nevertheless had a
TypeScript curator loop, evidence/submission processing, hash-admission files,
generated-skill staging and direct Markdown exports. That split left this local
backend work in the host and duplicated filesystem responsibilities.

The existing core mission-learning subsystem has a different verified-evidence
and user-acceptance policy. It must not be used to relabel generated Chat findings
as verified experiences or to bypass registry inspection.

## Decision

Use the existing lazy profile daemon, independently of the backend selected for
new missions. Add the versioned, capability-advertised `learning.process` port.
Rust owns a bounded learning worker and the local job state machine: evidence
selection/redaction, model/read effect sequencing, deadlines and counters,
submission validation, hashes, durable admission receipts, Markdown rendering,
safe note publication and generated skill staging. Keep its filesystem work off
the daemon's mission/control dispatch thread and drain accepted work on EOF.

The host retains admission and consent checks, provider credentials, the approved
provider's HTTP adapter, physical effect draining and UI event projection. Rust
issues correlated bounded effects; the host returns their actual completion.
Duplicate, late or foreign effect acknowledgements cannot reopen a job. Remote
model inference still runs at the selected provider: Rust processes and controls
its result, rather than replacing the language model.

The production automatic curator receives current-invocation tool evidence and
its submission tool. It receives no general host filesystem, web, shell or memory
tools. A profile's export destination is not a new model read grant. Ordinary
Native Chat tools and provider adapters remain transitional TypeScript paths;
this decision does not claim a fully migrated Native harness.

## Persistence and authority

- Keep the existing hash-only automatic-learning receipt filenames and admission
  semantics. Rust reads the same profile/content namespace, so earlier attempted
  or uncertain writes continue to block automatic retries after an upgrade.
- Rust pins an authorized vault root and its filesystem identity to purpose,
  workspace, session, profile and policy revision. Models cannot select paths.
  A prepared Markdown note is a private temporary file. The host checks consent
  and write authority again before committing it; Rust then publishes without
  overwriting different content. Exact retries remain idempotent.
- Opaque pins, drafts, stages and jobs belong to their issuing daemon connection.
  Restart never rebinds them or automatically replays inference. Releasing pins
  discards their unpublished drafts; shutdown cleans unpublished temporary work.
- Generated skills are Markdown/provenance candidates in the fixed profile
  import inbox. Rust validates, renders and stages them; the same existing Rust
  registry imports and inspects them. No automatic approval or activation is
  introduced, and an unavailable scanner still means quarantine.
- Managed vault creation is a Rust operation constrained to the daemon's own
  `vaults/default` or registered-profile directory pattern. Custom vaults must
  already exist. Exports do not switch the live Knowledge index or edit Obsidian
  configuration.
- Cancellation requests revocation. The host waits for an entered provider,
  tool or storage operation to actually settle before releasing its ownership.
  Lost acknowledgements remain uncertain; they do not justify automatic retries.

## Hermes reference

Hermes provides useful product patterns: progressively disclose reusable skill
instructions, distinguish durable memory from procedural skills, review completed
work in a separate curator, and stage reviewable edits with recoverable history.
Its Obsidian integration uses Markdown files and vault conventions. Extalia
retains its own one-vault-per-profile boundaries and mandatory skill registry
inspection; Hermes's implementation language does not determine process placement.

References: [skills](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md),
[curator](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/curator.md),
[Obsidian integration](https://github.com/NousResearch/hermes-agent/blob/main/skills/note-taking/obsidian/SKILL.md).

## Validation

Artifact effects currently require the Unix descriptor-relative backend. Windows
does not advertise `learning.process`, so these effects and curator inference are
unavailable there. A path-based JavaScript or Rust fallback would weaken the
validated-root boundary; equivalent Windows handle-relative publication requires
a separate implementation and platform testing. General Knowledge and existing
registry read/lifecycle operations retain their own platform behavior.

Use temporary profiles/vaults, synthetic model effects and the actual sidecar.
Verify schema parity, bounded admission, control responsiveness, duplicate/late
effects, cancellation and drain, legacy receipts, root replacement and symlinks,
idempotent publication, revoked authority, stage cleanup and scanner quarantine.
These tests establish the implemented ownership boundary; they do not measure
whole-application resource improvements or certify live provider behavior.

Full `pnpm check` passed locally: 7,759 TypeScript tests (26 optional tests skipped),
501 Rust tests, formatting, Clippy, types and all builds. Actual sidecar tests use
temporary profiles/vaults and synthetic provider responses. The 14 learning-owner
tests cover bounded jobs/intake, legacy receipts, immutable publication and worker
queue/drain behavior. Host tests also verify large evidence, profile boundaries,
permission revocation, same-connection handles and shutdown fencing. These results
do not certify live provider behavior, Windows artifacts or whole-process savings.
