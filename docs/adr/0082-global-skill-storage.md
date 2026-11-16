# ADR 0082: Global skill storage independent of operating profiles

Status: Accepted — 2026-11-12

## Context

Skills are reusable procedures across Extalia workspaces, including isolated
projects. A physical location beneath a profile suggests the library belongs
to that personality or project. The existing default registry, its immutable
revisions, scanner attestations and approval history must remain authoritative
when the location changes.

The data root can already contain legacy W0 skill folders in `skills/`.
Marketplace and generated-skill staging also have writers outside a single
registry transaction. A whole-directory rename or an unverified fallback read
would risk existing data or approval integrity.

## Decision

Use `<data>/skills` for the application's default shared skill library on Unix
platforms, including macOS and Linux. The
normal data root is the OS user's `~/.extalia-vo`, with `EXTALIA_HOME` and test
data-directory overrides retaining their existing meanings. Keep immutable
registry objects, staging and import/marketplace areas separate beneath the
library root. Do not expose an editable source mirror as the activation source.

Preserve the internal `default` registry namespace and all revision, scanner,
approval and activation identities. The canonical tree hash depends on package
bytes and relevant modes, not its absolute storage address. Existing nondefault
daemon CLI namespaces stay separate for compatibility; do not merge their
grants into the application's shared default library.

Non-Unix platforms retain their existing physical paths for this update. Do
not create a global-layout marker or claim migration there. This compatibility
path keeps existing installations usable while a native no-follow migration
and its hosted platform tests remain follow-up work. All producers and
consumers must make the same platform choice.

Before default registry recovery or built-in restoration, perform a serialized,
restartable copy-and-verify upgrade. Retain legacy objects as recovery copies.
Preserve unrelated W0 folders and reject reserved-name conflicts and unsafe
filesystem entries. Commit the layout marker only after durable verified
publication. After commit, one root is authoritative; do not alternate between
old and new objects on read errors. Import/marketplace producers and consumers
must agree on the layout and must not replay abandoned legacy stages.

Global availability does not authorize activation or indiscriminate loading.
Existing scanner, review, exact activation approval, workspace-scope and
per-worker relevance checks continue to apply. Knowledge, memory and file
permissions remain workspace-bound.

## Profiles

An operating profile is a separate preset for purpose, personality,
lead model/runtime and agent/subagent composition. Its identifier must not
select a skill storage/security namespace. Existing display preferences and
Knowledge vault profiles remain separate concepts. The global storage change
does not implement a profile manager or apply new defaults to running sessions.

The subsequent [ADR 0083](0083-team-and-individual-operating-profiles.md) and
[operating-profile design](../design/agent-operating-profiles.md) define its
implementation, precedence and team-model reuse.

## Consequences

Migration temporarily uses extra disk space because the old immutable bytes
are retained. Conflicts stop the upgrade with an explicit error rather than
overwriting user data. Downgrading requires a deliberate stopped-owner layout
recovery; retaining old files alone does not make an older binary aware of new
global revisions. No real home data is modified by the implementation tests.

This supersedes the default-profile physical paths in ADR 0025. Registry
identity and activation semantics are unchanged.

## Verification

The complete local v0.4.295 `pnpm check` passed: 9,579 application tests
(26 skipped), 610 Rust tests, formatting, Clippy, types, ownership/public-safety,
all application builds, version consistency and local asset validation.
All 2,516 product files retained identical fingerprints during the gate.

Actual temporary-profile host tests cover migration with unchanged complete
revision details/history, immutable backups and modes, W0 folder retention,
ignored legacy stages, subsequent global writes and repeated restart. Core
tests preserve active approval/scanner/built-in authority and exercise reserved
collisions, links, tampering, interrupted publication, stale temporary names,
destination identity substitution and strict marker/lock behavior. A marketplace
HTTP regression verifies simultaneous object reads and refuses independent
migration. An independent reviewer reproduced three draft findings and verified
their fixes; separate final storage (8) and marketplace (1) tests passed.

Windows compatibility was reviewed statically and its host path branches were
tested locally; no Windows executable or hosted runner was exercised. Small
fixture relocation took about 127–230 ms; this is not a large-library throughput
benchmark. Migration enumerates at most 4,096 objects, with the existing default
per-object limits. Local evidence is retained in `output/global-skill-storage/`.
