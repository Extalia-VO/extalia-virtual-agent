# ADR 0092: Durable learning before idle admission

- Date: 2026-11-15.
- Status: Implemented for v0.4.331; focused local verification.
- Extends: ADRs 0074, 0081 and 0091.

## Problem

ADR 0091 preserves analysis checkpoints and prepared findings, but its Rust job
starts after the host's idle countdown. Closing Extalia during that countdown
can lose the completed source's pending learning. Persisting an arbitrary host
closure would also retain obsolete providers, permissions or writer handles.
A separate queued record plus a new analysis job would create a crash window
between two independently published identities.

## Decision: queued is the first state of the same Rust job

The host awaits durable capture of eligible completed Native evidence or an
explicitly opted-in Observe episode. Rust performs the existing bounded evidence
selection and sanitization, then publishes a queued job in the existing journal.
Capture creates no model effect, source-reader contract, vault pin or live job
handle. The source identity determines the job ID; an exact capture retry returns
the existing record. Changed evidence, route or policy for the same source is
refused rather than creating a second analysis.

Queue metadata contains source identifiers, the destination/policy/route binding,
zero initial model/read counts, and a revision-bound quiet interval. It exposes
no retained prompt, evidence body, credentials or vault root to the UI.

| Operation | Durable consequence |
| --- | --- |
| `queue.capture` / `observed.queueCapture` | Save the never-started source once; no provider request. |
| `queue.delay` | Save 60 or 600 seconds with the exact queue revision. |
| `queue.cancel` | Retire queued work without entering an effect. |
| `queue.admit` | Atomically change the same job to running with freshly authorized readers and an unentered next effect. |
| `job.enter` / `job.advance` | Retain ADR 0091's before-effect and after-result checkpoints. |

Every mutation checks the full binding and a digest of the journal generation
and owner. Queue admission checkpoints the transition before exposing the first
effect. If its acknowledgement is lost, repeating queue admission cannot fork
or replay analysis; the retained job follows the ordinary checkpoint recovery
rules. An entered effect without confirmed completion remains uncertain.

## Host admission and restart

The existing profile-aware scheduler still decides when work can run. Native
capture remains owned by its foreground invocation until it settles; Observe
capture remains owned by the episode callback. A bounded host tracker drains
admitted capture operations before releasing daemon/profile ownership.
Storage authority for already accepted work remains valid through orderly
shutdown only while the exact source, policy and destination still match. A
committed in-flight Observe episode drains its local queue handoff before the
admission tracker is sealed; this never grants a new provider invocation.

After source discovery and local work-memory replay, startup makes one bounded
restoration pass. It reconstructs fresh callbacks only for authorized queued
records. Profile, workspace boundary, saved session/history, model route,
destination revision and current policy are checked again. Observe additionally
requires its exact source scope, active observation consent and retained episode.
Startup does not replay already-started analysis or unknown paid effects.

A restored entry waits its entire selected quiet interval after conflicting work
settles. Elapsed wall time while Extalia was closed does not trigger immediate
model calls. Run now is an explicit, transient admission request and is not
remembered across restart. A full local queue leaves the durable record available
for an explicit action or a later restart. Reading the UI catalog alone never
restores or dispatches work.
An unavailable startup catalog does not prevent Extalia from opening. Healthy
profiles remain inspectable when another profile fails; an incomplete-list notice
distinguishes omitted or unreadable records from the work actually shown.

Snooze fences the entry before its first asynchronous storage operation. Neither
an old timer nor a concurrent action may enter it before storage acknowledges
the new delay. A lost acknowledgement fails the local entry and leaves the
durable catalog to reconcile its actual revision. Pending retirement is ordered
after a concurrent delay write. Shutdown drains storage callbacks and preserves
queued intent; configuration invalidation retires it.

Source revocation also retires matching queued Observe jobs. This prevents a
later capture of an identical episode from reviving the old intent. It is not
a secure-erasure claim: existing journal retention and diagnostic generations
still apply.

## Independent outputs and source freshness

At execution time, a notes-only queued job checks that its current destination
can be prepared before paid analysis. When skills are also enabled, a temporary
note preparation failure leaves skill analysis/publication independently
available. The exact captured policy is not silently narrowed to fit a failed
destination. Existing note/skill receipts continue to reconcile independently.

Observed scope comparison uses named fields rather than JSON property order.
The protocol may reorder object keys without changing source identity; changing
any scope field still invalidates authorization.

Initial Native admission may supply bounded historical recall using that
source's user query. Restored Native work retains its exact selected source
evidence and scoped work-memory tools; it does not manufacture a query from a
newer session turn. Observe can retrieve its query from the exact retained
episode. Historical recall remains optional context, never current evidence.

Full-package skill replacement requires reading all pages of `SKILL.md` and all
existing Markdown references. Curator guidance now states that same requirement
and instructs the model to omit refinement if its bounded read budget cannot
cover the package. This does not add a fresh-review phase for a recovered
refinement or certify skill usefulness.

## Placement, limits and verification

Rust owns normalized queued evidence, identity, immutable generations, expiry,
source replay checks and execution transitions. TypeScript owns current host
authorization, physical effects, shutdown draining and the existing idle timer.
React presents queued, resumable, publication, uncertain and expired states.
This extends the existing ownership boundaries without a second persistence
store or a language-migration claim.

The journal retains its 64-job per-profile cap, one-MiB checkpoint bound and
seven-day recovery window. Expired entries are pruned lazily at later admission;
the most recent generations are retained, and a corrupt latest generation is
never replaced by an older one. Unsupported Windows durable-file behavior
remains unavailable. Team knowledge meetings still use their separate existing
live scheduler; this change persists bounded automatic curation, not every
background activity or external application's process.
Initial Observe episode capture and the later learning-journal write remain
separate durable operations. An abrupt kill before queue-capture acknowledgement
is not covered by an atomic cross-store handoff guarantee. Source work that has
not entered capture is also outside the accepted-capture shutdown drain.

Verification covers actual daemon kill/restart, restarted Native/default and
isolated hosts, global Observe, preserved snooze, revoked consent, stale revisions,
lost acknowledgements, conflicting timers, shutdown drain and partial publication.
See the [verification record](../bench/learning-admission-v0331.md).
The owner's instruction defers CI fixture repairs. Local tests do not establish
installed-product acceptance, live-provider cost savings or Hermes parity.
