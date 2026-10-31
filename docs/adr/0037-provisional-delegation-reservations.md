# ADR 0037: Provisional hierarchical delegation reservations

Status: Verified locally v0.4.131 for the storage prerequisite, 2026-10-30. Execution,
authority resolution, command delivery and runtime activation remain gated.

Tracking: [V2-08 / #46](https://github.com/Extalia-VO/extalia-virtual-agent/issues/46),
using [V2-02 / #40](https://github.com/Extalia-VO/extalia-virtual-agent/issues/40)
contracts under [ADR 0036](0036-prd-v2-compatible-adoption.md).

## Context and boundary

The pure delegation inspections can establish a consistent branch but cannot
reserve a shared allocation. Two siblings may each fit the original envelope
while exceeding the parent's combined remaining budget. Durable allocation is
a prerequisite for later admission; it does not supply missing grants or policy.

Add a Rust CoreStore ledger with `provisional` rows and library methods only.
There is no daemon operation, host endpoint, queue/dispatcher or runtime consumer.
Pool, scope, generation and clock are caller-asserted bookkeeping inputs. They
are not captured authoritative grants or verified mission/execution membership.
Existing mission/task/lease/admission rows and source IDs are not reinterpreted
or linked by inferred foreign keys. Canonical registry/ownership resolution is
still required before any future integration.

## Explicit seed and scoped identity

Initialization receives an independent UUID scope `(profileId, workspaceId,
rootMissionId, rootRunId)`, an envelope with one ancestor and a valid active time.
The seed fixes the root anchor, source generation, validity window and caps.
One pool per scope prevents replenishing the same run with another pool UUID or
generation. Identical initialization returns its original historical receipt;
changed initialization conflicts. No request automatically creates a pool.

Schema 9 adds `delegation_pools`, `delegation_branches` and immutable
`delegation_reservations`. Composite scope/parent foreign keys, per-pool task and
idempotency uniqueness, STRICT safe-integer constraints and monotonic triggers
complement Rust checks. A pool has at most 1,001 branches including its root.
The existing single-writer file lock, WAL/FULL durability, immediate transaction,
exact-schema validation and backup rules remain in effect.

## Hierarchical escrow and atomic transaction

Reservable allowance is for future subtree allocations, not actual expenditure.
Reserving child C deducts **`1 + C.childRemaining` slots** and C's entire four
budget caps from its immediate parent's available balance. C receives its own
descendant slots and caps for subsequent subdivision. A grandchild carves only
from C, without charging ancestors again. Unused allocations remain held.
Depth is still bounded by the envelope's hop and lineage rules.

Within one `BEGIN IMMEDIATE`, load and validate the complete bounded ledger,
check exact root scope/generation and parent binding, active windows, lineage,
CAS revision, remaining slots and all caps. Conditional debit and CAS updates
must each affect exactly one row. Insert child branch and immutable receipt,
reload invariants, then commit together. SQL or precommit failure rolls all of
those writes back. No expiry, revoke, restart or missing acknowledgement refunds
capacity, releases an uncertain operation or restores permission.

Every load checks canonical payload checksums, envelope/column agreement, receipt
membership and time bounds. Reconstruct every balance from its original allocation
minus immediate-child escrow; any drift is corruption. For N receipts, the pool
revision must equal `1 + N + revoked`. Receipt revisions are exactly `2..=N+1`,
parent receipts precede children, and times cannot decrease in revision order.
Whole-pool revocation is one-way, consumes one revision and prevents all future
descendant reservations. Branch-specific revocation and settlement/refund are
not implemented.

## Historical idempotency and conservative clock

A scoped idempotency key binds the complete validated intent and explicit parent
allocation. An exact replay returns the original receipt/version/time before
checking current CAS, expiry or revocation, without another debit. Changed intent
or parent is a conflict. Canonical JSON treats object-key order and equivalent
safe integers equally. A historical acknowledgement is never replay permission.

The caller supplies UTC time; there is no unrequested wall-clock source. A valid
known-scope call may advance a persisted high-water mark, including a business
denial, initialization conflict or exact replay. Clock-only updates do not change
balances, receipts or CAS revision. New allocations refuse times below the
high-water mark, so a recorded expiry denial followed by restart/clock rewind
cannot reactivate capacity. Storage/injected failures roll back the clock too.
Inspection alone has no clock side effect. A caller's future clock jump can freeze
allocation permanently; no automatic reset/refund is provided. The clock and caller
must be trusted by the eventual authoritative composition.

All snapshots/receipts return `authority_verified: false` and
`dispatch_eligible: false`. Success proves local bookkeeping consistency only.
No process, provider, model, file effect, driver or broker is called.

## Migration, rollback and acceptance limits

Migration 9 is additive, with no legacy pool backfill. Existing migration backups,
transaction rollback, exact-schema and newer-version refusal remain mandatory.
Tests rehearse 8→9 preserving legacy rows and backup contents, interrupted schema
9 creation, failed reservation commits and mid-transaction SQL failures.
Older binaries refuse schema 9. A backup restoration can discard reservations;
this ledger alone cannot detect that external rollback. A future restore manifest
must quarantine newer runs and may not revive them from discarded capacity.
There is no restore/resume path or downgrade cleanup added here.

The ledger partitions allocations; it does not meter actual tokens, tools,
billing or elapsed execution time, including a parent's own spending. It does
not prove current external ownership, actor/target/definition truth, inherited
policy/approval, current engine/writer fencing or operation settlement. Local
locking/checksums are neither a provider-global guarantee nor protection across
independent data directories. No hash is a permission credential.

V2-03/04/05/06 and registry/queue gates still control activation. This preparatory
V2-08A slice is not an executing broker, durable command intent/outbox, event replay
cursor, exactly-once provider effect or complete AR-04/15/16/17 acceptance.
Tests use temporary stores only; no real profile or external configuration changes.
