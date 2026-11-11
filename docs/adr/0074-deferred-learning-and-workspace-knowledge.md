# ADR 0074: Deferred learning and workspace-bound Knowledge

Status: accepted, 2026-11-11. Extends ADRs 0024, 0066 and 0067; placement follows ADR 0071.

## Problem

Learning previously blocked source completion. Additional vault profiles were
export destinations while Knowledge continued showing only the default index.
Missing policies disabled beginner use, and workspace isolation did not create a
dedicated vault profile. Displaying a delayed notification alone would not fix
source ownership, released note pins or the Rust curator's active deadline.

## Decision

Keep host admission/timers separate from Rust execution. On successful eligible
saved Native Chat completion, enqueue a bounded evidence copy after the source
run releases its ownership. The countdown is 60 seconds; snooze is ten minutes.
Controls carry the schedule revision, so simultaneous clients cannot claim stale
actions. Reaching zero starts automatically when foreground/configuration work
allows. A new prompt restarts that workspace's quiet period without shortening
a longer snooze. One curator executes at a time; sixteen sources can wait, eight
terminal notices and 256 recent source IDs are retained. Rust durable hash receipts
remain authoritative against repeat publication/uncertain imports.

Waiting entries have no Rust job, evidence intake or note pin. They retain at most
ten 2,000-unit excerpts, IDs and approved invocation context, without a conversation
or attachment payload. Rust revalidates, selects and redacts evidence at execution.
The curator has its own signal, worker projection and pin lifecycle. Provider calls
and entered registry/file effects retain ownership until physical settlement.
Shutdown cancels waiting entries, aborts the active worker and drains it before
sealing persistence or releasing the daemon/profile lock. These timers are not a
durable restart queue; uncertain effects are not automatically replayed.

Managed roots have enabled learning defaults; explicit disabled policies survive.
Custom roots without prior policy/consent do not acquire it through migration.
Saving a selected folder with notes enabled binds that consent to the new root.
Captured workspace/profile/catalog-policy/connection/session authority is checked
before dispatch and before publication. Configuration changes cancel pending work;
old evidence never gets silently redirected. Catalog-wide invalidation is deliberately
conservative, including unrelated vault profile edits.

Isolated workspace creation/edit and startup reconciliation bind a dedicated stable
`vp-UUID` profile atomically with the workspace. Managed paths use profile IDs,
not display names; renames do not move files. Isolated profiles cannot be shared
or rebound to default through the vault editor. Existing notes are never moved.
This is a workspace/vault boundary, not a new credential or skill-registry isolation
model. Workers' learning inherits the source workspace profile.

The UI's workspace Knowledge adapter supplies only a workspace ID, a whitelisted
action and ordinary parameters. The host resolves/validates the registered root;
UI and models cannot provide a profile ID or absolute root to the Rust envelope.
Default calls keep their route. `knowledge.scoped` strictly validates an ordinary
Knowledge request/result and forbids recursive scopes. The existing Rust index
thread owns an eight-entry profile LRU. Root replacement drops its handle and
rebuilds derived data before answering; invalid/missing roots do not fall back.
No second daemon competes for the shared core lock.

Default and scoped index operations share one host admission lane. Deadlines start
after host queue admission; scoped requests allow the existing five-minute sync
deadline because opening an evicted/restarted scope can rebuild. Services retained
by outstanding calls drain even after cache replacement/eviction. Visible scoped
Knowledge refreshes status every five seconds; confirmed automatic note publication
also syncs the matching index and sends the standard refresh hint. Inactive profiles
do not require one permanent watcher or process per workspace.

Rust continues to own curator state, result validation, receipts, note bytes,
secure no-overwrite publication and skill staging. The host owns consent/config,
provider HTTP, timer admission and effect drain; React only presents status and
actions. No unmeasured language rewrite is claimed. Skill inspection, approval
and activation stay separate; imported/generated guidance cannot approve itself.

## Verification

Temporary-profile integration uses the real Rust daemon and a synthetic provider.
It covers source completion before inference, countdown/snooze/run-now, foreground
deferral, profile/folder invalidation, physical shutdown drain, scoped CAS edits,
profile/default isolation, live custom-root switching and symlink refusal. Shared
wire fixtures validate strict TS/Rust envelopes. Browser checks cover English and
Indonesian, light/dark, desktop/phone, keyboard controls and overflow. The release
tracker records the final combined gate rather than treating synthetic providers
as live-provider certification.
