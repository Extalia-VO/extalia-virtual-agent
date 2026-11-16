# ADR 0090: Repeatable handover from observed work

- Status: Implemented for local review; live vendor and installed Desktop acceptance remain separate.
- Date: 2026-11-15.
- Extends: ADRs 0076, 0078, 0079, 0080 and 0089.

## Problem

The existing continuity journal preserves a canonical work identity, but several
independent barriers make practical repeated handover fail:

1. Every source append invalidates an open review, including an observed agent
   continuing to stream while the operator chooses a destination.
2. A source status refresh creates a separate canonical record. Inspecting both
   endpoints can then make the destination appear to belong to incompatible work.
3. CLI pairing includes transcript size and modification time. A successful
   continuation changes its own pairing identity and disables the next transfer.
4. Observe-only workspace mode blocks Native adoption even when a suitable saved
   connection is available. Inspecting an unregistered source also locks its
   synthetic scope before the operator can associate its project.
5. Full source evidence is copied into every archive. Repeated transfers reach
   the bounded journal limit even when most evidence is unchanged.
6. Hermes attachment lists only live sessions before trying to resume. Stored
   sessions and entries beyond the list page cannot reach its exact resume API.
7. Read-only handover review uses the global workspace mutation flag. An unrelated
   Native request can interpret that inspection as a change to its permissions.

These are distinct implementation defects. Increasing a prompt or tool budget
does not address them.

## Decision

### Capture a checkpoint, retain current authority

The shared dialog requests `capture: "checkpoint"`. The host freezes visible
evidence and records capture time, source activity and the observation watermark.
The packet discloses that later progress and in-flight effects are excluded.
Capturing or exporting this checkpoint does not cancel the source, approve its
pending requests, transfer worker ownership or execute its queued prompts.

The continuity owner keeps bounded source evidence in the review. Apply checks
the live source access revision, workspace/profile scope, destination authority,
selected model, notes and lineage. Ordinary source progress or a status refresh
can add new evidence without changing the reviewed copy. A later handover captures
the newer work. The previous exact-latest contract remains available by omitting
the checkpoint option; old clients retain their stricter stale-source behavior.

Cheap `inspectSourceAccess` reads authorize archive pages and receipt replay
without collecting a vault, skill library or current transcript again. Native
aliases must still match their current workspace boundary. Watch pause/resume
epochs, profile changes, isolation changes, privacy changes and destination
control generations remain authority fences.

### Serialize actual mutations at their owner

Handover shares the ordered workspace settings lane, but a review or ordinary
context transfer does not set the global workspace-boundary mutation flag.
Native context writes reserve their destination session and serialize with its
prompt queue. Prompts, missions, option changes and team updates cannot enter a
destination while its reviewed context is being written. A busy Native destination
must settle before its existing history or model is changed.

The host checks archive/source access after grant activation and immediately
before observed delivery. A positive pre-delivery refusal revokes only that
packet's access grant. Native writes recheck access after asynchronous session
preparation and message reads. These checks do not undo already admitted native
effects or imply that a provider consumed the packet.

Uncertain transfer receipts remain non-replayable. Their inspection uses an
authorized metadata view, so reaching an evidence-capacity limit does not prevent
reconciling the exact existing receipt. Cross-scope inspection uses the same
isolation policy as the original permitted transfer.

### Preserve lineage when endpoints already have records

A reviewed destination may have its own record because the user previously
inspected it. Its original evidence is included in the combined preview; ownership
joins only at the durable transfer reservation. An established destination lineage
requires explicit consent to its displayed canonical ID and revision. A later
change requires another review. Unknown transfers cannot be bypassed by a merge.

Merging retains source attribution, snapshots, prior notes as attributed claims,
receipts, endpoint aliases and earlier canonical IDs. Old scoped bearer readers
can still read their original pinned archives under their original canonical ID.
They do not gain the joined lineage or future evidence. A history-off member
demotes the combined record and all its persisted grant aliases.

### Keep immutable deltas instead of repeated full histories

Initial capture retains bounded visible original evidence. Later captures compare
full-entry identities for the same source and retain new or changed entries.
Clipped legacy entries cannot prove an unchanged tail and are not silently
deduplicated. Coverage explicitly says when earlier archives contain unchanged
evidence. Exact delivered capsule echoes remain excluded.

Token counters and incidental source revisions alone do not consume archive slots.
Changes to model identity or reported compaction retain provenance snapshots.
Existing snapshots, IDs and pages remain immutable. The journal still has explicit
capacity limits; this change neither evicts old evidence nor promises unbounded
history.

A controlled storage fixture with forty requested transfers completed forty cycles
with the new implementation. The v0.4.328 baseline stopped after thirty-four
cycles when its archive filled. The respective last persisted files were 248,636
and 4,215,440 bytes, holding 55 and 1,068 evidence entries. These have different
completed-work totals and are not an equal-work percentage comparison. The ZIP
includes the measurement and its reproducible temporary-profile script. This
measures storage, not model quality or inference cost.

