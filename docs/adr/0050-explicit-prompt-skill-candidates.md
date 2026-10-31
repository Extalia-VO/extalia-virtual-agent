# ADR 0050: Explicit prompt learning creates quarantined skill candidates

Status: Implemented and verified locally v0.4.156, 2026-10-31
Tracking: V2-16 / issue #54; extends ADR 0049

## Decision

A current Native Chat message may explicitly request one generated skill
candidate. The client passes `learnSkill: true`, or the user starts the submitted
message with the exact `/learn-skill` command token. Natural language works with
the per-message checkbox; keyword matching alone never authorizes a write.
History, quoted commands, attachments, project instructions and model assertions
cannot opt in. The flag is not a session permission or a persistent preference.

Only the Native lead with Extalia skills enabled, the Rust registry and a
non-plan permission mode receives `skill_propose`. Workers and missions never
receive it. Existing write policy still applies; a prior write grant alone does
not enable this tool. Observed and managed external sessions are not emulated.
The additional current-message opt-in authorizes bounded profile-library draft
storage, not arbitrary access outside the workspace.

## Candidate and inspection

The tool accepts a bounded name, single-line description, instructions and
optional source URLs. It accepts no paths, executable files, scanner results,
permissions or lifecycle decisions. The host binds the actual session/workspace
and submitted-prompt SHA-256 into provenance; the raw prompt is not copied.
Source URLs are inert, unverified attribution claims, never fetched by this tool.

Only `SKILL.md` and a Markdown provenance receipt are privately staged and
imported through the existing registry with `origin: generated`. Import owns
scanner inspection; the host also obtains `skill.inspect` for current state and
recorded evidence. A library record is not a successful scan, approval or active
skill. No approval or activation operation is called. Production inspection is
still unavailable, so successful candidate imports remain quarantined and never
reach agent skill catalogs or `skill_read`.

One tool instance admits at most one proposal attempt, consuming its slot before
asynchronous effects. Invalid input or cancellation before admission creates no
candidate. Once import may have started, errors cannot imply rollback. An
acknowledged import with a lost inspection response remains saved and is reported
with inspection unavailable; cancellation after import does not delete it or
prove the scan completed. Users review the actual revision in Skills.

## Limits

This produces a generated instructions-only draft, not a faithful archive or
scanner certification of the original page/package or its referenced scripts.
Source reading remains within existing tools and permissions. Model guidance
prohibits executing source code or adopting unverified procedures during
learning; it is not a generic-content injection sandbox. Approval, activation,
scanner worker/pins, effect-time ACL and mission skill parity remain separate
gates. The current host refuses TypeScript-only and unsupported registry
configurations without creating a fake candidate or clean scan. Older application
hosts do not implement this learning flow and need updating; sending a new option
to an older host does not prove it was understood. A model response without a
successful proposal receipt does not establish that anything was saved.

## Verification

Real temporary-profile Rust/provider regressions prove generated-library
persistence, scanner-unavailable quarantine, provenance binding and no approval
or active offering. Ordinary EN/ID reading, quoted/fenced/nested/near-match
commands, invented model calls and prior write allowance cannot create a
candidate; the next ordinary turn and delegated workers have no proposal tool.
Plan, feature-off, TypeScript and external-runtime requests refuse before
inference. Rejected write approval leaves the library empty. Backend fixtures
also cover uncertain inspection, cancellation, cleanup and duplicate attempts.

Shared UI regressions cover explicit flag forwarding with attachments, failure
retry, host/workspace/session resets, unsupported mock parity and late completion.
Independent review found a first-session handoff losing failed drafts and a
navigation race while awaiting state. Both were fixed and reproduced through the
production handoff helper; re-review found no remaining blocker. Synthetic
browser QA covers EN/light desktop and ID/dark 390px, selected scanner hint,
successful-send reset and plan-mode removal, with no horizontal overflow.

Full `pnpm check` passed: 353 TypeScript suites / 5,339 tests and 453 Rust tests;
one TypeScript suite / five tests skipped. Lint, boundaries, public safety,
schemas, types, strict Clippy/format and Web/Desktop/CLI builds passed. Its first
attempt found a type-import lint error in a concurrent temporary garment preview;
a minimal type-import correction preserved that preview and assets, then the
complete rerun passed. Tests use temporary profiles only. No production scanner
or publication is certified by these checks.
