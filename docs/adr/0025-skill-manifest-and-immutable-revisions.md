# ADR 0025: Skill manifest and immutable revisions

Status: Accepted (2026-10-22) with the recommended defaults for its open questions; the owner
may revise them before the wave that implements them.

## Context

FR-15, FR-16, FR-18 and FR-21 need machine-readable skill metadata (categories, intents,
compatibility, dependencies, conflicts, permissions, risk), immutable packages bound to a
content hash, attestations, and an audited lifecycle in which "any skill mutation
invalidates prior attestation" (PRD §17). The [skills-engine spec](../product/master-prd-v1.1/skills-engine-and-security.md)
and [blueprint §6–§7](../product/master-prd-v1.1/technical-blueprint-v1.1.1.md) describe the
same lifecycle and tables with **different names**. PRD §16 item 8 (manifest format and
trust levels) has no ADR yet.

Repository facts (working tree, 2026-10-21):

- `packages/host/src/skills.ts` loads built-in (`builtinSkills.ts`), user (`<data>/skills`)
  and workspace (`<project>/.extalia/skills/<name>/SKILL.md`) skills. Only `SKILL.md` is
  read (256 KiB cap); supporting files are ignored. Front matter is hand-parsed: `name`
  (`SKILL_NAME_PATTERN`, `packages/platform/src/skills.ts`) and `description`; no other
  field is understood and there is no YAML dependency. Workspace symlinks are refused; user
  skill symlinks are followed.
- **W0 consent:** a workspace skill loads only if `<data>/workspaces/<id>/skill-consent.json`
  (`SkillConsentStore`, schema `extalia.skill-consent.v1`) maps its name to the SHA-256 of
  the exact `SKILL.md` bytes, for the same canonical `projectLocation`; otherwise it is
  `pending` (`not-allowed` or `changed`). A corrupt consent file allows nothing. User skills
  and allowed workspace skills reach the model **unscanned**, marked `(user|workspace,
  untrusted)` and wrapped in `<skill-content>` with a notice (`createSkillTools`).
- The whole catalog is listed in one `skill_read` tool per turn (`access: 'meta'`, always
  allowed by `decide()`).
- ADR 0023 fixes the scanner adapter (pinned, fail closed, attestation fields); ADR 0019
  makes `<data>/state/core.sqlite` the daemon-owned database; ADR 0024 makes the profile the
  security boundary.

## Options considered

**Manifest location**

| Option | For | Against |
| --- | --- | --- |
| Extend `SKILL.md` front matter | One file, portable | Front matter is read by other agent apps; nested maps need a YAML parser; editing permissions changes the instruction file's hash and diff noise |
| **Sidecar `extalia-skill.json` next to `SKILL.md`** | Strict JSON, hand validators in `@extalia/protocol` like other contracts, no new dependency; other apps ignore it | A second file to author; YAML in the PRD example is only illustrative |
| Registry-only metadata (entered in the UI) | No authoring | Not portable, not reviewable in a repository, not part of the hashed tree. Rejected |

**Revision identity**: random id + hash column, vs **content address (tree SHA-256)** with
uniqueness per package. **Hash scope**: `SKILL.md` only (W0) vs **whole package tree**.

## Recommended decision

1. **Manifest** `extalia-skill.json` (schema `extalia.skill-manifest.v1`), part of the hashed
   tree. Fields: `id` (package id, `SKILL_NAME_PATTERN`), `version` (SemVer, a label, not
   identity), `categories` (stable dotted category ids, ≥0), `intents` (snake_case ids),
   `compatibility` (map of runtime/framework id → SemVer range, evaluated against detected
   workspace facts; an undetectable fact is **not satisfied** and excludes with reason
   `compatibility_unknown`), `dependencies` (`{ id, range }`), `conflicts` (`{ id, range? }`),
   `permissions` (`filesystem_read`/`filesystem_write`: workspace-relative globs;
   `network`: `false` or a host allow-list; `terminal`: `false` or `true`; `secrets`:
   `false` or named credential refs), `risk_class` (`declarative` = Markdown only, no tool
   use beyond reads; `tool_using` = instructs the agent to use host tools needing grants;
   `executable` = ships code meant to run). Unknown fields fail validation. Declared
   permissions are a **request and a ceiling, never a grant** (ADR 0026). Without a
   manifest, a Markdown-only package gets an inferred manifest (`declarative`, no
   categories, no permissions); any non-Markdown file without a manifest is `executable`
   and needs approval.