### Make Observe-to-Native an explicit destination transition

For a registered Observe workspace, the dialog can select a saved Native
connection and explicitly review enabling full Extalia. Preview changes no
workspace settings. Apply enables the selected workspace, retains its files,
isolation and permissions, switches the visible workflow when needed, and creates
or reuses its canonical Native endpoint. It does not call a model. The next normal
Native prompt executes with the selected connection and current scoped memory,
Knowledge and skill preparation.

A passive unregistered-source inspection does not lock project association. A
pristine synthetic record can follow a later explicit matching-folder association,
including an isolated workspace. Established synthetic chains can associate with
a matching non-isolated workspace under the existing cross-scope policy. They
cannot silently enter an isolated workspace. An established registered chain
retains its registered scope.

The legacy observed `continueSession` API uses canonical handover for an already
associated managed workspace. It no longer repeatedly copies only first/recent
messages into unrelated Native sessions. It does not synthesize consent to enable
an Observe-only workspace; that action belongs in the reviewed dialog.

### Separate CLI pairing identity from current transcript identity

New CLI pairings retain a stable authority revision covering source/profile,
native configuration and selection environment, with a separately verified
executable pin. Transcript
appends do not unpair them. Pairing review and the final per-dispatch check still
bind the exact current source; an intervening change before process admission is
refused. Older persisted pairings without a stable authority revision require one
fresh pairing review rather than an unsafe automatic migration.

Claude's reported response model is informational when a separately configured
resume model is the actual route. Codex/Gemini model values remain bound when
their CLI arguments use them. A verified unregistered observed project can use
its native CLI profile without being assigned unrelated Extalia file permissions.

### Use genuine Hermes gateway capabilities

Hermes control is bound to the retained SQLite source, canonical project folder,
profile home, native ID and watch generation. A hook-only source without these
facts does not acquire a guessed default-profile control channel. Explicit Connect
uses exact authorized `session.resume`, including stored sessions; it no longer
requires membership in the first live-list page. Returned IDs, project, gateway
profile and authority generation must match.

Fresh Hermes creation is a separate explicit action. Passive Hermes discovery
uses filesystem metadata only and advertises **setup required**, not a verified
live gateway. After the user chooses **Check gateway and create**, Extalia attaches
to an existing authenticated gateway and verifies the advertised creation contract.
It calls `session.create` with a durable stable `request_id`, `source: "cli"` and
the reviewed project folder. Creation reserves a native session identity without a
bootstrap user prompt or inference. Registration verifies that exact native ID,
profile home and project before enabling observation. An empty native conversation
is not populated with an invented readiness message.

Explicit recovery of a lost creation acknowledgement may repeat the exact native
idempotent creation request. It cannot submit a prompt or substitute a new
operation. This limited recovery contract is different from replaying an uncertain
handover prompt. Gateway preparation, creation, cleanup and shutdown retain owned
lifetimes; unresolved cleanup remains a fence.

The primary upstream contract is
[Hermes gateway local sessions](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/gateway-local-sessions.md),
reviewed on 2026-11-15. Installed runtime capabilities are checked again at the
explicit action. Documentation and scripted RPC acceptance do not certify an
arbitrary installed Hermes version.

## User interface and limits

Chat, Observe, History and Office use the same controller. Source-only live
progress preserves a checkpoint review; real workspace/profile/privacy changes
invalidate it. The dialog exposes initial CLI/Hermes setup, Native enablement,
notes, the transfer trail, manual preparation and destination navigation. A
tool/status-only observed conversation can open the handover workflow.

Codex and Claude direct delivery still requires an existing supported observed
conversation and a reviewed available control route. This change does not claim
automatic creation of their native threads or attachment to an arbitrary Desktop
process. Manual preparation stays explicitly distinct from delivery. Antigravity
uses its existing verified endpoint/create path. A source can keep running after
checkpoint capture; the user coordinates concurrent file writers when continuing
the same project elsewhere.

Transport admission, Native readiness, manual readiness, uncertain delivery and
model consumption remain separate. No handover guarantees hidden reasoning,
private harness context, execution settlement or future recall by another model.

## Placement and validation

The existing TypeScript host owns local session/profile state, CLI supervision and
gateway control. Keeping this on-demand coordination there avoids introducing
another daemon or duplicate lifecycle owner. Rust continues to own the operational
memory, Knowledge and learning stores. This follows ADR 0071; the storage probe is
not evidence for a backend-language migration.

The acceptance matrix and final gate results are in
[repeatable handover validation](../bench/repeatable-handover-validation.md).
Fixtures use temporary homes and scripted providers/transports. The review ZIP
contains the patch, changed source, test logs and reproducible storage measurement.
No live personal configuration or remote Git publication is part of this work.
