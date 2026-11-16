# Native agent and orchestration

Audit baseline: **v0.4.288, 2026-11-12**. Status below describes the checked-in
implementation and recorded evidence, not a new provider or platform certification.
Use the [PRD acceptance map](../product/prd-v2-acceptance-map.md) for release gates.

## Responsibility and boundaries

Extalia Native runs managed model/tool conversations, saved teams and delegated
workers. Worker results return to the lead for synthesis. The separate Missions
workflow schedules fixed task graphs, read-only by default. Explicitly write-capable
tasks receive file tools rooted in isolated Git worktrees. Production integration
test gates are not run and Apply refuses proposals; commands remain unavailable.
See [Mission changes](../getting-started/mission-changes.md).

The host owns credentials, admission and platform effects; React presents protocol
state. Rust owns selected stores, mission policy and indexes. Provider completion
and ordinary orchestration remain TypeScript under the measured placement decision
in [ADR 0071](../adr/0071-rust-openai-completion-and-resource-evidence.md).
Supervised Python supplies the pinned scanner, not a general coding executor.

## Status

| Capability | Status | Scope or remaining acceptance |
| --- | --- | --- |
| Managed Chat and workspace-bounded file tools | Implemented | File changes retain workspace permissions and approval checks. Native terminal commands are unavailable until a verified workspace-isolated executor exists. |
| Named teams with separate models/connections and worker reports | Implemented | Up to eight active invocations per lead turn; write jobs serialize. Saved connection/model grants remain authoritative. |
| Skills and memory preparation | Implemented | Connection-controlled; see [Skills](skills.md) and [Knowledge and memory](knowledge-memory.md). |
| Mission planning and task DAG projection | Implemented preview | Read-only by default; explicit write tasks use isolated worktrees. Production integration test/apply is blocked; model answers remain unverified. |
| Rust mission journal, leases, recovery inspection and status | Partial acceptance | Recorded ownership and local drain do not establish complete descendant membership, writer fencing or physical settlement. |
| Durable exact action approval and accepted evidence before dependency release | Not complete | V2-05/06 and their prerequisite recovery gates remain open. |
| General Python worker and durable replay-safe dispatch | Not complete | Specific scanner supervision and conservative recovery are not these capabilities. |
| v0.5 acceptance | Open | Functional implementation and passing release CI do not close the [gate](https://github.com/Extalia-VO/extalia-virtual-agent/issues/60). |

## Read by purpose

- Use: [Chat orchestration](../getting-started/chat-orchestration.md),
  [Native teams](../getting-started/native-teams.md),
  [Missions](../getting-started/missions.md),
  [Native core and status](../getting-started/native-core.md).
- Architecture: [Runtime adapters](../architecture/runtime-adapters.md),
  [Native missions](../architecture/native-missions.md),
  [ADR 0058: team authority](../adr/0058-native-team-connection-authority.md),
  [ADR 0059: folder authority](../adr/0059-native-workspace-folder-authority.md).
- Development: [Harness review](../product/native-harness-development-review.md),
  [PRD development plan](../product/prd-v2-development-plan.md).

## Source and regression evidence

| Area | Source | Regression coverage |
| --- | --- | --- |
| Worker dispatch, model routing and lead result | [delegation.ts](../../packages/runtime/src/delegation.ts) | [Distinct models](../../packages/runtime/test/delegationDistinctModels.test.ts), [capacity](../../packages/runtime/test/delegationCapacity.test.ts), [status](../../packages/runtime/test/delegationStatus.test.ts) |
| Task graph and persistence acknowledgement | [mission.ts](../../packages/runtime/src/mission.ts), [host mission](../../packages/host/src/mission.ts) | [Durability](../../packages/runtime/test/missionDurability.test.ts), [acknowledgement](../../packages/runtime/test/missionAsyncAcknowledgement.test.ts) |
| Inspection without replay | [missionRecovery.ts](../../packages/host/src/missionRecovery.ts), [nativeStatus.ts](../../packages/host/src/nativeStatus.ts) | [Recovery UI](../../apps/web/test/missionRecoveryUi.test.ts), [Native status](../../apps/web/test/nativeStatus.test.ts) |

These are traceability references. Their presence is not a claim that this docs
audit reran them or certified real-cloud costs, latency or external settlement.