2. **Canonical tree hash.** The package is staged by copying (never linking) into a
   private, read-only quarantine store `<data>/profiles/<profile-id>/skills/objects/<tree-sha256>/`.
   `tree_sha256` = SHA-256 over `extalia.skill-tree.v1\n` followed by one line per regular
   file, sorted by byte order of the path: `<NFC path with '/' separators>\0<size>\0<sha256>\n`.
   Rejected before hashing: symlinks, hard links to outside, devices, `..` or absolute
   paths, case-insensitive path collisions, empty or oversize packages (caps per file,
   total and file count, owner to set).
3. **Immutable revisions.** A revision row is `(package_id, tree_sha256)`, unique; its id is
   derived from the hash (`skr_<tree_sha256>`), so the same bytes always name the same
   revision within a profile. Any byte change is a new revision; nothing is edited in
   place. `version` must change between approved revisions of one package (a different
   tree reusing an approved version is `blocked: version_reuse`).
4. **One lifecycle** (revision states, lowercase like protocol states), reconciling both
   documents:

   | Unified | PRD spec | Blueprint |
   | --- | --- | --- |
   | `discovered` | discovered | IMPORTED |
   | `quarantined` | quarantined | QUARANTINED |
   | `inspecting` (job, leased) | — | INSPECTING |
   | `inspected` | inspected | INSPECTED |
   | `review_required` | (medium finding) | REVIEW_REQUIRED |
   | `blocked` (terminal) | — | BLOCKED |
   | `validated` (manifest, permission diff, dependency closure, compatibility) | validated | — |
   | `evaluating` → `evaluated` | evaluated | EVALUATING |
   | `awaiting_approval` / `auto_eligible` | same | AWAITING_APPROVAL |
   | `approved` (eligible to activate) | — | — |
   | `active` | active | ACTIVE |
   | `superseded` | deprecated (by a newer revision) | SUPERSEDED |
   | `deprecated` (owner/author marks, still active until replaced) | deprecated | — |
   | `revoked` (terminal) | revoked | REVOKED |

   Transitions are only forward along this order, plus: any non-terminal state →
   `blocked` or `revoked`; `inspected`/later → `quarantined` when the attestation becomes
   stale (scanner pin or policy version changed; same bytes, re-inspection). There is no
   edge from `discovered`/`quarantined` to `active`. `active` is not stored on the
   revision alone: `skill_activations(profile_id, package_id) → revision_id` is the single
   pointer, changed in one transaction with an append-only `skill_activation_events` row;
   activating a revision marks the previous one `superseded`, and rollback re-points to a
   still-valid `approved` revision (AC-28). Learning candidates (`SkillCandidate.status` in
   `@extalia/protocol`) enter this lifecycle at `discovered` once a package exists; candidate
   approval is not activation.
5. **Attestation binding.** An inspection row binds `tree_sha256`, scanner pin (upstream
   commit + installed artifact hash) **and** the scanner's self-reported version, normalizer
   schema version, `policy_version`, coverage (`complete` required), verdict, redacted report
   reference and time (ADR 0023). An attestation is valid only while all of these equal the
   current values. An approval binds `revision_id`, `tree_sha256`, attestation id, profile,
   workspace scope, the granted permission set's digest and `expires_at`; a new revision or
   a stale attestation voids it.
6. **TOCTOU hashing points.** Hash (a) the staged copy at staging (never the source), (b)
   immediately before the scan and (c) after it, (d) before and after evaluation, (e) in the
   approval request (the user approves a digest that is shown), (f) inside the activation
   transaction, (g) when the router loads `SKILL.md` or a supporting file for execution (read
   from the object store, compared to the recorded per-file SHA-256; small files, cheap).
   Any mismatch → `revoked` with reason `integrity`, alert, no fallback to the source copy.
   No re-scan per invocation: (g) verifies bytes and the attestation's validity only.
