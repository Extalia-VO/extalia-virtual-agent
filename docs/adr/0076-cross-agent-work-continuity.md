# ADR 0076: Reviewed cross-agent work continuity

- Status: Accepted
- Scope: Native connection changes and capability-bound or manual handover to an existing observed conversation

## Problem

The previous Continue in Extalia action created a new managed conversation from
the first and most recent user/assistant messages. Repeating that operation
could progressively lose decisions, original tool evidence and source identity.
Reported context token use describes pressure on a model window; it cannot
establish which facts an outside harness retained after compaction.

## Decision

Keep a profile-local canonical **work record**, independently from each runtime's
native thread ID. Bind explicitly reviewed source/destination sessions to this
record. Retain attributed snapshots of visible original requests, responses,
tool results, file changes and reported model/context metadata. Store six
reviewable working-note fields: objective, decisions, completed work, next
steps, verification, and uncertainty. Claims remain distinct from actual tool
or artifact evidence.

Each transfer is previewed against the current source, destination, workspace,
connection and capability. Expired or changed reviews fail before an effect.
Record an immutable operation reservation before entering the selected adapter.
Retries with the same operation/review return its receipt without executing the
effect again. Unknown outcomes survive restart and require deliberate user
inspection before later transfers; inspection records a claim, never model
consumption or physical worker settlement.

Native connection changes keep the existing Native session ID, history, name,
team and workspace. The selected model is frozen in the review. The reviewed
capsule is added as imported user context, without inventing an assistant reply
or calling inference. The next ordinary prompt uses the selected connection.
Adopting an observed source into Native creates one managed endpoint and binds
it to the existing canonical work record. Returning to a prior observed endpoint
does not create a replacement external thread.

Observed delivery uses only an existing host-advertised control capability.
Native attachment, source queue, cooperative tool and cooperative inbox remain
different adapters. Manual preparation can bind a destination conversation, but
its receipt says prepared, not sent. Extalia never fabricates a Claude, Gemini
or other runtime's native resume/control API.

## Bounds and access

- The journal uses private atomic files and a serialized owner with a close
  drain. A reserved effect without a final receipt remains unknown.
- Sources and targets must belong to the same reviewed workspace. Current
  foreground work, pending prompts, mission ownership and context operations
  remain admission gates. No transferred text changes filesystem permissions.
- History-off work stays in RAM. Native connection handovers require matching
  saved-history policy; the continuity layer never silently changes retention.
- Labels-only mode prevents observed and mixed-lineage archive retrieval,
  including through a Native alias. Pure Native work is independent.
- Evidence archives and capsules are bounded. Every omission or shortened
  entry is disclosed; full coverage means all visible retained source evidence,
  not hidden harness context. Native agents can page retained evidence through
  `continuity_status` and `continuity_read`.
- Existing external MCP connections can page reviewed archives with
  `extalia_continuity_status` and `extalia_continuity_read`. An explicit target
  handover includes a 24-hour scoped bearer code; shared hook authentication
  or a guessed session ID alone grants no context access. Only pinned notes and
  snapshot IDs are exposed, never later work. Grants persist hashes only and
  respect RAM retention, current workspace/watch identity, expiry and revocation.
  Two-phase reads release the grant lane while waiting for the archive owner,
  then recheck authority before returning, preventing lock inversion and late
  disclosure after revocation. Codes are redacted from subsequent evidence.
- Exact delivered capsules and explicitly identified Native continuity-read
  results are excluded from subsequent source evidence. External wrapper tool
  outputs can remain in the archive when they lack reliable continuity-tool
  identity. The source watermark advances only for retained meaningful evidence.
- Independent existing canonical work records are not merged implicitly.
  Source application IDs remain distinct and visible in lineage metadata.

The host retains transport, source-selection, durable JSON and lifecycle
ownership alongside its existing session store. This small on-demand workload
does not introduce an LLM summarizer, extra runtime process or per-frame UI
processing. This is an ADR 0071 placement choice, not a Rust/Python migration
claim. React projects host-owned previews and receipts only.

## Verification

Focused tests cover repeated cross-model and cross-source lineage, restart,
original objective/evidence retention, new Native endpoint aliasing, stale
reviews, packet byte bounds, privacy and RAM retention, entered-effect failure,
idempotent receipts and explicit user-inspected recovery. Actual-host tests use
temporary profiles and real provider/transport adapters with scripted model
responses. These tests do not certify live third-party application versions or
hidden context preservation.

A subsequent [live CLI acceptance run](../bench/live-handover-chain.md) on
v0.4.288 completed Codex → Gemini → Claude → the original Codex session,
using real inference, reviewed export and supported CLI resume. Original
decisions and intervening progress were preserved across three transfers and
host restarts. Actual scoped MCP reads recovered a shortened Claude entry.
Desktop automatic dispatch and context-window compaction remain open.

See the [user workflow](../getting-started/cross-agent-handover.md) and
[remaining PRD breakdown](../product/prd-remaining-work.md).
