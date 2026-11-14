# ADR 0081: Scoped observed work memory and curation

Status: Implemented; runtime-specific and full-product acceptance remain separate.

## Context

Observe already retained visible conversation snapshots and supplied reviewed
handover archives. It did not automatically build searchable work episodes or
feed the post-task Knowledge/skill curator. A transcript, an idle event and a
successful tool report are different kinds of evidence; observing them cannot
create independent verification or new permissions.

## Decision

Add an optional `automaticLearning.observed` profile setting, off when absent.
It requires automatic learning to be enabled. It applies only to watched,
content-visible observations associated with a registered workspace in that
profile. Existing installations acquire neither background analysis nor model
spending from this update. Enabling the setting or starting the host establishes
a baseline; it does not silently process historical backlog.

After observation persistence, a bounded host coordinator frames newly visible
prompt-to-result episodes. Rust owns credential masking, immutable record
digests, atomic native-source/episode deduplication, SQLite persistence, lexical
search and revision-aware reads. Records retain source app/native identity,
workspace/profile/boundary, event attribution and partial-coverage information.
They are always `untrusted-observed`; reported success never becomes a verified
task outcome. Framing has a 96 KiB serialized transport ceiling. Rust retains
at most 32 entries of 2,000 characters per episode, 256 episodes per source and
4,096 per profile. Capacity refusal is explicit; history is not silently pruned.

Queries use only currently authorized sources in the same workspace, even when
multiple workspaces share a profile/vault. Search is bounded to 32 native sources
and 12 hits. Scope checks run around effects and before returning material.
Pause, removal, labels-only privacy and in-process consent/scope changes revoke
access and cancel applicable curation. Disabling at startup does not launch Rust
merely to inspect retained private storage; those records remain inaccessible.
Already published Knowledge notes and reviewed skill candidates are separate
artifacts, not erased by stopping an observation.

## Providerless Observe setup

An explicit `Workspace.mode: observe` registers project folders and their vault
profile without requiring an Extalia model connection. Legacy workspaces without
this field remain managed. Observe onboarding offers profile and optional folder
setup, then agent-app connection instructions; skipping the folder remains valid
for viewing activity, but workspace-scoped recall requires association later.

Capturing opted-in episodes, local search/read and reviewed external handovers
are independent of inference. A saved optional workspace connection permits
curation; without it no curator job is scheduled. The tools panel explains that
limit. An observed application's subscription is never treated as Extalia API
credentials or silently borrowed for background work.

The Observe workflow shows Office, Observe, history/import, logs and application
settings/diagnostics. It does not show managed Chat, missions, Files/Git, Knowledge
or Grimoire navigation, a Native status shortcut, team setup or a Native Office
composer. The Office board shows observed agents across workspaces in this mode;
saved Native sessions remain available when returning to full Extalia. Profile storage/learning consent and optional model connections remain
available because they configure observed capture and curation. Underlying saved
notes, skills, sessions and workspaces are retained when changing workflow.

Settings offers **Set up full Extalia**, opening connection setup when needed and
then workspace editing. Changing the same workspace to `mode: managed` requires
a valid Native connection (or an available supported managed runtime). It keeps
its identity, folders, profile and observed history. A curator connection alone
does not authorize Native sessions, teams, missions or Native handover. Existing
managed session identities remain independent from a workspace's later default.

## Retrieval and handover

Native agents with Extalia memory enabled receive `observed_memory_search` and
`observed_memory_read`. The Observe tools panel exposes explicit human search
and evidence reads without background polling. Ordinary workspace MemoryStore
recall continues to select bounded relevant metadata before a Native prompt;
reading note bodies and observed episodes remains progressive.

For opted-in profiles, handover snapshots retain a small attributed selection
from workspace memory, Knowledge, approved skills and observed episodes.
Retrieved references enter the reviewed packet/archive, retain omissions and
receive reserved archive space even in long histories. Their profile/access
boundary and observed contributors are recorded and rechecked for review,
apply and archive reads, including when the source snapshot is Native.

These are reviewed copies. Existing continuity MCP access remains pinned to
those archives; it is not broadened into live access to the workspace, future
notes, or the whole skill library. A general external memory/Knowledge/skills
broker requires a separate pairing and authorization contract.

## Learning

New captured episodes may schedule a quiet-time curator using the workspace's
configured model connection and the profile's existing notes/skills choices.
Capture and lexical retrieval do not require an inference call. A profile with
neither output enabled can retain observed episodes without curator calls.

The distinct Rust `observed.jobBegin` loads the exact stored episode/revision.
It does not accept fabricated Native `ToolResultEntry` success. The model sees
explicitly untrusted observed claims and may use scoped Knowledge read tools.
The host supervises model effects; Rust validates findings, owns receipts and
stages/publishes notes and candidate artifacts. Current scope/consent is checked
again before each effect. Fresh external work aborts active review and retains
ownership until the actual provider/effects settle. The shared scheduler then
waits for a fresh idle interval.

Generated skill revisions remain subject to scanner, review and activation
policy. A saved candidate is not an active skill. Skill sharing follows the
registry's actual activation scope; the vault profile is provenance, not a new
skill-isolation mechanism.

## Validation and limits

Core/daemon tests cover persistence, duplicate/conflicting captures, scope and
revision refusal, credential masking, limits, tamper checks and scoped job
revocation. Host tests use a real Rust sidecar and a scripted provider in temporary
directories: fresh capture, no historical model calls, restart recall, actual
Knowledge publication, inactive skill-candidate receipts, reviewed handover
references, contributor revocation and cancellation/drain after new work.
UI tests distinguish simulated transport from real host evidence.

Live validation on an isolated v0.4.295 production Bridge, host, Rust daemon and
browser UI covers providerless setup, a real graceful restart, same-workspace
Native upgrade and reviewed UI handover. The observed input is a controlled
synthetic Codex transcript, while Native inference uses an actual configured GPT
model. The model recovered the test marker, parser decisions, batch limit,
completed progress and pending work without those values in the new request.
Repeated Observe/Native UI switches retained both sessions and their history;
settled Observe views excluded managed characters, status, composer and unrelated
navigation. Supporting capture consent and fixture import used authenticated
host APIs. No real user profile was copied or modified. These results apply to
the frozen tested build, not later concurrent source work.

This is not model training, automatic prompt caching, a complete transcript
archive or universal safe compaction. Hidden reasoning, missing hook events,
unseen/compacted history and attachment bytes remain unavailable. Windows note
publication retains the existing native learning backend limitations; do not
infer cross-platform runtime certification from local fixture tests.