7. **W0 → revisions.** W0 consent stays the only gate until W3 ships. At W3 import every
   user skill and every consented workspace skill is staged as `discovered` → `quarantined`;
   the W0 `sha256` is kept on the revision as `skill_md_sha256` so the UI can show "you
   allowed this file on <date>", and the consent is recorded as a user review **input**, not
   as an inspection or approval. Consent never activates a revision. `skill-consent.json`
   remains readable for one migration and is then ignored (not deleted). Built-in skills
   ship with the app and are attested at build time (ADR 0023 question 2).
8. **Tables in `core.sqlite`** (ADR 0019 migrations, `profile_id NOT NULL` where scoped,
   foreign keys, append-only audit): `skill_packages(id, profile_id, origin, source_ref,
   created_at)`; `skill_revisions(id, package_id, version, tree_sha256, skill_md_sha256,
   manifest_json, state, state_reason, created_at)`; `skill_files(revision_id, path, size,
   sha256)`; `skill_inspections`; `skill_permissions(revision_id, capability, scope)`;
   `skill_dependencies`; `skill_conflicts`; `skill_compatibility`; `skill_evaluations`;
   `skill_approvals`; `skill_activations`; `skill_activation_events`; `skill_categories`,
   `skill_category_edges`, `skill_category_aliases`, `skill_category_map(revision_id,
   category_id)`, `skill_intents`; `skill_index_generation(profile_id, generation)`.
   Category/intent rows are derivable from manifests but live in the same file so that
   activation and index generation change in one transaction (hot reload). Blueprint names
   `skill_versions`/`skill_activation_history` and the canonical id `skill_version_id` map
   to `skill_revisions`/`skill_activation_events`/`revision_id`. Only the core writes
   `skill_approvals` and `skill_activations`; the scanner, the Python worker and models
   cannot (blueprint §7).

## Consequences

- Contracts (W1): manifest, tree-hash canonicalization, state enum and transition table in
  `@extalia/protocol` with fixtures shared by Vitest and `cargo test`; tests for every
  forbidden transition, hash mismatch at each point, version reuse, stale attestation.
- When W3 turns the registry on, user and workspace skills that work today become
  unavailable until a pinned scanner exists (ADR 0023): a visible regression unless the
  owner accepts a transition mode (question 1).
- Skill authors must add `extalia-skill.json` to get categories or permissions; plain
  `SKILL.md` folders stay usable as uncategorized declarative skills after inspection.

## Open questions for the owner

1. When W3 is enabled but no scanner is verified: block all user/workspace skills
   (FR-16 strict, proposed), or keep the W0 consent path as a labelled, time-boxed legacy
   mode?
2. JSON sidecar (proposed) or also accept YAML for the manifest?
3. Package size caps (per file, total, file count) and whether supporting files beyond
   Markdown are allowed before sandboxing (FR-22) exists.
4. May the same bytes be shared between profiles (one inspection reused), or must each
   profile inspect its own copy (proposed: per profile, no cross-profile reuse)?
5. Default approval expiry for `awaiting_approval` revisions.

## Amendment (2026-10-22): canonical tree hash v1 and staging rules

W3 slice 1 (`crates/extalia-core/src/skills/tree.rs`, migration `0002_skills.sql`) fixes
decision 2 as follows; the module documentation is the normative text.

- **Tree text `extalia.skill-tree.v1`.** `tree_sha256` is the lowercase hex SHA-256 of
  `"extalia.skill-tree.v1\n"` followed by one line per regular file, sorted by the bytes of
  its path: `<path>\0<mode>\0<size>\0<sha256>\n`. `<path>` is package-relative with `/`
  separators; `<mode>` is `100755` when any executable bit is set and `100644` otherwise
  (the executable bit is part of the identity, unlike the original line format); `<size>` is
  decimal without leading zeros; `<sha256>` is the lowercase hex digest of the file bytes.
  Directories, timestamps, owners and other mode bits are not hashed. The hash is computed
  from the staged copy only. On Windows the executable bit is always clear.
- **Names.** Each path segment must match `[A-Za-z0-9_][A-Za-z0-9._-]{0,127}`, must not end
  with `.` and must not be a Windows device name; paths are at most 512 bytes. Names are
  therefore ASCII and NFC normalization is the identity. Names starting with `.` (hidden
  entries, `.` and `..`) are refused; case-insensitive collisions are refused.
