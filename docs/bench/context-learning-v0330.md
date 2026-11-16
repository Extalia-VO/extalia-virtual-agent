# Context optimization and learning recovery — v0.4.330

Date: 2026-11-15. Source extends PR #110's `cf3a47e` implementation.

## Scope

This development pass follows the owner's direction to strengthen features and
defer CI fixture repairs. It covers Native context optimization, scoped memory
admission and durable post-task learning. It does not change CI workflows or the
known macOS/Windows portability fixtures from the previous PR head.

All execution uses synthetic temporary profiles, controlled providers, local
files and the real Rust daemon. No paid model call or live user profile is part
of the verification. The Caveman adapter runs its actual subprocess lifecycle
against a controlled CLI protocol fixture. The upstream engine at `b4ee71d` was
source-inspected; no executable or Go compiler was available to benchmark it.

## Behavior exercised

| Area | Evidence |
| --- | --- |
| Connection settings | Decoder and EN/ID form validation, legacy defaults, explicit executable, no shell arguments, mode roundtrip. |
| Real Native optimization | Saved lead/worker off/local/Caveman settings affect actual provider request bodies; workers follow their own connection. Structured fallback receipts persist in session events. |
| Protected context | Original history, exact instructions/source reads, native payloads, pairing, errors, diagnostic/constraint lines and recovery readers remain protected. |
| Local archive | New files contain only selected sanitized tool reports; unrelated messages/arguments are absent. Legacy reads retain explicit evidence/version labels. |
| Engine failure | Missing executable, malformed report, recovery mismatch, scope change, deadlines and unavailable storage do not claim successful engine compression. |
| Recall and admission | EN/ID continuation, nearest user goal, actual AND-style Knowledge search, relevance-ranked fresh excerpts, separately read amendments, partial read coverage, mandatory skills and per-block budgets. |
| Integrated learning reuse | A real local memory → curator → Knowledge/inactive skill → new Native session cycle includes the freshly saved Knowledge note. |
| Durable daemon | Actual process kill/restart preserves exact unentered work and ready findings. Entered effects remain uncertain. Stale owners, corrupt generations, expiry, source revocation and independent attempted/recorded artifacts are refused or reconciled appropriately. |
| Restarted host | Resume works through the public host API and existing idle queue. Ready findings publish with no new model request; unentered analysis resumes only its remaining request. |
| Partial recovery | Missing note preparation leaves its claim unconsumed and permits independent skill publication. A stale skill-refinement review does not block a separately verified note. |
| Async authority | Recheck after pre-effect activity, memory/Knowledge reads and reporting. Changed scope cannot deliver stale context to a provider. |

## Verification record

- Focused TypeScript/UI/host/runtime/protocol selection: **303 passed, one
  platform-conditional case skipped, 21 files passed**. The suite requires the
  rebuilt real daemon, including host restart and local memory-cycle cases.
- Rust learning unit subset: **79 passed**.
- Real daemon process kill/restart integration: **2 passed**.
- All workspace typechecks and Web/CLI/Desktop bundle builds passed. The lint
  gate includes ESLint, schema freshness, dependency boundaries, public-data
  checks and the reviewed ownership baseline. Version consistency is 0.4.330.
  Backend ownership remains a placement inventory, not a claim that all
  TypeScript backend responsibilities moved to Rust.
- Feature tests run independently of the complete `pnpm check`/CI matrix.
  No unrun full gate is counted as passing, and prior CI failures are not repaired
  or hidden by this feature work.

The focused selection includes `contextCompaction`, `toolContextProjection`,
`nativeContextArchive`, `cavemanContextOptimizer`, `nativeContextOptimizationHost`,
`nativeMemoryPreparation`, `nativeRecallPlan`, `workMemoryService`,
`automaticLearning`, `automaticLearningService`, `learningRecovery`,
`learningSchedule`, `observedGlobalLearning`, `observedLearningScope`,
`learningKnowledgeCycle`, `rustLearning`, protocol `learningCurator`, core
`connections`, and web `validation`, `connectionTestFlow`, `learningCountdown`.

## Practical limits

The engine setting requires Extalia memory, saved history and the selected
profile's automatic-learning consent. Passive Observe does not intercept requests
from other apps. Local token counts and per-transform estimates do not establish
total task cost or quality. Protection rules deliberately leave some large
contexts unchanged; an oversized non-optional request can still be refused.

Projection caching lasts for one Native turn. Recovery is bounded to exact
compatible bindings and a seven-day window; expired checkpoints are pruned
lazily on later admission. Legacy jobs have no retroactive journal. Uncertain
effects require inspection, and old skill-refinement review receipts cannot be
reused after restart. The pre-admission idle countdown is still in memory;
durability starts when Rust admits the learning job. Windows durable learning
and archive support, installed-engine acceptance, full interactive UI checks and
live-provider quality/cost comparisons remain separate work.
