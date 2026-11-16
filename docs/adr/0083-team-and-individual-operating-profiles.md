# ADR 0083: Team defaults and individual operating profiles

Status: Accepted — 2026-11-12; implemented and verified locally in v0.4.297

## Context

The owner confirmed both levels: a reusable team profile is the workspace
default, and each lead/subagent can have individual working preferences.
Display preferences, Knowledge vault profiles and daemon storage namespaces
already have unrelated meanings. Reusing their IDs would mix personality with
data visibility or skill activation authority.

Existing `AgentTeam` settings provide member roles, responsibilities, `soul`
instructions, approved connection/model lists and editing constraints. Sessions
already snapshot routing and team settings. Lead agents need an equivalent
persona and a stable source-profile snapshot.

## Decision

Add a separate host-owned `config/operating-profiles.json` catalog with schema
`extalia.operating-profiles.v1`. A preset contains its name, revision, shared
purpose/personality, lead connection/model/effort preferences, individual lead
persona and an optional existing `AgentTeam`. Reuse member role/task/soul and
model controls instead of creating another roster format.

Validate bounded plain data in core/platform and serialize atomic catalog
writes in the existing host. This small local settings workload does not
justify another native process or protocol round trip under ADR 0071. React
remains presentation-only; credentials remain in the existing secret store.

Use a distinct `Workspace.operatingProfileId` and explicit operating overrides.
Resolve profile defaults, then workspace overrides, then explicit session
choices. Absence inherits; `team: null` explicitly starts solo. Replacing a
roster replaces its array rather than merging members by position. An empty
lead personality explicitly clears shared inheritance; a blank member soul
uses shared personality. Clearing workspace overrides returns to the preset.

Persist the resolved source metadata and shared/lead guidance with each new
session; keep its effective connection, options and team in the existing
session fields. Profile edits change future sessions, not existing records or
running invocations. Individual lead edits use an explicit session action;
subagent overrides continue through the session team editor. Session summaries
show source metadata rather than broadcasting complete persona text.

Inject shared and individual preferences as bounded, escaped system guidance
for the Native lead, workers and discussions. Current user instructions,
workspace permissions and tool policy retain precedence. A worker's actual
assignment alone drives optional skill relevance; profile purpose/personality
must not be appended to its request or delegated-task history.

The initial execution capability is Extalia Native. Hermes and observed
external applications retain their actual supported settings; selecting a
managed preset cannot rewrite their configuration or emulate per-agent model
routing. No change is made to global skill storage, activation approval,
Knowledge visibility, memory recall or workspace file boundaries.

## Persistence and bounds

Profile edits/deletes require the expected integer revision. Reject deleting a
preset while workspaces reference it. Historical session snapshots remain
self-contained. Validate references and the effective routing at admission;
missing connections or incompatible model grants produce an error rather than
an implicit substitute. Malformed stored operational guidance cannot silently
broaden defaults.

New editor drafts carry a stable UUID creation request ID. Its derived profile
ID makes an identical explicit retry return the committed receipt after a lost
response; a changed payload with that ID is refused. Mutating requests are not
automatically replayed. Existing-profile updates retain revision comparison.
The receipt is retained with the profile; deletion ends that retention. This
does not introduce a separate tombstone or unlimited replay-history ledger.
Catalog invalidation is explicit in the UI because unchanged workspace arrays
may retain their identity when an unbound preset changes.

Allow at most 32 presets, 64 KiB of UTF-8 JSON per profile/override/snapshot and
512 KiB for the entire stored catalog. Pretty-printed storage is budgeted too.
Oversize goal documents need shortening; the existing ordinary Bridge request
limit remains sufficient, without another privileged transport body type.

## Interface

Provide one Agent profiles settings destination and workspace selection with a
clear reset-to-profile action. Keep Knowledge/vault controls in their existing
destination. The profile team editor uses an in-memory draft and actual saved
model catalogs, without pretending to save a workspace. The existing session
team entry points in Chat and Office expose individual lead/member settings.
Unsupported hosts/runtimes, stale saves and failed refreshes must be visible
while preserving a recoverable draft.

## Verification requirements

Check restart persistence, optimistic edit conflicts, all override levels,
explicit solo sessions, stable existing/running session snapshots, concurrent
creation/profile edits, deleted references, model/connection ceilings and
isolated workspace boundaries. Test lead/worker personality precedence and a
security persona assigned an unrelated poem without optional security-skill
loading. Validate authenticated Web/Desktop method admission and no replay of
an uncertain write. Review English/light desktop and Indonesian/dark mobile
flows using real components and temporary host data.

## Local verification

The combined v0.4.297 checkout passed `pnpm check`: 9,642 application tests
(26 skipped), 610 Rust tests, types, formatting, Clippy, ownership/public-safety,
all application builds, version checks and local asset validation. All 2,547
source files retained identical fingerprints during that gate. Profile work was
introduced in v0.4.296; v0.4.297 also includes the independently developed session
browser.

A separate default-feature Native build was published to the local development
artifact after verifying its Rust sources against that gate. Twenty-two focused
host/skill-relevance and Web/Desktop admission tests passed against this artifact.

Actual Web/Bridge/host tests used temporary data, home and project directories
with a deterministic local Native provider. They verified profile CRUD, workspace
selection/override/reset, persistence after restart and an individual lead's
guidance/model reaching a real provider request without rewriting its preset.
An intentionally lost committed save response followed by an explicit retry
produced one profile with the same revision. Desktop-width English/light and
390-pixel Indonesian/dark browser checks covered recoverable drafts, refreshed
catalogs, themed inputs and reachable controls with learning notifications.

Runtime/host regressions keep optional skills tied to the current worker task,
including a security persona assigned a poem. Independent review checked nested
clone isolation, Unicode byte bounds, concurrent creation/default edits and
reviewed handover routing. No real Extalia profile, external application config,
paid model call or packaged Desktop runtime was exercised by these profile tests.
The local provider verifies guidance/routing transport, not model obedience.
Evidence is retained under `output/playwright/operating-profiles/`.
