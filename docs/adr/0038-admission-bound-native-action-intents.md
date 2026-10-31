# ADR 0038: Admission-bound non-executable native action intents

Status: Verified locally in v0.4.132 for request-lifecycle storage, 2026-10-30. Executable approval,
user decision, policy resolution and consumption remain separate gates.

Tracking: [V2-05 / #43](https://github.com/Extalia-VO/extalia-virtual-agent/issues/43).
Dependencies: [ADR 0026](0026-permission-enforcement-point.md),
[ADR 0036](0036-prd-v2-compatible-adoption.md) and the actual immutable native
execution admissions in [ADR 0033](0033-durable-execution-observations.md).

## Context and deliberately narrow scope

The existing Rust PDP decides access classes from mode/permissions/session
grants. It does not resolve an exact action, actual policy snapshot or authenticated
user decision. The provisional reservation ledger is allocation bookkeeping,
not a substitute for those facts. Native execution admissions and live leases
already provide a real source identity that request capture can verify.

Add a Rust library-only lifecycle for **non-executable edit intents**. There is
no new daemon/RPC, host, UI, runtime, provider, approval/decision or consume route.
The existing runtime permission behavior is unchanged. This is a V2-05A storage
prerequisite, not ADR 0026 enforcement or full AR-09–11 acceptance.

## Actual source binding and explicit unverified claims

The trusted composition supplies the owning profile independently. Preserve its
existing native identifier, including legacy profile names. Do not invent a v2
execution UUID or infer a mapping: identity is the real mission/workspace/task,
lease, holder, supervisor, attempt and captured admission digest.

One immediate transaction validates the complete canonical mission snapshot and
loads the actual immutable admission. New capture requires a running mission,
a running write-capable task, the exact current lease/holder, acquisition/admission
not in the future and an unexpired lease. Store the actual admission, current
mission revision and task digest with the request. Historical admission loading
alone does not establish liveness. Requests cannot renew leases, change task or
mission state, clear quarantine, or report validation/settlement.

Only existing native `write_file`/`edit_file` names and the journal's bounded
ASCII workspace-relative edit target are accepted. This lexical target check is
not filesystem containment, symlink resolution or credential-file approval.
Other tools and commands require a separate capability design.

Input includes a stable request UUID/idempotency key, target, opaque parameter
digest, policy reference/version/digest, unique bounded skill references and an
explicit expiry. Parameter digests are labelled **`unverified-sha256`**: no raw
arguments are supplied, canonicalized or stored by this API. The local record's
canonical digest covers its own fixed-shape metadata/admission and safe counters;
it does not establish RFC 8785 conformance for arbitrary tool arguments.

Actual policy, skill ceilings and argument fingerprints remain unverified caller
claims. Every result returns `parameters_verified: false`, `policy_verified: false`
and `dispatch_eligible: false`. `admission_bound: true` means the immutable
historical binding was validated; it never means currently authorized, including
when a returned record is expired/revoked.

## Immutable request, projection and terminal closure

Schema 10 reuses the existing `approvals` table as a projection and adds:

- `native_action_requests`: immutable intent-only bindings with composite
  profile/lease foreign keys to actual execution admissions and scoped idempotency.
- `native_action_clocks`: a monotonic high-water mark for the real admission,
  shared by all its request IDs. Changing an ID/key cannot reset that clock.
- `native_action_closures`: one immutable `expired` or `revoked` closure per
  request, with reason/time and a digest bound to the immutable request digest.

Projection status is `pending`, then at most one irreversible terminal closure.
SQL guards prevent this format from ever becoming `granted` or `rejected`, and
reject attachment to an existing legacy grant. They also reject `REPLACE` of
clocks, requests, projections and closures without relying on recursive triggers.
Clock observation uses explicit insert/update inside the transaction and checks
that exactly one row changed. The limits are 128 intents per real admission,
32 skill references and bounded canonical payloads. No raw contents/arguments,
commands, model output or provider credentials are stored.

Exact scoped replay returns historical identity/timestamps without a new request
or refreshed expiry. Changed intent conflicts. Expiry must be after capture,
within ten minutes, and no later than the current lease expiry at capture;
heartbeats do not extend it. New calls refuse time below the persisted execution
clock. Known valid-source observations may survive a business denial as clock-only
updates, preventing a recorded expiry denial from being bypassed with a new ID and
rewound time. SQL or precommit failure rolls the entire transaction back.

`inspect_native_action_request` is an observe/refresh operation: it can persist
clock advancement and expiry/source-loss closure. It is not the read-only mission
snapshot API. Current task/mission revision/digest, lease or write-access loss
closes pending intent; it never manufactures a successful action. Withdrawal
requires the displayed request digest and pending revision, then writes a revoked
closure. Replays preserve the original terminal reason/time. No user approval or
self-approval is possible because this format has no positive decision operation.

## Recovery, compatibility and activation gates

The existing canonical profile `recover` expires pending native intents in the
same transaction that removes old leases and quarantines in-flight work. Recovery
failure rolls those changes back together. `CoreStore::open` alone is not runtime
startup or recovery; daemon startup already requires profile recovery before use.
Periodic source loss is also detected by subsequent observe/replay calls. No
background expiry timer or current-authority claim is added.

Migration 10 is additive, with no backfill or promotion of legacy approval rows.
Schema-9 provisional allocations and legacy approvals remain intact; backups,
rollback and newer-schema refusal follow the existing store rules. Historical
migration tests pin their endpoints. Tests use temporary stores/missions only.
Clock inputs remain trusted composition data: forward jumps can conservatively
expire requests; restoring an old database is not certified and must not revive
newer runs or uncertain effects. Local locking is not provider-global fencing.

Executable approval needs a **distinct verified format and authenticated user
decision channel**, an authoritative current policy/skill resolver, proven digest
canonicalization of exact validated arguments, current execution/writer fencing,
revocation/expiry checks at the actual effect, and atomic once-consumption with
durable operation receipts. These intent rows can never be promoted in place or
used as delegation authority. V2-03/04/05/06 and actual platform/vendor gates stay
open; no weaker fallback is introduced.
