# ADR 0094: Generated skill metadata and revision-bound evaluation

- Status: Accepted; implemented and locally verified v0.4.348; broader provider/behavior certification remains separate
- Date: 2026-11-16
- Amends: [ADR 0088](0088-grounded-knowledge-and-skill-refinement.md)

## Context

Generated candidates previously lacked structured categories and task intents.
Procedure sections were model guidance, and clean declarative packages could
request approval without behavioral evaluation. Immutable revisions and scans
alone cannot demonstrate that a learned correction works.

## Decision

New generated proposals require one to eight manifest category slugs, one to
sixteen manifest intent identifiers and one to six declarative verification
cases. Natural-language usage belongs in the procedure's **When to Use** section.
**Procedure**, **Pitfalls** and **Verification** are also mandatory populated
sections outside code fences. Inputs are optional. Host admission mirrors Rust;
Rust validates and stages the authoritative immutable package.

Categories and intents persist in the manifest and verified `SKILL.md` metadata.
The active catalog carries this metadata into Native relevance selection, still
subject to active revision, workspace consent, negation and ambiguity guards.
Category membership grants no tool, file or activation authority.

`TESTS.json` contains bounded inputs, required output substrings and optional
forbidden substrings. It contains no executable code. Refinement reads the
complete current procedure, manifest, fixtures and references. Existing reference
paths and verification cases cannot silently disappear or have their assertions
weakened. New cases can extend the suite within its bound. Generated package
identity, logical-content deduplication and conservative class-overlap refusal
are checked at insertion; uncertain matches require review rather than an
automatic merge. This does not establish universal semantic equivalence.

Evaluation is an explicit action in the Security Center. Rust prepares a bounded,
expiring, single-use plan pinned to the candidate tree and current active tree.
The host uses the selected saved Native workspace connection to answer the same
synthetic inputs with the candidate and baseline procedures separately. Requests
are blind to expected/forbidden assertions and contain no tools, session history,
project files or permission grants. Actual provider promises retain their owner
until physically settled, including cancellation and shutdown.

The provider returns answers, never grades. Rust checks hidden assertions,
complete case coverage, immutable candidate/base bytes and the current activation
pointer before recording evidence. Missing, truncated, malformed, refused or
cancelled responses cannot pass. Failed and insufficient candidates remain
available for repair. Successful checks permit the ordinary user approval flow;
they do not approve or activate a skill. Approval and activation recheck the
revision-bound evidence and current baseline. The generic evaluation-recording
path and declarative approval shortcut cannot bypass this generated-skill gate.
Previously activated revisions retain the existing explicit rollback authority.

## Meaning and limits of passing

The evidence demonstrates synthetic declarative behavior on the stored bounded
suite. Baseline results expose the comparison; passing is not proof that every
task succeeds, a live tool workflow was exercised, or every textual change is an
improvement. Candidate-authored fixtures remain review material. User approval,
scanner attestation, dependency checks and activation are separate requirements.
No automatic promotion or executable sandbox is introduced.

Older active packages remain usable under their existing authority. Missing new
metadata is shown as incomplete or unchecked; it is not fabricated. Older peers
that omit evaluation capabilities cannot claim evaluation support. Old queued
proposals without required fields may need regeneration.

## Verification

Acceptance includes malformed and fenced-only sections, metadata propagation into
real selection, exact aliases and overlapping classes, unchanged reuse, retained
fixtures/references, hidden assertions, failed and missing answers, stale tree
and active pointers, approval/activation bypass attempts, provider cancellation
and physical settlement. Temporary profiles and synthetic providers isolate
tests from installed user skills and external application settings.