- **Refused entries.** Symbolic links (including the package root), regular files with more
  than one hard link, FIFOs, sockets and devices; a file whose opened inode differs from the
  one seen by the walk (`changed`); a source inside the skill store.
- **Default caps** (open question 3, owner may change): 1 MiB per file, 8 MiB per package,
  256 entries (files and directories), depth 8; `SKILL.md` is required at the root.
- **Store.** Per profile (open question 4 answered as proposed: no cross-profile reuse), files
  `0400`/`0500`, directories `0500`, store directories `0700`.
- **Manifest.** `extalia-skill.json` carries `"schema": "extalia.skill-manifest.v1"`; all
  fields except `schema`, `id`, `version` and `risk_class` are optional and default to empty /
  `false`. An inferred manifest's version is `0.0.0+tree.<first 16 hex of tree_sha256>`.
- **Scanner.** An inspector without a verified pin is never run; the outcome is recorded as
  `scanner-unavailable` and the revision stays `quarantined` (ADR 0023).

## Note (2026-10-23): W3 slice 2, daemon operations

- **Wire.** The daemon contract v1 gains `skill.import`, `skill.list`, `skill.inspect`,
  `skill.review`, `skill.approve`, `skill.activate`, `skill.deactivate`, `skill.rollback`,
  `skill.revoke` and `skill.read` (`packages/protocol/src/daemonSkills.ts`), additively within
  schema version 1, with the error codes `denied` and `integrity_failure` and an optional error
  `reason`. They are advertised only when the daemon serves a core store. Imports read only
  `<data>/profiles/<profile>/skill-imports/<path>`; `builtin` is not an import origin.
- **Approval expiry (question 5).** Default 10 minutes (ADR 0026 `once` default), at most
  24 hours. The expiry bounds the revision's first activation; an approval that has activated
  its revision keeps authorizing re-activation of the same revision (rollback, activation after
  a deactivation) until it is revoked, so rollback (AC-28) does not need a new approval. The
  attestation and the bytes are re-checked every time.
- **Recovery.** A revision left `inspecting` by a crash returns to `quarantined`
  (`inspection-interrupted`) when the daemon opens the store; the scan is never replayed.
- **W0 consent (§7)** is matched to a revision by the stored `SKILL.md` SHA-256 and shown by
  `skill.inspect` as review input; it changes no state and is not stored.
- **Built-in skills** (gap-map decision 10) are registered only through a daemon-internal API,
  staged and content-hashed like imports, exempt from the scanner, and kept in memory per daemon
  run.
- **Open: schema change needed.** Recording a human review (principal, revision hash, decision,
  note), storing W0 consent as a review input, and recording built-in skills durably need new
  core tables or a wider `skill_packages.origin` check, i.e. a new migration. Until it exists,
  `skill.review` is defined but not served (`unknown_op`), and `review_required` revisions
  cannot advance.

## Note (2026-10-23): core migration 0004, `skill.review` served

`crates/extalia-core/migrations/0004_skill_reviews.sql` (core.sqlite schema 4) resolves the
open schema item of the previous note. All three tables carry `profile_id`, reference
revisions through composite keys and are append-only (UPDATE/DELETE triggers).

- **`skill_reviews`** records a human review: revision, the tree hash the reviewer was shown,
  the inspection whose findings were reviewed (composite FK to `skill_inspections`), principal
  (`CHECK` prefix `user:`), decision `accept | reject`, optional note (≤ 2000 characters) and
  time. Only a `review_required` revision can be reviewed. `accept` → `validated`
  (`review-accepted`) only while the attestation still holds and the resolver check of
  validation passes (declared dependencies still refuse with `resolver_unavailable`);
  `reject` → `quarantined` (`review-rejected`), from where only a new inspection leads on
  (`skill.revoke` remains the terminal choice). A stale hash is refused (`digest_mismatch`);
  agent, model, scanner and policy principals cannot review (ADR 0026 §5). There is no
  self-approval rule between users: the review is recorded, and the later approval is still a
  separate, digest-bound decision (the medium finding keeps routing to `awaiting_approval` with
  `reviewed_finding`). The `skill.review` result gains the optional `stateReason` and
  `reviewId` (additive).
