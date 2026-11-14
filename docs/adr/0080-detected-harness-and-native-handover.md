# ADR 0080: Detected harness selection and native Antigravity handover

Status: Accepted; isolated live UI acceptance recorded for source v0.4.290. Installed Desktop packaging and physical context-limit acceptance remain separate gates.

## Context

Users choose a harness to continue work, while provider/model settings describe what that harness uses. Presenting transport setup as the main handover flow obscures that distinction. Installation discovery also cannot establish permission, a working adapter or a successful model call.

Antigravity's native conversation helper can create a conversation, but launching it with a process working directory did not bind that conversation to the project. Native creation can also complete before Extalia registers an observation. Reopening setup must recover that original operation without creating another conversation or transferring context prematurely.

## Decision

### Select a detected harness, then its conversation

The dialog first offers detected harnesses, with separate existing-conversation and creation capabilities. Evidence can come from an executable, installed application, watched session or usable native connection. Extalia's built-in runtime is shown separately from outside harnesses. Undiscovered harnesses are omitted; detected harnesses without an adapter remain visibly unavailable. Kiro/OpenCode detection does not emulate a missing control adapter.

Selecting a card does not create a conversation or send a packet. Creation is explicit. Technical connection setup, notes and evidence remain in Advanced. Existing-session continuation retains the reviewed pairing requirements in [ADR 0079](0079-reviewed-cli-handover.md). The final packet, destination, digest and confirmation stay part of the normal handover review.

### Create through one pinned native endpoint

`AntigravityHandoverService` uses the authenticated loopback `LanguageServerService` declared by the installed runtime. Discovery identifies a native endpoint; the reviewed operation pins its identity rather than trying multiple daemons. The default production transport bypasses proxy settings and DNS before attaching the local CSRF credential. Endpoint credentials are not written into the operation journal or exposed to the renderer.

Before `StartCascade`, persist an operation ID and preallocated native UUID. The request supplies that exact ID, the controlled folder's file URI, the native agent-API source/type, and a selected native model. `workspaceUris` and `overrideWorkspaceUris` are repeated strings. A process cwd or prompt mentioning a path is not workspace authority.

Creation is accepted only when the returned UUID matches and both native metadata and trajectory identify the same conversation and canonical workspace URI. The model must come from an explicit reviewed host selection or an available native catalog default. Model aliases and placeholder enums are not mapped by hardcoded frontend rules. Native policy remains in force; this adapter does not invent approval/question controls or grant broader execution permissions.

The tested native API creates an empty trajectory before a readable brain transcript exists. A separate, fixed readiness bootstrap can prepare that newly created conversation. It contains no transferred work context and forbids tools or file changes. Its deterministic child operation and persisted client message ID prevent replay. Ordinary handover messages remain blocked until Extalia verifies the observation's native ID/workspace and records registration.

### Recover identity, never repeat uncertain effects

Native creation, observation registration and handover delivery have distinct receipts. A created but unregistered conversation blocks new creation operations for that workspace. The original operation remains inspectable after restart. Explicit setup recovery can verify its exact preallocated UUID against the same endpoint and workspace boundary, then continue registration. Missing or ambiguous identity stays uncertain. Recovery does not call `StartCascade` again or silently select a replacement session.

Each ordinary message is journaled before `SendUserCascadeMessage`, with its own stable native client message ID and reviewed model configuration. A native HTTP acknowledgement means submission. Read-only monitoring releases active ownership only after a later user-input step echoes that exact client ID and the native trajectory becomes idle. Unrelated progress cannot settle the operation. Closing or losing an unconfirmed request preserves uncertainty; it does not claim to cancel native execution or replay a prompt.

The explicit **Inspect native connection** UI action can reconcile a watched, registered conversation after a host restart or native endpoint rotation. It re-attests the exact native ID, unchanged original workspace boundary and canonical folder through native reads. Each uncertain submission must have its own saved client message ID visible after its recorded baseline in complete returned steps, and the trajectory must be idle. Missing, truncated, unrelated or changed-scope evidence keeps the fence. Successful inspection can rebind a known creation to the current native endpoint and mark proven operations reconciled in Extalia's journal. Their original `unknown` receipts remain unknown; inspection neither resends a message nor upgrades historical transport acceptance. Old external-session journals without original scope evidence remain fenced.

Source and destination are linked to the existing canonical work record only through the normal reviewed continuity flow. A native destination keeps its own conversation ID, while returning to Codex can resume the original Codex ID. Existing workspace isolation and source-change checks remain mandatory.

### Reflect native metadata in Observe

Antigravity folder association uses authenticated native workspace attestation, even when its transcript has no cwd field. Folder grouping itself neither links an unbound session nor grants new access. Model display identity is resolved only through the native catalog's enum-to-model-ID entry. The cache lasts 60 seconds and is bounded to eight endpoint generations and 512 model keys per generation. Lookup failure preserves scope inspection and the raw native enum; it does not fabricate a friendly model or context-token count.

For Codex, current folder evidence follows the bounded dated-native-metadata rules in ADR 0079. Origin hints, current visible metadata and an explicitly linked workspace are distinct facts.

## Ownership and limits

The existing host adapter owns discovery, native RPC supervision, operation journals and observation attribution. React presents capabilities and user choices. No inference engine or heavy background analysis moves into the renderer; this decision makes no unmeasured speed or memory-saving claim.

The native RPC is version-sensitive. A detected installation is not a guarantee that every runtime version supports these methods. Native responses are bounded to 2 MiB. A creation cannot be declared ready solely because a helper exited, a transcript exists, or a runtime became idle. Native completion also does not establish task correctness; files, decisions and tests require independent verification.

The native handover journal currently retains at most **128 creations and 512 submissions**. Reaching a limit is surfaced as unavailable/refused further operations. Entries are not silently pruned, and a different operation ID cannot bypass the limit. Supported archival with durable idempotency evidence remains future work; deleting the journal is not a supported recovery flow.

## Validation

The [native Antigravity benchmark](../bench/native-antigravity-handover.md) records a real Codex → Antigravity → original Codex roundtrip through the Extalia React UI and isolated host. It preserved the implementation, decisions and Antigravity's fourteen tests. The accepted UI creation operation registered the same native conversation after a recoverable setup gap, without another creation call. A final host restart retained one creation and two native Antigravity submissions—the bootstrap and reviewed task transfer—without replay.

Separate real-HTTP fixture tests cover workspace attribution without transcript cwd, lost creation acknowledgement, negative identity inspection, restart recovery, exact packet dispatch and canonical return. Service tests cover registration fences, fixed bootstrap idempotency, native client-message correlation, explicit read-only reconciliation, endpoint/source changes and catalog display metadata. UI matrices use simulated host APIs and establish layout/interaction behavior only.

This acceptance did not attach to an installed Codex Desktop process, saturate a context window or prove universal compaction. No further live Claude calls were part of the later Codex/Antigravity acceptance after that scope change.
