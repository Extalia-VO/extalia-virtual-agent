# Agent-app connections and observed conversations

Audit baseline: **v0.4.288**, 2026-11-12. Managed runtime sessions and observed
outside conversations are distinct. Receiving a hook, reading a transcript or
finding an installed CLI never grants control of that application.

## Read by purpose

| Purpose | Documentation |
| --- | --- |
| Install, diagnose and undo connections | [Connection safety and verification](../architecture/agent-app-connections.md), [Settings/Observe/Import](../getting-started/settings-observe-import.md) |
| Send to an existing conversation | [Observed messaging](../getting-started/observed-agent-messaging.md), [Codex controls](../getting-started/observed-codex-control.md) |
| Questions and approvals | [Observed replies](../getting-started/observed-replies.md), [message presentation](../design/chat-message-presentation.md) |
| Transfer reviewed context | [Cross-agent handover](../getting-started/cross-agent-handover.md), [ADR 0076](../adr/0076-cross-agent-work-continuity.md) |
| Transport contracts and acceptance | [Runtime adapters](../architecture/runtime-adapters.md), [Observe PRD](../product/prd-observed-agent-control.md), [ADR 0072](../adr/0072-observed-control-hub-and-cooperative-inboxes.md) |

## Implementation status

| Area | Status at this baseline | Remaining boundary |
| --- | --- | --- |
| Codex, Claude Code, Gemini CLI, Antigravity and Hermes connectors | Implemented | External configuration changes require preview, consent, backup and undo; supported installed-version evidence is separate from synthetic tests. |
| Authenticated hook ingest, transcript catch-up and liveness | Implemented | Endpoint probes prove endpoint acceptance only. Real normalized hook activity can restore a failed transcript channel; silence cannot prove an agent healthy. |
| Serialized connector writes and crash-journal review | Implemented | Advisory locking coordinates Extalia processes. This is not OS-level locking or filesystem CAS; a leftover journal needs explicit reviewed recovery. |
| Session-bound native, queue and cooperative control | Implemented, capability-specific | Codex/Hermes attachments, source queues, direct supported source adapters and paired tool inboxes have different authority and receipts. No universal attach/approval contract. |
| Shared Chat/Observe/Office messages, file previews and answers | Implemented | File reads retain host scope checks; display formatting creates no execution authority. Native request controls require a real current adapter capability. |
| Canonical work records and reviewed handover | Implemented | Visible snapshots are not hidden harness context. Queued/submitted/manual-ready records do not prove model consumption or physical settlement. |
| Real vendor/version/platform certification and owned generic CLI launch | Incomplete / future scope | [Observe PRD](../product/prd-observed-agent-control.md) retains separate acceptance issues; no PTY/ACP managed runtime is implied. |

## Source and regression map

- Configuration plans, backups and journals: [connect/service.ts](../../packages/host/src/connect/service.ts),
  [operationJournal.ts](../../packages/host/src/connect/operationJournal.ts);
  [connectSafety.test.ts](../../packages/host/test/connectSafety.test.ts),
  [connectTransaction.test.ts](../../packages/host/test/connectTransaction.test.ts)
  and [connectJournal.test.ts](../../packages/host/test/connectJournal.test.ts).
- Hook authentication and mapping: [hooks/http.ts](../../packages/host/src/hooks/http.ts),
  [hooks/normalize.ts](../../packages/host/src/hooks/normalize.ts);
  [hooks.test.ts](../../packages/host/test/hooks.test.ts) and
  [observedHookFallback.test.ts](../../packages/host/test/observedHookFallback.test.ts).
- Control authority/receipts: [observedControlService.ts](../../packages/host/src/observedControlService.ts),
  [observedControlDrivers.ts](../../packages/host/src/observedControlDrivers.ts);
  [observedControlHost.test.ts](../../packages/host/test/observedControlHost.test.ts)
  and [observedInbox.test.ts](../../packages/host/test/observedInbox.test.ts).
- Continuity access: [continuityAccess.ts](../../packages/host/src/continuityAccess.ts),
  [handoverEvidence.ts](../../packages/host/src/handoverEvidence.ts);
  [continuityAccess.test.ts](../../packages/host/test/continuityAccess.test.ts)
  and [handoverHistory.test.ts](../../packages/host/test/handoverHistory.test.ts).

This audit checked source and recorded evidence; it changed no external
configuration and performed no live vendor-session certification.