- **`skill_review_inputs`** stores W0 consent as review input (§7): source `w0-consent`,
  workspace id, consent SHA-256 (a trigger requires it to equal the revision's stored
  `SKILL.md` hash), the consent's `allowedAt` and `observed_at`; one row per (revision,
  workspace, digest). `skill.inspect` with a `workspaceId` records it. It changes no state.
- **Built-ins: `skill_builtin_registrations`, not a wider `skill_packages.origin`.** Widening
  the origin `CHECK` would need a table rebuild under the foreign keys of every skill table
  (SQLite cannot alter a `CHECK`), and a `builtin` package row would put built-ins next to the
  revision lifecycle, approvals and the activation pointer, which they must never enter. A
  separate audit table is smaller and keeps the import origins and the existing spoofing tests
  unchanged. Rows: `registered` (package, revision id, tree hash, `SKILL.md` hash, version, risk
  class, permission digest), `integrity` (the stored object no longer hashes to the recorded
  tree) and `retired`. When the daemon opens the store it re-hashes the object of each
  package's latest `registered` row and re-resolves its manifest; only an exact match is
  loaded, an altered or missing object is recorded as `integrity` and stays unavailable (no
  fallback). Within one run another tree under a registered built-in is refused; a package
  restored from an earlier run may be replaced by new bytes (an app update).

## Note (2026-10-23): host workspace ids, core migration 0005, `skill.scanner`

- **Workspace ids.** The host names workspaces `w_<Date.now() base 36><4 random bytes hex>`
  (`newId('w')`, `packages/host/src/service.ts`), but the skill contract and the core schema
  required a UUID, so W0 consent could not be stored as review input and an approval could not
  name its workspace. `@extalia/protocol` now exports `HOST_WORKSPACE_ID_PATTERN`
  (`^w_[0-9a-z]{1,11}[0-9a-f]{8}$`, at most 21 characters, safe as one path segment) and
  `SKILL_WORKSPACE_ID_PATTERN` (a host id or a lowercase UUID). `skill.inspect`, `skill.approve`
  and the approval record accept it; lowercase UUIDs stay valid, so the change is additive within
  schema version 1. The core checks the same rule (`skills::is_workspace_id`) before an id reaches a
  path or a row.
- **Migration 0005 (`0005_workspace_ids.sql`, core.sqlite schema 5).** SQLite cannot alter a
  `CHECK`, so `skill_approvals` and `skill_review_inputs` are rebuilt, and with them the two
  children of `skill_approvals` (`skill_activations`, `skill_activation_events`): rows are copied to
  `TEMP` tables, children are dropped before their parent (the migrator keeps foreign keys on),
  each table is recreated with its earlier definition except the workspace `CHECK`, rows are copied
  back with their ids, then indexes and the append-only triggers are recreated. The new `CHECK`
  admits a host id or, as before, any 36-character id, so every schema-4 row remains valid. Tests:
  exact schema after replay, upgrade from schema 4 with rows in all four tables (backup
  `core.sqlite.bak-4-*`, rows and ids unchanged, children still reference `skill_approvals`,
  triggers still refuse updates and deletes), and the bounded check.
- **Consent shown as stored input.** `SkillConsentInput` gains an optional `workspaceId`, and the
  `consent` of `skill.inspect` now lists the revision's stored review inputs (newest last, at most
  8), not only those matched in this call. The host passes each workspace whose W0 consent allowed
  exactly the revision's `SKILL.md` (same package name and SHA-256) once; the Security Center shows
  "Allowed in project X on <date> (input only)". It still changes no state.
- **`skill.scanner`** (additive operation, empty params) reports the installed inspector:
  `scannerId`, `pinned` (exactly when a pin is set), optional `pin`, `version` and
  `normalizerVersion`, `policyVersion` and `status` `unpinned | ready | unavailable`. A separate
  read-only operation rather than a field of `skill.list` (repeated on every page and unrelated to
  paging) or of `hello` (whose result lists capabilities only): an older daemon simply does not
  advertise it. The binary's fail-closed inspector reports `unavailable`; `ready` is never reported
  without a pin. The host takes `pinned` from it instead of inferring it from revision states; a
  daemon without the operation counts as unpinned.
