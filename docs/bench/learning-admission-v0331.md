# Durable learning admission — v0.4.331

Date: 2026-11-15. Extends PR #110's v0.4.330 implementation.

## Scope

Persist bounded automatic learning before its idle countdown, restore only
never-started and currently authorized sources, and preserve independent
Knowledge/skill outcomes. The implementation follows
[ADR 0092](../adr/0092-durable-learning-admission.md).

Verification uses synthetic temporary profiles, controlled provider responses
and the real Rust daemon. No paid model call, live user configuration, external
agent installation or CI workflow change is part of this increment.

## Acceptance evidence

| Case | Expected result |
| --- | --- |
| Capture and exact capture retry | One retained source identity; no model, reader or vault pin while waiting. |
| Changed evidence, route, policy or workspace | Refused instead of creating another job or redirecting evidence. |
| Idle shutdown and restart | Current authorization reconstructs a queue entry from saved evidence. |
| Isolated profile and snooze | The same profile retains a 600-second full quiet interval. |
| Global Observe restart | Only captured, consented work restores; visible historical backlog does not create new learning. |
| Observe field order | Reordered wire object keys preserve identity; changed field values do not. |
| Revoked source | Old queued intent does not execute or revive after equivalent recapture. |
| Admission acknowledgement lost | Same job remains recoverable without a second initial model effect. |
| Unconfirmed entered effect | No automatic paid replay. |
| Snooze acknowledgement lost or stale generation | The local stale callback cannot enter; stored metadata remains inspectable. |
| Timer/control/shutdown race | Storage finishes before acknowledgement/retirement; shutdown preserves waiting intent. |
| Committed Observe capture during close | Fresh storage authority permits its local intent handoff; no provider begins after close. |
| Partial or unavailable recovery catalog | Healthy queued work remains actionable; limits or unreadable records receive an honest notice, and opening Extalia is not blocked. |
| Unavailable note destination | Notes-only analysis does not spend model tokens; enabled skills can still complete independently. |
| Existing memory → learning → later recall | The learned Knowledge note remains retrievable in a fresh Native session. |
| UI and protocol | English/Indonesian queued state is distinct from resumable analysis; controls require exact bounded bindings. |

## Verification record

- Focused TypeScript, host, runtime, protocol and UI selection: **390 passed,
  one platform-conditional skip, 24 test files passed**. Real-host cases use the
  rebuilt daemon and controlled providers.
- Rust learning unit subset: **98 passed**.
- Actual daemon kill/restart integration: **3 passed**.
- All workspace typechecks passed. Web, CLI and Desktop bundle builds passed;
  existing bundle-size and non-module boot-script warnings remain.
- `pnpm lint` passed, including ESLint, dependency boundaries, the reviewed
  backend ownership inventory, public-data checks and generated-schema freshness.
  Version consistency passed at **0.4.331**. Rust Clippy for the daemon library
  also passed with warnings denied.
- Feature verification is separate from the deferred full `pnpm check`/CI
  matrix. No existing CI fixture was disabled or repaired as part of this work.

## Remaining limits

Restoration does not rerun a paid effect whose completion is unknown. Incompatible
or expired bindings cannot be moved to a new vault or model by restoring them.
The durable catalog is bounded; a full in-memory queue leaves additional saved
work available for explicit admission or the next startup pass.

Only bounded automatic Native/Observe curation receives pre-admission durability.
Existing multi-participant knowledge meetings retain their separate live queue.
A recovered skill refinement still needs a dedicated fresh source-review phase;
this increment aligns full-reference instructions but does not add that phase.
Larger valid skill packages can exceed the curator's eight-read budget and must
be omitted rather than partially overwritten.

Restored Native work has retained selected source evidence and scoped memory
readers, but no invented historical prefetch query from a later turn. Optional
initial-turn recall is not guaranteed to be identical after restart. Local
retention is seven days with lazy expiry pruning, not a secure-erasure schedule.
An abrupt kill before acknowledgement of the separate queue capture can still
interrupt the handoff from the initial Observe episode store; cross-store atomic
handoff is not claimed. Source work not yet admitted to capture is outside the
accepted-capture shutdown drain.
Windows durable storage, live model quality/cost, installed Desktop interaction,
and real upstream Caveman acceptance remain separate work. No claim of parity
or superiority over Hermes or Claude-Mem is made by these tests.
