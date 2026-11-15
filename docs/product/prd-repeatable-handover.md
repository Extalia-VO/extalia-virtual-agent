# Repeatable handover from Observe and Native

Status: implemented for local review on 2026-11-15. See
[ADR 0090](../adr/0090-repeatable-observe-handover.md) and the
[validation record](../bench/repeatable-handover-validation.md) for precise scope.

## Intended outcome

An operator can continue the same work across Codex, Claude Code, Antigravity,
Hermes and Extalia Native, including a later return to an earlier conversation.
The work retains one canonical lineage and attributed original evidence, while
each application keeps its own native conversation ID.

The operator can capture a checkpoint whenever visible source work is available.
Source activity does not repeatedly erase the review while the destination is
being chosen. Destination execution still requires a real supported control route
and its current native permissions. A checkpoint is a copy of observed progress;
it does not move a running process or settle pending file writes.

## Product behavior

| Situation | Required behavior |
| --- | --- |
| Source gains messages during review | Preserve the displayed checkpoint; a new review captures newer work. |
| Source is active or waiting for approval | Show activity and partial coverage; preserve original runtime/approval ownership. |
| Existing Native destination is active | Refuse changing its history/model until that destination settles. |
| User inspects both endpoints first | Include both sets of evidence in review; passive inspection is not a permanent conflict. |
| Destination already has transferred work | Display the lineage being joined and require exact revision-bound consent. |
| User returns to a prior Native endpoint | Reuse its saved session ID, replacing only previously marked generated capsules. |
| Native workspace is Observe-only | Offer a saved connection and an explicit workspace enablement review. |
| Source has no registered project | Offer matching-folder association; do not infer an isolated workspace grant. |
| CLI transcript grows after continuation | Keep the reviewed pairing; check the exact current source again before the next launch. |
| Hermes session is stored but not live | Use exact authorized resume with verified native profile and project. |
| New Hermes destination is requested | Check gateway creation capability explicitly, reserve a native ID without inference, then register its actual source. |
| Runtime cannot create a destination through this adapter | Explain setup/manual options; never display an unsupported action as ready. |
| Delivery becomes uncertain | Preserve the exact receipt; inspection must not resend the prompt. |
| Hermes creation acknowledgement is lost | Inspect using the same idempotent native creation request; do not submit a readiness prompt. |
| Host restarts | Restore saved lineage, endpoint aliases, receipts and compatible pairings. |
| Source/profile/privacy authority changes | Invalidate access/review before new disclosure or dispatch. |
| Journal reaches capacity | Preserve evidence and allow inspection of existing uncertain receipts. |

## User flow

1. Open the source in Observe, Chat, History or the Office conversation panel.
2. Open **Hand over work**. The dialog uses a checkpoint by default and shows
   whether the source was still working when captured.
3. Choose a detected harness or Native connection. For an existing external
   conversation, finish the available connection/CLI setup in this dialog.
4. If Native requires enabling the selected workspace, explicitly select that
   action. If the destination has an established lineage, review its combined
   evidence and approve that exact lineage revision.
5. Review notes, source coverage and the packet. Apply the transfer.
6. Read the receipt and open the actual destination. A Native-ready receipt
   requires a normal next prompt; queued/submitted means transport admission.
7. To switch again, open handover on the conversation that now holds the latest
   work. Earlier endpoint IDs remain available for a return hop.

For a new Hermes conversation, **Check gateway and create** verifies the selected
profile's existing gateway before reserving a native conversation. It does not
start a gateway, install configuration, call a model or send the source packet.
The newly created conversation becomes selectable for the separate handover review.

For a manual destination, the prepared packet remains a manual export. The user
must paste it in the destination application. Linking an existing observation
lets later observed progress participate in the same lineage.

## Acceptance cases

### Ordinary cycles

- Observe Codex → Native → observed external conversation → original Codex.
- Observe Codex → existing Claude → Native → original Claude.
- Observe Codex → newly created Hermes → Native, using the verified native
  profile/project identity and original persisted session ID.
- Existing Antigravity creation, delivery and return behavior remains covered by
  its earlier adapter/host regressions.
- Repeated Native model changes preserve tool history, session identity and
  provider-specific message serialization.

### Activity and concurrent changes

- Append a source message after review, refresh source status, and apply the
  unchanged checkpoint. The appended message is excluded from that packet and
  included in the next capture.
- Export an active Native checkpoint while a provider call is pending. The
  original turn continues, without a global workspace-mutation failure.
- Keep a pending source approval and queued prompt with their original owner.
- Refuse an occupied Native destination and block concurrent destination option,
  team, prompt or mission admission during its context write.
- Reject a source watch pause/resume ABA, changed privacy, changed profile,
  changed file scope or stale destination capability.

### Persistence and repeated work

- Preserve original archive pages and old scoped reader grants after an explicit
  lineage join and host restart, without granting newly joined/future evidence.
- Preserve exact operation receipts without executing the same effect again.
- Store new/changed evidence across forty growing cycles instead of duplicating
  complete earlier histories. Retain changed tails of previously clipped entries.
- Ignore token-only metadata churn for archive capacity; preserve genuine model
  and compaction provenance changes.
- Inspect/reconcile an existing unknown receipt at the snapshot capacity limit.

### Runtime-specific cases

- CLI pairing survives normal transcript appends; exact dispatch checks still
  refuse an intervening source/configuration or executable change.
- Legacy CLI pairings require one explicit refreshed review when no stable
  authority revision was previously stored.
- Hermes resumes an authorized stored session without relying on a live-list
  page; wrong profile, project, native identity or generation is refused.
- Hermes discovery performs no gateway attachment. Explicit creation refuses
  missing required advertised parameters before `session.create`.
- A lost Hermes creation acknowledgement is recoverable with the same request
  ID after host/gateway restart. No duplicate native identity or model prompt is
  created, and an empty native conversation is registered without fake content.
- Gateway shutdown waits for admitted preparation/creation and actual transport
  cleanup; cleanup failure does not become a successful settlement receipt.

## Scope boundaries

This work implements Extalia coordination and tested adapter contracts. It does
not certify all external application builds or move hidden private model context.
It does not silently stop an outside process, accept its approvals, change its
configuration or give imported text new permissions.

Direct Claude/Codex creation is not added. Those targets use an existing native
conversation with a supported control route, or a clearly marked manual packet.
Hermes creation requires an authenticated gateway that advertises the implemented
contract. Unavailable or unsupported installed runtimes remain explicit.

Source capture and a receiving model's use of the evidence are different
acceptance levels. Local tests use synthetic transcripts, real Extalia storage and
scripted provider/gateway responses. Paid-provider quality, cross-product Desktop
attachment, screenshots from a supported graphical environment and installation
acceptance are recorded separately.

## Handover to memory and learning

The new Native endpoint uses the existing scoped operational memory, Knowledge
and skills preparation before its ordinary next request. Handover archives retain
attribution and optional reviewed workspace references; they do not become a new
global memory source or permission grant. Completed work continues through the
existing evidence-bound learning pipeline. A transport receipt alone is not a
successful-task observation or evidence that a new skill should be activated.

## Delivery

Provide a review ZIP before remote Git work. Include a combined patch from the
published v0.4.324 source and an incremental patch from the delivered v0.4.328
review tree, changed source files, documentation, checksums, validation logs and
the storage probe. Both patch routes must reconstruct the same target tree.
No commit, push, pull request, installer deployment or personal profile migration
is implied by producing this package.
